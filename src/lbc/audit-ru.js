// The Russian half of LoreBook Creator's key audit. LBC's own audit knows English only: its list of over-common words
// is English, and for short keys it suggests "match whole words", which SillyTavern cannot do for Cyrillic (`\W`
// without the `u` flag treats every Cyrillic letter as a non-word character). Pure logic, unit-tested in Node.
import { looksLikeRegexKey, parseRegexLikeST } from '../regex-builder.js';

/** Russian words that occur in almost any roleplay text: as keys they fire all the time. */
export const RUSSIAN_GENERIC_KEYS = Object.freeze([
    'человек', 'люди', 'мужчина', 'женщина', 'мир', 'город', 'дом', 'комната', 'дверь', 'улица', 'дорога', 'вода',
    'огонь', 'свет', 'тьма', 'ночь', 'день', 'время', 'жизнь', 'смерть', 'любовь', 'ненависть', 'страх', 'война',
    'сила', 'власть', 'бог', 'магия', 'имя', 'работа', 'игра', 'тело', 'группа', 'место', 'история',
    'правило', 'закон', 'порядок', 'система', 'событие', 'вещь', 'деньги', 'еда', 'кровь', 'глаза', 'рука', 'голова',
    'сердце', 'душа', 'король', 'королева', 'солдат', 'страж', 'стража', 'торговец', 'рынок',
]);

const CYRILLIC = /\p{Script=Cyrillic}/u;
const fold = (text) => String(text ?? '').trim().toLowerCase().replace(/ё/g, 'е');

/**
 * @typedef {object} RuKeyIssue
 * @property {'error'|'warn'|'info'} sev
 * @property {'no_russian'|'single_form'|'generic_ru'|'forms_collision'} type
 * @property {number} idx entry index in the editor
 * @property {string} [key]
 * @property {number} [other] the other entry of a collision
 */

/**
 * @param {any} entry an LBC editor entry
 * @returns {{plain: string[], regexes: RegExp[]}}
 */
function keysOf(entry) {
    const plain = [];
    const regexes = [];
    for (const field of ['key', 'keysecondary']) {
        for (const raw of Array.isArray(entry[field]) ? entry[field] : []) {
            const key = String(raw).trim();
            if (!key) continue;
            if (looksLikeRegexKey(key)) {
                const regex = parseRegexLikeST(key);
                if (regex) regexes.push(regex);
            } else {
                plain.push(key);
            }
        }
    }
    return { plain, regexes };
}

/**
 * @param {RegExp} regex
 * @param {string} text
 */
function matches(regex, text) {
    regex.lastIndex = 0;
    return regex.test(text);
}

/**
 * Finds the key problems that matter for a Russian roleplay.
 * @param {any[]} entries LBC editor entries
 * @returns {RuKeyIssue[]}
 */
export function auditRussianKeys(entries) {
    /** @type {RuKeyIssue[]} */
    const issues = [];
    const keys = entries.map(keysOf);
    const generic = new Set(RUSSIAN_GENERIC_KEYS);

    entries.forEach((entry, idx) => {
        if (entry.constant || entry.disable) return;
        const { plain, regexes } = keys[idx];
        if (!plain.length && !regexes.length) return;
        const russianPlain = plain.filter(key => CYRILLIC.test(key));
        const russianRegex = regexes.some(regex => CYRILLIC.test(regex.source));
        if (!russianPlain.length && !russianRegex) {
            issues.push({ sev: 'error', type: 'no_russian', idx });
            return;
        }
        for (const key of russianPlain) {
            if (generic.has(fold(key))) issues.push({ sev: 'warn', type: 'generic_ru', idx, key });
            // A plain Cyrillic key catches one form (and, without word boundaries, also matches inside longer words);
            // a regex key with Unicode boundaries covers every case.
            else if (!regexes.some(regex => matches(regex, key))) issues.push({ sev: 'warn', type: 'single_form', idx, key });
        }
    });

    // One entry's key that another entry's word forms catch: both fire on the same word.
    for (let a = 0; a < entries.length; a++) {
        if (entries[a].constant || entries[a].disable) continue;
        for (let b = 0; b < entries.length; b++) {
            if (a === b || entries[b].constant || entries[b].disable) continue;
            if (entries[a].group && entries[a].group === entries[b].group) continue;
            const key = keys[a].plain.find(plainKey => CYRILLIC.test(plainKey) && keys[b].regexes.some(regex => matches(regex, plainKey)));
            if (key) issues.push({ sev: 'warn', type: 'forms_collision', idx: a, key, other: b });
        }
    }
    return issues;
}

/**
 * Entries that the Russian keys button would help: no Russian keys, or Russian keys with one form only.
 * @param {RuKeyIssue[]} issues
 */
export function entriesNeedingForms(issues) {
    return [...new Set(issues.filter(issue => issue.type === 'no_russian' || issue.type === 'single_form').map(issue => issue.idx))];
}
