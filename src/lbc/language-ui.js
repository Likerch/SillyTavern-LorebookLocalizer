// The "language of entries" switch in LoreBook Creator's header (the same setting as in the extension's drawer).
// With a fixed language LBC's "To English" idea translation is pointless and hidden: the rules make the model write
// in the chosen language whatever the idea is written in.
import { getSettings, saveSettings, t } from '../settings.js';
import { LBC } from './adapter.js';
import { CONTENT_LANGUAGES } from './language.js';

const SELECT_CLASS = 'lbl-lbc-language';
/** Class on <html> while the language is fixed; style.css hides LBC's "To English" under it. */
const FIXED_CLASS = 'lbl-lbc-language-fixed';

/** @returns {Record<string, string>} */
export function contentLanguageLabels() {
    return {
        en: t`Entries in English, keys also in Russian`,
        ru: t`Entries in Russian`,
        idea: t`Language of the idea (as LoreBook Creator does)`,
    };
}

function syncPageClass() {
    const language = getSettings().lbcContentLanguage;
    document.documentElement.classList.toggle(FIXED_CLASS, language === 'en' || language === 'ru');
}

/** @type {import('./module.js').LbcPart} */
export const languagePart = {
    id: 'language',
    setting: 'lbcChannel',
    needsDom: true,
    start(scope) {
        const settings = getSettings();
        const labels = contentLanguageLabels();
        const select = $('<select>', { class: `text_pole ${SELECT_CLASS}`, title: t`Language of the entries LoreBook Creator writes` });
        for (const language of CONTENT_LANGUAGES) select.append($('<option>', { value: language, text: labels[language] }));
        select.val(settings.lbcContentLanguage);
        select.on('focus mousedown', () => select.val(getSettings().lbcContentLanguage));
        select.on('change', () => {
            settings.lbcContentLanguage = String(select.val());
            saveSettings();
            syncPageClass();
        });
        const header = $(LBC.selectors.header);
        const anchor = header.find(LBC.selectors.resetButton);
        if (anchor.length) select.insertBefore(anchor);
        else header.append(select);
        scope.add(() => select.remove());

        syncPageClass();
        scope.add(() => document.documentElement.classList.remove(FIXED_CLASS));
    },
};

export { syncPageClass as syncContentLanguageClass };
