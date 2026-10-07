// Lossless saving of LoreBook Creator's editor into World Info: pure parts, unit-tested in Node. The SillyTavern and DOM
// side is saving.js.
//
// LBC's editor keeps 20 fields of an entry (LBC_ENTRY_FIELDS) and rebuilds the rest on export with fixed values, so a
// book that goes through LBC loses its uids, `extensions` (other extensions' data), roles, filters and triggers, and
// every 0 in depth / order / probability becomes the default. Here an entry the module saw being loaded keeps its
// original as the base: a field the user did not change keeps its original value, a changed one takes LBC's.
import { MARKER_KEY } from '../constants.js';
import { foldForm } from '../regex-builder.js';
import { LBC_ENTRY_FIELDS, lbcEntryText, normalizeLikeLbc } from './adapter.js';

/**
 * @typedef {object} EntryLink where an editor entry came from
 * @property {any} raw a copy of the original World Info entry
 * @property {string} source `st:<book name>` or `file:<file name>`
 */

/**
 * A book name as SillyTavern's server will store it (`sanitize-filename` on `<name>.json`), so the name the module
 * saves under is the name the book list shows afterwards.
 * @param {unknown} name
 */
export function sanitizeBookName(name) {
    return String(name ?? '')
        .replace(/[/?<>\\:*|"]/g, '')
        .replace(/[\x00-\x1f\x80-\x9f]/g, '')
        .replace(/^\.+$/, '')
        .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i, '')
        .trim();
}

/**
 * `<name> (2)`, `<name> (3)`, … — the first one not taken.
 * @param {string} name
 * @param {string[]} taken
 */
export function freeBookName(name, taken) {
    const base = name.replace(/\s*\(\d+\)$/, '');
    for (let index = 2; ; index++) {
        const candidate = `${base} (${index})`;
        if (!taken.includes(candidate)) return candidate;
    }
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameValue(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * LBC's editor value of a field the way LBC's own `exportAsWorldInfo` writes it.
 * @param {string} field one of LBC_ENTRY_FIELDS
 * @param {any} entry an LBC editor entry
 */
export function exportValue(field, entry) {
    switch (field) {
        case 'comment': return lbcEntryText(entry).comment;
        case 'content': return lbcEntryText(entry).content;
        case 'key':
        case 'keysecondary': return Array.isArray(entry[field]) ? entry[field].map(String) : [];
        case 'constant':
        case 'selective':
        case 'disable':
        case 'preventRecursion':
        case 'excludeRecursion': return Boolean(entry[field]);
        case 'selectiveLogic': return entry.selectiveLogic ?? 0;
        case 'order': return entry.order || 100;
        case 'position': return entry.position || 0;
        case 'depth': return entry.depth || 4;
        case 'probability': return entry.probability || 100;
        case 'group': return entry.group || '';
        case 'groupWeight': return entry.groupWeight || 100;
        case 'useGroupScoring': return entry.useGroupScoring === true ? true : null;
        case 'matchWholeWords': return entry.matchWholeWords === true || entry.matchWholeWords === false ? entry.matchWholeWords : null;
        case 'sticky': return entry.sticky || 0;
        case 'cooldown': return entry.cooldown || null;
        default: return entry[field];
    }
}

/**
 * Fields of an editor entry that differ from what LBC showed right after loading `raw`.
 * @param {any} entry
 * @param {any} raw
 * @returns {string[]}
 */
export function changedFields(entry, raw) {
    const loaded = normalizeLikeLbc(raw);
    return LBC_ENTRY_FIELDS.filter((field) => {
        const now = field === 'comment' || field === 'content' ? lbcEntryText(entry)[field] : entry[field];
        return !sameValue(now, loaded[field]);
    });
}

/**
 * Writes LBC's category only when LBC would not get the same one back from the comment on the next load.
 * @param {any} out the World Info entry being built
 * @param {any} entry the LBC editor entry
 * @param {any} [raw]
 */
function applyCategory(out, entry, raw) {
    const category = typeof entry.category === 'string' ? entry.category.trim() : '';
    if (raw && Object.hasOwn(raw, 'category')) {
        out.category = category || raw.category;
        return;
    }
    delete out.category;
    if (category && normalizeLikeLbc(out).category !== category) out.category = category;
}

const KEY_FIELDS = ['key', 'keysecondary'];

/**
 * LBC's Optimize and LLM Edit rewrite an entry's whole key list and may drop the word-form keys Lorebook Localizer
 * added (its marker in `extensions` lists them). While every key they were made from is still there, the dropped ones
 * come back; when a source key is gone (a renamed entity), that language's added keys and its record go, so the next
 * localization translates the new keys from scratch.
 * @param {any} out a World Info entry (changed in place)
 */
export function reconcileLocalizedKeys(out) {
    const marker = out.extensions?.[MARKER_KEY];
    if (!marker?.languages || typeof marker.languages !== 'object') return;
    for (const [id, state] of Object.entries(marker.languages)) {
        const present = new Set(KEY_FIELDS.flatMap(field => (Array.isArray(out[field]) ? out[field] : []).map(key => foldForm(String(key)))));
        const sourcesKept = (state?.sources ?? []).every(source => present.has(foldForm(String(source))));
        for (const field of KEY_FIELDS) {
            const added = Array.isArray(state?.added?.[field]) ? state.added[field] : [];
            if (!Array.isArray(out[field])) out[field] = [];
            if (sourcesKept) {
                const have = new Set(out[field].map(key => String(key).trim().toLowerCase()));
                for (const key of added) if (!have.has(String(key).trim().toLowerCase())) out[field].push(key);
            } else {
                const drop = new Set(added);
                out[field] = out[field].filter(key => !drop.has(key));
            }
        }
        if (!sourcesKept) delete marker.languages[id];
    }
    if (!Object.keys(marker.languages).length) delete out.extensions[MARKER_KEY];
}

/**
 * @param {any} entry an LBC editor entry
 * @param {EntryLink|undefined} link
 * @param {object} template SillyTavern's `newWorldInfoEntryTemplate`
 * @returns {{entry: any, kind: 'kept'|'updated'|'added'}}
 */
export function toWorldInfoEntry(entry, link, template) {
    if (link?.raw) {
        const out = structuredClone(link.raw);
        const changed = changedFields(entry, link.raw);
        for (const field of changed) out[field] = exportValue(field, entry);
        if (changed.includes('key') || changed.includes('keysecondary')) reconcileLocalizedKeys(out);
        // An entry moved to @depth needs a role; LBC writes system there.
        if (out.position === 4 && !Number.isInteger(out.role)) out.role = 0;
        applyCategory(out, entry, link.raw);
        const categoryChanged = !sameValue(out.category, link.raw.category);
        return { entry: out, kind: changed.length || categoryChanged ? 'updated' : 'kept' };
    }

    const out = structuredClone(template);
    for (const field of LBC_ENTRY_FIELDS) out[field] = exportValue(field, entry);
    // LBC's "nothing set" values where SillyTavern's template has its own empty value.
    if (!out.sticky) out.sticky = template.sticky ?? null;
    if (!out.cooldown) out.cooldown = template.cooldown ?? null;
    if (out.useGroupScoring !== true) out.useGroupScoring = template.useGroupScoring ?? null;
    out.role = out.position === 4 ? 0 : (template.role ?? null);
    applyCategory(out, entry);
    return { entry: out, kind: 'added' };
}

/**
 * Builds the World Info data for the editor's entries.
 *
 * Uids: an entry loaded from the target book keeps its uid; an entry from another book or file keeps its uid when it
 * is free in the target (taken = any uid the target has now, so a deleted entry's uid is never reused for something
 * else that other extensions may still refer to); everything else gets a new uid after the largest one.
 *
 * @param {any[]} entries LBC editor entries, in editor order
 * @param {(entry: any) => EntryLink|undefined} linkOf
 * @param {{target: string, template: object, existing?: any}} options `existing`: the target book's current data
 * @returns {{data: {entries: Record<string, any>}, uids: number[], stats: {kept: number, updated: number, added: number}}}
 */
export function buildBook(entries, linkOf, { target, template, existing = null }) {
    const sameSource = `st:${target}`;
    const reserved = new Set(Object.values(existing?.entries ?? {}).map(entry => entry?.uid).filter(Number.isInteger));
    const used = new Set();
    // New uids go after every uid in play, so a new entry never takes the uid a linked entry further down will claim.
    const linkedUids = entries.map(entry => linkOf(entry)?.raw?.uid).filter(Number.isInteger);
    let next = Math.max(-1, ...reserved, ...linkedUids) + 1;
    const fresh = () => {
        while (reserved.has(next) || used.has(next)) next++;
        return next++;
    };

    const base = existing ? structuredClone({ ...existing, entries: undefined }) : {};
    delete base.entries;
    const data = { ...base, entries: {} };
    const stats = { kept: 0, updated: 0, added: 0 };
    const uids = [];
    let nextDisplay = Math.max(-1, ...Object.values(existing?.entries ?? {}).map(entry => Number(entry?.displayIndex)).filter(Number.isFinite)) + 1;

    for (const entry of entries) {
        const link = linkOf(entry);
        const built = toWorldInfoEntry(entry, link, template);
        const own = Number.isInteger(link?.raw?.uid) ? link.raw.uid : null;
        let uid;
        if (own !== null && !used.has(own) && (link.source === sameSource || !reserved.has(own))) {
            uid = own;
        } else {
            uid = fresh();
        }
        used.add(uid);
        built.entry.uid = uid;
        if (!Number.isFinite(Number(built.entry.displayIndex))) built.entry.displayIndex = nextDisplay++;
        data.entries[uid] = built.entry;
        uids.push(uid);
        stats[built.kind]++;
    }
    return { data, uids, stats };
}

/**
 * Pairs freshly loaded editor entries with the World Info entries they were parsed from. LBC either replaces its list
 * with the loaded entries or appends them, so the loaded ones are the tail of the list, in `lbcRawEntryList` order.
 * An entry is paired only if LBC's view of the original matches it exactly (title and text).
 * @param {any[]} entries the editor list right after a load
 * @param {any[]} rawList
 * @param {(entry: any) => boolean} isLinked
 * @returns {{entry: any, raw: any}[]}
 */
export function pairLoadedEntries(entries, rawList, isLinked) {
    const offset = entries.length - rawList.length;
    if (offset < 0 || !rawList.length) return [];
    const pairs = [];
    rawList.forEach((raw, index) => {
        const entry = entries[offset + index];
        if (!entry || typeof entry !== 'object' || isLinked(entry)) return;
        const loaded = normalizeLikeLbc(raw);
        const text = lbcEntryText(entry);
        if (text.comment === loaded.comment && text.content === loaded.content) pairs.push({ entry, raw });
    });
    return pairs;
}
