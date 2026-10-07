// The clean generation channel. LBC asks for its text with generateQuietPrompt, which SillyTavern turns into a full
// roleplay turn: the RP preset, the chat, every active lorebook (which also starts sticky/cooldown timers in the chat)
// and the prompts of other extensions, with LBC's request glued to the end. For LBC's requests only, this part
// - empties the lorebook lists, so World Info is not even scanned;
// - replaces the prompt with a system message and LBC's own prompt, taken before SillyTavern substituted {{user}},
//   with the chosen language of the entries (language.js);
// - sends the request through the chosen Connection Manager profile without its preset (or through the current
//   connection with LBC's response length, temperature and reasoning settings);
// - turns an empty reply, or one LBC gets nothing out of, into an error. LBC would report "0 entries generated!"
//   and replace the whole editor with those 0 entries.
import { EXTENSION_TITLE } from '../constants.js';
import { getSettings, t } from '../settings.js';
import { classifyLbcPrompt, isLbcGenerating, isLbcPrompt, lbcExpectsJson, lbcParseJson, lbcReplyProblem, showLbcStatus } from './adapter.js';
import {
    buildMessages, CHAT_COMPLETION_URL, chatHasPrompt, completionBody, errorBody, excerpt, promptProbe, reasoningEffort,
    rejectsTemperature, resolveLbcProfileId, ROUTE_MARK,
} from './channel-core.js';
import { addFetchHandler } from './fetch-hook.js';
import { applyContentLanguage, canonicalizeReplyCategories, languageRules } from './language.js';

/**
 * @typedef {object} LbcJob
 * @property {string} id
 * @property {string} raw LBC's prompt as LBC wrote it
 * @property {string} probe a macro-free piece of it, to recognize the prepared chat
 * @property {string} kind
 * @property {{id: string, name: string, api?: string, model?: string}|null} profile null: the current connection
 * @property {number} started
 * @property {boolean} lorebooksCleared
 * @property {string|null} system our system message, once the prompt was replaced
 */

/** A pending request older than this is dropped (its generation ended without reaching the request). */
const PENDING_MS = 60_000;
/** LBC's World Info scan follows its start within this time; a later scan belongs to someone else. */
const SCAN_MS = 10_000;
/** A marked request that never reached fetch is forgotten after this time. */
const JOB_MS = 10 * 60_000;

/**
 * @param {object} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** How long LBC takes to put its own "Got response status …" into the status bar after a failed request. */
const LBC_STATUS_DELAY_MS = 150;

/**
 * Fails the request with a readable reason. SillyTavern shows it in a toast; LBC would only say "Got response status
 * 502", so its status bar gets the reason too, right after LBC writes there.
 * @param {string} message
 * @param {number} status
 */
function failure(message, status) {
    setTimeout(() => showLbcStatus(message, 'error'), LBC_STATUS_DELAY_MS);
    return jsonResponse(errorBody(message), status);
}

/** @type {import('./module.js').LbcPart} */
export const channelPart = {
    id: 'channel',
    setting: 'lbcChannel',
    needsDom: false,
    start(scope, env) {
        const ctx = SillyTavern.getContext();
        const { eventSource, eventTypes } = ctx;
        /** @type {LbcJob|null} Between LBC's GENERATION_STARTED and the request leaving. */
        let pending = null;
        /** @type {Map<string, LbcJob>} Marked requests on their way to the fetch wrapper. */
        const jobs = new Map();
        const warned = new Set();
        const warnOnce = (key, message) => {
            if (warned.has(key)) return;
            warned.add(key);
            toastr.warning(message, EXTENSION_TITLE, { timeOut: 10000 });
        };

        /** @returns {LbcJob['profile']|undefined} undefined: the channel cannot be used for this request */
        const pickProfile = () => {
            // Read every time: the user may switch between Chat and Text Completion while LBC is open.
            if (SillyTavern.getContext().mainApi !== 'openai') {
                warnOnce('api', t`LoreBook Creator: the clean channel works while SillyTavern uses Chat Completion. Its requests go out as before.`);
                return undefined;
            }
            const profileId = resolveLbcProfileId(getSettings());
            if (profileId) {
                try {
                    const profile = ctx.ConnectionManagerRequestService.getProfile(profileId);
                    ctx.ConnectionManagerRequestService.validateProfile(profile);
                    return { id: profile.id, name: profile.name, api: profile.api, model: profile.model };
                } catch (error) {
                    warnOnce(`profile:${profileId}`, t`LoreBook Creator: the connection profile cannot be used (${error?.message ?? error}). Using the current connection.`);
                }
            }
            return null;
        };

        /** The pending request, unless it went stale (its Generate returned early, without ENDED/STOPPED). */
        const current = () => {
            if (pending && Date.now() - pending.started > PENDING_MS) pending = null;
            return pending;
        };

        // Only LBC's own generation starts a job; other generations leave a pending LBC request alone. Every later step
        // checks that the data really is that request's, since other generations (and generateRaw, which fires the
        // prompt events without GENERATION_STARTED) may be prepared at the same time.
        scope.on(eventSource, eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
            if (type !== 'quiet' || dryRun || !isLbcGenerating() || !isLbcPrompt(options?.quiet_prompt)) return;
            pending = null;
            const profile = pickProfile();
            if (profile === undefined) return;
            pending = {
                id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
                raw: options.quiet_prompt,
                probe: promptProbe(options.quiet_prompt),
                kind: classifyLbcPrompt(options.quiet_prompt),
                profile,
                started: Date.now(),
                lorebooksCleared: false,
                system: null,
            };
            env.log('request', pending.kind, profile ? `profile «${profile.name}»` : 'current connection');
            // Extensions loaded after this one may also have registered as "last" (Maestro does): be last for this request.
            for (const [event, listener] of lastListeners) eventSource.makeLast(event, listener);
        });

        // Last, so lists filled by other listeners are emptied too. Nothing is scanned, no timers start in the chat.
        // The scan carries no sign of whose it is: only the first one soon after LBC's start is taken.
        const onEntriesLoaded = (lists) => {
            const job = current();
            if (!job || job.lorebooksCleared || job.system || !lists || Date.now() - job.started > SCAN_MS) return;
            job.lorebooksCleared = true;
            for (const list of Object.values(lists)) {
                if (Array.isArray(list)) list.splice(0);
            }
        };

        const onPromptReady = (data) => {
            const job = current();
            if (!job || job.system || data?.dryRun || !chatHasPrompt(data?.chat, job.probe)) return;
            const language = getSettings().lbcContentLanguage;
            const messages = buildMessages(applyContentLanguage(job.raw, language), languageRules(language));
            job.system = messages[0].content;
            data.chat.splice(0, data.chat.length, ...messages);
        };

        const onSettingsReady = (data) => {
            const job = current();
            if (!job?.system || !data || data.messages?.[0]?.content !== job.system) return;
            pending = null;
            for (const [id, old] of jobs) if (Date.now() - old.started > JOB_MS) jobs.delete(id);
            jobs.set(job.id, job);
            data[ROUTE_MARK] = job.id;
            if (job.profile) return;
            // The current connection: LBC's own settings instead of the RP preset's. SillyTavern has already adapted
            // the request to the model (reasoning models take max_completion_tokens and no temperature): keep that.
            const settings = getSettings();
            if ('max_completion_tokens' in data) data.max_completion_tokens = settings.lbcResponseTokens;
            else data.max_tokens = settings.lbcResponseTokens;
            if ('temperature' in data) data.temperature = settings.lbcTemperature;
            const effort = reasoningEffort(settings.lbcReasoning, data.chat_completion_source);
            if (effort !== undefined) data.reasoning_effort = effort;
        };

        /** @type {[string, Function][]} */
        const lastListeners = [
            [eventTypes.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded],
            [eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady],
            [eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady],
        ];
        for (const [event, listener] of lastListeners) scope.onLast(eventSource, event, listener);

        scope.add(addFetchHandler((request, next) => {
            const body = request.init?.body;
            if (request.url !== CHAT_COMPLETION_URL || typeof body !== 'string' || !body.includes(ROUTE_MARK)) return null;
            /** @type {any} */
            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch {
                return null;
            }
            const job = jobs.get(parsed?.[ROUTE_MARK]);
            delete parsed[ROUTE_MARK];
            if (!job) return next({ ...request.init, body: JSON.stringify(parsed) });
            jobs.delete(job.id);
            return run(job, parsed, request.init, next);
        }));

        /**
         * @param {LbcJob} job
         * @param {any} body SillyTavern's request body without the mark
         * @param {RequestInit} init
         * @param {(init?: RequestInit) => Promise<Response>} next
         */
        async function run(job, body, init, next) {
            const settings = getSettings();
            const controller = new AbortController();
            const outer = init?.signal;
            const onOuterAbort = () => controller.abort(outer?.reason);
            if (outer?.aborted) onOuterAbort();
            outer?.addEventListener('abort', onOuterAbort, { once: true });
            let timedOut = false;
            const timer = settings.lbcRequestTimeout > 0
                ? setTimeout(() => { timedOut = true; controller.abort(new DOMException('Timed out', 'TimeoutError')); }, settings.lbcRequestTimeout * 1000)
                : null;

            try {
                /** @type {Response} */
                let response;
                let content;
                if (job.profile) {
                    const override = rejectsTemperature(job.profile.model) ? {} : { temperature: settings.lbcTemperature };
                    const effort = reasoningEffort(settings.lbcReasoning, job.profile.api);
                    if (effort !== undefined) override.reasoning_effort = effort;
                    const result = await ctx.ConnectionManagerRequestService.sendRequest(
                        job.profile.id,
                        body.messages,
                        settings.lbcResponseTokens,
                        { stream: false, signal: controller.signal, extractData: true, includePreset: false, includeInstruct: true },
                        override,
                    );
                    content = typeof result === 'string' ? result : String(result?.content ?? '');
                    response = jsonResponse(completionBody(content));
                } else {
                    response = await next({ ...init, body: JSON.stringify(body), signal: controller.signal });
                    if (!response.ok) return response;
                    const data = await response.clone().json().catch(() => null);
                    if (!data || data.error) return response;
                    content = String(ctx.extractMessageFromData(data) ?? '');
                }

                const seconds = Math.round((Date.now() - job.started) / 1000);
                env.log('reply', job.kind, `${content.length} chars in ${seconds} s`);
                const problem = lbcReplyProblem(job.kind, content);
                if (problem === 'empty') {
                    return failure(t`LoreBook Creator: the model returned an empty reply.`, 502);
                }
                if (problem) {
                    console.warn(`[${EXTENSION_TITLE}] LBC: unusable reply (${problem})`, { kind: job.kind, content });
                    return failure(problem === 'shape'
                        ? t`LoreBook Creator: the model answered with JSON of another shape: «${excerpt(content)}». Nothing was changed; the full reply is in the browser console.`
                        : t`LoreBook Creator: the model did not answer with JSON: «${excerpt(content)}». The full reply is in the browser console.`, 502);
                }
                // A model writing Russian may still name categories in Russian: LBC needs its English names.
                if (lbcExpectsJson(job.kind)) {
                    const value = lbcParseJson(content);
                    const custom = env.api()?.getData()?.customCategories;
                    const fixed = canonicalizeReplyCategories(value, Array.isArray(custom) ? custom : []);
                    if (fixed) {
                        env.log('categories renamed', fixed);
                        return jsonResponse(completionBody(JSON.stringify(value)));
                    }
                }
                return response;
            } catch (error) {
                if (timedOut) {
                    return failure(t`LoreBook Creator: no reply within ${settings.lbcRequestTimeout} s. The limit is in the Lorebook Localizer settings.`, 504);
                }
                if (outer?.aborted) throw error;
                console.error(`[${EXTENSION_TITLE}] LBC request failed`, error);
                return failure(t`LoreBook Creator: the request failed: ${error?.message ?? error}`, 502);
            } finally {
                if (timer) clearTimeout(timer);
                outer?.removeEventListener('abort', onOuterAbort);
            }
        }
    },
};
