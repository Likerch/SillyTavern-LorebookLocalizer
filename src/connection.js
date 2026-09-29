import { RESPONSE_SCHEMA, SCHEMA_NAME } from './prompt.js';
import { t } from './settings.js';

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
 * @returns {{kind: 'profile', profileId: string, isChat: boolean, label: string} | {kind: 'current', isChat: boolean, api: string, label: string} | {kind: 'error', message: string}}
 */
export function resolveConnection(settings) {
    const ctx = SillyTavern.getContext();
    if (settings.profileId) {
        try {
            const profile = ctx.ConnectionManagerRequestService.getProfile(settings.profileId);
            ctx.ConnectionManagerRequestService.validateProfile(profile);
            const isChat = ctx.CONNECT_API_MAP[profile.api]?.selected === 'openai';
            return { kind: 'profile', profileId: profile.id, isChat, label: profile.name };
        } catch (error) {
            return { kind: 'error', message: error?.message ?? String(error) };
        }
    }
    return { kind: 'current', isChat: ctx.mainApi === 'openai', api: ctx.mainApi, label: t`Current connection` };
}

/**
 * Creates the LLM call used by the Translator.
 * @param {ReturnType<typeof resolveConnection>} connection
 * @param {{responseTokens: number, temperature: number}} settings
 * @returns {import('./translator.js').RequestFn}
 */
export function createRequestFn(connection, settings) {
    const ctx = SillyTavern.getContext();

    if (connection.kind === 'profile') {
        // Sends through the chosen profile without switching the user's active connection.
        return async (messages, { useSchema, signal }) => {
            const overridePayload = { temperature: settings.temperature };
            if (useSchema && connection.isChat) {
                overridePayload.json_schema = { name: SCHEMA_NAME, strict: true, value: RESPONSE_SCHEMA };
            }
            const result = await ctx.ConnectionManagerRequestService.sendRequest(
                connection.profileId,
                messages,
                settings.responseTokens,
                // The profile's RP preset (jailbreaks, formatting rules) would only get in the way of JSON output.
                { stream: false, signal, extractData: true, includePreset: false, includeInstruct: true },
                overridePayload,
            );
            return result?.content ?? result;
        };
    }

    // Current connection. generateRawData is used instead of generateRaw because generateRaw runs the reply
    // through the user's regex scripts (e.g. quote replacement), which can corrupt JSON.
    return async (messages, { useSchema, signal }) => {
        const onAbort = () => ctx.stopGeneration();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            const jsonSchema = useSchema && connection.isChat
                ? { name: SCHEMA_NAME, value: RESPONSE_SCHEMA, strict: true, returnInvalid: true }
                : null;
            const data = await ctx.generateRawData({ prompt: messages, responseLength: settings.responseTokens, jsonSchema });
            signal.throwIfAborted();
            return jsonSchema ? data : ctx.extractMessageFromData(data);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    };
}
