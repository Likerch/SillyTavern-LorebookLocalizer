// The public API for other extensions (Maestro): `globalThis.LOREBOOK_LOCALIZER_API`. No SillyTavern imports.
//
// The object is versioned: within version 1 members are only added, never changed. A breaking change gets a new
// version number. `features` lists what was added after the first release, for feature detection.
import { HEADLESS_FEATURES } from './headless.js';
import { buildKeyRegex, buildPlainKeys, cleanForms } from './regex-builder.js';

export const API_VERSION = 1;
export const API_GLOBAL = 'LOREBOOK_LOCALIZER_API';

/**
 * @typedef {import('./exclusive.js').BusyState} BusyState
 *
 * @typedef {object} LorebookLocalizerApi
 * @property {number} version
 * @property {readonly string[]} features `progress`, `cancel`, `busy`, `timeout`
 * @property {(forms: string[], options?: {boundaries?: boolean}) => string|null} buildKeyRegex one ST regex key (`/…/iu`) matching every form
 * @property {(forms: string[]) => string[]} buildPlainKeys every form as a plain key
 * @property {(forms: string[]) => string[]} cleanForms normalized, deduplicated (case and ё/е), capped forms
 * @property {(book: string, uids: number[], options?: import('./headless.js').LocalizeOptions) => Promise<import('./headless.js').LocalizeResult>} localizeEntries
 * @property {(book: string) => Promise<boolean>} isProtectedBook
 * @property {() => BusyState} busy whether a Localizer job (the dialog's or an API call's) runs or waits, and whose
 * @property {(listener: (state: BusyState) => void) => () => void} onBusyChange called on every change; returns unsubscribe
 */

/**
 * @typedef {object} HeadlessApi
 * @property {LorebookLocalizerApi['localizeEntries']} localizeEntries
 * @property {LorebookLocalizerApi['isProtectedBook']} isProtectedBook
 * @property {LorebookLocalizerApi['busy']} busy
 * @property {LorebookLocalizerApi['onBusyChange']} onBusyChange
 */

/**
 * @param {HeadlessApi} headless
 * @returns {Readonly<LorebookLocalizerApi>}
 */
export function createApi(headless) {
    return Object.freeze({
        version: API_VERSION,
        features: HEADLESS_FEATURES,
        buildKeyRegex: (forms, options) => buildKeyRegex(forms, options),
        buildPlainKeys: (forms) => buildPlainKeys(forms),
        cleanForms: (forms) => cleanForms(forms),
        localizeEntries: (book, uids, options) => headless.localizeEntries(book, uids, options),
        isProtectedBook: (book) => headless.isProtectedBook(book),
        busy: () => headless.busy(),
        onBusyChange: (listener) => headless.onBusyChange(listener),
    });
}

/** @param {HeadlessApi} headless */
export function installApi(headless) {
    globalThis[API_GLOBAL] = createApi(headless);
}

export function uninstallApi() {
    delete globalThis[API_GLOBAL];
}
