// Localization without the dialog, for other extensions (the public API, see api.js). No SillyTavern imports:
// everything that touches SillyTavern is passed in, so the pipeline is unit-tested in Node.
import { DEFAULT_SETTINGS, LANGUAGES, resolveLanguage } from './constants.js';
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
 * @property {ReturnType<typeof import('./exclusive.js').createExclusive>} exclusive shared with the dialog: one job at a time
 * @property {(...args: unknown[]) => void} [warn]
 * @property {number} [retryDelayMs] the pause before a retry is this times the attempt number (tests make it short)
 *
 * @typedef {{phase: 'queued'|'running'|'saving', done: number, total: number}} LocalizeProgress
 *   `queued`: waiting for another Localizer job, `total` is the number of requested entries. `running` and `saving`:
 *   `total` is the number of entries sent to the model (entries with nothing to translate are not counted), `done`
 *   the entries finished so far, translated or failed.
 *
 * @typedef {object} LocalizeOptions
 * @property {string} [language] target language id (`ru`, `uk`, `de`, …); default: the language chosen in the dialog
 * @property {string} [profileId] Connection Manager profile id, `''` for the current connection; default: as in the dialog
 * @property {(progress: LocalizeProgress) => void} [onProgress]
 * @property {AbortSignal} [signal] stops the job: the request in flight is dropped, finished batches are still saved
 *   and the promise resolves with `cancelled: true`. While the job waits for another one it resolves at once.
 * @property {number} [batchTimeoutMs] a request with no reply in this time counts as a failed attempt and is retried
 *   like an error; default: the dialog's reply timeout (90 s unless the user changed it); 0 or Infinity: no limit
 *
 * @typedef {{uid: number, reason: import('./translator.js').FailureKind}} LocalizeFailure
 *
 * @typedef {object} LocalizeResult
 * @property {number} added keys added
 * @property {number} entries entries that got keys
 * @property {number} failures entries that were tried and got no keys because something failed (`failed.length`)
 * @property {boolean} cancelled the signal stopped the job before every entry was tried
 * @property {LocalizeFailure[]} failed the failed entries: `timeout` no reply in time (after the retries), `invalid`
 *   an unusable reply (not JSON, cut off, the entry missing, no valid key), `error` the request failed
 */

/** What `localizeEntries` and the API around it support, for feature detection. */
export const HEADLESS_FEATURES = Object.freeze(['progress', 'cancel', 'busy', 'timeout']);

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
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number} milliseconds, 0 = no limit
 */
function timeoutOption(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
        throw new TypeError('localizeEntries: batchTimeoutMs must be a number of milliseconds (0 or Infinity: no limit)');
    }
    return Number.isFinite(value) ? value : 0;
}

/** @param {unknown} value */
function signalOption(value) {
    if (value === undefined) return undefined;
    const signal = /** @type {AbortSignal} */ (value);
    if (typeof signal?.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
        throw new TypeError('localizeEntries: signal must be an AbortSignal');
    }
    return signal;
}

/**
 * @param {boolean} cancelled
 * @returns {LocalizeResult}
 */
function emptyResult(cancelled) {
    return { added: 0, entries: 0, failures: 0, cancelled, failed: [] };
}

/**
 * Why entries got no keys. An entry the model answered without any translation (nothing to add) is not a failure,
 * and neither is an entry left untried because of a stop.
 * @param {{id: number, uid: number}[]} items
 * @param {import('./translator.js').Translator} translator
 * @param {{uid: number}[]} proposals
 * @param {boolean} cancelled
 * @returns {LocalizeFailure[]}
 */
function failuresOf(items, translator, proposals, cancelled) {
    const proposed = new Set(proposals.map(proposal => proposal.uid));
    const failedById = new Map(translator.failures.map(failure => [failure.id, failure]));
    /** @type {LocalizeFailure[]} */
    const failed = [];
    for (const item of items) {
        const failure = failedById.get(item.id);
        const translations = translator.results.get(item.id);
        if (failure) {
            failed.push({ uid: item.uid, reason: failure.kind });
        } else if (translations) {
            // Variants came back, but none of them made a valid key.
            if (!proposed.has(item.uid) && translations.some(translation => translation.variants.length)) {
                failed.push({ uid: item.uid, reason: 'invalid' });
            }
        } else if (!cancelled) {
            // Lost without a recorded reason (an unexpected error inside a batch, see the warnings).
            failed.push({ uid: item.uid, reason: 'error' });
        }
    }
    return failed;
}

/**
 * The dialog's pipeline without the dialog: collect the keys of the chosen entries, translate them, build the keys
 * and write them. No preview and no backup; every other option of the dialog applies as the user set it (secondary
 * keys, context, constant and disabled entries, key format, variants, batching, reply timeout). Protected books are
 * refused.
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
        const signal = signalOption(options.signal);
        const { onProgress } = options;
        if (onProgress !== undefined && typeof onProgress !== 'function') {
            throw new TypeError('localizeEntries: onProgress must be a function');
        }
        const userSettings = deps.getSettings();
        const settings = { ...userSettings, backupMode: 'none' };
        if (options.profileId !== undefined) settings.profileId = String(options.profileId ?? '');
        const settingSeconds = Number(userSettings.requestTimeout ?? DEFAULT_SETTINGS.requestTimeout);
        const batchTimeoutMs = timeoutOption(options.batchTimeoutMs, Number.isFinite(settingSeconds) && settingSeconds > 0 ? settingSeconds * 1000 : 0);
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
        if (!wanted.size) return emptyResult(false);
        if (signal?.aborted) return emptyResult(true);

        /** @type {(phase: LocalizeProgress['phase'], done: number, total: number) => void} */
        const report = (phase, done, total) => {
            try {
                onProgress?.({ phase, done, total });
            } catch (error) {
                warn('[Lorebook Localizer] onProgress failed', error);
            }
        };

        const job = async () => {
            const ctx = deps.context();
            const data = await ctx.loadWorldInfo(book);
            if (!data?.entries) throw new Error(`localizeEntries: lorebook "${book}" not found`);
            if (isProtectedBookData(data)) throw new Error(`localizeEntries: "${book}" is a BunnyMo book or pack, those are never localized`);

            const connection = deps.resolveConnection(settings);
            if (connection.kind === 'error') throw new Error(`localizeEntries: the connection profile cannot be used: ${connection.message}`);
            if (connection.kind === 'current' && ctx.onlineStatus === 'no_connection') throw new Error('localizeEntries: no API connection');

            const { items } = await deps.collectItems([book], settings, lang, { uids: wanted, skipProtected: true });
            if (!items.length) return emptyResult(Boolean(signal?.aborted));
            report('running', 0, items.length);

            const translator = new Translator({
                request: deps.createRequestFn(connection, settings),
                lang,
                settings,
                // Parallel calls through the current connection would leave the user's response length changed.
                concurrency: connection.kind === 'profile' ? settings.maxConcurrency : 1,
                countTokens: (text) => ctx.getTokenCountAsync(text),
                signal: signal ?? new AbortController().signal,
                onProgress: (done, total) => report('running', done, total),
                batchTimeoutMs,
                ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
            });
            await translator.translate(items.map(item => toPromptItem(item)));
            const cancelled = Boolean(signal?.aborted);

            const { proposals, warnings } = buildProposals(items, translator.results, settings, lang, deps.parse);
            const failed = failuresOf(items, translator, proposals, cancelled);
            const allWarnings = [...translator.warnings, ...warnings];
            if (allWarnings.length || failed.length) {
                warn('[Lorebook Localizer] localizeEntries', { book, warnings: allWarnings, failures: translator.failures, failed });
            }
            if (!proposals.length) return { ...emptyResult(cancelled), failures: failed.length, failed };

            // Finished batches are saved even after a stop.
            report('saving', translator.done, items.length);
            const saved = await deps.applyChanges(proposals, settings, lang);
            return { added: saved.keys, entries: saved.entries, failures: failed.length, cancelled, failed };
        };

        try {
            return await deps.exclusive.run(job, {
                by: 'api',
                signal,
                onQueued: () => report('queued', 0, wanted.size),
            });
        } catch (error) {
            // Stopped while waiting for another job: nothing was done.
            if (signal?.aborted && error === signal.reason) return emptyResult(true);
            throw error;
        }
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

    /** @returns {import('./exclusive.js').BusyState} */
    function busy() {
        return deps.exclusive.state();
    }

    /**
     * @param {(state: import('./exclusive.js').BusyState) => void} listener
     * @returns {() => void} unsubscribe
     */
    function onBusyChange(listener) {
        if (typeof listener !== 'function') throw new TypeError('onBusyChange: the listener must be a function');
        return deps.exclusive.onChange(listener);
    }

    return { localizeEntries, isProtectedBook, busy, onBusyChange };
}
