// The LoreBook Creator section of the extension's drawer in the Extensions panel.
import { getSettings, saveSettings, t } from '../settings.js';
import { LBC } from './adapter.js';
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

    section.append(statusLine, enabledRow, untestedRow);
    drawerContent.append(section);

    /** @param {import('./module.js').LbcStatus} status */
    const render = (status) => {
        const { text, warning } = describeStatus(status);
        statusLine.text(text).toggleClass('lbl-warning', warning).attr('title', status.name ? `${lbcFolder()} · ${status.compat}` : '');
        enabledRow.toggle(status.state === 'ready');
        untestedRow.toggle(status.state === 'ready' && status.compat !== 'tested');
    };
    render(getLbcStatus());
    onLbcStatusChange(render);
}
