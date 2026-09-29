// Pure entry-level logic, no SillyTavern imports: unit-tested in Node.
import { MARKER_KEY, MARKER_VERSION } from './constants.js';
import { buildKeyRegex, buildPlainKeys, foldForm, looksLikeRegexKey, parseRegexLikeST, validateKeyRegex } from './regex-builder.js';

/** Entry key fields and their names in `originalData` (books imported from character cards). */
export const KEY_FIELDS = [
    { field: 'key', original: 'keys' },
    { field: 'keysecondary', original: 'secondary_keys' },
];

export function getMarker(entry) {
    const marker = entry?.extensions?.[MARKER_KEY];
    return marker && typeof marker === 'object' ? marker : null;
}

/**
 * Per-language record of what the extension did to an entry:
 * `sources` = original keys already translated, `added` = keys the extension appended.
 */
export function ensureLanguageState(entry, lang) {
    if (!entry.extensions || typeof entry.extensions !== 'object') entry.extensions = {};
    const marker = entry.extensions[MARKER_KEY] ??= { version: MARKER_VERSION, languages: {} };
    marker.version = MARKER_VERSION;
    marker.languages ??= {};
    const state = marker.languages[lang.id] ??= { language: lang.name, sources: [], added: {} };
    state.sources ??= [];
    state.added ??= {};
    for (const { field } of KEY_FIELDS) state.added[field] ??= [];
    return state;
}

function addedKeysOf(marker) {
    const keys = new Set();
    for (const state of Object.values(marker?.languages ?? {})) {
        for (const { field } of KEY_FIELDS) {
            for (const key of state?.added?.[field] ?? []) keys.add(key);
        }
    }
    return keys;
}

/**
 * Picks the keys of an entry that should be sent for translation.
 * @returns {{terms: string[], fieldsByTerm: Map<string, string[]>, skipped: {regex: number, script: number, done: number}}|null}
 */
export function collectEntryTerms(entry, settings, lang) {
    if (entry.disable && !settings.includeDisabled) return null;
    if (entry.constant && settings.skipConstant) return null;

    const marker = getMarker(entry);
    const ours = addedKeysOf(marker);
    const done = new Set(settings.force ? [] : (marker?.languages?.[lang.id]?.sources ?? []).map(foldForm));
    const fields = settings.includeSecondary ? KEY_FIELDS : KEY_FIELDS.slice(0, 1);
    const skipped = { regex: 0, script: 0, done: 0 };

    /** @type {Map<string, {term: string, fields: string[]}>} */
    const byFold = new Map();
    for (const { field } of fields) {
        for (const rawKey of Array.isArray(entry[field]) ? entry[field] : []) {
            const term = String(rawKey).trim();
            if (!term || ours.has(term)) continue;
            if (looksLikeRegexKey(term)) { skipped.regex++; continue; }
            if (lang.scriptRe?.test(term)) { skipped.script++; continue; }
            const fold = foldForm(term);
            if (done.has(fold)) { skipped.done++; continue; }
            const known = byFold.get(fold);
            if (known) {
                if (!known.fields.includes(field)) known.fields.push(field);
            } else {
                byFold.set(fold, { term, fields: [field] });
            }
        }
    }
    if (!byFold.size) return { terms: [], fieldsByTerm: new Map(), skipped };
    const values = [...byFold.values()];
    return { terms: values.map(v => v.term), fieldsByTerm: new Map(values.map(v => [v.term, v.fields])), skipped };
}

/**
 * @param {{content?: string}} entry
 * @param {number} maxChars
 */
export function contextExcerpt(entry, maxChars) {
    const text = String(entry.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text || maxChars <= 0) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Turns validated translations into reviewable proposals (one per variant).
 * @param {{id: number, book: string, uid: number, title: string, terms: string[], fieldsByTerm: Map<string, string[]>}[]} items
 * @param {Map<number, {source: string, variants: {base: string, forms: string[]}[]}[]>} results
 * @param {{keyFormat: string}} settings
 * @param {{boundaries: boolean}} lang
 * @param {(input: string) => RegExp|null} [parse]
 */
export function buildProposals(items, results, settings, lang, parse = parseRegexLikeST) {
    const proposals = [];
    const warnings = [];
    for (const item of items) {
        for (const translation of results.get(item.id) ?? []) {
            const fields = item.fieldsByTerm.get(translation.source) ?? ['key'];
            for (const variant of translation.variants) {
                let keys;
                if (settings.keyFormat === 'plain') {
                    keys = buildPlainKeys(variant.forms);
                } else {
                    const key = buildKeyRegex(variant.forms, { boundaries: lang.boundaries });
                    const check = validateKeyRegex(key, variant.forms, parse);
                    if (!check.ok) {
                        warnings.push(`${item.book} / ${item.title || item.terms[0]}: "${variant.base}" skipped (${check.reason})`);
                        continue;
                    }
                    keys = [key];
                }
                if (!keys.length) continue;
                proposals.push({
                    book: item.book,
                    uid: item.uid,
                    title: item.title,
                    terms: item.terms,
                    source: translation.source,
                    fields,
                    base: variant.base,
                    forms: variant.forms,
                    keys,
                });
            }
        }
    }
    return { proposals, warnings };
}

/**
 * Removes the keys the extension added for one language state. Returns the number of removed keys.
 * Keys the user edited afterwards no longer match exactly and are kept.
 */
export function removeLanguageKeys(entry, state) {
    let removed = 0;
    for (const { field } of KEY_FIELDS) {
        const ours = new Set(state?.added?.[field] ?? []);
        if (!ours.size || !Array.isArray(entry[field])) continue;
        const before = entry[field].length;
        entry[field] = entry[field].filter(key => !ours.has(key));
        removed += before - entry[field].length;
    }
    if (state) {
        state.sources = [];
        for (const { field } of KEY_FIELDS) state.added[field] = [];
    }
    return removed;
}

/**
 * Appends accepted keys to an entry and records them in the marker.
 * @param {object} entry
 * @param {{source: string, fields: string[], keys: string[]}[]} proposals
 * @param {{id: string, name: string}} lang
 * @param {{force?: boolean}} options
 * @returns {number} Number of keys added.
 */
export function applyToEntry(entry, proposals, lang, { force = false } = {}) {
    const state = ensureLanguageState(entry, lang);
    if (force) removeLanguageKeys(entry, state);

    let added = 0;
    for (const { field } of KEY_FIELDS) {
        if (!Array.isArray(entry[field])) entry[field] = [];
        const existing = new Set(entry[field].map(key => String(key).trim().toLowerCase()));
        for (const proposal of proposals) {
            if (!proposal.fields.includes(field)) continue;
            for (const key of proposal.keys) {
                const folded = key.trim().toLowerCase();
                if (!folded || existing.has(folded)) continue;
                entry[field].push(key);
                state.added[field].push(key);
                existing.add(folded);
                added++;
            }
        }
    }
    for (const { source } of proposals) {
        if (!state.sources.some(s => foldForm(s) === foldForm(source))) state.sources.push(source);
    }
    state.language = lang.name;
    state.updated = new Date().toISOString();
    return added;
}

/**
 * Removes added keys of one language (or of all languages when `langId` is null) and cleans up the marker.
 * @returns {number|null} Number of removed keys, or null when the entry has nothing to remove.
 */
export function removeFromEntry(entry, langId) {
    const marker = getMarker(entry);
    if (!marker?.languages) return null;
    const ids = langId ? [langId].filter(id => marker.languages[id]) : Object.keys(marker.languages);
    if (!ids.length) return null;
    let removed = 0;
    for (const id of ids) {
        removed += removeLanguageKeys(entry, marker.languages[id]);
        delete marker.languages[id];
    }
    if (!Object.keys(marker.languages).length) delete entry.extensions[MARKER_KEY];
    return removed;
}
