import { settledOrAborted } from './batching.js';
import { RESPONSE_SCHEMA, SCHEMA_NAME } from './prompt.js';
import { reasoningEffort } from './reasoning.js';
import { t } from './settings.js';
import { isTimeoutError } from './translator.js';

/**
 * Released when the current connection's latest generateRawData call settles. generateRawData swaps the global
 * response length through a single static slot, so a call never starts while an earlier one is still running, even
 * one the Translator abandoned after a timeout or a stop (it ignores the late answer but the call goes on).
 * @type {Promise<void>}
 */
let rawCallsDone = Promise.resolve();

/**
 * Connection profiles usable for requests, or null when the Connection Manager extension is disabled.
 * @returns {{id: string, name: string}[]|null}
 */
export function getProfiles() {
    try {
        return SillyTavern.getContext().ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        return null;
    }
}

/**
 * @param {{profileId: string}} settings
 * @returns {{kind: 'profile', profileId: string, isChat: boolean, api: string, label: string} | {kind: 'current', isChat: boolean, api: string, label: string} | {kind: 'error', message: string}}
 */
export function resolveConnection(settings) {
    const ctx = SillyTavern.getContext();
    if (settings.profileId) {
        try {
            const profile = ctx.ConnectionManagerRequestService.getProfile(settings.profileId);
            ctx.ConnectionManagerRequestService.validateProfile(profile);
            const isChat = ctx.CONNECT_API_MAP[profile.api]?.selected === 'openai';
            return { kind: 'profile', profileId: profile.id, isChat, api: profile.api, label: profile.name };
        } catch (error) {
            return { kind: 'error', message: error?.message ?? String(error) };
        }
    }
    return { kind: 'current', isChat: ctx.mainApi === 'openai', api: ctx.mainApi, label: t`Current connection` };
}

/**
 * Starts generateRawData and finds the stop hook it registers for this call.
 *
 * generateRawData takes no AbortSignal. It stops on GENERATION_STOPPED through a hook that it adds synchronously on
 * entry (before its first await) and removes when it settles, so the listener that appears during the call is this
 * call's own. Calling it aborts this request only. Emitting the event, or ctx.stopGeneration(), would also stop the
 * user's chat generation, group auto mode and the raw generations of other extensions.
 * @param {any} ctx
 * @param {object} params
 * @returns {{promise: Promise<any>, ownStop: (() => void)|null}}
 */
function startRawGeneration(ctx, params) {
    const listeners = () => {
        const list = ctx.eventSource?.events?.[ctx.eventTypes?.GENERATION_STOPPED];
        return Array.isArray(list) ? list : [];
    };
    const before = new Set(listeners());
    const promise = ctx.generateRawData(params);
    const added = listeners().filter(listener => !before.has(listener));
    return { promise, ownStop: added.length === 1 ? added[0] : null };
}

/**
 * Sets the reasoning effort of this extension's own request made through the current connection: generateRawData
 * takes it from the RP preset (often "high"). Only the request whose messages are ours is touched, so another
 * generation prepared meanwhile is left alone.
 * @param {any} ctx
 * @param {{role: string, content: string}[]} messages
 * @param {string} mode the `reasoning` setting
 * @returns {() => void} removes the listener
 */
function overrideReasoning(ctx, messages, mode) {
    const source = ctx.eventSource;
    const event = ctx.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
    if (!event || typeof source?.on !== 'function' || typeof source.removeListener !== 'function') return () => {};
    const first = messages[0]?.content;
    const listener = (data) => {
        if (!data || first === undefined || data.messages?.[0]?.content !== first) return;
        const effort = reasoningEffort(mode, data.chat_completion_source);
        if (effort !== undefined) data.reasoning_effort = effort;
    };
    if (typeof source.makeLast === 'function') source.makeLast(event, listener);
    else source.on(event, listener);
    return () => source.removeListener(event, listener);
}

/**
 * Creates the LLM call used by the Translator. The call stops and settles soon after its signal aborts (a stop or
 * a timeout of the attempt). With `useSchema` the reply is constrained by the key translation schema, or by `schema`
 * when given (`{name, value}`: another caller's JSON schema); `useSchema: false` asks for free text.
 * @param {ReturnType<typeof resolveConnection>} connection
 * @param {{responseTokens: number, temperature: number, reasoning?: string}} settings
 * @param {any} [ctx] SillyTavern's context (tests pass a fake one)
 * @returns {import('./translator.js').RequestFn}
 */
export function createRequestFn(connection, settings, ctx = SillyTavern.getContext()) {
    if (connection.kind === 'profile') {
        // Sends through the chosen profile without switching the user's active connection. The signal goes down to
        // fetch(); profile requests share no global state, so a retry may start while an aborted call winds down.
        return async (messages, { useSchema, signal, schema }) => {
            const overridePayload = { temperature: settings.temperature };
            const effort = reasoningEffort(settings.reasoning ?? 'off', connection.api);
            if (effort !== undefined) overridePayload.reasoning_effort = effort;
            if (useSchema && connection.isChat) {
                overridePayload.json_schema = { name: schema?.name ?? SCHEMA_NAME, strict: true, value: schema?.value ?? RESPONSE_SCHEMA };
            }
            const result = await ctx.ConnectionManagerRequestService.sendRequest(
                connection.profileId,
                messages,
                settings.responseTokens,
                // The profile's RP preset (jailbreaks, formatting rules) would only get in the way of JSON output.
                { stream: false, signal, extractData: true, includePreset: false, includeInstruct: true },
                overridePayload,
            );
            // A reasoning model may spend the whole response length on thoughts and answer nothing: say so.
            if (result && typeof result === 'object' && !String(result.content ?? '').trim() && String(result.reasoning ?? '').trim()) {
                throw new Error(t`The model spent the whole reply on reasoning and returned no answer. Turn reasoning off in Requests or raise the response length.`);
            }
            return result?.content ?? result;
        };
    }

    // Current connection. generateRawData is used instead of generateRaw because generateRaw runs the reply
    // through the user's regex scripts (e.g. quote replacement), which can corrupt JSON.
    return async (messages, { useSchema, signal, schema }) => {
        // Take the next turn synchronously, then wait for the previous call to settle.
        const previous = rawCallsDone;
        /** @type {() => void} */
        let release = () => { };
        rawCallsDone = new Promise(resolve => { release = resolve; });
        try {
            await settledOrAborted(previous, signal);
            signal.throwIfAborted();
        } catch (error) {
            void previous.then(release);
            throw error;
        }

        const jsonSchema = useSchema && connection.isChat
            ? { name: schema?.name ?? SCHEMA_NAME, value: schema?.value ?? RESPONSE_SCHEMA, strict: true, returnInvalid: true }
            : null;
        /** @type {ReturnType<typeof startRawGeneration>} */
        let call;
        const restoreReasoning = connection.isChat ? overrideReasoning(ctx, messages, settings.reasoning ?? 'off') : () => {};
        try {
            call = startRawGeneration(ctx, { prompt: messages, responseLength: settings.responseTokens, jsonSchema });
        } catch (error) {
            restoreReasoning();
            release();
            throw error;
        }
        call.promise.then(release, release);
        call.promise.then(restoreReasoning, restoreReasoning);

        const onAbort = () => {
            if (call.ownStop) {
                call.ownStop();
            } else if (!isTimeoutError(signal.reason)) {
                // The hook was not found (another SillyTavern version): a stop still stops everything, as before 0.3.
                // A timed-out call is left to finish; the next call waits for it above.
                ctx.stopGeneration();
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            const data = await call.promise;
            signal.throwIfAborted();
            return jsonSchema ? data : ctx.extractMessageFromData(data);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    };
}
