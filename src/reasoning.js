// Pure helper, no SillyTavern imports: unit-tested in Node.

/** Values of the "model reasoning" settings (`reasoning`, `lbcReasoning`). */
export const REASONING_MODES = Object.freeze(['off', 'auto', 'low', 'medium', 'high']);

/**
 * The effort sent instead of 'none' to a model whose reasoning cannot be turned off (GLM 5.3, Gemini 3 Flash on
 * OpenRouter): the lowest effort all of them take.
 */
export const REQUIRED_EFFORT = 'low';

/** Models that refused 'none' in this session: their requests go with REQUIRED_EFFORT from the start. */
const reasoningRequired = new Set();

/**
 * The `reasoning_effort` to send with the extension's own requests. They ask for JSON, where reasoning only costs
 * time and money. Worse, a reasoning model asked without the profile's preset (or with an RP preset set to "high")
 * may spend the whole response length on thoughts and return no answer at all: DeepSeek on OpenRouter reasons unless
 * it is told not to, and OpenRouter takes 'none' as given.
 * @param {string} mode `off` | `auto` | `low` | `medium` | `high`
 * @param {string|undefined} api the API or chat completion source (`openrouter`, …)
 * @param {string} [model] the model id: one known to refuse 'none' gets REQUIRED_EFFORT
 * @returns {string|undefined} undefined: leave the request as it is
 */
export function reasoningEffort(mode, api, model) {
    if (mode === 'auto') return undefined;
    if (mode === 'off' || !mode) {
        if (api !== 'openrouter') return undefined;
        return model && reasoningRequired.has(model) ? REQUIRED_EFFORT : 'none';
    }
    return mode;
}

/**
 * Whether a failed request may have been refused for its reasoning being off. OpenRouter answers 400 "Reasoning is
 * mandatory for this endpoint and cannot be disabled", and SillyTavern passes on only the status text "Bad Request".
 * Connection profile requests wrap it once more: `Error('API request failed', {cause: Error('Bad Request')})`.
 * @param {unknown} error an Error (its `cause` chain is checked too), SillyTavern's `{error: {message}}` body or a message
 * @returns {boolean}
 */
export function mayBeReasoningRefusal(error) {
    let current = /** @type {any} */ (error);
    for (let depth = 0; depth < 5 && current != null; depth++) {
        const text = String(typeof current === 'string' ? current : current.error?.message ?? current.message ?? '').trim();
        if (/^bad request$/i.test(text) || /reasoning\b.*\b(mandatory|cannot be disabled)/i.test(text)) return true;
        if (typeof current !== 'object') break;
        current = current.cause;
    }
    return false;
}

/**
 * Remembers for this session that a model needs its reasoning on.
 * @param {string|undefined} model
 */
export function rememberReasoningRequired(model) {
    if (model) reasoningRequired.add(model);
}

/** Forgets the models remembered by rememberReasoningRequired (tests). */
export function forgetReasoningRequired() {
    reasoningRequired.clear();
}
