// Pure helpers, no SillyTavern imports: this module is unit-tested in Node.

// JS `\b` and `\w` are ASCII-only even with the `u` flag, so Cyrillic needs explicit Unicode lookarounds.
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';

export const MAX_FORMS = 60;
export const MAX_FORM_LENGTH = 80;
export const MAX_KEY_LENGTH = 1500;

/**
 * Same parsing rules as SillyTavern's `parseRegexFromString` (world-info.js).
 * Used for tests and as a fallback; the extension passes the real ST function where available.
 * @param {string} input
 * @returns {RegExp|null}
 */
export function parseRegexLikeST(input) {
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

/** A key that SillyTavern would try to treat as a regex (`/pattern/flags`). */
export function looksLikeRegexKey(key) {
    return /^\/[\s\S]+\/[a-z]*$/.test(String(key).trim());
}

/**
 * Cleans a single word form coming from the LLM.
 * Commas are removed because SillyTavern's key editor splits plain keys on them.
 * @param {unknown} form
 * @returns {string|null}
 */
export function normalizeForm(form) {
    if (typeof form !== 'string') return null;
    const cleaned = form
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[,;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned || cleaned.length > MAX_FORM_LENGTH) return null;
    return cleaned;
}

/**
 * Normalizes, dedupes (case-insensitively) and caps a list of forms. Keeps the first spelling seen.
 * @param {unknown[]} forms
 * @returns {string[]}
 */
export function cleanForms(forms) {
    const seen = new Set();
    const result = [];
    for (const form of Array.isArray(forms) ? forms : []) {
        const cleaned = normalizeForm(form);
        if (!cleaned) continue;
        const folded = foldForm(cleaned);
        if (seen.has(folded)) continue;
        seen.add(folded);
        result.push(cleaned);
        if (result.length >= MAX_FORMS) break;
    }
    return result;
}

/** Case- and ё/е-insensitive comparison form. */
export function foldForm(form) {
    return form.toLowerCase().replace(/ё/g, 'е');
}

function escapePatternPart(text) {
    return text
        .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
        // Russian text often writes ё as е, so match both.
        .replace(/е/g, '[её]')
        .replace(/ /g, '\\s+');
}

/**
 * Builds one SillyTavern regex key (`/pattern/iu`) that matches every given word form:
 * a shared stem followed by an alternation of endings, wrapped in Unicode word boundaries.
 * @param {string[]} forms
 * @param {{boundaries?: boolean}} [options]
 * @returns {string|null}
 */
export function buildKeyRegex(forms, { boundaries = true } = {}) {
    const folded = [...new Set(cleanForms(forms).map(foldForm))];
    if (!folded.length) return null;

    // Work on code points so a surrogate pair is never split between stem and ending.
    const chars = folded.map(form => Array.from(form));
    let stemLength = Math.min(...chars.map(c => c.length));
    for (let i = 0; i < stemLength; i++) {
        const ch = chars[0][i];
        if (chars.some(c => c[i] !== ch)) {
            stemLength = i;
            break;
        }
    }

    const stem = chars[0].slice(0, stemLength).join('');
    const endings = [...new Set(chars.map(c => c.slice(stemLength).join('')))];
    const optional = endings.includes('');
    const alternatives = endings
        .filter(Boolean)
        .sort((a, b) => b.length - a.length || a.localeCompare(b))
        .map(escapePatternPart);

    let body = escapePatternPart(stem);
    if (alternatives.length) {
        body += `(?:${alternatives.join('|')})${optional ? '?' : ''}`;
    }

    const pattern = boundaries ? `${BOUNDARY_BEFORE}${body}${BOUNDARY_AFTER}` : body;
    return `/${pattern}/iu`;
}

/**
 * Checks that a generated regex key is accepted by SillyTavern and really matches its forms.
 * @param {string} key
 * @param {string[]} forms
 * @param {(input: string) => RegExp|null} [parse]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateKeyRegex(key, forms, parse = parseRegexLikeST) {
    if (!key) return { ok: false, reason: 'empty key' };
    if (key.length > MAX_KEY_LENGTH) return { ok: false, reason: 'regex is too long' };
    if (key.includes('{{')) return { ok: false, reason: 'contains a macro' };
    const regex = parse(key);
    if (!regex) return { ok: false, reason: 'SillyTavern cannot parse the regex' };
    if (regex.test('')) return { ok: false, reason: 'regex matches empty text' };
    for (const form of cleanForms(forms)) {
        // ST scans messages joined as '\x01' + 'Name: message'.
        if (!regex.test(form) || !regex.test(`\x01User: ${form}.`)) {
            return { ok: false, reason: `does not match "${form}"` };
        }
    }
    return { ok: true };
}

/**
 * Plain-key mode: every word form becomes its own key.
 * @param {string[]} forms
 * @returns {string[]}
 */
export function buildPlainKeys(forms) {
    return cleanForms(forms);
}
