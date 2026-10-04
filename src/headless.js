// Localization without the dialog, for other extensions (the public API, see api.js). No SillyTavern imports:
// everything that touches SillyTavern is passed in, so the pipeline is unit-tested in Node.
import { LANGUAGES, resolveLanguage } from './constants.js';
import { buildProposals, toPromptItem } from './entries.js';
import { isProtectedBookData } from './protected.js';
import { Translator } from './translator.js';

/**
 * @typedef {object} HeadlessDeps
 * @property {() => any} context SillyTavern's getContext()
 * @property {() => object} getSettings the user's settings (live object; never changed here)
 * @property {(settings: object) => any} resolveConnection
 * @property {(connection: any, settings: object) => import('./translator.js').RequestFn} createRequestFn
 * @property {(books: string[], settings: object, lang: object, options: {uids?: Set<number>|null, skipProtected?: boolean}) => Promise<{items: any[]}>} collectItems
 * @property {(accepted: object[], settings: object, lang: object) => Promise<{entries: number, keys: number}>} applyChanges
 * @property {(input: string) => RegExp|null} [parse] SillyTavern's parseRegexFromString
 * @property {{ run: <T>(job: () => Promise<T>) => Promise<T> }} exclusive shared with the dialog: one job at a time
 * @property {(...args: unknown[]) => void} [warn]
 *
 * @typedef {object} LocalizeOptions
 * @property {string} [language] target language id (`ru`, `uk`, `de`, …); default: the language chosen in the dialog
 * @property {string} [profileId] Connection Manager profile id, `''` for the current connection; default: as in the dialog
 *
 * @typedef {object} LocalizeResult
 * @property {number} added keys added
 * @property {number} entries entries that got keys
 * @property {number} failures entries the model did not translate (errors, missing or unusable replies)
 */

/** @param {unknown} value */
function uidSet(value) {
    if (!Array.isArray(value)) throw new TypeError('localizeEntries: uids must be an array of entry uids');
    const uids = new Set();
    for (const uid of value) {
        const number = Number(uid);
        if (!Number.isInteger(number)) throw new TypeError(`localizeEntries: invalid uid ${JSON.stringify(uid)}`);
        uids.add(number);
    }
    return uids;
}

/**
 * The dialog's pipeline without the dialog: collect the keys of the chosen entries, translate them, build the keys
 * and write them. No preview and no backup; every other option of the dialog applies as the user set it (secondary
 * keys, context, constant and disabled entries, key format, variants, batching). Protected books are refused.
 * @param {HeadlessDeps} deps
 */
export function createHeadless(deps) {
    const warn = deps.warn ?? ((...args) => console.warn(...args));

    /**
     * @param {string} book
     * @param {number[]} uids
     * @param {LocalizeOptions} [options]
     * @returns {Promise<LocalizeResult>}
     */
    async function localizeEntries(book, uids, options = {}) {
        if (typeof book !== 'string' || !book) throw new TypeError('localizeEntries: book must be a lorebook name');
        const wanted = uidSet(uids);
        const userSettings = deps.getSettings();
        const settings = { ...userSettings, backupMode: 'none' };
        if (options.profileId !== undefined) settings.profileId = String(options.profileId ?? '');
        let lang;
        if (options.language !== undefined) {
            if (!LANGUAGES.some(language => language.id === options.language)) {
                throw new Error(`localizeEntries: unknown language id "${options.language}"`);
            }
            lang = resolveLanguage({ language: options.language });
        } else {
            lang = resolveLanguage(userSettings);
        }
        if (!lang.id) throw new Error('localizeEntries: no target language (the custom language has no name)');
        if (!wanted.size) return { added: 0, entries: 0, failures: 0 };

        return deps.exclusive.run(async () => {
            const ctx = deps.context();
            const data = await ctx.loadWorldInfo(book);
            if (!data?.entries) throw new Error(`localizeEntries: lorebook "${book}" not found`);
            if (isProtectedBookData(data)) throw new Error(`localizeEntries: "${book}" is a BunnyMo book or pack, those are never localized`);

            const connection = deps.resolveConnection(settings);
            if (connection.kind === 'error') throw new Error(`localizeEntries: the connection profile cannot be used: ${connection.message}`);
            if (connection.kind === 'current' && ctx.onlineStatus === 'no_connection') throw new Error('localizeEntries: no API connection');

            const { items } = await deps.collectItems([book], settings, lang, { uids: wanted, skipProtected: true });
            if (!items.length) return { added: 0, entries: 0, failures: 0 };

            const translator = new Translator({
                request: deps.createRequestFn(connection, settings),
                lang,
                settings,
                // Parallel calls through the current connection would leave the user's response length changed.
                concurrency: connection.kind === 'profile' ? settings.maxConcurrency : 1,
                countTokens: (text) => ctx.getTokenCountAsync(text),
                signal: new AbortController().signal,
            });
            await translator.translate(items.map(item => toPromptItem(item)));

            const { proposals, warnings } = buildProposals(items, translator.results, settings, lang, deps.parse);
            const untranslated = items.filter(item => !translator.results.has(item.id));
            const allWarnings = [...translator.warnings, ...warnings];
            if (allWarnings.length || untranslated.length) {
                warn('[Lorebook Localizer] localizeEntries', { book, warnings: allWarnings, failures: translator.failures });
            }
            if (!proposals.length) return { added: 0, entries: 0, failures: untranslated.length };

            const report = await deps.applyChanges(proposals, settings, lang);
            return { added: report.keys, entries: report.entries, failures: untranslated.length };
        });
    }

    /**
     * @param {string} book
     * @returns {Promise<boolean>}
     */
    async function isProtectedBook(book) {
        if (typeof book !== 'string' || !book) return false;
        const data = await deps.context().loadWorldInfo(book);
        return isProtectedBookData(data);
    }

    return { localizeEntries, isProtectedBook };
}
