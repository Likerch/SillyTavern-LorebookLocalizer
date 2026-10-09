// "Expand the world" for LoreBook Creator: new lore around a character the player likes, written into that
// character's lorebook. Two ways:
// - one click: a comment and a size; the answer is merged into the book at once, with a summary and "Undo";
// - a dialog: the model answers with ideas and questions and proposes entries, the player accepts or rejects each.
// A character without a book gets one («<Name> — лор», or its card's embedded book imported) attached to it. A BunnyMo
// pack as the primary book is never written: a book of ours is added to the character's additional books instead.
//
// The work happens in LBC's editor (it holds the target book) and goes into the book through lossless saving in
// patch mode, so the book's other entries, uids, regex keys and other extensions' data stay. Requests go through the
// connection chosen for LoreBook Creator, never through LBC's own generation. Pure logic: expand-core.js.
import { EXTENSION_TITLE } from '../constants.js';
import { createRequestFn, resolveConnection } from '../connection.js';
import { isProtectedBook } from '../lorebook.js';
import { clampSetting, getSettings, saveSettings, t } from '../settings.js';
import {
    charUpdateAddAuxWorld, charUpdatePrimaryWorld, selected_world_info, setWorldInfoButtonClass, world_info,
} from '../st.js';
import { isTimeoutError, RequestTimeoutError } from '../translator.js';
import {
    isLbcGenerating, isLbcPanelCentered, isLbcPanelOpen, LBC, lbcEntryText, lbcRawEntryList, showLbcEntries,
    syncLbcEntryForm,
} from './adapter.js';
import { pairLoadedEntries } from './book.js';
import { excerpt, resolveLbcProfileId } from './channel-core.js';
import { openLbcStore } from './draft.js';
import {
    addAssistantTurn, adoptCategories, applyPlan, buildDialogMessages, buildDigest, buildLoreContext, buildOneShotMessages,
    cardFields, chooseTarget, createSession, EXPAND_SIZES, escapeMessages, foldTitle, historyMessages, otherBookItems,
    parseExpandReply, parseSession, planMerge, proposalTitle, recentMessages, restoreEditorSnapshot, restoreMacros,
    retryMessage, selectedGreeting, serializeSession, sessionKey, stripCategory, takeEditorSnapshot, trimHistory,
} from './expand-core.js';
import { ExpandWindow } from './expand-ui.js';
import { syncContentLanguageClass } from './language-ui.js';
import { entryLinks } from './links.js';
import { isLosslessSavingOn, saveEditorToBook } from './saving.js';

const FOOTER_CLASS = 'lbl-lbc-expand-footer';
const WAND_ID = 'lbl_lbc_expand_wand';

/** @param {string} avatar */
const avatarKey = (avatar) => String(avatar ?? '').replace(/\.[^/.]+$/, '');
const stopReason = () => new DOMException('Stopped by user', 'AbortError');
/** @param {unknown} error */
const isAbort = (error) => /** @type {any} */ (error)?.name === 'AbortError';

/**
 * @typedef {object} Target the book an expansion writes to, ready
 * @property {string} book
 * @property {string} status TargetStatus, or `created` once this window created and attached it
 * @property {number} chid
 * @property {any} character
 *
 * @typedef {object} LastExpansion what "Undo" puts back
 * @property {string} book
 * @property {any} bookBefore
 * @property {import('./expand-core.js').EditorSnapshot} editorBefore
 * @property {any[]} list the editor list the expansion went into
 */

/** @type {import('./module.js').LbcPart} */
export const expandPart = {
    id: 'expand',
    setting: 'lbcExpand',
    needsDom: true,
    start(scope, env) {
        const api = env.api();
        if (!api?.getData()) {
            env.log('expand: no LBC API, "Expand the world" is off');
            return;
        }
        const ctx = SillyTavern.getContext();
        // SillyTavern reassigns `characters`, `chat` and `chat_metadata`: read them from a fresh context every time.
        const live = () => SillyTavern.getContext();
        const store = openLbcStore();

        /** @type {{avatar: string, name: string}|null} The character the window works for. */
        let bound = null;
        /** @type {{book: string, status: string}|null} The planned or prepared target, for the header. */
        let shownTarget = null;
        let archives = false;
        let busy = false;
        /** @type {AbortController|null} */
        let running = null;
        /** @type {LastExpansion|null} */
        let lastExpansion = null;
        /** Books backed up during this page session: an expansion backs a book up once, not on every save. */
        const backedUp = new Set();
        /** @type {{list: any[], book: string}|null} An empty book put into the editor by us (LBC refuses to open those). */
        let emptyBookList = null;

        /** @type {import('./expand-core.js').DialogSession|null} */
        let session = null;
        /** Digest ids of each model turn of this page session (they do not survive a reload): turn index → ids. */
        const turnIds = new Map();
        /** Entry each accepted proposal went into: pid → entry. */
        const appliedEntries = new Map();
        /** Books created by this window, for the header ("created and attached"). */
        const createdBooks = new Set();

        const ui = new ExpandWindow({
            close: () => ui.hide(),
            bind: (avatar) => { void bindTo(avatar || null); },
            followChat: () => { void bindTo(chatCharacters().suggested); },
            openBook: () => { void openBook(); },
            setLanguage: (language) => {
                getSettings().lbcContentLanguage = language;
                saveSettings();
                syncContentLanguageClass();
            },
            setMessages: (count) => {
                const settings = getSettings();
                settings.lbcExpandMessages = Math.round(clampSetting('lbcExpandMessages', count));
                saveSettings();
                return settings.lbcExpandMessages;
            },
            expand: (comment, size) => { void runOneShot(comment, size); },
            stop: () => running?.abort(stopReason()),
            undo: () => { void undo(); },
            openEntry: (ref) => openEntry(ref),
            send: (text) => sendDialog(text),
            accept: (pid) => { void decide(pid, true); },
            reject: (pid) => { void decide(pid, false); },
            openProposal: (pid) => openProposal(pid),
            restart: () => { void restartSession(); },
            setSaveNow: (on) => {
                getSettings().lbcExpandSaveNow = on;
                saveSettings();
            },
        });
        scope.add(() => {
            running?.abort(stopReason());
            ui.destroy();
        });
        ui.setSize(getSettings().lbcExpandSize);

        // --- Who the window works for --------------------------------------------------------------------------------

        /** The characters of the current chat and the one an expansion most likely means. */
        function chatCharacters() {
            const context = live();
            const byAvatar = (avatar) => context.characters.find(character => character.avatar === avatar);
            if (context.groupId) {
                const group = context.groups.find(item => item.id === context.groupId);
                const members = (group?.members ?? []).map(byAvatar).filter(Boolean).map(character => ({ avatar: character.avatar, name: character.name }));
                const last = [...(context.chat ?? [])].reverse()
                    .find(message => !message.is_user && !message.is_system && members.some(member => member.avatar === message.original_avatar));
                return { group: true, members, suggested: last?.original_avatar ?? null };
            }
            const character = context.characters[context.characterId];
            return {
                group: false,
                members: character ? [{ avatar: character.avatar, name: character.name }] : [],
                suggested: character?.avatar ?? null,
            };
        }

        /** @param {string} avatar */
        const inCurrentChat = (avatar) => chatCharacters().members.some(member => member.avatar === avatar);

        /** @param {string|null} avatar */
        async function bindTo(avatar) {
            const character = avatar ? live().characters.find(item => item.avatar === avatar) : null;
            bound = character ? { avatar: character.avatar, name: character.name } : null;
            shownTarget = null;
            archives = false;
            await refreshHeader();
        }

        /**
         * The character's book as it is now, and what an expansion would do to get one.
         * @param {string} avatar
         */
        async function resolvePlan(avatar) {
            const chid = live().characters.findIndex(item => item.avatar === avatar);
            if (chid < 0) return null;
            await ctx.unshallowCharacter(chid);
            const character = live().characters[chid];
            const world = String(character?.data?.extensions?.world ?? '');
            const names = ctx.getWorldInfoNames();
            const primaryProtected = Boolean(world) && names.includes(world) && await isProtectedBook(world);
            const extraBooks = (world_info?.charLore ?? []).find(item => item?.name === avatarKey(avatar))?.extraBooks ?? [];
            const plan = chooseTarget({ name: character.name, world, characterBook: character.data?.character_book, extraBooks }, names, { primaryProtected });
            return plan ? { chid, character, plan } : null;
        }

        async function refreshHeader() {
            if (bound && !busy) {
                try {
                    const resolved = await resolvePlan(bound.avatar);
                    if (resolved) {
                        const created = createdBooks.has(resolved.plan.book) && (resolved.plan.status === 'primary' || resolved.plan.status === 'extra');
                        shownTarget = { book: resolved.plan.book, status: created ? 'created' : resolved.plan.status };
                    }
                } catch (error) {
                    console.warn(`[${EXTENSION_TITLE}] LBC expand: the character's book was not resolved`, error);
                }
            }
            renderHeader();
            await loadSession();
        }

        function renderHeader() {
            const chars = chatCharacters();
            const settings = getSettings();
            const current = chars.members.find(member => member.avatar === chars.suggested);
            ui.renderHeader({
                group: chars.group && (!bound || inCurrentChat(bound.avatar)),
                members: chars.members,
                character: bound,
                book: bound ? shownTarget?.book ?? null : null,
                status: bound ? shownTarget?.status ?? null : null,
                mismatch: bound && !inCurrentChat(bound.avatar) ? (current?.name ?? t`no character`) : null,
                savingOff: !isLosslessSavingOn(),
                archives,
                language: settings.lbcContentLanguage,
                messages: settings.lbcExpandMessages,
            });
        }

        // --- The target book -----------------------------------------------------------------------------------------

        /**
         * @param {number} chid
         * @param {string} name
         */
        async function setPrimaryBook(chid, name) {
            const context = live();
            const isOpen = Number(context.characterId) === chid && context.menuType !== 'create';
            if (isOpen && document.getElementById('character_world')) {
                await charUpdatePrimaryWorld(name);
            } else {
                await context.writeExtensionField(chid, 'world', name);
                if (isOpen) setWorldInfoButtonClass(chid, true);
            }
        }

        /**
         * The book an expansion writes to: created (or imported from the card) and attached when the character has
         * none.
         * @returns {Promise<Target>}
         */
        async function ensureTarget() {
            if (!bound) throw new Error(t`Choose a character first.`);
            const resolved = await resolvePlan(bound.avatar);
            if (!resolved) throw new Error(t`The character is not found.`);
            const { chid, character, plan } = resolved;
            if (plan.status === 'import' || plan.status === 'create' || plan.status === 'createExtra') {
                const book = plan.status === 'import'
                    ? ctx.convertCharacterBook(structuredClone(character.data.character_book))
                    : { entries: {} };
                await ctx.saveWorldInfo(plan.book, book, true);
                await ctx.updateWorldInfoList();
                if (plan.attach === 'primary') await setPrimaryBook(chid, plan.book);
                else charUpdateAddAuxWorld(character.avatar, plan.book);
                createdBooks.add(plan.book);
                toastr.success(plan.attach === 'primary'
                    ? t`The lorebook "${plan.book}" was created and attached to ${character.name}.`
                    : t`The lorebook "${plan.book}" was created and added to the additional books of ${character.name}.`, EXTENSION_TITLE);
                env.log('expand: book', plan.status, plan.book);
            }
            const status = createdBooks.has(plan.book) ? 'created' : plan.status;
            shownTarget = { book: plan.book, status };
            renderHeader();
            return { book: plan.book, status, chid, character };
        }

        /**
         * Whether LBC's editor holds the book: its entries were loaded from it (or saved into it), or it is an empty
         * book we put there.
         * @param {string} book
         */
        function holdsBook(book) {
            const data = api.getData();
            const source = `st:${book}`;
            if ([...data.entries].some(entry => entryLinks.get(entry)?.source === source)) return true;
            return emptyBookList?.book === book && emptyBookList.list === data.entries && data._loadedWorld === book;
        }

        /**
         * Puts the book into LBC's editor unless it is there already. LBC asks before replacing other work.
         * @param {string} book
         * @returns {Promise<boolean>} false: the user kept the editor as it was
         */
        async function ensureEditor(book) {
            if (holdsBook(book)) return true;
            const rawList = lbcRawEntryList(await ctx.loadWorldInfo(book));
            const data = api.getData();
            if (!rawList.length) {
                // LBC refuses to open an empty book: set its editor up ourselves.
                if (data.entries.length) {
                    const content = $('<div>').append(
                        $('<h3>').text(t`Replace the editor's entries?`),
                        $('<div>').text(t`LoreBook Creator's editor holds ${data.entries.length} entries of another book. They are replaced by the empty book "${book}"; unsaved changes there are lost.`),
                    );
                    const answer = await new ctx.Popup(content, ctx.POPUP_TYPE.CONFIRM, '', { okButton: t`Replace`, cancelButton: t`Cancel` }).show();
                    if (answer !== ctx.POPUP_RESULT.AFFIRMATIVE) return false;
                }
                data.entries = [];
                data.worldName = book;
                data._origWorldName = book;
                data._loadedWorld = book;
                emptyBookList = { list: data.entries, book };
                showLbcEntries(api);
                return true;
            }
            await api.openWorld(book);
            const now = api.getData();
            const pairs = pairLoadedEntries(now.entries, rawList, entry => entryLinks.has(entry));
            for (const { entry, raw } of pairs) entryLinks.set(entry, { raw: structuredClone(raw), source: `st:${book}` });
            if (!holdsBook(book)) return false;
            archives = buildDigest([...now.entries]).items.some(item => item.archive);
            renderHeader();
            return true;
        }

        async function openBook() {
            if (!guard()) return;
            const resolved = bound ? await resolvePlan(bound.avatar) : null;
            if (!resolved) {
                toastr.info(t`Choose a character first.`, EXTENSION_TITLE);
                return;
            }
            const { plan, character } = resolved;
            if (plan.status !== 'primary' && plan.status !== 'extra') {
                const question = {
                    create: t`${character.name} has no lorebook yet. Create "${plan.book}" and attach it to the character?`,
                    import: t`${character.name} has a lorebook embedded in the card. Import it as "${plan.book}" and attach it to the character?`,
                    createExtra: t`The primary book of ${character.name} is a BunnyMo pack, which is never written. Create "${plan.book}" and add it to the character's additional books?`,
                }[plan.status];
                const answer = await new ctx.Popup($('<div>').text(question), ctx.POPUP_TYPE.CONFIRM, '', { okButton: t`Create`, cancelButton: t`Cancel` }).show();
                if (answer !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
            }
            await withBusy(null, async () => {
                const target = await ensureTarget();
                if (await ensureEditor(target.book)) showLbcEntries(api);
                else toastr.info(t`The book was not opened: LoreBook Creator's editor was kept as it was.`, EXTENSION_TITLE);
            });
        }

        // --- Context and requests ------------------------------------------------------------------------------------

        /**
         * The other lorebooks of the character and the chat (titles and keys), without Maestro's, backups and BunnyMo.
         * @param {Target} target
         * @param {boolean} chatMatches
         */
        async function otherItems(target, chatMatches) {
            const character = target.character;
            const extra = (world_info?.charLore ?? []).find(item => item?.name === avatarKey(character.avatar))?.extraBooks ?? [];
            const names = [
                character.data?.extensions?.world,
                ...extra,
                chatMatches ? live().chatMetadata?.world_info : null,
                ...(chatMatches ? selected_world_info ?? [] : []),
            ];
            const existing = ctx.getWorldInfoNames();
            const unique = [...new Set(names.filter(name => typeof name === 'string' && name && name !== target.book && existing.includes(name)))];
            const books = [];
            for (const name of unique) books.push({ name, data: await ctx.loadWorldInfo(name) });
            return otherBookItems(books);
        }

        /**
         * @param {Target} target
         * @param {string} comment
         */
        async function gatherContext(target, comment) {
            const context = live();
            const matches = inCurrentChat(target.character.avatar);
            const chat = matches ? context.chat ?? [] : [];
            const card = cardFields(target.character, {
                scenario: matches ? String(context.chatMetadata?.scenario ?? '') : '',
                greeting: selectedGreeting(target.character, chat),
            });
            const messages = recentMessages(chat, getSettings().lbcExpandMessages);
            const others = await otherItems(target, matches);
            const built = buildLoreContext({ card, messages, book: target.book, entries: [...api.getData().entries], others, comment });
            archives = built.digest.items.some(item => item.archive);
            return { ...built, others };
        }

        /**
         * Sends a request through LoreBook Creator's connection with its timeout, and reads the answer; an unusable
         * answer is asked again once.
         * @param {{role: string, content: string}[]} messages
         * @param {'oneshot'|'dialog'} mode
         * @param {AbortSignal} signal
         * @param {(text: string) => void} status
         */
        async function ask(messages, mode, signal, status) {
            const settings = getSettings();
            const connection = resolveConnection({ profileId: resolveLbcProfileId(settings) });
            if (connection.kind === 'error') throw new Error(t`The connection profile cannot be used: ${connection.message}`);
            if (connection.kind === 'current' && live().onlineStatus === 'no_connection') {
                throw new Error(t`No API connection. Connect to an API or choose a connection profile.`);
            }
            const request = createRequestFn(connection, {
                responseTokens: settings.lbcResponseTokens,
                temperature: settings.lbcTemperature,
                reasoning: settings.lbcReasoning,
            });
            // generateRawData substitutes macros in every message: keep {{user}} and {{char}} for the entries.
            const send = (list) => (connection.kind === 'current' ? escapeMessages(list) : list);
            const custom = api.getData().customCategories ?? [];
            let attempt = messages;
            for (let round = 1; ; round++) {
                status(round === 1 ? t`Waiting for the model (${connection.label})…` : t`The answer was unusable, asking again (${connection.label})…`);
                const started = Date.now();
                const raw = await withTimeout((inner) => request(send(attempt), { useSchema: false, signal: inner }), signal);
                const text = restoreMacros(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''));
                env.log('expand: reply', mode, `${text.length} chars in ${Math.round((Date.now() - started) / 1000)} s`);
                const parsed = parseExpandReply(text, mode, custom);
                if ('value' in parsed) return parsed.value;
                console.warn(`[${EXTENSION_TITLE}] LBC expand: unusable reply (${parsed.problem})`, text);
                if (round >= 2) {
                    if (parsed.problem === 'empty') throw new Error(t`The model returned an empty reply.`);
                    throw new Error(t`The model did not answer with the expected JSON: «${excerpt(text)}». The full reply is in the browser console.`);
                }
                attempt = [...messages, retryMessage(parsed.problem)];
            }
        }

        /**
         * @template T
         * @param {(signal: AbortSignal) => Promise<T>} call
         * @param {AbortSignal} outer the Stop button
         * @returns {Promise<T>}
         */
        async function withTimeout(call, outer) {
            const seconds = getSettings().lbcRequestTimeout;
            const controller = new AbortController();
            const onAbort = () => controller.abort(outer.reason);
            if (outer.aborted) onAbort();
            else outer.addEventListener('abort', onAbort, { once: true });
            const timer = seconds > 0 ? setTimeout(() => controller.abort(new RequestTimeoutError(seconds * 1000)), seconds * 1000) : null;
            try {
                const result = await call(controller.signal);
                controller.signal.throwIfAborted();
                return result;
            } catch (error) {
                if (isTimeoutError(controller.signal.reason)) {
                    throw new Error(t`LoreBook Creator: no reply within ${seconds} s. The limit is in the Lorebook Localizer settings.`);
                }
                if (outer.aborted) throw stopReason();
                throw error;
            } finally {
                if (timer) clearTimeout(timer);
                outer.removeEventListener('abort', onAbort);
            }
        }

        /** Whether a new job may start now; says why not. */
        function guard() {
            if (busy) {
                toastr.info(t`"Expand the world" is already working.`, EXTENSION_TITLE);
                return false;
            }
            if (isLbcGenerating()) {
                toastr.info(t`LoreBook Creator is generating right now. Try again when it is done.`, EXTENSION_TITLE);
                return false;
            }
            return true;
        }

        /**
         * @template T
         * @param {'oneshot'|'dialog'|null} mode
         * @param {(signal: AbortSignal) => Promise<T>} job
         * @returns {Promise<T|undefined>}
         */
        async function withBusy(mode, job) {
            busy = true;
            running = new AbortController();
            ui.setBusy(true, mode);
            try {
                return await job(running.signal);
            } catch (error) {
                if (isAbort(error)) {
                    if (mode) ui.setStatus(mode, t`Stopped.`, 'info');
                    return undefined;
                }
                console.error(`[${EXTENSION_TITLE}] LBC expand failed`, error);
                const message = String(error?.message ?? error);
                if (mode) ui.setStatus(mode, message, 'error');
                toastr.error(message, EXTENSION_TITLE);
                return undefined;
            } finally {
                busy = false;
                running = null;
                ui.setBusy(false);
                renderHeader();
            }
        }

        /**
         * The editor may have changed while the model worked: LBC replaces its whole list on Generate, Load, Merge,
         * "Lorebook from lore" and Reset.
         * @param {any[]} list
         * @param {string} book
         */
        function assertSameEditor(list, book) {
            if (api.getData().entries !== list || !holdsBook(book)) {
                throw new Error(t`LoreBook Creator's editor changed while the model was working (another book or a new generation). Nothing was applied.`);
            }
        }

        /** Re-renders LBC's panel after its entries changed (the form of an open entry was taken in first). */
        function refreshLbc() {
            api.open();
        }

        /**
         * @param {Target} target
         * @param {any[]} added new entries (Russian word forms are offered for these)
         */
        async function saveTarget(target, added) {
            const result = await saveEditorToBook(target.book, { mode: 'patch', backup: !backedUp.has(target.book), russianKeysFor: added });
            backedUp.add(target.book);
            return result;
        }

        // --- One click ---------------------------------------------------------------------------------------------

        /**
         * @param {string} comment
         * @param {number} size
         */
        async function runOneShot(comment, size) {
            if (!guard()) return;
            if (!isLosslessSavingOn()) {
                ui.setStatus('oneshot', t`Lossless saving is off: an expansion cannot write into the book. Turn it on in the LoreBook Creator section of Lorebook Localizer.`, 'error');
                return;
            }
            const settings = getSettings();
            settings.lbcExpandSize = EXPAND_SIZES.includes(size) ? size : EXPAND_SIZES[1];
            saveSettings();
            ui.renderResult(null);
            await withBusy('oneshot', async (signal) => {
                const status = (text) => ui.setStatus('oneshot', text);
                status(t`Preparing the book…`);
                const target = await ensureTarget();
                if (!(await ensureEditor(target.book))) {
                    status(t`The book was not opened: LoreBook Creator's editor was kept as it was.`);
                    return;
                }
                const data = api.getData();
                const list = data.entries;
                const { text: context, digest, others } = await gatherContext(target, comment);
                const messages = buildOneShotMessages({ context, comment, size: settings.lbcExpandSize, language: settings.lbcContentLanguage });
                const answer = await ask(messages, 'oneshot', signal, status);

                assertSameEditor(list, target.book);
                syncLbcEntryForm(data);
                const bookBefore = structuredClone(await ctx.loadWorldInfo(target.book));
                const editorBefore = takeEditorSnapshot(list, entry => entryLinks.get(entry));
                const plan = planMerge({ target: digest.items, others }, answer);
                const applied = applyPlan(list, plan, digest.ids, { custom: data.customCategories ?? [] });
                adoptCategories(data, applied.added);
                const notes = [...plan.dropped, ...applied.dropped].map(describeDropped).filter(Boolean);
                if (!applied.added.length && !applied.updated.length) {
                    status(t`Nothing new: the model's proposals are already in the lore.`);
                    ui.renderResult({ summary: answer.summary, saved: '', added: [], updated: [], notes, undoable: false });
                    return;
                }
                refreshLbc();
                lastExpansion = { book: target.book, bookBefore, editorBefore, list };
                /** @type {import('./expand-ui.js').ResultModel} */
                const result = {
                    summary: answer.summary,
                    saved: '',
                    added: applied.added.map(entry => ({ title: stripCategory(lbcEntryText(entry).comment), detail: entry.category, ref: entry })),
                    updated: applied.updated.map(update => ({ title: stripCategory(update.title), detail: updateDetail(update), ref: update.entry })),
                    notes,
                    undoable: true,
                };
                status(t`Saving into "${target.book}"…`);
                try {
                    const saved = await saveTarget(target, applied.added);
                    result.saved = savedLine(saved, applied.added.length, applied.updated.length);
                } catch (error) {
                    // The changes are in the editor; "Undo" still takes them back.
                    ui.renderResult({ ...result, saved: t`Not saved into the book: ${error?.message ?? error}` });
                    throw error;
                }
                refreshLbc();
                status('');
                ui.renderResult(result);
            });
        }

        /**
         * @param {import('./saving.js').SaveResult} saved
         * @param {number} added
         * @param {number} updated
         */
        function savedLine(saved, added, updated) {
            const line = t`Saved into "${saved.target}": ${added} new, ${updated} enriched.`;
            return saved.backups.length ? `${line} ${t`Backup: ${saved.backups.join(', ')}`}` : line;
        }

        /** @param {import('./expand-core.js').AppliedUpdate} update */
        function updateDetail(update) {
            const parts = [];
            if (update.appended) parts.push(t`+${update.appended} paragraphs`);
            if (update.keys) parts.push(t`+${update.keys} keys`);
            if (update.merged.length) parts.push(t`proposed as new: ${update.merged.join(', ')}`);
            return parts.join(', ');
        }

        /** @param {import('./expand-core.js').DroppedProposal} item */
        function describeDropped(item) {
            const title = stripCategory(item.title) || item.id || '?';
            switch (item.kind) {
                case 'otherBook': return t`«${title}»: already in the book "${item.book}" as «${stripCategory(item.other)}».`;
                case 'duplicate': return t`«${title}»: proposed twice; folded into «${stripCategory(item.other)}».`;
                case 'unknownId': return t`An addition to ${item.id}: there is no such entry.`;
                case 'archive': return t`«${title}»: a CarrotKernel archive, left as it is.`;
                case 'deleted': return t`«${title}»: the entry was deleted while the model was working.`;
                default: return '';
            }
        }

        async function undo() {
            const last = lastExpansion;
            if (!last || !guard()) return;
            await withBusy('oneshot', async () => {
                await ctx.saveWorldInfo(last.book, structuredClone(last.bookBefore), true);
                await ctx.updateWorldInfoList();
                ctx.reloadWorldInfoEditor(last.book);
                const data = api.getData();
                let editor = false;
                if (data.entries === last.list) {
                    syncLbcEntryForm(data);
                    restoreEditorSnapshot(data.entries, last.editorBefore, (entry, link) => {
                        if (link) entryLinks.set(entry, link);
                        else entryLinks.delete(entry);
                    });
                    if (data.editingEntryIdx >= data.entries.length) data.editingEntryIdx = -1;
                    editor = true;
                    if (isLbcPanelOpen()) refreshLbc();
                }
                lastExpansion = null;
                ui.renderResult(null);
                ui.setStatus('oneshot', editor
                    ? t`Undone: the book and the editor are as they were before the expansion.`
                    : t`Undone in the book. LoreBook Creator's editor holds other entries now and was left alone.`, 'success');
            });
        }

        /** @param {any} entry */
        function openEntry(entry) {
            const data = api.getData();
            const index = data.entries.indexOf(entry);
            if (index < 0) {
                toastr.info(t`The entry is no longer in LoreBook Creator's editor.`, EXTENSION_TITLE);
                return;
            }
            showLbcEntries(api, index);
        }

        // --- Dialog --------------------------------------------------------------------------------------------------

        /** The stored dialog of the bound character and its book (created empty when there is none). */
        async function loadSession() {
            const book = shownTarget?.book;
            if (!bound || !book) {
                session = null;
                renderSession();
                return;
            }
            if (session?.avatar === bound.avatar && session.book === book) {
                renderSession();
                return;
            }
            let stored = null;
            try {
                stored = store ? parseSession(await store.getItem(sessionKey(bound.avatar, book))) : null;
            } catch (error) {
                console.warn(`[${EXTENSION_TITLE}] LBC expand: the dialog was not restored`, error);
            }
            session = stored ?? createSession({ avatar: bound.avatar, name: bound.name, book });
            turnIds.clear();
            appliedEntries.clear();
            renderSession();
        }

        async function persistSession() {
            if (!session || !store) return;
            try {
                if (session.turns.length) await store.setItem(sessionKey(session.avatar, session.book), serializeSession(session));
                else await store.removeItem(sessionKey(session.avatar, session.book));
            } catch (error) {
                console.warn(`[${EXTENSION_TITLE}] LBC expand: the dialog was not saved`, error);
            }
        }

        function renderSession() {
            if (!session) {
                ui.renderSession(null);
                return;
            }
            const settings = getSettings();
            ui.renderSession({
                owner: t`Session: ${session.name} · «${session.book}»`,
                saveNow: settings.lbcExpandSaveNow && isLosslessSavingOn(),
                saveNowAvailable: isLosslessSavingOn(),
                turns: session.turns.map(turn => ({
                    role: turn.role,
                    text: turn.text,
                    proposals: (turn.proposals ?? []).map(proposal => ({
                        pid: proposal.pid,
                        op: proposal.op,
                        title: proposalTitle(proposal),
                        target: proposal.op === 'update' ? `${proposal.id} «${stripCategory(proposal.targetTitle) || '?'}»` : undefined,
                        category: proposal.op === 'add' ? String(proposal.entry?.category ?? '') : undefined,
                        keys: proposal.op === 'add' ? (Array.isArray(proposal.entry?.key) ? proposal.entry.key.map(String) : []) : (proposal.addKeys ?? []),
                        text: proposal.op === 'add' ? String(proposal.entry?.content ?? '') : String(proposal.append ?? ''),
                        reason: proposal.reason,
                        state: proposal.state,
                        note: proposal.note,
                        canOpen: proposal.state === 'accepted',
                    })),
                })),
            });
        }

        /**
         * @param {string} text
         * @returns {Promise<boolean>} whether the message was taken
         */
        async function sendDialog(text) {
            if (!guard()) return false;
            let taken = false;
            await withBusy('dialog', async (signal) => {
                const status = (line) => ui.setStatus('dialog', line);
                status(t`Preparing the book…`);
                const target = await ensureTarget();
                await loadSession();
                if (!(await ensureEditor(target.book))) {
                    status(t`The book was not opened: LoreBook Creator's editor was kept as it was.`);
                    return;
                }
                const current = /** @type {import('./expand-core.js').DialogSession} */ (session);
                current.turns.push({ role: 'user', text });
                taken = true;
                renderSession();
                try {
                    const { text: context, digest } = await gatherContext(target, text);
                    const history = await trimHistory(historyMessages(current), { countTokens: (value) => ctx.getTokenCountAsync(value) });
                    const settings = getSettings();
                    const answer = await ask(buildDialogMessages({ context, history, language: settings.lbcContentLanguage }), 'dialog', signal, status);
                    if (session !== current) return;
                    turnIds.set(current.turns.length, digest.ids);
                    addAssistantTurn(current, answer, digest.ids);
                    status('');
                } catch (error) {
                    // The message goes back into the input box; the session stays as it was.
                    if (session === current && current.turns.at(-1)?.role === 'user' && current.turns.at(-1)?.text === text) current.turns.pop();
                    taken = false;
                    throw error;
                } finally {
                    renderSession();
                    await persistSession();
                }
            });
            return taken;
        }

        /** @param {string} pid */
        function findProposal(pid) {
            const turnIndex = session?.turns.findIndex(turn => turn.proposals?.some(proposal => proposal.pid === pid)) ?? -1;
            const proposal = turnIndex >= 0 ? session?.turns[turnIndex].proposals?.find(item => item.pid === pid) : null;
            return proposal ? { turnIndex, proposal } : null;
        }

        /**
         * The editor entry an update proposal meant: the very object while the page lives, else the entry with that title.
         * @param {number} turnIndex
         * @param {import('./expand-core.js').SessionProposal} proposal
         */
        function updateTarget(turnIndex, proposal) {
            const entries = api.getData().entries;
            const known = turnIds.get(turnIndex)?.get(proposal.id);
            if (known && entries.includes(known)) return known;
            const title = foldTitle(proposal.targetTitle);
            return title ? [...entries].find(entry => foldTitle(lbcEntryText(entry).comment) === title) ?? null : null;
        }

        /**
         * @param {string} pid
         * @param {boolean} accepted
         */
        async function decide(pid, accepted) {
            const found = findProposal(pid);
            if (!found || found.proposal.state !== 'pending' || !session) return;
            const { turnIndex, proposal } = found;
            const current = session;
            if (!accepted) {
                proposal.state = 'rejected';
                renderSession();
                await persistSession();
                return;
            }
            if (!guard()) return;
            await withBusy(null, async () => {
                const target = await ensureTarget();
                if (!(await ensureEditor(target.book))) {
                    ui.setStatus('dialog', t`The book was not opened: LoreBook Creator's editor was kept as it was.`);
                    return;
                }
                const data = api.getData();
                syncLbcEntryForm(data);
                const digest = buildDigest([...data.entries]);
                const others = await otherItems(target, inCurrentChat(target.character.avatar));
                /** @type {{entries?: any[], updates?: any[]}} */
                let proposals;
                if (proposal.op === 'add') {
                    proposals = { entries: [structuredClone(proposal.entry)] };
                } else {
                    const entry = updateTarget(turnIndex, proposal);
                    const id = entry ? digest.items.find(item => item.entry === entry)?.id : null;
                    if (!id) throw new Error(t`The entry «${stripCategory(proposal.targetTitle) || proposal.id}» is not in LoreBook Creator's editor.`);
                    proposals = { updates: [{ id, append: proposal.append, addKeys: proposal.addKeys, reason: proposal.reason }] };
                }
                const plan = planMerge({ target: digest.items, others }, proposals);
                const applied = applyPlan(data.entries, plan, digest.ids, { custom: data.customCategories ?? [] });
                adoptCategories(data, applied.added);
                const entry = applied.added[0] ?? applied.updated[0]?.entry ?? null;
                if (entry) {
                    proposal.state = 'accepted';
                    proposal.appliedTitle = lbcEntryText(entry).comment;
                    appliedEntries.set(pid, entry);
                    if (applied.added.length) proposal.note = t`added to the editor`;
                    else if (proposal.op === 'add') proposal.note = t`the book already has «${stripCategory(proposal.appliedTitle)}», added to it`;
                    else proposal.note = t`added to «${stripCategory(proposal.appliedTitle)}»`;
                } else {
                    proposal.state = 'skipped';
                    const other = plan.dropped.find(item => item.kind === 'otherBook');
                    proposal.note = other
                        ? t`already in the book "${other.book}" as «${stripCategory(other.other)}»`
                        : t`the entry already has all of it`;
                }
                if (entry) {
                    refreshLbc();
                    if (getSettings().lbcExpandSaveNow && isLosslessSavingOn()) {
                        const saved = await saveTarget(target, applied.added);
                        proposal.note = `${proposal.note}; ${t`saved into "${saved.target}"`}`;
                        refreshLbc();
                    }
                }
                if (session === current) {
                    renderSession();
                    await persistSession();
                }
            });
        }

        /** @param {string} pid */
        function openProposal(pid) {
            const found = findProposal(pid);
            if (!found) return;
            const entries = api.getData().entries;
            let entry = appliedEntries.get(pid);
            if (!entry || !entries.includes(entry)) {
                const title = foldTitle(found.proposal.appliedTitle);
                entry = title ? [...entries].find(item => foldTitle(lbcEntryText(item).comment) === title) : null;
            }
            if (!entry) {
                toastr.info(t`The entry is no longer in LoreBook Creator's editor.`, EXTENSION_TITLE);
                return;
            }
            showLbcEntries(api, entries.indexOf(entry));
        }

        async function restartSession() {
            if (!session || busy) return;
            const answer = await new ctx.Popup($('<div>').text(t`Start the dialog over? The conversation is deleted; the book stays as it is.`), ctx.POPUP_TYPE.CONFIRM, '', { okButton: t`Start over`, cancelButton: t`Cancel` }).show();
            if (answer !== ctx.POPUP_RESULT.AFFIRMATIVE || !session) return;
            session = createSession({ avatar: session.avatar, name: session.name, book: session.book });
            turnIds.clear();
            appliedEntries.clear();
            await persistSession();
            renderSession();
            ui.setStatus('dialog', '');
        }

        // --- Entry points --------------------------------------------------------------------------------------------

        function syncPlacement() {
            ui.place({ lbcOpen: isLbcPanelOpen(), centered: isLbcPanelCentered() });
        }

        async function showWindow() {
            syncPlacement();
            ui.show();
            if (!bound || (!busy && !inCurrentChat(bound.avatar) && !session?.turns.length && !lastExpansion)) {
                await bindTo(chatCharacters().suggested);
            } else {
                await refreshHeader();
            }
        }

        // LBC builds its footer once: our buttons go after "Load LoreBook".
        const anchor = $(LBC.selectors.loadBookButton);
        if (anchor.length) {
            const footerButton = (icon, text, title) => $('<button>', { type: 'button', class: `menu_button ${FOOTER_CLASS}`, title })
                .append($('<i>').addClass(`fa-solid fa-${icon}`), document.createTextNode(` ${text}`));
            const bookButton = footerButton('user-pen', t`Character's book`, t`Open the current character's lorebook in LoreBook Creator (created and attached when there is none).`)
                .on('click', () => {
                    void (async () => {
                        if (!bound || !inCurrentChat(bound.avatar)) await bindTo(chatCharacters().suggested);
                        if (!bound) {
                            await showWindow();
                            toastr.info(chatCharacters().group ? t`Group chat: choose whose world to expand.` : t`Open a chat with a character first.`, EXTENSION_TITLE);
                            return;
                        }
                        await openBook();
                    })();
                });
            const expandButton = footerButton('earth-europe', t`Expand the world`, t`New lore around the current character, in one click or in a dialog with the model.`)
                .on('click', () => { void showWindow(); });
            anchor.after(bookButton, expandButton);
            scope.add(() => $(`.${FOOTER_CLASS}`).remove());
        } else {
            env.log('expand: no "Load LoreBook" button in LBC\'s footer');
        }

        // The wand menu next to the chat input.
        const menu = $('#extensionsMenu');
        if (menu.length) {
            const item = $('<div>', { id: WAND_ID, class: 'list-group-item flex-container flexGap5', title: t`New lore around the current character, in one click or in a dialog with the model.` })
                .append($('<div class="fa-solid fa-earth-europe extensionsMenuExtensionButton"></div>'), $('<span>').text(t`Expand the world (LoreBook Creator)…`))
                .on('click', () => {
                    api.open();
                    void showWindow();
                });
            menu.append(item);
            scope.add(() => item.remove());
        }

        // The window follows LBC's panel: left of its drawer, or alone when it is closed.
        const panel = document.querySelector(LBC.selectors.panel);
        if (panel) {
            const observer = new MutationObserver(syncPlacement);
            observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
            scope.add(() => observer.disconnect());
        }

        // Another chat: the window keeps working for its character (a dialog is not lost) and says so.
        scope.on(ctx.eventSource, ctx.eventTypes.CHAT_CHANGED, () => {
            if (!ui.isOpen()) return;
            if (!busy && bound && !inCurrentChat(bound.avatar) && !session?.turns.length && !lastExpansion) {
                void bindTo(chatCharacters().suggested);
            } else {
                renderHeader();
            }
        });
    },
};
