// Pure helper, no SillyTavern imports: unit-tested in Node.

/** Values of the "model reasoning" settings (`reasoning`, `lbcReasoning`). */
export const REASONING_MODES = Object.freeze(['off', 'auto', 'low', 'medium', 'high']);

/**
 * The `reasoning_effort` to send with the extension's own requests. They ask for JSON, where reasoning only costs
 * time and money. Worse, a reasoning model asked without the profile's preset (or with an RP preset set to "high")
 * may spend the whole response length on thoughts and return no answer at all: DeepSeek on OpenRouter reasons unless
 * it is told not to, and OpenRouter takes 'none' as given.
 * @param {string} mode `off` | `auto` | `low` | `medium` | `high`
 * @param {string|undefined} api the API or chat completion source (`openrouter`, …)
 * @returns {string|undefined} undefined: leave the request as it is
 */
export function reasoningEffort(mode, api) {
    if (mode === 'auto') return undefined;
    if (mode === 'off' || !mode) return api === 'openrouter' ? 'none' : undefined;
    return mode;
}
