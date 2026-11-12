// «Расширить мир» as a built-in agent of Maestro (Maestro 1.34, MAESTRO_API.agents; its docs/integration-agents.md):
// the job keeps its own channel — the connection chosen for LoreBook Creator (Maestro's decision В11) — and Maestro shows
// its instruction in the «Агенты» window, where the user adds «Дополнительные указания» or rewrites it and changes the
// temperature and the answer's length. Before each request the system message goes through
// `MAESTRO_API.agents.instruction`; after it the run is reported to Maestro's run log. Without Maestro 1.34 nothing
// changes. Registered again when Maestro publishes its API again (`maestro-api-ready`).
import { expandSystemPrompt } from './lbc/expand-core.js';

export const EXPAND_AGENT_ID = 'localizer.expand';
const READY_EVENT = 'maestro-api-ready';

/** @type {{ api: unknown, off: () => void } | null} */
let registered = null;

/** MAESTRO_API with the agents member (Maestro 1.34+), else null. */
export function maestroAgents() {
    const api = /** @type {any} */ (globalThis).MAESTRO_API;
    if (!api || api.version !== 1 || !api.agents) return null;
    const agents = api.agents;
    return typeof agents.registerBuiltIn === 'function' && typeof agents.instruction === 'function' ? api : null;
}

/** Every default instruction of the job (both modes, the languages Localizer writes in). */
export function expandDefaults() {
    const texts = [];
    for (const mode of /** @type {const} */ (['oneshot', 'dialog'])) {
        for (const language of ['ru', 'en', 'other']) texts.push(expandSystemPrompt(/** @type {any} */ (language), mode));
    }
    return [...new Set(texts)];
}

function register() {
    const api = maestroAgents();
    if (!api) return;
    if (registered?.api === api) return;
    try {
        registered?.off();
    } catch {
        // the old Maestro is gone
    }
    try {
        const off = api.agents.registerBuiltIn({
            id: EXPAND_AGENT_ID,
            title: { ru: 'Localizer: расширить мир', en: 'Localizer: expand the world' },
            when: { ru: 'по кнопке в LoreBook Creator', en: 'by the button in LoreBook Creator' },
            description: {
                ru: 'Новые записи лора вокруг персонажа — одним нажатием или в диалоге. Модель — подключение, выбранное для LoreBook Creator.',
                en: 'New lore around a character — in one click or in a dialog. The model is the connection chosen for LoreBook Creator.',
            },
            sources: { ru: 'карточка, последние сообщения, лор персонажа', en: 'the card, the last messages, the character’s lore' },
            icon: 'fa-earth-europe',
            defaultInstructions: expandDefaults,
            defaults: { maxTokens: 4000, temperature: 0.8 },
            channel: 'own',
            interactive: true,
        });
        registered = { api, off: typeof off === 'function' ? off : () => {} };
    } catch (error) {
        console.warn('[Localizer] the expand agent was not registered with Maestro', error);
    }
}

/** Starts registering with Maestro now and whenever it publishes its API again. */
export function installMaestroAgents() {
    register();
    if (typeof window !== 'undefined') window.addEventListener(READY_EVENT, register);
    return () => {
        if (typeof window !== 'undefined') window.removeEventListener(READY_EVENT, register);
        try {
            registered?.off();
        } catch {
            // already gone
        }
        registered = null;
    };
}

/**
 * The messages and parameters the user made of the job in Maestro: the first system message replaced by the instruction
 * Maestro gives for it; the temperature and the answer's length when the user set them. Unchanged without Maestro.
 * @param {{role: string, content: string}[]} messages
 * @returns {{messages: {role: string, content: string}[], temperature?: number, maxTokens?: number}}
 */
export function tuneExpand(messages) {
    const api = maestroAgents();
    const at = messages.findIndex((message) => message.role === 'system');
    if (!api || at < 0) return { messages };
    try {
        const answer = api.agents.instruction(EXPAND_AGENT_ID, messages[at].content);
        const out = messages.map((message) => ({ ...message }));
        if (answer && typeof answer.text === 'string' && answer.text.trim()) out[at].content = answer.text;
        /** @type {{messages: {role: string, content: string}[], temperature?: number, maxTokens?: number}} */
        const tuned = { messages: out };
        if (typeof answer?.temperature === 'number') tuned.temperature = answer.temperature;
        if (typeof answer?.maxTokens === 'number') tuned.maxTokens = answer.maxTokens;
        return tuned;
    } catch (error) {
        console.warn('[Localizer] Maestro did not give the expand instruction', error);
        return { messages };
    }
}

/**
 * Reports one request of the job to Maestro's run log (nothing without Maestro).
 * @param {{ok: boolean, ms: number, error?: string, request?: {role: string, content: string}[], raw?: string}} run
 */
export function reportExpand(run) {
    const api = maestroAgents();
    if (!api || typeof api.agents.report !== 'function') return;
    try {
        api.agents.report(EXPAND_AGENT_ID, run);
    } catch (error) {
        console.warn('[Localizer] the run was not reported to Maestro', error);
    }
}
