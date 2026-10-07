// Russian keys for the entries in LoreBook Creator's editor, before they are saved: Lorebook Localizer's own pipeline
// (the model lists every word form, regex keys are built and checked, the user reviews them) runs on World Info copies
// of the editor entries. The added keys go back into the editor; the copies, with Localizer's marker, become the
// entries' originals for lossless saving, so the keys and the marker reach the saved book.
import { EXTENSION_TITLE, MARKER_KEY, resolveLanguage } from '../constants.js';
import { createRequestFn, resolveConnection } from '../connection.js';
import { applyToEntry, buildProposals, collectEntryTerms, contextExcerpt, toPromptItem } from '../entries.js';
import { getSettings, t } from '../settings.js';
import { newWorldInfoEntryTemplate, parseRegexFromString } from '../st.js';
import { Translator } from '../translator.js';
import { ProgressDialog, showPreview } from '../ui.js';
import { toWorldInfoEntry } from './book.js';
import { entryLinks } from './links.js';

/**
 * Localizer's target language for LBC. Keys already written in that script are sent too: LBC's own Russian keys
 * ("Ирина") need their other forms as much as the English ones need a translation.
 */
export function lbcKeysLanguage(settings = getSettings()) {
    return { ...resolveLanguage(settings), scriptRe: null };
}

/**
 * World Info copies of editor entries and the terms Localizer would translate in each.
 * @param {any[]} entries LBC editor entries
 * @param {number[]} indices which of them
 */
export function collectEditorItems(entries, indices, settings = getSettings(), lang = lbcKeysLanguage(settings), book = 'LoreBook Creator') {
    const copies = new Map();
    const items = [];
    for (const index of indices) {
        const entry = entries[index];
        if (!entry) continue;
        const copy = toWorldInfoEntry(entry, entryLinks.get(entry), newWorldInfoEntryTemplate).entry;
        copies.set(index, copy);
        const collected = collectEntryTerms(copy, settings, lang);
        if (!collected?.terms.length) continue;
        items.push({
            id: items.length + 1,
            book,
            uid: index,
            title: String(copy.comment ?? '').trim(),
            context: settings.includeContext ? contextExcerpt(copy, settings.contextChars) : '',
            terms: collected.terms,
            fieldsByTerm: collected.fieldsByTerm,
        });
    }
    return { items, copies };
}

/**
 * How many of the editor's entries have keys still without Russian word forms.
 * @param {any[]} entries
 */
export function countEntriesWithoutForms(entries) {
    return collectEditorItems(entries, entries.map((_, index) => index)).items.length;
}

/**
 * Translates the keys of some editor entries and, after the user's review, adds the word-form keys to them.
 * @param {object} options
 * @param {any} options.data LBC's live editor state
 * @param {number[]} options.indices editor entries to localize
 * @param {ReturnType<import('../exclusive.js').createExclusive>} options.exclusive Localizer's one-job-at-a-time lock
 * @returns {Promise<{entries: number, keys: number}|null>} null when nothing was done (nothing to do, stopped, cancelled)
 */
export async function localizeEditorEntries({ data, indices, exclusive }) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();
    const lang = lbcKeysLanguage(settings);
    const connection = resolveConnection(settings);
    if (connection.kind === 'error') {
        toastr.error(t`The connection profile cannot be used: ${connection.message}`, EXTENSION_TITLE);
        return null;
    }
    if (connection.kind === 'current' && ctx.onlineStatus === 'no_connection') {
        toastr.error(t`No API connection. Connect to an API or choose a connection profile.`, EXTENSION_TITLE);
        return null;
    }
    const book = String(data.worldName || '').trim() || 'LoreBook Creator';
    const entries = [...data.entries];
    const { items, copies } = collectEditorItems(entries, indices, settings, lang, book);
    if (!items.length) {
        toastr.info(t`Nothing to translate: the keys are already localized, are regexes or are already in ${lang.name}.`, EXTENSION_TITLE);
        return null;
    }
    const terms = items.reduce((sum, item) => sum + item.terms.length, 0);

    return exclusive.run(async () => {
        const controller = new AbortController();
        const progress = new ProgressDialog(t`Translating keys to ${lang.name}…`, () => controller.abort(new DOMException('Stopped by user', 'AbortError')));
        progress.update(0, items.length, t`${terms} keys in ${items.length} entries · ${connection.label}`);
        const translator = new Translator({
            request: createRequestFn(connection, settings),
            lang,
            settings,
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
        if (allWarnings.length || failures.length) console.warn(`[${EXTENSION_TITLE}] LBC keys`, { warnings: allWarnings, failures });
        if (!proposals.length) {
            toastr.warning(stopped
                ? t`Stopped before any translation was received.`
                : t`The model returned no usable translations. Details are in the browser console.`, EXTENSION_TITLE);
            return null;
        }
        const accepted = await showPreview({ proposals, warnings: allWarnings, failures, stopped });
        if (!accepted?.length) return null;

        let keys = 0;
        let changed = 0;
        const byIndex = new Map();
        for (const proposal of accepted) {
            if (!byIndex.has(proposal.uid)) byIndex.set(proposal.uid, []);
            byIndex.get(proposal.uid).push(proposal);
        }
        for (const [index, entryProposals] of byIndex) {
            const entry = entries[index];
            const copy = copies.get(index);
            // The entry may have been deleted or replaced while the model worked.
            if (!entry || !copy || data.entries[index] !== entry) continue;
            const added = applyToEntry(copy, entryProposals, lang, { force: settings.force });
            if (!added) continue;
            entry.key = [...copy.key];
            entry.keysecondary = [...copy.keysecondary];
            const link = entryLinks.get(entry);
            if (link?.raw) {
                // The original stays the load-time snapshot (saving compares against it); the marker travels apart.
                entryLinks.set(entry, { ...link, marker: copy.extensions?.[MARKER_KEY] });
            } else {
                delete copy.uid;
                entryLinks.set(entry, { raw: copy, source: 'lbc:editor' });
            }
            keys += added;
            changed++;
        }
        return { entries: changed, keys };
    }, { by: 'dialog' });
}
