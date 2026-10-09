// Lossless saving. LBC's "Import to ST" uploads a rebuilt file under a name with every character outside [a-zA-Z0-9_-]
// replaced by "_" ("Мир Тьмы" becomes "________", a book reopened from SillyTavern lands next to itself as a copy), with
// no backup and no refresh of SillyTavern's book list, and its export drops most of each entry (see book.js).
// This part remembers the original of every entry LBC loads, takes over "Import to ST" and "Download JSON", and
// saves through SillyTavern itself under the real name.
import { EXTENSION_TITLE } from '../constants.js';
import { backupBook, isProtectedBook, timestamp } from '../lorebook.js';
import { getSettings, t } from '../settings.js';
import { download, newWorldInfoEntryTemplate } from '../st.js';
import { LBC, lbcRawEntryList, showLbcStatus } from './adapter.js';
import { buildBook, freeBookName, pairLoadedEntries, sanitizeBookName } from './book.js';
import { russianKeysBeforeSave } from './keys-ui.js';
import { entryLinks as links } from './links.js';

const OVERWRITE = 1;
const COPY = 2;
const PENDING_FILE_MS = 10_000;

/**
 * @typedef {object} SaveOptions
 * @property {'full'|'patch'} [mode] `full` replaces the book's entries with the editor's (LBC's "Import to ST");
 *   `patch` keeps the book's entries the editor does not hold (see buildBook)
 * @property {boolean} [backup] back the book up first, as set in Lorebook Localizer (an empty book never is)
 * @property {any[]} [russianKeysFor] offer Russian word forms for these editor entries first, as set in "word forms
 *   before saving to ST"; declining saves without them
 *
 * @typedef {object} SaveResult
 * @property {string} target
 * @property {number} entries editor entries written
 * @property {{kept: number, updated: number, added: number}} stats
 * @property {string[]} backups
 */

/** @type {((target: string, options?: SaveOptions) => Promise<SaveResult>)|null} The running part's writer. */
let writer = null;

/** Whether lossless saving runs: writing the editor into a book needs it (it knows where every entry came from). */
export function isLosslessSavingOn() {
    return writer !== null;
}

/**
 * Writes LBC's editor into a SillyTavern lorebook without asking: a book that exists is written over (in `patch`
 * mode, only the editor's entries change). The editor holds that book afterwards.
 * @param {string} target the book name
 * @param {SaveOptions} [options]
 * @returns {Promise<SaveResult>}
 */
export function saveEditorToBook(target, options = {}) {
    if (!writer) return Promise.reject(new Error(t`Lossless saving is off: turn it on in the LoreBook Creator section of Lorebook Localizer to write into books.`));
    return writer(target, options);
}

/** @type {import('./module.js').LbcPart} */
export const savingPart = {
    id: 'saving',
    setting: 'lbcSaving',
    needsDom: true,
    start(scope, env) {
        const ctx = SillyTavern.getContext();
        const lbc = env.api();
        const data = lbc?.getData();
        if (!data || !Array.isArray(data.entries)) {
            console.warn(`[${EXTENSION_TITLE}] LBC: no editor data, lossless saving is off`);
            return;
        }

        /**
         * The file picked in "Load LoreBook", read by us too. It waits for the list LBC builds from it and is dropped
         * once used, or after PENDING_FILE_MS (the pick was cancelled or LBC rejected the file).
         * @type {{read: Promise<{name: string, json: any}|null>, at: number}|null}
         */
        let pendingFile = null;
        let busy = false;

        // --- Remembering where entries came from -------------------------------------------------------------------

        /** @type {WeakMap<object, any[]>} proxy → array */
        const targets = new WeakMap();
        /**
         * LBC regenerates an entry by putting a new object at its index; the new object inherits the old one's link.
         * Objects moved around by splice are already in the list and keep their own links.
         * @param {unknown} list
         */
        const track = (list) => {
            if (!Array.isArray(list) || targets.has(list)) return list;
            const proxy = new Proxy(list, {
                set(target, property, value) {
                    if (typeof property === 'string' && /^\d+$/.test(property)) {
                        const old = target[Number(property)];
                        if (old && value && old !== value && typeof value === 'object' && links.has(old)
                            && !links.has(value) && !target.includes(value)) {
                            links.set(value, links.get(old));
                        }
                    }
                    target[property] = value;
                    return true;
                },
            });
            targets.set(proxy, list);
            return proxy;
        };

        let current = track(data.entries);
        Object.defineProperty(data, 'entries', {
            configurable: true,
            enumerable: true,
            get: () => current,
            set: (value) => {
                current = track(value);
                // LBC sets the book's name right after the list (openWorld, file load), so look a tick later.
                queueMicrotask(() => { void linkLoaded(current); });
            },
        });
        scope.add(() => {
            const plain = targets.get(current) ?? current;
            delete data.entries;
            data.entries = plain;
        });

        /** @param {any[]} list */
        async function linkLoaded(list) {
            try {
                const pending = pendingFile;
                if (pending) {
                    const file = await pending.read;
                    const linked = Boolean(file) && link(list, lbcRawEntryList(file.json), `file:${file.name}`);
                    if (pendingFile === pending && (linked || !file || Date.now() - pending.at > PENDING_FILE_MS)) pendingFile = null;
                    if (linked) return;
                }
                const book = data._loadedWorld;
                if (book && ctx.getWorldInfoNames().includes(book)) {
                    link(list, lbcRawEntryList(await ctx.loadWorldInfo(book)), `st:${book}`);
                }
            } catch (error) {
                console.warn(`[${EXTENSION_TITLE}] LBC: could not match loaded entries`, error);
            }
        }

        /**
         * @param {any[]} list
         * @param {any[]} rawList
         * @param {string} source
         */
        function link(list, rawList, source) {
            const pairs = pairLoadedEntries(list, rawList, entry => links.has(entry));
            for (const { entry, raw } of pairs) links.set(entry, { raw: structuredClone(raw), source });
            if (pairs.length) env.log('linked', pairs.length, 'of', rawList.length, 'entries to', source);
            return pairs.length > 0;
        }

        // LBC reads the picked file in its own jQuery handler; ours runs first (capture) and keeps the full JSON.
        const onChange = (event) => {
            const input = /** @type {HTMLInputElement} */ (event.target);
            if (!input?.matches?.(LBC.selectors.loadBookInput)) return;
            const file = input.files?.[0];
            pendingFile = file
                ? { read: file.text().then(text => ({ name: file.name, json: JSON.parse(text) })).catch(() => null), at: Date.now() }
                : null;
        };
        document.addEventListener('change', onChange, true);
        scope.add(() => document.removeEventListener('change', onChange, true));

        // --- Taking over the buttons ---------------------------------------------------------------------------------

        const onClick = (event) => {
            const target = /** @type {Element} */ (event.target);
            const save = target?.closest?.(LBC.selectors.importButtons);
            const exportJson = save ? null : target?.closest?.(LBC.selectors.downloadButton);
            if (!save && !exportJson) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (busy) return;
            busy = true;
            const button = $(save ?? exportJson).prop('disabled', true);
            (save ? saveToSillyTavern() : downloadJson())
                .catch((error) => {
                    console.error(`[${EXTENSION_TITLE}] LBC save failed`, error);
                    showLbcStatus(String(error?.message ?? error), 'error');
                    toastr.error(String(error?.message ?? error), EXTENSION_TITLE);
                })
                .finally(() => {
                    busy = false;
                    button.prop('disabled', false);
                });
        };
        document.addEventListener('click', onClick, true);
        scope.add(() => document.removeEventListener('click', onClick, true));

        /**
         * The book name from the editor, cleaned the way SillyTavern's server cleans file names. LBC itself prefers
         * `_origWorldName`, which it keeps for its machine translation and never resets when a file is loaded.
         */
        const wantedName = () => {
            const name = data._translated ? (data._origWorldName || data.worldName) : (data.worldName || data._origWorldName);
            return sanitizeBookName(name) || 'New LoreBook';
        };

        async function saveToSillyTavern() {
            if (!current.length) {
                showLbcStatus(t`No entries to save.`, 'error');
                return;
            }
            if (!(await russianKeysBeforeSave(lbc, env.deps.exclusive))) return;
            const names = ctx.getWorldInfoNames();
            let target = wantedName();
            if (names.includes(target)) {
                const choice = await askOverwrite(target, await isProtectedBook(target));
                if (!choice) return;
                if (choice === COPY) target = freeBookName(target, names);
            }

            const { entries, stats, backups } = await writeEditor(target, { mode: 'full', backup: true });
            const message = t`"${target}" saved: ${entries} entries (${stats.kept} unchanged, ${stats.updated} changed, ${stats.added} new).`;
            showLbcStatus(message, 'success');
            toastr.success(backups.length ? `${message} ${t`Backup: ${backups.join(', ')}`}` : message, EXTENSION_TITLE);
        }

        /**
         * @param {string} target
         * @param {SaveOptions} options
         * @returns {Promise<SaveResult>}
         */
        async function writeEditor(target, { mode = 'full', backup = true, russianKeysFor } = {}) {
            if (russianKeysFor?.length) {
                const indices = russianKeysFor.map(entry => current.indexOf(entry)).filter(index => index >= 0);
                await russianKeysBeforeSave(lbc, env.deps.exclusive, { indices, cancellable: false });
            }
            const entries = [...current];
            const names = ctx.getWorldInfoNames();
            const existing = names.includes(target) ? await ctx.loadWorldInfo(target) : null;
            const report = { backups: [] };
            if (existing && backup && Object.keys(existing.entries ?? {}).length) {
                await backupBook(target, existing, getSettings().backupMode, timestamp(), report);
            }

            const { data: book, uids, stats } = buildBook(entries, entry => links.get(entry), {
                target,
                template: newWorldInfoEntryTemplate,
                existing,
                mode,
            });
            await ctx.saveWorldInfo(target, book, true);
            await ctx.updateWorldInfoList();
            ctx.reloadWorldInfoEditor(target);

            // From now on the editor holds this book: the next save overwrites it with the same uids.
            entries.forEach((entry, index) => links.set(entry, { raw: structuredClone(book.entries[uids[index]]), source: `st:${target}` }));
            data.worldName = target;
            data._origWorldName = target;
            data._loadedWorld = target;
            env.log('saved', target, mode, stats);
            return { target, entries: entries.length, stats, backups: report.backups };
        }

        writer = writeEditor;
        scope.add(() => {
            if (writer === writeEditor) writer = null;
        });

        async function downloadJson() {
            const entries = [...current];
            if (!entries.length) {
                showLbcStatus(t`No entries to save.`, 'error');
                return;
            }
            const name = wantedName();
            const { data: book } = buildBook(entries, entry => links.get(entry), { target: name, template: newWorldInfoEntryTemplate });
            // LBC takes the book name from `_name` when the file is loaded back.
            download(JSON.stringify({ ...book, _name: name }, null, 4), `${name}.json`, 'application/json');
            showLbcStatus(t`"${name}.json" downloaded: ${entries.length} entries.`, 'success');
        }

        /**
         * @param {string} name
         * @param {boolean} isProtected a BunnyMo book or pack: overwriting is not offered
         * @returns {Promise<number|null>} OVERWRITE, COPY or null
         */
        async function askOverwrite(name, isProtected) {
            const content = $('<div>').append(
                $('<h3>').text(t`The lorebook "${name}" already exists`),
                $('<div>').text(isProtected
                    ? t`It is a BunnyMo book or pack: LoreBook Creator does not overwrite those. The entries can be saved as a copy.`
                    : t`Overwrite it with the editor's entries? Entries that are not in the editor are removed from the book. A backup is made as set in Lorebook Localizer.`),
            );
            const popup = new ctx.Popup(content, ctx.POPUP_TYPE.CONFIRM, '', isProtected
                ? { okButton: t`Save as a copy`, cancelButton: t`Cancel` }
                : { okButton: t`Overwrite`, cancelButton: t`Cancel`, customButtons: [{ text: t`Save as a copy`, result: COPY }] });
            const result = await popup.show();
            if (result === ctx.POPUP_RESULT.AFFIRMATIVE) return isProtected ? COPY : OVERWRITE;
            return result === COPY ? COPY : null;
        }
    },
};
