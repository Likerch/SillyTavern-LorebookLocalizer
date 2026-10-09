// The "Expand the world" window next to LoreBook Creator's panel: not modal, so LBC's editor stays usable. The window
// only draws and reports clicks; expand.js does the work. Book data (titles, keys, texts, model replies) always goes
// in through .text(), never as HTML.
import { t } from '../settings.js';
import { EXPAND_SIZES } from './expand-core.js';
import { CONTENT_LANGUAGES } from './language.js';
import { contentLanguageLabels } from './language-ui.js';

const ROOT_ID = 'lbl-lbc-expand';

/**
 * @typedef {object} ExpandActions
 * @property {() => void} close
 * @property {(avatar: string) => void} bind a group member was chosen
 * @property {() => void} followChat bind the window to the current chat's character
 * @property {() => void} openBook load the target book into LBC's editor
 * @property {(language: string) => void} setLanguage
 * @property {(count: number) => number} setMessages returns the value as stored
 * @property {(comment: string, size: number) => void} expand
 * @property {() => void} stop
 * @property {() => void} undo
 * @property {(ref: any) => void} openEntry
 * @property {(text: string) => Promise<boolean>|boolean} send false: the text was not taken
 * @property {(pid: string) => void} accept
 * @property {(pid: string) => void} reject
 * @property {(pid: string) => void} openProposal
 * @property {() => void} restart
 * @property {(on: boolean) => void} setSaveNow
 *
 * @typedef {object} HeaderModel
 * @property {boolean} group
 * @property {{avatar: string, name: string}[]} members
 * @property {{avatar: string, name: string}|null} character
 * @property {string|null} book
 * @property {string|null} status TargetStatus or `created`
 * @property {string|null} mismatch the current chat's character when the window works for another one
 * @property {boolean} savingOff
 * @property {boolean} archives the book has CarrotKernel archives
 * @property {string} language
 * @property {number} messages
 *
 * @typedef {object} ResultItem
 * @property {string} title
 * @property {string} [detail]
 * @property {any} ref
 *
 * @typedef {object} ResultModel
 * @property {string} summary
 * @property {string} saved
 * @property {ResultItem[]} added
 * @property {ResultItem[]} updated
 * @property {string[]} notes
 * @property {boolean} undoable
 *
 * @typedef {object} ProposalModel
 * @property {string} pid
 * @property {'add'|'update'} op
 * @property {string} title
 * @property {string} [target] `#3 Title` of an update
 * @property {string} [category]
 * @property {string[]} keys
 * @property {string} text
 * @property {string} [reason]
 * @property {'pending'|'accepted'|'rejected'|'skipped'} state
 * @property {string} [note]
 * @property {boolean} canOpen
 *
 * @typedef {object} SessionModel
 * @property {string} owner
 * @property {{role: 'user'|'assistant', text: string, proposals?: ProposalModel[]}[]} turns
 * @property {boolean} saveNow
 * @property {boolean} saveNowAvailable
 */

/**
 * @param {string} icon Font Awesome name without `fa-`
 * @param {string} text
 * @param {string} [extra] more classes
 */
function button(icon, text, extra = '') {
    return $('<button>', { type: 'button', class: `menu_button lbl-x-button ${extra}`.trim() })
        .append($('<i>').addClass(`fa-solid fa-${icon}`), $('<span>').text(text));
}

/** @returns {Record<string, string>} */
function statusLabels() {
    return {
        primary: t`primary book`,
        extra: t`additional book (the primary one is a BunnyMo pack)`,
        create: t`will be created and attached`,
        createExtra: t`will be created as an additional book (the primary one is a BunnyMo pack)`,
        import: t`the card's embedded book will be imported and attached`,
        created: t`created and attached`,
    };
}

export class ExpandWindow {
    /** @param {ExpandActions} actions */
    constructor(actions) {
        this.actions = actions;
        this.root = $('<div>', { id: ROOT_ID, class: 'lbl-x', role: 'dialog', 'aria-label': t`Expand the world` });
        this.busy = false;
        this.#build();
        $('body').append(this.root);

        // Escape closes this window, not LBC's panel under it (LBC closes on any Escape on the page).
        this.onKeyDown = (event) => {
            if (event.key !== 'Escape' || !this.isOpen() || !this.root[0].contains(document.activeElement)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.actions.close();
        };
        document.addEventListener('keydown', this.onKeyDown, true);
    }

    #build() {
        const head = $('<div class="lbl-x-head">').append(
            $('<i class="fa-solid fa-earth-europe"></i>'),
            $('<b>').text(t`Expand the world`),
            $('<span class="lbl-x-close fa-solid fa-xmark" tabindex="0">').attr('title', t`Close`).on('click', () => this.actions.close()),
        );

        // Who and where.
        this.characterValue = $('<span class="lbl-x-value">');
        this.memberSelect = $('<select class="text_pole lbl-x-select">').on('change', () => this.actions.bind(String(this.memberSelect.val())));
        this.followButton = button('arrows-rotate', t`To the current chat`, 'lbl-x-small').on('click', () => this.actions.followChat());
        this.bookValue = $('<span class="lbl-x-value lbl-x-book">');
        this.bookStatus = $('<span class="lbl-x-badge">');
        this.openBookButton = button('folder-open', t`Open in the editor`, 'lbl-x-small').on('click', () => this.actions.openBook());
        this.languageSelect = $('<select class="text_pole lbl-x-select">');
        const labels = contentLanguageLabels();
        for (const language of CONTENT_LANGUAGES) this.languageSelect.append($('<option>', { value: language, text: labels[language] }));
        this.languageSelect.on('change', () => this.actions.setLanguage(String(this.languageSelect.val())));
        this.messagesInput = $('<input type="number" class="text_pole lbl-x-number" min="0" max="200" step="1">')
            .on('change', () => this.messagesInput.val(this.actions.setMessages(Number(this.messagesInput.val()))));
        this.notices = $('<div class="lbl-x-notices">');
        const row = (label, ...content) => $('<div class="lbl-x-row">').append($('<span class="lbl-x-label">').text(label), ...content);
        const info = $('<div class="lbl-x-info">').append(
            row(t`Character`, this.characterValue, this.memberSelect, this.followButton),
            row(t`Book`, this.bookValue, this.bookStatus, this.openBookButton),
            row(t`Entries`, this.languageSelect),
            $('<div class="lbl-x-row">').append(
                $('<span class="lbl-x-label">').text(t`Chat`),
                $('<span>').text(t`use the latest`),
                this.messagesInput,
                $('<span>').text(t`messages`),
            ),
            this.notices,
        );

        this.tabs = $('<div class="lbl-x-tabs">');
        const tab = (id, icon, text) => $('<div class="lbl-x-tab" tabindex="0">').attr('data-tab', id)
            .append($('<i>').addClass(`fa-solid fa-${icon}`), $('<span>').text(text))
            .on('click keydown', (event) => {
                if (event.type === 'keydown' && event.key !== 'Enter') return;
                this.setTab(id);
            });
        this.tabs.append(tab('oneshot', 'wand-magic-sparkles', t`One click`), tab('dialog', 'comments', t`Dialog`));

        this.oneshot = this.#buildOneShot();
        this.dialog = this.#buildDialog();
        const body = $('<div class="lbl-x-body">').append(this.oneshot, this.dialog);
        this.root.append(head, info, this.tabs, body);
        this.setTab('oneshot');
    }

    #buildOneShot() {
        this.comment = $('<textarea class="text_pole lbl-x-comment" rows="4">')
            .attr('placeholder', t`What to add or develop. For example: more about her past and the guild she left; the town where she grew up.`);
        this.sizeSelect = $('<select class="text_pole lbl-x-select">');
        for (const size of EXPAND_SIZES) this.sizeSelect.append($('<option>', { value: size, text: t`about ${size} entries` }));
        this.expandButton = button('wand-magic-sparkles', t`Expand`, 'lbl-x-primary').on('click', () => {
            this.actions.expand(String(this.comment.val() ?? ''), Number(this.sizeSelect.val()));
        });
        this.oneshotStop = button('stop', t`Stop`, 'lbl-x-stop').hide().on('click', () => this.actions.stop());
        this.oneshotStatus = $('<div class="lbl-x-status">');
        this.result = $('<div class="lbl-x-result">');
        return $('<div class="lbl-x-pane" data-pane="oneshot">').append(
            $('<div class="lbl-x-hint">').text(t`The model reads the character card, the latest messages and the lore that exists, then adds new entries and enriches existing ones. The result goes into the book at once; "Undo" takes it back.`),
            this.comment,
            $('<div class="lbl-x-actions">').append(this.sizeSelect, this.expandButton, this.oneshotStop),
            this.oneshotStatus,
            this.result,
        );
    }

    #buildDialog() {
        this.owner = $('<span class="lbl-x-owner">');
        this.restartButton = button('rotate-left', t`Start over`, 'lbl-x-small').on('click', () => this.actions.restart());
        this.chat = $('<div class="lbl-x-chat">');
        this.saveNow = $('<input type="checkbox">').on('change', () => this.actions.setSaveNow(this.saveNow.prop('checked')));
        this.saveNowRow = $('<label class="checkbox_label lbl-x-savenow">').append(this.saveNow, $('<span>').text(t`Save to the book at once`))
            .attr('title', t`Each accepted proposal is written into the book right away. Off: it goes into LoreBook Creator's editor only.`);
        this.input = $('<textarea class="text_pole lbl-x-input" rows="2">')
            .attr('placeholder', t`A message to the model. Enter sends, Shift+Enter is a new line.`)
            .on('keydown', (event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
                event.preventDefault();
                void this.#send();
            });
        this.sendButton = button('paper-plane', t`Send`, 'lbl-x-primary').on('click', () => void this.#send());
        this.dialogStop = button('stop', t`Stop`, 'lbl-x-stop').hide().on('click', () => this.actions.stop());
        this.dialogStatus = $('<div class="lbl-x-status">');
        return $('<div class="lbl-x-pane" data-pane="dialog">').append(
            $('<div class="lbl-x-actions lbl-x-session">').append(this.owner, this.restartButton),
            this.chat,
            this.dialogStatus,
            this.saveNowRow,
            $('<div class="lbl-x-compose">').append(this.input, this.sendButton, this.dialogStop),
        );
    }

    async #send() {
        if (this.busy) return;
        const text = String(this.input.val() ?? '').trim();
        if (!text) return;
        this.input.val('');
        const taken = await this.actions.send(text);
        if (!taken && !String(this.input.val() ?? '').trim()) this.input.val(text);
    }

    /** @param {'oneshot'|'dialog'} id */
    setTab(id) {
        this.tabs.children().each((_, element) => { $(element).toggleClass('active', element.dataset.tab === id); });
        this.oneshot.toggle(id === 'oneshot');
        this.dialog.toggle(id === 'dialog');
        this.currentTab = id;
        if (id === 'dialog') this.#scrollChat();
    }

    show() {
        this.root.addClass('lbl-x-open');
        const focus = this.currentTab === 'dialog' ? this.input : this.comment;
        setTimeout(() => focus.trigger('focus'), 0);
    }

    hide() {
        this.root.removeClass('lbl-x-open');
    }

    isOpen() {
        return this.root.hasClass('lbl-x-open');
    }

    /**
     * Where the window stands: left of LBC's drawer, at the left edge over LBC's centered panel, or alone at the right.
     * @param {{lbcOpen: boolean, centered: boolean}} placement
     */
    place({ lbcOpen, centered }) {
        this.root.toggleClass('lbl-x-alone', !lbcOpen).toggleClass('lbl-x-center', lbcOpen && centered);
    }

    /** @param {number} size */
    setSize(size) {
        this.sizeSelect.val(String(EXPAND_SIZES.includes(size) ? size : EXPAND_SIZES[1]));
    }

    /** @param {HeaderModel} model */
    renderHeader(model) {
        const labels = statusLabels();
        this.memberSelect.empty().toggle(model.group);
        if (model.group) {
            this.memberSelect.append($('<option>', { value: '', text: t`Choose a member…` }));
            for (const member of model.members) this.memberSelect.append($('<option>', { value: member.avatar, text: member.name }));
            this.memberSelect.val(model.character?.avatar ?? '');
        }
        this.characterValue.text(model.character?.name ?? t`no character`).toggle(!model.group);
        this.followButton.toggle(Boolean(model.mismatch)).attr('title', model.mismatch ? t`The current chat is with ${model.mismatch}` : '');
        this.bookValue.text(model.book ? `«${model.book}»` : '—');
        this.bookStatus.text(model.status ? labels[model.status] ?? '' : '').toggle(Boolean(model.status))
            .toggleClass('lbl-x-badge-new', model.status === 'create' || model.status === 'createExtra' || model.status === 'import');
        this.openBookButton.toggle(Boolean(model.book));
        this.languageSelect.val(model.language);
        this.messagesInput.val(model.messages);

        this.notices.empty();
        const notice = (text, warning = false) => this.notices.append($('<div class="lbl-x-notice">').toggleClass('lbl-warning', warning).text(text));
        if (model.mismatch && model.character) {
            notice(t`This window works for ${model.character.name}, the current chat is with ${model.mismatch}: the chat's messages are not used.`, true);
        }
        if (model.group && !model.character) notice(t`Group chat: choose whose world to expand.`);
        if (model.savingOff) notice(t`Lossless saving is off: an expansion cannot write into the book. Turn it on in the LoreBook Creator section of Lorebook Localizer.`, true);
        if (model.archives) notice(t`The book has CarrotKernel archives: expansions never change them (their first key is the character's name).`);
        this.expandButton.prop('disabled', this.busy || model.savingOff || !model.character);
    }

    /**
     * @param {boolean} busy
     * @param {'oneshot'|'dialog'|null} [mode] where the Stop button shows
     */
    setBusy(busy, mode = null) {
        this.busy = busy;
        this.root.toggleClass('lbl-x-busy', busy);
        this.expandButton.prop('disabled', busy);
        this.sendButton.prop('disabled', busy);
        this.oneshotStop.toggle(busy && mode === 'oneshot');
        this.dialogStop.toggle(busy && mode === 'dialog');
        this.expandButton.toggle(!(busy && mode === 'oneshot'));
        this.sendButton.toggle(!(busy && mode === 'dialog'));
        this.chat.find('.lbl-x-card button').prop('disabled', busy);
        this.result.find('button').prop('disabled', busy);
    }

    /**
     * @param {'oneshot'|'dialog'} mode
     * @param {string} text
     * @param {'info'|'error'|'success'} [kind]
     */
    setStatus(mode, text, kind = 'info') {
        const target = mode === 'oneshot' ? this.oneshotStatus : this.dialogStatus;
        target.text(text).attr('data-kind', kind).toggle(Boolean(text));
    }

    /** @param {ResultModel|null} model */
    renderResult(model) {
        this.result.empty();
        if (!model) return;
        if (model.summary) this.result.append($('<div class="lbl-x-summary">').text(model.summary));
        if (model.saved) this.result.append($('<div class="lbl-x-saved">').text(model.saved));
        const list = (title, items) => {
            if (!items.length) return;
            const ul = $('<ul class="lbl-x-list">');
            for (const item of items) {
                const link = $('<span class="lbl-x-link" role="button" tabindex="0">').text(item.title || '?')
                    .attr('title', t`Open in LoreBook Creator's editor`)
                    .on('click keydown', (event) => {
                        if (event.type === 'keydown' && event.key !== 'Enter') return;
                        this.actions.openEntry(item.ref);
                    });
                ul.append($('<li>').append(link, item.detail ? $('<small>').text(` ${item.detail}`) : ''));
            }
            this.result.append($('<div class="lbl-x-section">').text(title), ul);
        };
        list(t`Added (${model.added.length})`, model.added);
        list(t`Enriched (${model.updated.length})`, model.updated);
        if (model.notes.length) {
            const ul = $('<ul class="lbl-x-list lbl-x-notes">');
            for (const note of model.notes) ul.append($('<li>').text(note));
            this.result.append($('<div class="lbl-x-section">').text(t`Skipped`), ul);
        }
        if (model.undoable) {
            this.result.append($('<div class="lbl-x-actions">').append(
                button('rotate-left', t`Undo`, 'lbl-x-undo').attr('title', t`Put the book and the editor back as they were before this expansion.`)
                    .on('click', () => this.actions.undo()),
            ));
        }
    }

    /** @param {SessionModel|null} model */
    renderSession(model) {
        this.chat.empty();
        this.owner.text(model?.owner ?? '');
        this.restartButton.toggle(Boolean(model?.turns.length));
        this.saveNow.prop('checked', Boolean(model?.saveNow)).prop('disabled', !model?.saveNowAvailable);
        this.saveNowRow.toggleClass('lbl-lbc-unavailable', !model?.saveNowAvailable);
        if (!model?.turns.length) {
            this.chat.append($('<div class="lbl-x-hint lbl-x-empty">').text(t`Tell the model what you would like to develop: a character's past, a place, a faction. It answers with ideas and questions and proposes entries; you accept or reject each one.`));
            return;
        }
        for (const turn of model.turns) {
            const bubble = $('<div class="lbl-x-msg">').addClass(turn.role === 'user' ? 'lbl-x-msg-user' : 'lbl-x-msg-ai');
            bubble.append($('<div class="lbl-x-msg-text">').text(turn.text || (turn.role === 'assistant' ? '…' : '')));
            for (const proposal of turn.proposals ?? []) bubble.append(this.#card(proposal));
            this.chat.append(bubble);
        }
        this.#scrollChat();
    }

    /** @param {ProposalModel} proposal */
    #card(proposal) {
        const card = $('<div class="lbl-x-card">').addClass(`lbl-x-card-${proposal.state}`);
        const badge = proposal.op === 'add' ? t`New entry` : t`Addition to ${proposal.target ?? ''}`;
        card.append($('<div class="lbl-x-card-head">').append(
            $('<span class="lbl-x-badge">').text(badge),
            $('<b>').text(proposal.title),
            proposal.category ? $('<small>').text(proposal.category) : '',
        ));
        if (proposal.keys.length) card.append($('<div class="lbl-x-card-keys">').text(`${t`Keys`}: ${proposal.keys.join(', ')}`));
        if (proposal.text) card.append($('<div class="lbl-x-card-text">').text(proposal.text));
        if (proposal.reason) card.append($('<div class="lbl-x-card-reason">').text(proposal.reason));
        const actions = $('<div class="lbl-x-actions">');
        if (proposal.state === 'pending') {
            actions.append(
                button('check', t`Accept`, 'lbl-x-small lbl-x-accept').on('click', () => this.actions.accept(proposal.pid)),
                button('xmark', t`Reject`, 'lbl-x-small').on('click', () => this.actions.reject(proposal.pid)),
            );
        } else {
            const states = { accepted: t`Accepted`, rejected: t`Rejected`, skipped: t`Not added` };
            actions.append($('<span class="lbl-x-state">').text(proposal.note ? `${states[proposal.state]}: ${proposal.note}` : states[proposal.state]));
            if (proposal.canOpen) {
                actions.append(button('pen-to-square', t`Open in the editor`, 'lbl-x-small').on('click', () => this.actions.openProposal(proposal.pid)));
            }
        }
        card.append(actions);
        if (this.busy) card.find('button').prop('disabled', true);
        return card;
    }

    #scrollChat() {
        const element = this.chat[0];
        if (element) element.scrollTop = element.scrollHeight;
    }

    destroy() {
        document.removeEventListener('keydown', this.onKeyDown, true);
        this.root.remove();
    }
}
