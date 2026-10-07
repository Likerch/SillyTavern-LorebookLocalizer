import { installApi } from './src/api.js';
import { EXTENSION_TITLE, resolveLanguage } from './src/constants.js';
import { createRequestFn, resolveConnection } from './src/connection.js';
import { buildProposals } from './src/entries.js';
import { createExclusive } from './src/exclusive.js';
import { createHeadless } from './src/headless.js';
import { startLbcModule } from './src/lbc/module.js';
import { addLbcSettings } from './src/lbc/panel.js';
import { applyChanges, collectItems, removeAddedKeys, toPromptItem } from './src/lorebook.js';
import { getSettings, t } from './src/settings.js';
import { parseRegexFromString } from './src/st.js';
import { Translator } from './src/translator.js';
import { addSettingsPanel, addWorldInfoButton, confirmRemoval, openMainDialog, ProgressDialog, showPreview } from './src/ui.js';

/** The dialog and the API (localizeEntries) run one job at a time. */
const exclusive = createExclusive();

async function onOpen() {
    const busy = exclusive.state();
    if (busy.running) {
        toastr.info(busy.by === 'api'
            ? t`Lorebook Localizer is translating entries for another extension (Maestro). Open it again when that is done.`
            : t`Lorebook Localizer is already running.`, EXTENSION_TITLE);
        return;
    }
    const choice = await openMainDialog();
    if (!choice) return;

    try {
        await exclusive.run(async () => {
            if (choice.action === 'localize') await localize(choice.books);
            if (choice.action === 'remove') await removeKeys(choice.books);
        }, {
            by: 'dialog',
            // Another extension started a job while the dialog was open.
            onQueued: () => toastr.info(t`Lorebook Localizer is finishing a job for another extension; yours starts right after it.`, EXTENSION_TITLE),
        });
    } catch (error) {
        console.error(`[${EXTENSION_TITLE}]`, error);
        toastr.error(String(error?.message ?? error), EXTENSION_TITLE);
    }
}

/**
 * @param {string[]} books
 */
async function localize(books) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();
    const lang = resolveLanguage(settings);
    const connection = resolveConnection(settings);
    if (connection.kind === 'error') {
        toastr.error(t`The connection profile cannot be used: ${connection.message}`, EXTENSION_TITLE);
        return;
    }
    if (connection.kind === 'current' && ctx.onlineStatus === 'no_connection') {
        toastr.error(t`No API connection. Connect to an API or choose a connection profile.`, EXTENSION_TITLE);
        return;
    }

    const { items, stats } = await collectItems(books, settings, lang, { skipProtected: !settings.localizeProtected });
    if (stats.protectedBooks.length) {
        toastr.info(t`BunnyMo books and packs are not localized, skipped: ${stats.protectedBooks.join(', ')}`, EXTENSION_TITLE);
    }
    if (!items.length) {
        // Only BunnyMo books were chosen: the toast above says it all.
        if (!stats.books && stats.protectedBooks.length) return;
        toastr.info(t`Nothing to translate: the keys are already localized, are regexes or are already in ${lang.name}.`, EXTENSION_TITLE);
        return;
    }

    const controller = new AbortController();
    const progress = new ProgressDialog(t`Translating keys to ${lang.name}…`, () => controller.abort(new DOMException('Stopped by user', 'AbortError')));
    progress.update(0, items.length, t`${stats.terms} keys in ${stats.entries} entries · ${connection.label}`);

    const translator = new Translator({
        request: createRequestFn(connection, settings),
        lang,
        settings,
        // generateRawData swaps the global response length for the duration of a call,
        // so parallel calls through the current connection would leave the user's setting changed.
        concurrency: connection.kind === 'profile' ? settings.maxConcurrency : 1,
        countTokens: (text) => ctx.getTokenCountAsync(text),
        signal: controller.signal,
        onProgress: (done, total) => progress.update(done, total, t`${done} of ${total} entries done`),
        batchTimeoutMs: settings.requestTimeout * 1000,
    });
    try {
        await translator.translate(items.map(item => toPromptItem(item)));
    } finally {
        await progress.close();
    }

    const stopped = controller.signal.aborted;
    const { proposals, warnings } = buildProposals(items, translator.results, settings, lang, parseRegexFromString);
    const itemsById = new Map(items.map(item => [item.id, item]));
    const failures = translator.failures.map(({ id, reason }) => {
        const item = itemsById.get(id);
        return { book: item?.book, title: item?.title || item?.terms.join(', '), reason };
    });
    const allWarnings = [...translator.warnings, ...warnings];
    if (allWarnings.length || failures.length) {
        console.warn(`[${EXTENSION_TITLE}]`, { warnings: allWarnings, failures });
    }

    if (!proposals.length) {
        toastr.warning(stopped
            ? t`Stopped before any translation was received.`
            : t`The model returned no usable translations. Details are in the browser console.`, EXTENSION_TITLE);
        return;
    }

    const accepted = await showPreview({ proposals, warnings: allWarnings, failures, stopped });
    if (!accepted?.length) return;

    const report = await applyChanges(accepted, settings, lang);
    toastr.success(t`Added ${report.keys} keys to ${report.entries} entries in ${report.books} lorebooks.`, EXTENSION_TITLE);
    if (report.missingEntries) {
        toastr.warning(t`${report.missingEntries} entries were deleted in the meantime and skipped.`, EXTENSION_TITLE);
    }
}

/**
 * @param {string[]} books
 */
async function removeKeys(books) {
    const lang = resolveLanguage(getSettings());
    const confirmed = await confirmRemoval(books.length, lang);
    if (!confirmed) return;
    const report = await removeAddedKeys(books, confirmed.allLanguages ? null : lang.id);
    toastr.success(t`Removed ${report.keys} keys from ${report.entries} entries in ${report.books} lorebooks.`, EXTENSION_TITLE);
}

function init() {
    getSettings();
    addWorldInfoButton(onOpen);
    addSettingsPanel(onOpen);
    addLbcSettings($('.lorebook-localizer-settings .inline-drawer-content'));
    startLbcModule();
}

// The API for other extensions (Maestro); the regex helpers work without SillyTavern being ready.
installApi(createHeadless({
    context: () => SillyTavern.getContext(),
    getSettings,
    resolveConnection,
    createRequestFn,
    collectItems,
    applyChanges,
    parse: parseRegexFromString,
    exclusive,
    warn: (...args) => console.warn(`[${EXTENSION_TITLE}]`, ...args),
}));

jQuery(() => {
    // The World Info markup is static, so the button can be added right away; APP_READY covers late layouts.
    init();
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.APP_READY, init);
});
