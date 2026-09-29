import { CUSTOM_LANGUAGE_ID, EXTENSION_TITLE, LANGUAGES, resolveLanguage } from './constants.js';
import { getProfiles } from './connection.js';
import { getOpenEditorBook } from './lorebook.js';
import { looksLikeRegexKey } from './regex-builder.js';
import { clampSetting, getSettings, NUMBER_LIMITS, saveSettings, t } from './settings.js';
import { parseRegexFromString, splitKeywordsAndRegexes } from './st.js';

const BUTTON_ID = 'lorebook_localizer_button';

// All user-provided text (book names, titles, keys) goes through .text()/.val(), never into HTML strings.

/** Adds the icon button to the World Info panel, next to "Duplicate". */
export function addWorldInfoButton(onClick) {
    if (document.getElementById(BUTTON_ID)) return;
    const button = $('<div>', {
        id: BUTTON_ID,
        class: 'menu_button fa-solid fa-language',
        title: t`Localize lorebook keys`,
        tabindex: 0,
    });
    button.on('click', onClick);
    const anchor = $('#world_duplicate');
    if (anchor.length) {
        button.insertAfter(anchor);
    } else if ($('#world_popup_delete').length) {
        button.insertBefore('#world_popup_delete');
    } else {
        console.warn(`[${EXTENSION_TITLE}] World Info buttons not found, use the Extensions panel instead.`);
    }
}

/** Small drawer in the Extensions panel with a second entry point. */
export function addSettingsPanel(onClick) {
    const container = $('#extensions_settings2');
    if (!container.length || container.find('.lorebook-localizer-settings').length) return;
    const panel = $(`
        <div class="lorebook-localizer-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p class="lbl-hint"></p>
                    <div class="menu_button menu_button_icon lbl-open"><i class="fa-solid fa-language"></i><span></span></div>
                </div>
            </div>
        </div>`);
    panel.find('b').text(EXTENSION_TITLE);
    panel.find('.lbl-hint').text(t`Translates lorebook keys with an LLM and adds regex keys that cover every word form. Also available from the language button in the World Info panel.`);
    panel.find('.lbl-open span').text(t`Open`);
    panel.find('.lbl-open').on('click', onClick);
    container.append(panel);
}

function iconButton(icon, text, onClick) {
    return $('<div class="menu_button menu_button_icon">')
        .append($('<i>').addClass(`fa-solid ${icon}`), $('<span>').text(text))
        .on('click', onClick);
}

function field(label, control, hint) {
    const wrapper = $('<label class="lbl-field">').append($('<span class="lbl-field-label">').text(label), control);
    if (hint) wrapper.attr('title', hint);
    return wrapper;
}

function checkboxControl(settings, key, label, hint) {
    const input = $('<input type="checkbox">').prop('checked', Boolean(settings[key]));
    input.on('change', () => {
        settings[key] = input.prop('checked');
        saveSettings();
    });
    const wrapper = $('<label class="checkbox_label lbl-option">').append(input, $('<span>').text(label));
    if (hint) wrapper.attr('title', hint);
    return wrapper;
}

function numberControl(settings, key, label, { step = 1, hint = '' } = {}) {
    const [min, max] = NUMBER_LIMITS[key];
    const input = $('<input type="number" class="text_pole lbl-number">').attr({ min, max, step }).val(settings[key]);
    input.on('change', () => {
        settings[key] = clampSetting(key, input.val());
        input.val(settings[key]);
        saveSettings();
    });
    return field(label, input, hint);
}

function selectControl(settings, key, label, options) {
    const select = $('<select class="text_pole">');
    for (const option of options) select.append($('<option>', { value: option.value, text: option.text }));
    select.val(settings[key]);
    select.on('change', () => {
        settings[key] = select.val();
        saveSettings();
    });
    return field(label, select);
}

function groupBy(list, keyFn) {
    const map = new Map();
    for (const item of list) {
        const key = keyFn(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }
    return map;
}

function detailsList(title, lines, limit = 200) {
    const list = $('<ul>');
    for (const line of lines.slice(0, limit)) list.append($('<li>').text(line));
    if (lines.length > limit) list.append($('<li>').text(`… +${lines.length - limit}`));
    return $('<details class="lbl-details lbl-warning-list">').append($('<summary>').text(title), list);
}

/**
 * Main dialog: books, language, connection and options.
 * @returns {Promise<{action: 'localize'|'remove', books: string[]}|null>}
 */
export async function openMainDialog() {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();
    const books = ctx.getWorldInfoNames();
    if (!books.length) {
        toastr.info(t`There are no lorebooks yet.`, EXTENSION_TITLE);
        return null;
    }

    const openBook = getOpenEditorBook();
    const remembered = settings.lastSelectedBooks.filter(book => books.includes(book));
    const selected = new Set(remembered.length ? remembered : (openBook ? [openBook] : []));

    const root = $('<div class="lbl-dialog">');
    root.append($('<h3>').text(t`Localize lorebook keys`));
    root.append($('<div class="lbl-hint">').text(t`The model translates the keys of the selected lorebooks. Every word form is added next to the original keys, which stay untouched. You review everything before it is written.`));

    // Language
    const languageSelect = $('<select class="text_pole">');
    for (const lang of LANGUAGES) languageSelect.append($('<option>', { value: lang.id, text: `${lang.label} — ${lang.name}` }));
    languageSelect.append($('<option>', { value: CUSTOM_LANGUAGE_ID, text: t`Other language…` }));
    languageSelect.val(settings.language);
    if (!languageSelect.val()) languageSelect.val(LANGUAGES[0].id);
    const customLanguage = $('<input type="text" class="text_pole">')
        .attr('placeholder', t`Language name in English, e.g. Esperanto`)
        .val(settings.customLanguage);
    const syncLanguage = () => customLanguage.toggle(languageSelect.val() === CUSTOM_LANGUAGE_ID);
    languageSelect.on('change', () => {
        settings.language = languageSelect.val();
        syncLanguage();
        saveSettings();
    });
    customLanguage.on('input', () => {
        settings.customLanguage = String(customLanguage.val());
        saveSettings();
    });
    syncLanguage();

    // Connection
    const profiles = getProfiles();
    const profileSelect = $('<select class="text_pole">').append($('<option>', { value: '', text: t`Current connection` }));
    for (const profile of profiles ?? []) profileSelect.append($('<option>', { value: profile.id, text: profile.name }));
    if (!profiles?.some(profile => profile.id === settings.profileId)) settings.profileId = '';
    profileSelect.val(settings.profileId);
    profileSelect.on('change', () => {
        settings.profileId = String(profileSelect.val());
        saveSettings();
    });
    const profileHint = profiles === null
        ? t`Connection Manager is disabled, so only the current connection can be used.`
        : t`A separate connection profile lets you translate with a cheaper model and send requests in parallel. Its RP preset is not applied.`;

    root.append($('<div class="lbl-grid">').append(
        field(t`Language`, $('<div class="lbl-inline">').append(languageSelect, customLanguage)),
        field(t`Connection`, profileSelect, profileHint),
    ));

    // Lorebooks
    const bookList = $('<div class="lbl-book-list">');
    for (const book of books) {
        const input = $('<input type="checkbox">').val(book).prop('checked', selected.has(book));
        const label = $('<label class="checkbox_label lbl-book">').append(input, $('<span>').text(book));
        if (book === openBook) label.append($('<small class="lbl-badge">').text(t`open`));
        bookList.append(label);
    }
    const counter = $('<span class="lbl-counter">');
    const getChosen = () => bookList.find('input:checked').map((_, el) => /** @type {HTMLInputElement} */ (el).value).get();
    const updateCounter = () => counter.text(t`Selected: ${getChosen().length} of ${books.length}`);
    bookList.on('change', 'input', updateCounter);
    const search = $('<input type="search" class="text_pole lbl-search">').attr('placeholder', t`Filter lorebooks…`);
    search.on('input', () => {
        const query = String(search.val()).toLowerCase();
        bookList.children().each((_, el) => { $(el).toggle($(el).text().toLowerCase().includes(query)); });
    });
    const setVisible = (checked) => {
        bookList.children(':visible').find('input').prop('checked', checked);
        updateCounter();
    };

    root.append(
        $('<div class="lbl-section-title">').text(t`Lorebooks`),
        $('<div class="lbl-toolbar">').append(
            search,
            iconButton('fa-check-double', t`Select all`, () => setVisible(true)),
            iconButton('fa-xmark', t`Select none`, () => setVisible(false)),
            counter,
        ),
        bookList,
    );

    // Options
    root.append($('<details class="lbl-details">').append(
        $('<summary>').text(t`Options`),
        checkboxControl(settings, 'includeSecondary', t`Translate secondary keys too`),
        checkboxControl(settings, 'includeContext', t`Send the entry title and a content excerpt as context`, t`Helps the model tell a name from a common word. Costs more input tokens.`),
        numberControl(settings, 'contextChars', t`Content excerpt length, characters`),
        checkboxControl(settings, 'skipConstant', t`Skip constant entries (their keys are never used)`),
        checkboxControl(settings, 'includeDisabled', t`Include disabled entries`),
        checkboxControl(settings, 'force', t`Translate again and replace keys added earlier`, t`Without this, keys that were already translated for this language are skipped.`),
        selectControl(settings, 'keyFormat', t`Key format`, [
            { value: 'regex', text: t`One regex per variant (recommended)` },
            { value: 'plain', text: t`Every word form as a plain key` },
        ]),
        numberControl(settings, 'maxVariants', t`Max translation variants per key`),
        selectControl(settings, 'backupMode', t`Backup before writing`, [
            { value: 'download', text: t`Download a JSON file` },
            { value: 'copy', text: t`Save a copy as a new lorebook` },
            { value: 'none', text: t`No backup` },
        ]),
    ));

    root.append($('<details class="lbl-details">').append(
        $('<summary>').text(t`Requests`),
        numberControl(settings, 'maxBatchTokens', t`Max input tokens per request`),
        numberControl(settings, 'maxTermsPerBatch', t`Max keys per request`, { hint: t`The reply lists many word forms per key, so it is much longer than the request.` }),
        numberControl(settings, 'maxConcurrency', t`Parallel requests (profile only)`, { hint: t`The current connection always sends one request at a time.` }),
        numberControl(settings, 'maxRetries', t`Retries`),
        numberControl(settings, 'responseTokens', t`Response length, tokens`),
        numberControl(settings, 'temperature', t`Temperature (profile only)`, { step: 0.05 }),
        checkboxControl(settings, 'useJsonSchema', t`Use structured output (JSON schema) when the API supports it`),
    ));

    updateCounter();

    const REMOVE = ctx.POPUP_RESULT.CUSTOM1;
    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        okButton: t`Localize`,
        cancelButton: t`Close`,
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        customButtons: [{ text: t`Remove added keys`, result: REMOVE, icon: 'fa-eraser' }],
        onClosing: (p) => {
            if (p.result !== ctx.POPUP_RESULT.AFFIRMATIVE && p.result !== REMOVE) return true;
            if (!getChosen().length) {
                toastr.warning(t`Select at least one lorebook.`, EXTENSION_TITLE);
                return false;
            }
            if (!resolveLanguage(settings).id) {
                toastr.warning(t`Enter the language name.`, EXTENSION_TITLE);
                return false;
            }
            return true;
        },
    });

    const result = await popup.show();
    const chosen = getChosen();
    settings.lastSelectedBooks = chosen;
    saveSettings();

    if (result === ctx.POPUP_RESULT.AFFIRMATIVE) return { action: 'localize', books: chosen };
    if (result === REMOVE) return { action: 'remove', books: chosen };
    return null;
}

/** Non-closable progress popup with a Stop button. */
export class ProgressDialog {
    #closed = false;
    #finished = false;

    /**
     * @param {string} title
     * @param {() => void} onStop
     */
    constructor(title, onStop) {
        const ctx = SillyTavern.getContext();
        this.bar = $('<progress class="lbl-progress-bar" max="1" value="0">');
        this.status = $('<div class="lbl-progress-status">');
        const root = $('<div class="lbl-dialog lbl-progress">').append($('<h3>').text(title), this.bar, this.status);
        this.popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', { okButton: false, cancelButton: t`Stop`, animation: 'fast' });
        this.popup.show().then(() => {
            this.#closed = true;
            if (!this.#finished) onStop();
        });
    }

    update(done, total, text) {
        this.bar.attr({ max: Math.max(1, total), value: done });
        if (text) this.status.text(text);
    }

    async close() {
        this.#finished = true;
        if (!this.#closed) await this.popup.completeAffirmative();
    }
}

/**
 * Splits an edited key field the same way the World Info editor does and validates regex keys.
 * @param {string} value
 */
function parseKeysInput(value) {
    const keys = [];
    const invalid = [];
    for (const piece of splitKeywordsAndRegexes(value).map(k => k.trim()).filter(Boolean)) {
        if (looksLikeRegexKey(piece) && !parseRegexFromString(piece)) invalid.push(piece);
        else keys.push(piece);
    }
    return { keys, invalid };
}

/**
 * Review step: nothing is written until the user presses Apply.
 * @returns {Promise<object[]|null>} Accepted proposals with (possibly edited) keys.
 */
export async function showPreview({ proposals, warnings, failures, stopped }) {
    const ctx = SillyTavern.getContext();
    const entryKey = (p) => `${p.book}\u0000${p.uid}`;
    const entryCount = new Set(proposals.map(entryKey)).size;
    const bookCount = new Set(proposals.map(p => p.book)).size;

    const root = $('<div class="lbl-dialog lbl-preview">');
    root.append($('<h3>').text(t`Review new keys`));
    root.append($('<div class="lbl-hint">').text(t`${proposals.length} translations for ${entryCount} entries in ${bookCount} lorebooks. Uncheck what you don't need or edit the keys. Hover a translation to see its word forms.`));
    if (stopped) root.append($('<div class="lbl-warning">').text(t`Stopped early: only the finished part is shown.`));
    if (failures.length) root.append(detailsList(t`Not translated (${failures.length})`, failures.map(f => `${f.book} / ${f.title}: ${f.reason}`)));
    if (warnings.length) root.append(detailsList(t`Warnings (${warnings.length})`, warnings));

    const rows = [];
    const list = $('<div class="lbl-preview-list">');
    for (const [book, bookProposals] of groupBy(proposals, p => p.book)) {
        const bookEl = $('<div class="lbl-preview-book">')
            .append($('<div class="lbl-preview-book-title">').append($('<i class="fa-solid fa-book-atlas">'), $('<span>').text(book)));
        for (const entryProposals of groupBy(bookProposals, p => p.uid).values()) {
            const first = entryProposals[0];
            const entryEl = $('<div class="lbl-preview-entry">')
                .append($('<div class="lbl-preview-entry-title">').text(first.title || first.terms.join(', ')));
            for (const proposal of entryProposals) {
                const checkbox = $('<input type="checkbox">').prop('checked', true);
                const formsTitle = proposal.forms.join(', ');
                const keyInput = $('<input type="text" class="text_pole lbl-key-input">').val(proposal.keys.join(', ')).attr('title', formsTitle);
                const where = proposal.fields.includes('keysecondary')
                    ? (proposal.fields.includes('key') ? t`primary + secondary` : t`secondary`)
                    : '';
                const row = $('<div class="lbl-proposal">').append(
                    $('<label class="checkbox_label lbl-proposal-label">').append(
                        checkbox,
                        $('<span class="lbl-source">').text(proposal.source),
                        $('<i class="fa-solid fa-arrow-right-long lbl-arrow">'),
                        $('<b class="lbl-base">').text(proposal.base).attr('title', formsTitle),
                    ),
                    keyInput,
                );
                if (where) row.append($('<small class="lbl-badge">').text(where));
                checkbox.on('change', () => row.toggleClass('lbl-unchecked', !checkbox.prop('checked')));
                rows.push({ proposal, checkbox, keyInput, row, visible: true, text: `${book} ${first.title} ${proposal.source} ${proposal.base}`.toLowerCase() });
                entryEl.append(row);
            }
            bookEl.append(entryEl);
        }
        list.append(bookEl);
    }

    const filter = $('<input type="search" class="text_pole lbl-search">').attr('placeholder', t`Filter…`);
    filter.on('input', () => {
        const query = String(filter.val()).toLowerCase();
        for (const r of rows) {
            r.visible = r.text.includes(query);
            r.row.toggle(r.visible);
        }
        const hasVisibleChild = (el, selector) => [...el.querySelectorAll(selector)].some(child => child.style.display !== 'none');
        list.find('.lbl-preview-entry').each((_, el) => { $(el).toggle(hasVisibleChild(el, '.lbl-proposal')); });
        list.find('.lbl-preview-book').each((_, el) => { $(el).toggle(hasVisibleChild(el, '.lbl-preview-entry')); });
    });
    const setVisible = (checked) => {
        for (const r of rows) {
            if (!r.visible) continue;
            r.checkbox.prop('checked', checked);
            r.row.toggleClass('lbl-unchecked', !checked);
        }
    };
    root.append(
        $('<div class="lbl-toolbar">').append(
            filter,
            iconButton('fa-check-double', t`Select all`, () => setVisible(true)),
            iconButton('fa-xmark', t`Select none`, () => setVisible(false)),
        ),
        list,
    );

    let accepted = null;
    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        okButton: t`Apply`,
        cancelButton: t`Cancel`,
        // `large` only sets the height; `wider` gives the key inputs room.
        large: true,
        wider: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        onClosing: (p) => {
            if (p.result !== ctx.POPUP_RESULT.AFFIRMATIVE) return true;
            const chosen = [];
            for (const r of rows) {
                if (!r.checkbox.prop('checked')) continue;
                const { keys, invalid } = parseKeysInput(String(r.keyInput.val()));
                if (invalid.length) {
                    r.keyInput.addClass('lbl-invalid').trigger('focus');
                    toastr.error(t`Invalid regex: ${invalid[0]}`, EXTENSION_TITLE);
                    return false;
                }
                r.keyInput.removeClass('lbl-invalid');
                if (keys.length) chosen.push({ ...r.proposal, keys });
            }
            if (!chosen.length) {
                toastr.warning(t`Nothing is selected.`, EXTENSION_TITLE);
                return false;
            }
            accepted = chosen;
            return true;
        },
    });

    const result = await popup.show();
    return result === ctx.POPUP_RESULT.AFFIRMATIVE ? accepted : null;
}

/**
 * @param {number} bookCount
 * @param {{name: string}} lang
 * @returns {Promise<{allLanguages: boolean}|null>}
 */
export async function confirmRemoval(bookCount, lang) {
    const ctx = SillyTavern.getContext();
    const inputId = 'lorebook_localizer_remove_all_languages';
    const content = $('<div>').append(
        $('<h3>').text(t`Remove added keys?`),
        $('<div>').text(t`Keys added by this extension will be removed from ${bookCount} lorebooks. Original keys and added keys you edited by hand stay.`),
    );
    const popup = new ctx.Popup(content, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: t`Remove`,
        cancelButton: t`Cancel`,
        customInputs: [{ id: inputId, label: t`All languages, not only ${lang.name}`, type: 'checkbox', defaultState: false }],
    });
    const result = await popup.show();
    if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return null;
    return { allLanguages: Boolean(popup.inputResults?.get(inputId)) };
}
