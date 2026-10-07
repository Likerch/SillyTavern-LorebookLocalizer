export const MODULE_NAME = 'lorebookLocalizer';
export const EXTENSION_TITLE = 'Lorebook Localizer';

/** Key under `entry.extensions` where the extension remembers what it added. */
export const MARKER_KEY = 'lorebook_localizer';
export const MARKER_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
    language: 'ru',
    customLanguage: '',
    /** Connection Manager profile id. Empty string = the currently active connection. */
    profileId: '',
    includeSecondary: true,
    includeContext: true,
    contextChars: 300,
    skipConstant: true,
    includeDisabled: false,
    force: false,
    /** 'regex' = one regex key per variant, 'plain' = every word form as a plain key. */
    keyFormat: 'regex',
    maxVariants: 3,
    /** 'download' | 'copy' | 'none' */
    backupMode: 'download',
    maxBatchTokens: 1500,
    maxTermsPerBatch: 25,
    maxConcurrency: 2,
    maxRetries: 2,
    responseTokens: 6000,
    /** Seconds to wait for a reply; a request with no reply in time counts as a failed attempt. 0 = no limit. */
    requestTimeout: 90,
    temperature: 0.2,
    useJsonSchema: true,
    lastSelectedBooks: [],
    /** BunnyMo books and packs are skipped by the dialog unless this is on (the API never localizes them). */
    localizeProtected: false,
    /** Russian support for LoreBook Creator (src/lbc/). Does nothing while LBC is not installed. */
    lbcEnabled: true,
    /** Run the parts that rely on LBC's markup and texts on a version they were not checked against. */
    lbcAllowUntested: false,
    /** LBC's requests go without the RP context, through lbcProfileId (src/lbc/channel.js). */
    lbcChannel: true,
    /** Connection Manager profile id for LBC; '@localizer' = the one chosen for keys (profileId), '' = current connection. */
    lbcProfileId: '@localizer',
    /** 'off' (none on OpenRouter) | 'auto' (the API's default) | 'low' | 'medium' | 'high' */
    lbcReasoning: 'off',
    lbcResponseTokens: 16000,
    /** Seconds; a whole book can take minutes. 0 = no limit. */
    lbcRequestTimeout: 600,
    lbcTemperature: 0.8,
    /** "Import to ST" and "Download JSON" keep everything LBC drops (src/lbc/saving.js). */
    lbcSaving: true,
});

const SLAVIC_CASES = (cases) => `List all ${cases} cases in the singular and, for countable common nouns, in the plural. `
    + 'For adjective + noun phrases inflect every word in agreement. '
    + 'For surnames of people whose gender is unknown include both masculine and feminine forms.';

/**
 * Target languages.
 * - `script`: keys already written in this script are skipped (null = cannot be detected, e.g. Latin-script targets).
 * - `boundaries`: wrap regex keys in Unicode word boundaries. Off for languages written without spaces.
 * - `grammar`: language-specific instruction for listing word forms.
 */
export const LANGUAGES = [
    {
        id: 'ru', name: 'Russian', label: 'Русский', script: 'Cyrillic', boundaries: true,
        grammar: SLAVIC_CASES('six (nominative, genitive, dative, accusative, instrumental, prepositional)')
            + ' Include the alternative instrumental endings (-ою, -ею) where they exist. Use the letter ё where it belongs.',
        example: '{"source":"Snape","variants":[{"base":"Снейп","forms":["Снейп","Снейпа","Снейпу","Снейпом","Снейпе"]},{"base":"Снегг","forms":["Снегг","Снегга","Снеггу","Снеггом","Снегге"]}]}',
    },
    { id: 'uk', name: 'Ukrainian', label: 'Українська', script: 'Cyrillic', boundaries: true, grammar: SLAVIC_CASES('seven (including the vocative)') },
    { id: 'be', name: 'Belarusian', label: 'Беларуская', script: 'Cyrillic', boundaries: true, grammar: SLAVIC_CASES('six (plus the vocative where used)') },
    { id: 'pl', name: 'Polish', label: 'Polski', script: null, boundaries: true, grammar: SLAVIC_CASES('seven (including the vocative)') },
    { id: 'cs', name: 'Czech', label: 'Čeština', script: null, boundaries: true, grammar: SLAVIC_CASES('seven (including the vocative)') },
    { id: 'de', name: 'German', label: 'Deutsch', script: null, boundaries: true, grammar: 'Include plural forms and case endings (genitive -s/-es, dative plural -n). For adjectives include all declension endings.' },
    { id: 'fr', name: 'French', label: 'Français', script: null, boundaries: true, grammar: 'Include plural and feminine/masculine forms where they exist.' },
    { id: 'es', name: 'Spanish', label: 'Español', script: null, boundaries: true, grammar: 'Include plural and feminine/masculine forms where they exist.' },
    { id: 'it', name: 'Italian', label: 'Italiano', script: null, boundaries: true, grammar: 'Include plural and feminine/masculine forms where they exist.' },
    { id: 'pt', name: 'Portuguese', label: 'Português', script: null, boundaries: true, grammar: 'Include plural and feminine/masculine forms where they exist.' },
    { id: 'en', name: 'English', label: 'English', script: 'Latin', boundaries: true, grammar: 'Include plural and possessive forms where they make sense.' },
    { id: 'ja', name: 'Japanese', label: '日本語', script: 'Japanese', boundaries: false, grammar: 'Words do not inflect: give the usual written form and common alternative spellings (kanji / katakana) only.' },
    { id: 'zh', name: 'Chinese (Simplified)', label: '简体中文', script: 'Han', boundaries: false, grammar: 'Words do not inflect: give the usual written form and common alternative renderings only.' },
    { id: 'ko', name: 'Korean', label: '한국어', script: 'Hangul', boundaries: false, grammar: 'Give the bare noun without particles; particles attach directly to it.' },
];

export const CUSTOM_LANGUAGE_ID = 'custom';

const SCRIPT_REGEXES = {
    Cyrillic: /\p{Script=Cyrillic}/u,
    Latin: /\p{Script=Latin}/u,
    Han: /\p{Script=Han}/u,
    Hangul: /\p{Script=Hangul}/u,
    Japanese: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
};

/**
 * Resolves the language settings into a language descriptor.
 * @param {{language: string, customLanguage?: string}} settings
 */
export function resolveLanguage(settings) {
    if (settings.language === CUSTOM_LANGUAGE_ID) {
        const name = String(settings.customLanguage || '').trim();
        return {
            id: name ? `custom:${name.toLowerCase()}` : '',
            name,
            label: name,
            scriptRe: null,
            boundaries: true,
            grammar: 'Include every inflected form (case, number, gender) in which the word can appear in running text.',
            example: '',
        };
    }
    const lang = LANGUAGES.find(l => l.id === settings.language) ?? LANGUAGES[0];
    return { ...lang, scriptRe: lang.script ? SCRIPT_REGEXES[lang.script] : null, example: lang.example ?? '' };
}
