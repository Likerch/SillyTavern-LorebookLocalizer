// The language of what LoreBook Creator generates. Pure logic, unit-tested in Node; the channel applies it.
//
// LBC's prompts say "same language as the idea / context / entries", so the language of a whole book follows whatever
// the user happened to type. A Russian roleplay is better served by a fixed choice:
// - `en`: entries written in English (the model's strongest language, cheaper in tokens), keys in English and Russian;
// - `ru`: everything in Russian, keys in Russian;
// - `idea`: LBC's own behaviour, unchanged.
// Categories always stay LBC's exact English names: LBC orders, filters and prioritizes by them, and a Russian name
// becomes a stray custom category.
import { normalizeText } from './dictionary.js';

/** @typedef {'en'|'ru'|'idea'} ContentLanguage */

export const CONTENT_LANGUAGES = Object.freeze(['en', 'ru', 'idea']);

/** LBC's built-in categories (ENTRY_CATEGORIES). */
export const LBC_CATEGORIES = Object.freeze([
    'Core Rule', 'Core Concept', 'Character', 'Faction', 'Location', 'Item / Artifact', 'Event / History',
    'Magic / Technology', 'Creature / Species', 'Culture / Custom', 'Organization', 'Lore / Legend', 'RP Prompt',
    'Supplementary',
]);

/** Russian names a model gives LBC's categories, lower case, ё as е. */
const RUSSIAN_CATEGORIES = {
    'Core Rule': ['основное правило', 'основные правила', 'правило', 'правила', 'закон мира', 'законы мира', 'базовое правило'],
    'Core Concept': ['ключевое понятие', 'ключевые понятия', 'понятие', 'концепция', 'концепт', 'основное понятие'],
    'Character': ['персонаж', 'персонажи', 'герой', 'герои', 'нпс', 'npc', 'личность', 'действующее лицо'],
    'Faction': ['фракция', 'фракции', 'группировка', 'группировки', 'группа'],
    'Location': ['место', 'места', 'локация', 'локации', 'регион', 'регионы', 'местность'],
    'Item / Artifact': ['предмет / артефакт', 'предмет', 'предметы', 'артефакт', 'артефакты', 'вещь'],
    'Event / History': ['событие / история', 'событие', 'события', 'история', 'историческое событие'],
    'Magic / Technology': ['магия / технологии', 'магия / технология', 'магия', 'технологии', 'технология', 'магия и технологии'],
    'Creature / Species': ['существо / вид', 'существо', 'существа', 'вид', 'виды', 'раса', 'расы', 'монстр', 'монстры', 'чудовище'],
    'Culture / Custom': ['культура / обычай', 'культура', 'обычай', 'обычаи', 'традиция', 'традиции'],
    'Organization': ['организация', 'организации', 'учреждение'],
    'Lore / Legend': ['предание / легенда', 'предание', 'легенда', 'легенды', 'миф', 'мифы', 'мифология'],
    'RP Prompt': ['rp-подсказка', 'рп-подсказка', 'подсказка для рп', 'подсказка', 'rp подсказка'],
    'Supplementary': ['дополнительно', 'дополнительное', 'прочее', 'разное', 'дополнение'],
};

const fold = (text) => normalizeText(text).toLowerCase().replace(/ё/g, 'е');

/** @type {Map<string, string>} folded Russian or English name → LBC category */
const CATEGORY_INDEX = new Map();
for (const category of LBC_CATEGORIES) CATEGORY_INDEX.set(fold(category), category);
for (const [category, names] of Object.entries(RUSSIAN_CATEGORIES)) {
    for (const name of names) CATEGORY_INDEX.set(fold(name), category);
}

/**
 * LBC's English category for a Russian (or differently written) name, or the name unchanged (a real custom category).
 * @param {unknown} name
 */
export function canonicalCategory(name) {
    if (typeof name !== 'string') return name;
    return CATEGORY_INDEX.get(fold(name)) ?? name;
}

/**
 * Puts LBC's English names into every category of a parsed reply (books, single entries, auto-categorize, merges).
 * @param {any} value the parsed JSON reply
 * @returns {number} how many categories changed
 */
export function canonicalizeReplyCategories(value) {
    let changed = 0;
    const fix = (item) => {
        if (!item || typeof item !== 'object' || typeof item.category !== 'string') return;
        const canonical = canonicalCategory(item.category);
        if (canonical !== item.category) {
            item.category = canonical;
            changed++;
        }
    };
    if (!value || typeof value !== 'object') return 0;
    fix(value);
    for (const list of [value.entries, value.assignments, value.merged]) {
        if (Array.isArray(list)) list.forEach(fix);
    }
    return changed;
}

/**
 * @param {ContentLanguage} language
 * @returns {string} the rule that replaces LBC's "same language" sentences
 */
function inlineRule(language) {
    return language === 'ru'
        ? 'Write all text in Russian (see the language rules).'
        : 'Write all text in English (see the language rules).';
}

/**
 * The sentences of LBC's prompts that tie the output language to the input, longest first: the merge prompts'
 * "CRITICAL LANGUAGE RULE … sample", the optimizer's key rule, then the short "same language as …" endings.
 * @type {[RegExp, (language: ContentLanguage, match: string) => string][]}
 */
const SAME_LANGUAGE = [
    [/CRITICAL LANGUAGE RULE:[^\n]*\n"[^\n]*"\n?/g, (language) => `${inlineRule(language)}\n`],
    [/\d+\.\s*Keep keys in the SAME LANGUAGE as the entry content\./gi, (_, match) => `${match.match(/^\d+/)[0]}. Keys: see the language rules.`],
    [/(?:Write|Respond|Answer) in the SAME LANGUAGE as [^.!\]\n]*[.!]?/gi, (language) => inlineRule(language)],
    [/Same language as [^.!\]\n]*\./gi, (language) => inlineRule(language)],
];

/**
 * LBC's prompt with its "same language as …" sentences replaced by the chosen language.
 * @param {string} prompt
 * @param {ContentLanguage} language
 */
export function applyContentLanguage(prompt, language) {
    if (language !== 'en' && language !== 'ru') return prompt;
    let text = prompt;
    for (const [pattern, replace] of SAME_LANGUAGE) text = text.replace(pattern, (match) => replace(language, match));
    return text;
}

/**
 * The language rules added to the system message of every LBC request.
 * @param {ContentLanguage} language
 * @returns {string[]}
 */
export function languageRules(language) {
    const common = [
        `Categories: use exactly one of these English names, never a translation: ${LBC_CATEGORIES.join(', ')}. A custom category the request names stays as written.`,
        'Keep JSON field names in English exactly as the request shows them.',
    ];
    if (language === 'en') {
        return [[
            'LANGUAGE RULES',
            '- Write every text in natural English: world fields, entry titles (comment), entry content, reasons and notes, even when the idea or the source text is in Russian.',
            '- Names from Russian text: one Latin spelling per name for the whole book (Ирина → Irina), used the same way everywhere.',
            '- Keys ("key", "keysecondary"): the English keywords and, next to each name or term, its Russian form in the nominative case (Irina, Ирина; Salt Bell, Соляной Колокол). The roleplay is in Russian; other word forms are added later automatically.',
            ...common.map(rule => `- ${rule}`),
        ].join('\n')];
    }
    if (language === 'ru') {
        return [[
            'LANGUAGE RULES',
            '- Write every text in natural, literary Russian: world fields, entry titles (comment), entry content, reasons and notes, even when the idea or the source text is in English.',
            '- No calques from English: Russian word order and idioms, Russian quotation marks «…», no "является" chains.',
            '- Names: one Russian spelling per name for the whole book, used the same way everywhere.',
            '- Keys ("key", "keysecondary"): Russian words in the nominative case (Ирина, Соляной Колокол); add the Latin spelling of a name only if it may appear in the text. Other word forms are added later automatically.',
            ...common.map(rule => `- ${rule}`),
        ].join('\n')];
    }
    return [['RULES', ...common.map(rule => `- ${rule}`)].join('\n')];
}
