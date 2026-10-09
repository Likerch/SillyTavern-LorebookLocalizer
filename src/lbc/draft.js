// LoreBook Creator keeps its whole editor in memory: a page reload loses the work. This part stores the editor (and
// where each entry came from, so lossless saving still works) in the browser's IndexedDB and puts it back after a
// reload, while LBC's editor is still empty.
import { EXTENSION_TITLE } from '../constants.js';
import { t } from '../settings.js';
import { isLbcPanelOpen, LBC_DRAFT_FIELDS } from './adapter.js';
import { entryLinks } from './links.js';

const STORE_KEY = 'lbc-draft';
const SAVE_EVERY_MS = 5000;
const DRAFT_VERSION = 1;

/** @returns {any} a localforage instance of the extension, or null when the page has no localforage */
export function openLbcStore() {
    const localforage = /** @type {any} */ (globalThis).localforage;
    return localforage?.createInstance ? localforage.createInstance({ name: 'LorebookLocalizer', storeName: 'lbc' }) : null;
}

/**
 * The editor state to store, or null when there is nothing worth keeping.
 * @param {any} data LBC's live editor state
 */
export function snapshotDraft(data, linkOf = (entry) => entryLinks.get(entry)) {
    const entries = Array.isArray(data.entries) ? [...data.entries] : [];
    const hasWork = entries.length > 0 || String(data.simpleIdea ?? '').trim() || String(data.worldName ?? '').trim();
    if (!hasWork) return null;
    const fields = {};
    for (const field of LBC_DRAFT_FIELDS) {
        if (field === 'entries') continue;
        if (data[field] !== undefined) fields[field] = data[field];
    }
    return {
        version: DRAFT_VERSION,
        savedAt: Date.now(),
        fields: JSON.parse(JSON.stringify(fields)),
        // LBC's own machine translation keeps the original text in _orig*: store the original.
        entries: entries.map((entry) => {
            const { _origContent, _origComment, ...rest } = entry;
            return JSON.parse(JSON.stringify({ ...rest, content: _origContent ?? rest.content, comment: _origComment ?? rest.comment }));
        }),
        links: entries.map(entry => linkOf(entry) ?? null),
    };
}

/**
 * Whether LBC's editor is untouched (fresh page): only then a draft is put back.
 * @param {any} data
 */
export function isEditorEmpty(data) {
    return !(data.entries?.length) && !String(data.simpleIdea ?? '').trim() && !String(data.worldName ?? '').trim();
}

/** @type {import('./module.js').LbcPart} */
export const draftPart = {
    id: 'draft',
    setting: 'lbcDraft',
    needsDom: false,
    start(scope, env) {
        const api = env.api();
        const data = api?.getData();
        const store = openLbcStore();
        if (!data || !store) {
            env.log('draft: no editor data or no IndexedDB, drafts are off');
            return;
        }
        let lastJson = '';

        async function restore() {
            const draft = await store.getItem(STORE_KEY);
            if (!draft || draft.version !== DRAFT_VERSION || scope.closed || !isEditorEmpty(data)) return;
            Object.assign(data, draft.fields);
            data.entries = draft.entries;
            // `entries` may be a getter now (the saving part): read the list back before linking.
            data.entries.forEach((entry, index) => {
                const link = draft.links?.[index];
                if (link) entryLinks.set(entry, link);
            });
            if (isLbcPanelOpen()) api.open();
            toastr.info(t`LoreBook Creator: the unsaved work was restored (${draft.entries.length} entries).`, EXTENSION_TITLE);
            env.log('draft restored', draft.entries.length, 'entries');
        }

        async function save() {
            const draft = snapshotDraft(data);
            // Links change on their own too (a save, a finished match after a load): they count as a change.
            const json = draft ? JSON.stringify({ ...draft, savedAt: 0 }) : '';
            if (json === lastJson) return;
            lastJson = json;
            if (draft) await store.setItem(STORE_KEY, draft);
            else await store.removeItem(STORE_KEY);
        }

        const saveSafely = () => {
            save().catch(error => console.warn(`[${EXTENSION_TITLE}] LBC: the draft was not saved`, error));
        };

        // Restore first, then start saving, so an empty fresh editor never overwrites the stored draft.
        restore()
            .catch(error => console.warn(`[${EXTENSION_TITLE}] LBC: the draft was not restored`, error))
            .finally(() => {
                if (scope.closed) return;
                const timer = setInterval(saveSafely, SAVE_EVERY_MS);
                scope.add(() => clearInterval(timer));
                const onHide = () => { if (document.visibilityState === 'hidden') saveSafely(); };
                window.addEventListener('pagehide', saveSafely);
                document.addEventListener('visibilitychange', onHide);
                scope.add(() => {
                    window.removeEventListener('pagehide', saveSafely);
                    document.removeEventListener('visibilitychange', onHide);
                });
            });
    },
};
