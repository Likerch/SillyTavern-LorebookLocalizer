// The clean generation channel for LoreBook Creator: pure parts, unit-tested in Node. The SillyTavern side is channel.js.
import { unwrapLbcPrompt } from './adapter.js';

/** `lbcProfileId` value meaning "the profile chosen for key translation". */
export const LBC_PROFILE_INHERIT = '@localizer';

/** Property put on SillyTavern's generate_data of an LBC request, so the fetch wrapper recognizes exactly that request. */
export const ROUTE_MARK = '__lorebookLocalizerLbc';

/** The chat completion endpoint SillyTavern's own generations go to. */
export const CHAT_COMPLETION_URL = '/api/backends/chat-completions/generate';

/**
 * The system message of every LBC request. LBC's own prompt carries the task; this only replaces the roleplay frame
 * the prompt was written for.
 */
export const BASE_RULES = [
    'You are a worldbuilding assistant that writes SillyTavern World Info (lorebook) data.',
    'This is not a roleplay turn: do not continue any story, do not add trackers, image tags or commentary.',
    'Follow the request below exactly and answer in the format it asks for. When it asks for JSON, output only that JSON.',
    'Keep SillyTavern macros such as {{user}} and {{char}} exactly as written.',
].join('\n');

/**
 * @param {{lbcProfileId?: string, profileId?: string}} settings
 * @returns {string} a Connection Manager profile id, or '' for the current connection
 */
export function resolveLbcProfileId(settings) {
    const own = settings.lbcProfileId ?? LBC_PROFILE_INHERIT;
    return own === LBC_PROFILE_INHERIT ? String(settings.profileId ?? '') : String(own);
}

/** Model reasoning for LBC's requests: the same rule as for key translation (see ../reasoning.js). */
export { reasoningEffort } from '../reasoning.js';

/**
 * @param {string} rawPrompt LBC's quiet prompt before SillyTavern substituted macros in it
 * @param {string[]} [extraRules] added to the system message (language rules of a later stage)
 * @returns {{role: 'system'|'user', content: string}[]}
 */
export function buildMessages(rawPrompt, extraRules = []) {
    const system = [BASE_RULES, ...extraRules.filter(Boolean)].join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: unwrapLbcPrompt(rawPrompt) },
    ];
}

/**
 * A non-streamed chat completion body that SillyTavern's `extractMessageFromData` reads.
 * @param {string} content
 */
export function completionBody(content) {
    return { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

/**
 * An error body: SillyTavern shows `error.message` in a toast and the generation fails, so LBC reports an error
 * instead of an empty result.
 * @param {string} message
 */
export function errorBody(message) {
    return { error: { message } };
}

/**
 * @param {string} text
 * @param {number} [limit]
 */
export function excerpt(text, limit = 160) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * A piece of LBC's prompt that survives SillyTavern's macro substitution: its first line, cut before any `{{macro}}`.
 * Used to tell LBC's request from any other one that happens to be prepared at the same time.
 * @param {string} rawPrompt
 */
export function promptProbe(rawPrompt) {
    const firstLine = String(rawPrompt ?? '').trim().split('\n')[0];
    const macro = firstLine.indexOf('{{');
    return (macro >= 0 ? firstLine.slice(0, macro) : firstLine).slice(0, 100).trim();
}

/**
 * Whether a prepared chat carries the prompt the probe came from.
 * @param {unknown[]} chat
 * @param {string} probe
 */
export function chatHasPrompt(chat, probe) {
    if (!probe || !Array.isArray(chat)) return false;
    return chat.some(message => typeof message?.content === 'string' && message.content.includes(probe));
}

/**
 * OpenAI reasoning models take no temperature (SillyTavern removes it for them; sending it fails the request).
 * @param {unknown} model
 */
export function rejectsTemperature(model) {
    return /^(?:o\d|gpt-5)/i.test(String(model ?? '').replace(/^openai\//i, ''));
}
