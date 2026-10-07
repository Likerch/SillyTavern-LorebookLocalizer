// An interface dictionary: English string → Russian. Pure logic, no DOM; unit-tested in Node.
// Ported from SillyTavern-DES-RU (src/lib/dictionary.js) by its author and relicensed under this repository's MIT.
//
// Kinds of keys:
// - a plain string: "Generate" → «Сгенерировать»;
// - a template with placeholders, for texts where interface and data are mixed:
//   'Loaded "{name}" — {#n} entries' → «Загружено «{name}»: {n} {n|запись|записи|записей}». `{#name}` only matches a
//   number, so "Entry {#n}" never catches an entry the user named "Entry about…". The translation can inflect by the
//   number: `{n|one|few|many}`;
// - an HTML fragment of a hint with inline tags (<code>, <strong>…), translated as a whole (may be a template too).

const PLACEHOLDER = /\{(#?)(\w+)\}/g;
/** Inline tags of hints; a key with them is an HTML fragment. */
const RICH_TAG = /<(?:code|strong|em|b|i|u|br|small|kbd|span|a)\b[^>]*>/i;
/** Leading non-letters (emoji, icons) and trailing punctuation around the label itself. */
const AFFIXES = /^([^\p{L}\p{N}]*)(.*?)([\s:：.…!?*]*)$/su;
const pluralRules = new Intl.PluralRules('ru');

/** Collapses spaces and line breaks, so markup and dictionary keys compare the same way. */
export function normalizeText(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** @param {string} value */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fills a template translation. `{name}` as is, `{name|one|few|many}` the form for the number.
 * @param {string} translation
 * @param {Record<string, string>} values
 */
export function renderTemplate(translation, values) {
    return translation.replace(/\{#?(\w+)(?:\|([^{}]*))?\}/g, (whole, name, forms) => {
        const value = values[name];
        if (value === undefined) return whole;
        if (forms === undefined) return value;
        const [one, few = one, many = few] = forms.split('|');
        const number = Number(String(value).replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(number)) return many;
        if (!Number.isInteger(number)) return few;
        const rule = pluralRules.select(Math.abs(number));
        return rule === 'one' ? one : rule === 'few' ? few : many;
    });
}

/**
 * @param {string} key a template with {name} placeholders
 * @param {string} translation
 */
function compileTemplate(key, translation) {
    const names = new Map();
    let pattern = '';
    let anchor = '';
    let last = 0;
    for (const match of key.matchAll(PLACEHOLDER)) {
        const literal = key.slice(last, match.index);
        pattern += escapeRegExp(literal);
        if (literal.trim().length > anchor.length) anchor = literal.trim();
        const [, numeric, name] = match;
        if (names.has(name)) {
            pattern += `\\k<${names.get(name)}>`;
        } else {
            const group = `p${names.size}`;
            names.set(name, group);
            pattern += numeric ? `(?<${group}>-?\\d[\\d\\s.,]*)` : `(?<${group}>.+?)`;
        }
        last = match.index + match[0].length;
    }
    const tail = key.slice(last);
    pattern += escapeRegExp(tail);
    if (tail.trim().length > anchor.length) anchor = tail.trim();
    const regex = new RegExp(`^${pattern}$`, 'su');
    return {
        key,
        anchor,
        literalLength: key.replace(PLACEHOLDER, '').length,
        /** @param {string} text */
        apply(text) {
            if (anchor && !text.includes(anchor)) return null;
            const found = regex.exec(text);
            if (!found) return null;
            const values = {};
            for (const [name, group] of names) values[name] = found.groups[group];
            return renderTemplate(translation, values);
        },
    };
}

/**
 * @param {Record<string, unknown>} entries key: the English string, value: the translation. Empty values mean
 *        "not translated yet" and are skipped, as are keys starting with `__` (notes).
 */
export function createDictionary(entries) {
    const exact = new Map();
    const rich = new Map();
    const templates = [];
    const richTemplates = [];
    for (const [rawKey, value] of Object.entries(entries ?? {})) {
        if (typeof value !== 'string' || !value.trim() || rawKey.startsWith('__')) continue;
        const key = normalizeText(rawKey);
        if (!key) continue;
        const isTemplate = /\{#?\w+\}/.test(key);
        if (RICH_TAG.test(key)) {
            if (isTemplate) richTemplates.push(compileTemplate(key, value));
            else rich.set(key, value);
        } else if (isTemplate) {
            templates.push(compileTemplate(key, value));
        } else {
            exact.set(key, value);
        }
    }
    // More specific templates first: the ones with more fixed text.
    templates.sort((a, b) => b.literalLength - a.literalLength);
    richTemplates.sort((a, b) => b.literalLength - a.literalLength);

    return {
        size: exact.size + rich.size + templates.length + richTemplates.length,
        /**
         * Translates a label: an exact match, then the same without icons and trailing punctuation, then templates.
         * @param {string} raw
         * @returns {string|null}
         */
        text(raw) {
            const text = normalizeText(raw);
            if (!text) return null;
            const direct = exact.get(text);
            if (direct !== undefined) return direct;

            const [, prefix = '', core = '', suffix = ''] = AFFIXES.exec(text) ?? [];
            if (core && (prefix || suffix)) {
                const inner = exact.get(core);
                if (inner !== undefined) return `${prefix}${inner}${suffix}`;
            }
            for (const template of templates) {
                const result = template.apply(text);
                if (result !== null) return result;
            }
            return null;
        },
        /**
         * Translates the HTML fragment of a hint (innerHTML of an element with inline tags).
         * @param {string} html
         * @returns {string|null}
         */
        rich(html) {
            const key = normalizeText(html);
            const direct = rich.get(key);
            if (direct !== undefined) return direct;
            for (const template of richTemplates) {
                const result = template.apply(key);
                if (result !== null) return result;
            }
            return null;
        },
    };
}

/**
 * Whether a string is worth listing as untranslated: it has English words and is not code, a link, a version or a
 * colour.
 * @param {string} raw
 */
export function looksTranslatable(raw) {
    const text = normalizeText(raw);
    if (text.length < 2 || text.length > 800) return false;
    if (!/[A-Za-z]{2}/.test(text)) return false;
    if (/^(?:https?:|www\.|\.{0,2}\/)/i.test(text)) return false;
    if (/^[\w.-]+\.(?:png|jpe?g|webp|gif|json|js|css|html|md|zip|txt)$/i.test(text)) return false;
    if (/^v?\d+(?:\.\d+)+\b/.test(text)) return false;
    if (/^#[0-9a-f]{3,8}$/i.test(text)) return false;
    if (/^-?\d+(?:\.\d+)?\s*(?:px|%|em|rem|ms|s|x)$/i.test(text) || /^\.[a-z0-9]+$/i.test(text)) return false;
    if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(text) || /^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(text)) return false;
    return true;
}
