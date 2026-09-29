import { applyToEntry, collectEntryTerms, contextExcerpt, KEY_FIELDS, removeFromEntry } from './entries.js';
import { download, setWIOriginalDataValue } from './st.js';

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
 * Gathers the entries (and their keys) that need translation.
 * @param {string[]} bookNames
 */
export async function collectItems(bookNames, settings, lang) {
    const ctx = SillyTavern.getContext();
    const items = [];
    const stats = { books: 0, entries: 0, terms: 0, skippedRegex: 0, skippedScript: 0, skippedDone: 0, missingBooks: [] };
    let nextId = 1;

    for (const book of bookNames) {
        const data = await ctx.loadWorldInfo(book);
        if (!data?.entries) {
            stats.missingBooks.push(book);
            continue;
        }
        stats.books++;
        for (const entry of Object.values(data.entries)) {
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

/** The part of an item that is sent to the model. */
export function toPromptItem(item) {
    const promptItem = { id: item.id, book: item.book };
    if (item.title) promptItem.title = item.title;
    if (item.context) promptItem.context = item.context;
    promptItem.terms = item.terms;
    return promptItem;
}

function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

async function backupBook(book, data, mode, stamp, report) {
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
