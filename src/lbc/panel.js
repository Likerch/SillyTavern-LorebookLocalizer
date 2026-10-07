// The LoreBook Creator section of the extension's drawer in the Extensions panel.
import { getProfiles } from '../connection.js';
import { clampSetting, getSettings, NUMBER_LIMITS, saveSettings, t } from '../settings.js';
import { LBC } from './adapter.js';
import { LBC_PROFILE_INHERIT } from './channel-core.js';
import { CONTENT_LANGUAGES } from './language.js';
import { contentLanguageLabels, syncContentLanguageClass } from './language-ui.js';
import { applySettings, getLbcStatus, lbcFolder, onLbcStatusChange } from './module.js';

const SECTION_CLASS = 'lbl-lbc-settings';

/**
 * @param {import('./module.js').LbcStatus} status
 * @returns {{text: string, warning: boolean}}
 */
function describeStatus(status) {
    const version = status.version || '?';
    switch (status.state) {
        case 'searching':
            return { text: t`Looking for LoreBook Creator…`, warning: false };
        case 'missing':
            return { text: t`LoreBook Creator is not installed or is disabled.`, warning: false };
        case 'failed':
            return { text: t`LoreBook Creator ${version} is installed but did not start. Reload the page; if it stays like this, see the browser console.`, warning: true };
    }
    if (!status.active) return { text: t`LoreBook Creator ${version} found. Russian support is off.`, warning: false };
    if (status.compat === 'tested') return { text: t`LoreBook Creator ${version}: Russian support is on.`, warning: false };
    const tested = LBC.testedVersions.join(', ');
    return status.domParts
        ? { text: t`LoreBook Creator ${version} was not tested (tested: ${tested}). Everything is on at your request; if its window looks broken, turn the option below off.`, warning: true }
        : { text: t`LoreBook Creator ${version} was not tested (tested: ${tested}). Parts that depend on its window are off.`, warning: true };
}

/**
 * A checkbox bound to a boolean setting; parts are started or stopped right away.
 * @param {string} key
 * @param {string} label
 * @param {string} hint
 */
function partCheckbox(key, label, hint) {
    const settings = getSettings();
    const input = $('<input type="checkbox">').prop('checked', Boolean(settings[key]));
    input.on('change', () => {
        settings[key] = input.prop('checked');
        saveSettings();
        applySettings();
    });
    return $('<label class="checkbox_label lbl-option">').append(input, $('<span>').text(label)).attr('title', hint);
}

/**
 * @param {string} key
 * @param {string} label
 * @param {{step?: number, hint?: string}} [options]
 */
function numberField(key, label, { step = 1, hint = '' } = {}) {
    const settings = getSettings();
    const [min, max] = NUMBER_LIMITS[key];
    const input = $('<input type="number" class="text_pole lbl-number">').attr({ min, max, step }).val(settings[key]);
    input.on('change', () => {
        settings[key] = clampSetting(key, input.val());
        input.val(settings[key]);
        saveSettings();
    });
    return $('<label class="lbl-field">').append($('<span class="lbl-field-label">').text(label), input).attr('title', hint);
}

/** The profile list is read again whenever the select is opened: profiles may be added in the meantime. */
function profileField() {
    const settings = getSettings();
    const select = $('<select class="text_pole">');
    const fill = () => {
        const profiles = getProfiles() ?? [];
        const keysProfile = profiles.find(profile => profile.id === settings.profileId)?.name ?? t`current connection`;
        select.empty().append(
            $('<option>', { value: LBC_PROFILE_INHERIT, text: t`As for keys (${keysProfile})` }),
            $('<option>', { value: '', text: t`Current connection` }),
            ...profiles.map(profile => $('<option>', { value: profile.id, text: profile.name })),
        );
        const known = settings.lbcProfileId === LBC_PROFILE_INHERIT || settings.lbcProfileId === ''
            || profiles.some(profile => profile.id === settings.lbcProfileId);
        select.val(known ? settings.lbcProfileId : LBC_PROFILE_INHERIT);
    };
    fill();
    select.on('focus mousedown', fill);
    select.on('change', () => {
        settings.lbcProfileId = String(select.val());
        saveSettings();
    });
    return $('<label class="lbl-field">').append($('<span class="lbl-field-label">').text(t`Connection for LoreBook Creator`), select)
        .attr('title', t`A profile sends LoreBook Creator's requests to its own model without its RP preset; the current connection uses the active API with the settings below instead of the RP preset's.`);
}

function reasoningField() {
    const settings = getSettings();
    const select = $('<select class="text_pole">').append(
        $('<option>', { value: 'off', text: t`Off (none on OpenRouter)` }),
        $('<option>', { value: 'auto', text: t`As the API decides` }),
        $('<option>', { value: 'low', text: t`Low` }),
        $('<option>', { value: 'medium', text: t`Medium` }),
        $('<option>', { value: 'high', text: t`High` }),
    ).val(settings.lbcReasoning);
    select.on('change', () => {
        settings.lbcReasoning = String(select.val());
        saveSettings();
    });
    return $('<label class="lbl-field">').append($('<span class="lbl-field-label">').text(t`Reasoning`), select)
        .attr('title', t`Reasoning makes lorebook JSON slower and dearer and rarely better. DeepSeek on OpenRouter reasons unless told not to.`);
}

function contentLanguageField() {
    const settings = getSettings();
    const labels = contentLanguageLabels();
    const select = $('<select class="text_pole">');
    for (const language of CONTENT_LANGUAGES) select.append($('<option>', { value: language, text: labels[language] }));
    select.val(settings.lbcContentLanguage);
    // The same setting has a switch in LoreBook Creator's header.
    select.on('focus mousedown', () => select.val(getSettings().lbcContentLanguage));
    select.on('change', () => {
        settings.lbcContentLanguage = String(select.val());
        saveSettings();
        syncContentLanguageClass();
    });
    return $('<label class="lbl-field">').append($('<span class="lbl-field-label">').text(t`Language of entries`), select)
        .attr('title', t`What LoreBook Creator writes in. English entries are the model's strongest and cheapest; their keys get Russian forms too. Categories always keep LoreBook Creator's English names.`);
}

/** @param {JQuery} drawerContent the content of the extension's drawer */
export function addLbcSettings(drawerContent) {
    if (!drawerContent.length || drawerContent.find(`.${SECTION_CLASS}`).length) return;
    const settings = getSettings();

    const section = $(`<div class="${SECTION_CLASS}">`);
    section.append($('<h4 class="lbl-lbc-title">').text(t`LoreBook Creator`));
    const statusLine = $('<div class="lbl-hint lbl-lbc-status">');

    const enabled = $('<input type="checkbox">').prop('checked', Boolean(settings.lbcEnabled));
    const enabledRow = $('<label class="checkbox_label lbl-option">')
        .append(enabled, $('<span>').text(t`Russian support for LoreBook Creator`))
        .attr('title', t`Russian interface, a clean and cheap generation channel, Russian keys and lossless saving for the LoreBook Creator extension.`);
    enabled.on('change', () => {
        settings.lbcEnabled = enabled.prop('checked');
        saveSettings();
        applySettings();
    });

    const untested = $('<input type="checkbox">').prop('checked', Boolean(settings.lbcAllowUntested));
    const untestedRow = $('<label class="checkbox_label lbl-option">')
        .append(untested, $('<span>').text(t`Also on an untested version`))
        .attr('title', t`Parts that depend on LoreBook Creator's window and texts were checked against specific versions only. On another version they may miss buttons or texts.`);
    untested.on('change', () => {
        settings.lbcAllowUntested = untested.prop('checked');
        saveSettings();
        applySettings();
    });

    const channelRow = partCheckbox('lbcChannel', t`Clean generation channel`,
        t`LoreBook Creator's requests go without the RP preset, the chat, lorebooks and other extensions' prompts, through the connection below.`);
    const channelOptions = $('<div class="lbl-grid lbl-lbc-options">').append(
        contentLanguageField(),
        profileField(),
        reasoningField(),
        numberField('lbcResponseTokens', t`Max response tokens`, { step: 500, hint: t`A whole lorebook in one reply needs room: 16000 fits about 50 entries.` }),
        numberField('lbcRequestTimeout', t`Timeout, seconds`, { step: 30, hint: t`0 = no limit.` }),
        numberField('lbcTemperature', t`Temperature`, { step: 0.05 }),
    );
    const savingRow = partCheckbox('lbcSaving', t`Lossless saving`,
        t`"Import to ST" and "Download JSON" keep the book name as typed (Cyrillic too), entry uids, other extensions' data and every field LoreBook Creator does not show. An existing book is overwritten only after asking, with a backup.`);
    const interfaceRow = partCheckbox('lbcInterface', t`Russian interface`,
        t`LoreBook Creator's window, settings and questions in Russian while SillyTavern's interface is Russian. Its machine translation button is hidden.`);
    const draftRow = partCheckbox('lbcDraft', t`Keep the draft across reloads`,
        t`LoreBook Creator keeps its editor in memory only. The draft is stored in this browser and comes back after a page reload.`);
    const parts = $('<div class="lbl-lbc-parts">').append(channelRow, channelOptions, savingRow, interfaceRow, draftRow);

    section.append(statusLine, enabledRow, untestedRow, parts);
    drawerContent.append(section);

    /** @param {import('./module.js').LbcStatus} status */
    const render = (status) => {
        const { text, warning } = describeStatus(status);
        statusLine.text(text).toggleClass('lbl-warning', warning).attr('title', status.name ? `${lbcFolder()} · ${status.compat}` : '');
        enabledRow.toggle(status.state === 'ready');
        untestedRow.toggle(status.state === 'ready' && status.compat !== 'tested');
        parts.toggle(status.active);
        for (const row of [savingRow, interfaceRow]) row.toggleClass('lbl-lbc-unavailable', !status.domParts).attr('aria-disabled', String(!status.domParts));
    };
    render(getLbcStatus());
    onLbcStatusChange(render);
}
