import { applyToEntry, collectEntryTerms, contextExcerpt, KEY_FIELDS, removeFromEntry } from './entries.js';
import { isProtectedBookData } from './protected.js';
import { download, setWIOriginalDataValue } from './st.js';

export { toPromptItem } from './entries.js';

/** Name of the lorebook currently open in the World Info editor, if any. */
export function getOpenEditorBook() {
    const index = Number($('#world_editor_select').val());
    const names = SillyTavern.getContext().getWorldInfoNames();
    return Number.isInteger(index) && index >= 0 ? names[index] ?? null : null;
}

function findEntry(data, uid) {
    const direct = data.entries[uid];
    if (direct && direct.uid == uid) return direct;
    return Object.values(data.entries).find(entry => entry.uid == uid) ?? null;
}

/** Books imported from character cards keep a copy of the card data that the editor mirrors key edits into. */
function mirrorKeysToOriginalData(data, entry) {
    for (const { field, original } of KEY_FIELDS) {
        setWIOriginalDataValue(data, entry.uid, original, [...(entry[field] ?? [])]);
    }
}

/**
 * BunnyMo's book or one of its packs (see protected.js): never localized by default.
 * @param {string} book
 */
export async function isProtectedBook(book) {
    const data = await SillyTavern.getContext().loadWorldInfo(book);
    return isProtectedBookData(data);
}

/**
 * Gathers the entries (and their keys) that need translation.
 * @param {string[]} bookNames
 * @param {{uids?: Set<number>|null, skipProtected?: boolean}} [options] `uids`: only these entries;
 *        `skipProtected`: leave BunnyMo books and packs out (listed in `stats.protectedBooks`)
 */
export async function collectItems(bookNames, settings, lang, { uids = null, skipProtected = false } = {}) {
    const ctx = SillyTavern.getContext();
    const items = [];
    const stats = { books: 0, entries: 0, terms: 0, skippedRegex: 0, skippedScript: 0, skippedDone: 0, missingBooks: [], protectedBooks: [] };
    let nextId = 1;

    for (const book of bookNames) {
        const data = await ctx.loadWorldInfo(book);
        if (!data?.entries) {
            stats.missingBooks.push(book);
            continue;
        }
        if (skipProtected && isProtectedBookData(data)) {
            stats.protectedBooks.push(book);
            continue;
        }
        stats.books++;
        for (const entry of Object.values(data.entries)) {
            if (uids && !uids.has(Number(entry.uid))) continue;
            const collected = collectEntryTerms(entry, settings, lang);
            if (!collected) continue;
            stats.skippedRegex += collected.skipped.regex;
            stats.skippedScript += collected.skipped.script;
            stats.skippedDone += collected.skipped.done;
            if (!collected.terms.length) continue;
            stats.entries++;
            stats.terms += collected.terms.length;
            items.push({
                id: nextId++,
                book,
                uid: entry.uid,
                title: String(entry.comment ?? '').trim(),
                context: settings.includeContext ? contextExcerpt(entry, settings.contextChars) : '',
                terms: collected.terms,
                fieldsByTerm: collected.fieldsByTerm,
            });
        }
    }
    return { items, stats };
}

/** Date and time for backup names: `2026-10-07 14-05`. */
export function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

/**
 * Saves a copy of a book before it is changed: a new book (`copy`) or a downloaded JSON (`download`).
 * @param {string} book
 * @param {any} data
 * @param {'download'|'copy'|'none'} mode
 * @param {string} stamp
 * @param {{backups: string[]}} report receives the backup's name
 */
export async function backupBook(book, data, mode, stamp, report) {
    if (mode === 'none') return;
    const ctx = SillyTavern.getContext();
    const snapshot = structuredClone(data);
    const baseName = `${book} (backup ${stamp})`;
    if (mode === 'copy') {
        const names = ctx.getWorldInfoNames();
        let name = baseName;
        for (let i = 2; names.includes(name); i++) name = `${baseName} ${i}`;
        await ctx.saveWorldInfo(name, snapshot, true);
        report.backups.push(name);
    } else {
        download(JSON.stringify(snapshot, null, 4), `${baseName}.json`, 'application/json');
        report.backups.push(`${baseName}.json`);
    }
}

function groupBy(list, key) {
    const map = new Map();
    for (const item of list) {
        const value = item[key];
        if (!map.has(value)) map.set(value, []);
        map.get(value).push(item);
    }
    return map;
}

/**
 * Writes accepted proposals into their lorebooks.
 * Each book is re-loaded right before writing, so edits made while the model was working are kept.
 * @param {{book: string, uid: number, source: string, fields: string[], keys: string[]}[]} accepted
 */
export async function applyChanges(accepted, settings, lang) {
    const ctx = SillyTavern.getContext();
    const report = { books: 0, entries: 0, keys: 0, missingEntries: 0, missingBooks: [], backups: [] };
    const stamp = timestamp();

    for (const [book, proposals] of groupBy(accepted, 'book')) {
        const data = await ctx.loadWorldInfo(book);
        if (!data?.entries) {
            report.missingBooks.push(book);
            continue;
        }
        await backupBook(book, data, settings.backupMode, stamp, report);

        for (const [uid, entryProposals] of groupBy(proposals, 'uid')) {
            const entry = findEntry(data, uid);
            if (!entry) {
                report.missingEntries++;
                continue;
            }
            const added = applyToEntry(entry, entryProposals, lang, { force: settings.force });
            mirrorKeysToOriginalData(data, entry);
            if (added) {
                report.entries++;
                report.keys += added;
            }
        }

        // `immediately` matters: the debounced save keeps only the last call, so a batch would lose books.
        await ctx.saveWorldInfo(book, data, true);
        report.books++;
        ctx.reloadWorldInfoEditor(book);
    }

    if (settings.backupMode === 'copy' && report.backups.length) {
        await ctx.updateWorldInfoList();
    }
    return report;
}

/**
 * Removes keys added by the extension.
 * @param {string[]} bookNames
 * @param {string|null} langId Language id, or null for all languages.
 */
export async function removeAddedKeys(bookNames, langId) {
    const ctx = SillyTavern.getContext();
    const report = { books: 0, entries: 0, keys: 0 };

    for (const book of bookNames) {
        const data = await ctx.loadWorldInfo(book);
        if (!data?.entries) continue;
        let changed = false;
        for (const entry of Object.values(data.entries)) {
            const removed = removeFromEntry(entry, langId);
            if (removed === null) continue;
            changed = true;
            mirrorKeysToOriginalData(data, entry);
            if (removed) {
                report.entries++;
                report.keys += removed;
            }
        }
        if (changed) {
            await ctx.saveWorldInfo(book, data, true);
            report.books++;
            ctx.reloadWorldInfoEditor(book);
        }
    }
    return report;
}
