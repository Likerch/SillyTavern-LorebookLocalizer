// Pure helpers, no SillyTavern imports: this module is unit-tested in Node.
import { cleanForms, foldForm, normalizeForm } from './regex-builder.js';

export const SCHEMA_NAME = 'lorebook_key_translations';

/** Strict-mode compatible schema (every property required, no extra properties). */
export const RESPONSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'translations'],
                properties: {
                    id: { type: 'integer' },
                    translations: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['source', 'variants'],
                            properties: {
                                source: { type: 'string' },
                                variants: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        additionalProperties: false,
                                        required: ['base', 'forms'],
                                        properties: {
                                            base: { type: 'string' },
                                            forms: { type: 'array', items: { type: 'string' } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};

/**
 * @param {{name: string, grammar: string, example?: string}} lang
 * @param {{maxVariants: number}} options
 */
export function buildSystemPrompt(lang, { maxVariants }) {
    const L = lang.name;
    const lines = [
        'You are an expert literary translator who localizes roleplay lorebooks (SillyTavern World Info).',
        `A lorebook entry is activated when one of its trigger keywords appears in the chat. The chat is written in ${L}, but the keywords are in another language, so they never trigger.`,
        `Your task: for every source keyword give its ${L} equivalents together with ALL word forms in which it can appear in ${L} text. The forms will be turned into a search pattern automatically.`,
        '',
        'Rules:',
        '1. Translate every string in "terms" of every item. "book", "title" and "context" only explain what the term refers to (a person, a place, an item, a common noun...). Never translate the context itself.',
        `2. Prefer established ${L} renderings: official translations, localizations and fandom usage. If several renderings are in wide use (different official translations, transliteration vs. translation), return each as a separate variant, most common first, at most ${maxVariants} variants. Do not invent rare variants.`,
        '3. Names of people and places are usually transliterated; common nouns and descriptive titles are translated.',
        `4. For every variant give "base" (the dictionary form) and "forms": every distinct written form of this variant that can occur in running ${L} text, including the base form. ${lang.grammar}`,
        '5. If a word does not inflect, "forms" contains only the base form.',
        '6. A source keyword may be a fragment or stem meant for substring matching (for example "Hogwart"). Translate the full word it stands for.',
        '7. Keep multi-word terms multi-word and inflect every word that changes.',
        '8. Write plain words only: no regex, wildcards, brackets, comments or notes.',
        `9. If a term cannot or must not be translated (an acronym, a code, a number, a word already in ${L}), return it with an empty "variants" array.`,
        '10. Return exactly one result per item id and one translation per source term, copying "source" verbatim.',
        '',
        'Answer with JSON only, without markdown fences, in exactly this shape:',
        '{"results":[{"id":1,"translations":[{"source":"<term>","variants":[{"base":"<base form>","forms":["<form>","<form>"]}]}]}]}',
    ];
    if (lang.example) {
        lines.push('', `Example of one translation object for ${L}:`, lang.example);
    }
    return lines.join('\n');
}

/**
 * @param {object[]} promptItems Items as sent to the model ({id, book, title?, context?, terms}).
 */
export function buildUserPrompt(promptItems) {
    return `Translate the terms of these ${promptItems.length} items:\n${JSON.stringify({ items: promptItems })}`;
}

/**
 * Extracts a JSON object from a model reply (object, JSON string, fenced block, text with reasoning tags...).
 * @param {unknown} raw
 * @returns {object|null}
 */
export function parseModelResponse(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;

    let text = raw
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();

    const tryParse = (s) => {
        try {
            const value = JSON.parse(s);
            return value && typeof value === 'object' ? value : null;
        } catch {
            return null;
        }
    };

    const direct = tryParse(text);
    if (direct) return direct;

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        return tryParse(text.slice(start, end + 1));
    }
    return null;
}

/** A reply that starts a JSON object but never closes it — typically cut off by the response length. */
export function looksTruncated(raw) {
    if (typeof raw !== 'string') return false;
    const text = raw.replace(/```\s*$/, '').trim();
    return text.includes('{') && !text.endsWith('}');
}

function getResultsArray(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.results)) return parsed.results;
    if (Array.isArray(parsed?.items)) return parsed.items;
    return null;
}

/**
 * Validates a parsed reply against the batch that was sent.
 * @param {object|null} parsed
 * @param {{id: number, terms: string[]}[]} batch
 * @param {{maxVariants: number}} options
 * @returns {{results: Map<number, {source: string, variants: {base: string, forms: string[]}[]}[]>, missing: number[], warnings: string[]}}
 */
export function validateBatchResponse(parsed, batch, { maxVariants }) {
    const byId = new Map(batch.map(item => [item.id, item]));
    const results = new Map();
    const warnings = [];

    const rawResults = getResultsArray(parsed) ?? [];
    for (const rawResult of rawResults) {
        const id = Number(rawResult?.id);
        const item = byId.get(id);
        if (!item || results.has(id)) continue;

        const termsByFold = new Map(item.terms.map(term => [foldForm(term.trim()), term]));
        const translations = [];
        const rawTranslations = Array.isArray(rawResult.translations) ? rawResult.translations : [];

        for (const rawTranslation of rawTranslations) {
            let source = termsByFold.get(foldForm(String(rawTranslation?.source ?? '').trim()));
            // Models sometimes paraphrase the source; accept it when the item has a single term.
            if (!source && item.terms.length === 1 && rawTranslations.length === 1) {
                source = item.terms[0];
            }
            if (!source) {
                warnings.push(`Item ${id}: unknown source term "${rawTranslation?.source}" ignored`);
                continue;
            }
            if (translations.some(t => t.source === source)) continue;

            const sourceFold = foldForm(source.trim());
            const variants = [];
            for (const rawVariant of Array.isArray(rawTranslation.variants) ? rawTranslation.variants : []) {
                const base = normalizeForm(rawVariant?.base) ?? normalizeForm(rawVariant?.forms?.[0]);
                if (!base) continue;
                const forms = cleanForms([base, ...(Array.isArray(rawVariant.forms) ? rawVariant.forms : [])]);
                // Untranslated echo of the source adds nothing.
                if (forms.every(form => foldForm(form) === sourceFold)) continue;
                if (variants.some(v => foldForm(v.base) === foldForm(base))) continue;
                variants.push({ base, forms });
                if (variants.length >= maxVariants) break;
            }
            translations.push({ source, variants });
        }

        results.set(id, translations);
    }

    const missing = batch.filter(item => !results.has(item.id)).map(item => item.id);
    return { results, missing, warnings };
}
