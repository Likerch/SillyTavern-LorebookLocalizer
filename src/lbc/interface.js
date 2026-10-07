// Russian interface for LoreBook Creator: its window, windows, settings block and chat button are translated by the
// dictionary in locales/ru.lorebook-creator.json; its confirm()/prompt() texts too. LBC's own "translate" button
// (machine translation of every label and of the entries through Chat Translation) is hidden.
// Runs only while SillyTavern's interface is in Russian.
import { EXTENSION_TITLE } from '../constants.js';
import { LBC } from './adapter.js';
import { createDictionary } from './dictionary.js';
import { createUiTranslator } from './ui-translator.js';

const DICTIONARY_URL = new URL('../../locales/ru.lorebook-creator.json', import.meta.url);
/** Class on <html> while the part runs; style.css hides LBC's machine translation button under it. */
const PAGE_CLASS = 'lbl-lbc-ru';
/** For the dictionary's next update: `lorebookLocalizerLbcUntranslated()` in the browser console. */
const DEBUG_GLOBAL = 'lorebookLocalizerLbcUntranslated';

/** @returns {Promise<Record<string, string>>} */
async function loadDictionary() {
    const response = await fetch(DICTIONARY_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/** @type {import('./module.js').LbcPart} */
export const interfacePart = {
    id: 'interface',
    setting: 'lbcInterface',
    needsDom: true,
    start(scope, env) {
        const locale = String(SillyTavern.getContext().getCurrentLocale?.() ?? '').toLowerCase();
        if (!locale.startsWith('ru')) {
            env.log('interface: SillyTavern is not in Russian, LoreBook Creator stays as it is');
            return;
        }
        let dictionary = createDictionary({});
        const translator = createUiTranslator({
            dictionary: () => dictionary,
            roots: LBC.selectors.uiRoots,
            containers: LBC.selectors.uiContainers,
            exclude: LBC.selectors.uiData,
        });
        scope.add(() => translator.stop());
        loadDictionary().then((entries) => {
            if (scope.closed) return;
            dictionary = createDictionary(entries);
            translator.start();
            env.log('interface: dictionary of', dictionary.size, 'strings');
        }, (error) => {
            console.error(`[${EXTENSION_TITLE}] LBC: the interface dictionary did not load`, error);
        });

        document.documentElement.classList.add(PAGE_CLASS);
        scope.add(() => document.documentElement.classList.remove(PAGE_CLASS));

        // LBC asks with the browser's own dialogs. Only texts from the dictionary change, others pass untouched.
        const translate = (message) => (typeof message === 'string' ? dictionary.text(message) ?? message : message);
        const originalConfirm = window.confirm;
        const originalPrompt = window.prompt;
        const confirm = function (message) {
            return originalConfirm.call(this, translate(message));
        };
        const prompt = function (message, value) {
            return originalPrompt.call(this, translate(message), value);
        };
        window.confirm = confirm;
        window.prompt = prompt;
        scope.add(() => {
            if (window.confirm === confirm) window.confirm = originalConfirm;
            if (window.prompt === prompt) window.prompt = originalPrompt;
        });

        globalThis[DEBUG_GLOBAL] = () => translator.untranslated();
        scope.add(() => { delete globalThis[DEBUG_GLOBAL]; });
    },
};
