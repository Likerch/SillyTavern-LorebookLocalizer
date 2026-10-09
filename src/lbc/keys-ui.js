// Russian keys in LoreBook Creator's window: a button for all entries next to Audit/Optimize, one in the entry editor,
// a "Russian keys" section in LBC's optimizer window, and the question before saving to SillyTavern.
import { EXTENSION_TITLE } from '../constants.js';
import { getSettings, t } from '../settings.js';
import { isLbcPanelOpen, LBC } from './adapter.js';
import { auditRussianKeys, entriesNeedingForms } from './audit-ru.js';
import { countEntriesWithoutForms, localizeEditorEntries } from './keys.js';

const ALL_BUTTON = 'lbl-lbc-keys-all';
const ENTRY_BUTTON = 'lbl-lbc-keys-entry';
const AUDIT_SECTION = 'lbl-lbc-audit';
const ADD = 1;
const SKIP = 2;

/**
 * Runs the localization and refreshes LBC's window.
 * @param {any} api LBC's public object
 * @param {number[]} indices
 * @param {any} exclusive
 * @param {{review?: boolean}} [options]
 */
async function localizeAndRefresh(api, indices, exclusive, { review = true } = {}) {
    const data = api.getData();
    const result = await localizeEditorEntries({ data, indices, exclusive, review });
    if (!result) return null;
    toastr.success(t`Russian word forms added: ${result.keys} keys in ${result.entries} entries.`, EXTENSION_TITLE);
    if (isLbcPanelOpen()) api.open();
    return result;
}

/**
 * Before saving to SillyTavern: offers (or, by the setting, runs) Russian word forms for entries that lack them.
 * @param {any} api
 * @param {any} exclusive
 * @param {{indices?: number[], cancellable?: boolean, quiet?: boolean}} [options] `indices`: only these editor entries
 *   (default: all); `cancellable: false`: the question has no Cancel, declining saves without the forms; `quiet`: no
 *   question and no review — the forms are added as the model gives them (the world expansion: «одной кнопкой» means one)
 * @returns {Promise<boolean>} false: the user cancelled the save
 */
export async function russianKeysBeforeSave(api, exclusive, { indices, cancellable = true, quiet = false } = {}) {
    const settings = getSettings();
    if (!settings.lbcKeys || settings.lbcKeysOnSave === 'never' || !exclusive) return true;
    const data = api.getData();
    const chosen = indices ?? data.entries.map((_, index) => index);
    if (!chosen.length) return true;
    const missing = countEntriesWithoutForms([...data.entries], chosen);
    if (!missing) return true;
    let choice = ADD;
    if (settings.lbcKeysOnSave !== 'always' && !quiet) {
        const ctx = SillyTavern.getContext();
        const content = $('<div>').append(
            $('<h3>').text(t`Add Russian word forms first?`),
            $('<div>').text(t`${missing} entries have keys without Russian word forms: in a Russian roleplay they fire on one form only, or not at all. The model lists every form, you review them, then the book is saved.`),
        );
        const popup = new ctx.Popup(content, ctx.POPUP_TYPE.CONFIRM, '', cancellable
            ? { okButton: t`Add and save`, cancelButton: t`Cancel`, customButtons: [{ text: t`Save without them`, result: SKIP }] }
            : { okButton: t`Add and save`, cancelButton: t`Save without them` });
        const result = await popup.show();
        if (result === ctx.POPUP_RESULT.AFFIRMATIVE) choice = ADD;
        else if (result === SKIP || !cancellable) choice = SKIP;
        else return false;
    }
    if (choice === ADD) await localizeAndRefresh(api, chosen, exclusive, { review: !quiet });
    return true;
}

/**
 * @param {import('./audit-ru.js').RuKeyIssue} issue
 * @param {any[]} entries
 */
function describeIssue(issue, entries) {
    const title = (index) => String(entries[index]?.comment || '?');
    const n = issue.idx + 1;
    switch (issue.type) {
        case 'no_russian': return t`#${n} «${title(issue.idx)}»: no Russian keys — in a Russian roleplay it will not fire.`;
        case 'single_form': return t`#${n} «${title(issue.idx)}»: the key «${issue.key}» catches this one form (and matches inside longer words); the other cases are missing.`;
        case 'generic_ru': return t`#${n} «${title(issue.idx)}»: «${issue.key}» is a common word — it will fire in ordinary prose.`;
        case 'forms_collision': return t`#${n} «${title(issue.idx)}»: the key «${issue.key}» also fires #${(issue.other ?? 0) + 1} «${title(issue.other ?? 0)}» through its word forms.`;
        default: return '';
    }
}

/** @type {import('./module.js').LbcPart} */
export const keysPart = {
    id: 'keys',
    setting: 'lbcKeys',
    needsDom: true,
    start(scope, env) {
        const api = env.api();
        const exclusive = env.deps?.exclusive;
        if (!api || !exclusive) {
            env.log('keys: no LBC API or no job lock, Russian keys are off');
            return;
        }
        let busy = false;
        const run = async (indices, button) => {
            if (busy || !indices.length) return;
            busy = true;
            $(button).prop('disabled', true);
            try {
                await localizeAndRefresh(api, indices, exclusive);
            } catch (error) {
                console.error(`[${EXTENSION_TITLE}] LBC keys failed`, error);
                toastr.error(String(error?.message ?? error), EXTENSION_TITLE);
            } finally {
                busy = false;
                $(button).prop('disabled', false);
            }
        };

        /** Puts our buttons into whatever LBC just rendered. */
        const decorate = () => {
            const toolbarAnchor = $('#lbc-body .lbc-optimize-btn').first();
            if (toolbarAnchor.length && !toolbarAnchor.siblings(`.${ALL_BUTTON}`).length) {
                $('<button>', { class: `menu_button ${ALL_BUTTON}`, title: t`Translate the keys of all entries and add every Russian word form (Lorebook Localizer).` })
                    .attr('style', toolbarAnchor.attr('style') ?? '')
                    .append($('<i class="fa-solid fa-language"></i>'), document.createTextNode(` ${t`Russian keys`}`))
                    .insertAfter(toolbarAnchor);
            }
            const saveButton = $('#lbc-editor-save');
            if (saveButton.length && !saveButton.siblings(`.${ENTRY_BUTTON}`).length) {
                $('<button>', { class: `menu_button ${ENTRY_BUTTON}`, title: t`Translate this entry's keys and add every Russian word form (Lorebook Localizer).` })
                    .append($('<i class="fa-solid fa-language"></i>'), document.createTextNode(` ${t`Russian keys`}`))
                    .insertBefore(saveButton);
            }
            const modal = $(LBC.selectors.optimizerModal);
            if (modal.length && !modal.find(`.${AUDIT_SECTION}`).length) addAuditSection(modal);
        };

        /** @param {JQuery} modal LBC's optimizer window */
        const addAuditSection = (modal) => {
            const entries = [...api.getData().entries];
            const issues = auditRussianKeys(entries);
            const section = $(`<div class="${AUDIT_SECTION}">`);
            section.append($('<div class="lbc-opt-section">').text(t`Russian keys`));
            const list = $('<div class="lbc-opt-issues">');
            for (const issue of issues.slice(0, 60)) list.append($('<div>', { class: `lbc-opt-issue lbc-sev-${issue.sev}` }).text(describeIssue(issue, entries)));
            if (!issues.length) list.append($('<div style="opacity:.5;padding:8px">').text(t`Russian keys are fine: every entry has Russian word forms.`));
            section.append(list);
            const fixable = entriesNeedingForms(issues);
            if (fixable.length) {
                const button = $('<button class="menu_button">')
                    .append($('<i class="fa-solid fa-language"></i>'), document.createTextNode(` ${t`Add Russian word forms (${fixable.length})`}`))
                    .on('click', () => run(fixable, button));
                section.append(button);
            }
            const foot = modal.find('.lbc-opt-foot');
            if (foot.length) section.insertBefore(foot);
            else modal.append(section);
        };

        const onClick = (event) => {
            const target = /** @type {Element} */ (event.target);
            const all = target?.closest?.(`.${ALL_BUTTON}`);
            const one = all ? null : target?.closest?.(`.${ENTRY_BUTTON}`);
            if (!all && !one) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const data = api.getData();
            if (all) {
                void run(data.entries.map((_, index) => index), all);
                return;
            }
            const index = Number(data.editingEntryIdx);
            const entry = data.entries[index];
            if (!entry) return;
            // The editor's fields may hold unsaved edits: take them, the way LBC's own Save does.
            const comment = $('#lbc-ed-comment').val();
            if (typeof comment === 'string') entry.comment = comment;
            for (const [selector, field] of [['#lbc-ed-keys', 'key'], ['#lbc-ed-keys2', 'keysecondary']]) {
                const value = $(selector).val();
                if (typeof value === 'string') entry[field] = value.split(',').map(key => key.trim()).filter(Boolean);
            }
            const content = $('#lbc-ed-content').val();
            if (typeof content === 'string') entry.content = content;
            void run([index], one);
        };
        document.addEventListener('click', onClick, true);
        scope.add(() => document.removeEventListener('click', onClick, true));

        // LBC re-renders its panel body on every action and adds its windows straight to <body>.
        const observer = new MutationObserver(decorate);
        const panel = document.querySelector(LBC.selectors.panel);
        if (panel) observer.observe(panel, { childList: true, subtree: true });
        observer.observe(document.body, { childList: true });
        scope.add(() => observer.disconnect());
        decorate();
        scope.add(() => $(`.${ALL_BUTTON}, .${ENTRY_BUTTON}, .${AUDIT_SECTION}`).remove());
    },
};
