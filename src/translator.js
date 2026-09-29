// No SillyTavern imports: the LLM call is injected, so the retry logic is unit-tested in Node.
import { delay, makeBatches, runPool } from './batching.js';
import { buildSystemPrompt, buildUserPrompt, looksTruncated, parseModelResponse, validateBatchResponse } from './prompt.js';

/**
 * @typedef {object} PromptItem
 * @property {number} id
 * @property {string} book
 * @property {string} [title]
 * @property {string} [context]
 * @property {string[]} terms
 *
 * @typedef {object} Translation
 * @property {string} source
 * @property {{base: string, forms: string[]}[]} variants
 *
 * @callback RequestFn
 * @param {{role: string, content: string}[]} messages
 * @param {{useSchema: boolean, signal: AbortSignal}} options
 * @returns {Promise<unknown>} Raw model output (string or already parsed object).
 */

export class Translator {
    /** @type {Map<number, Translation[]>} */
    results = new Map();
    /** @type {{id: number, reason: string}[]} */
    failures = [];
    /** @type {string[]} */
    warnings = [];
    schemaFallbackUsed = false;

    /**
     * @param {object} options
     * @param {RequestFn} options.request
     * @param {{name: string, grammar: string, example?: string}} options.lang
     * @param {{maxVariants: number, maxRetries: number, maxBatchTokens: number, maxTermsPerBatch: number, useJsonSchema: boolean}} options.settings
     * @param {number} options.concurrency
     * @param {(text: string) => Promise<number>} options.countTokens
     * @param {AbortSignal} options.signal
     * @param {(done: number, total: number) => void} [options.onProgress]
     * @param {number} [options.retryDelayMs]
     */
    constructor({ request, lang, settings, concurrency, countTokens, signal, onProgress, retryDelayMs = 1500 }) {
        this.request = request;
        this.settings = settings;
        this.concurrency = concurrency;
        this.countTokens = countTokens;
        this.signal = signal;
        this.onProgress = onProgress ?? (() => { });
        this.retryDelayMs = retryDelayMs;
        this.useSchema = settings.useJsonSchema;
        this.systemPrompt = buildSystemPrompt(lang, { maxVariants: settings.maxVariants });
        this.total = 0;
    }

    /**
     * @param {PromptItem[]} items
     */
    async translate(items) {
        this.total = items.length;
        const batches = await makeBatches(items, {
            countTokens: this.countTokens,
            maxTokens: this.settings.maxBatchTokens,
            maxTerms: this.settings.maxTermsPerBatch,
        });
        this.batchCount = batches.length;
        const errors = await runPool(batches.map(batch => () => this.#translateBatch(batch, 0)), this.concurrency, this.signal);
        for (const error of errors) {
            if (!this.signal.aborted) this.warnings.push(String(error?.message ?? error));
        }
    }

    #reportProgress() {
        this.onProgress(this.results.size + this.failures.length, this.total);
    }

    #fail(batch, reason) {
        for (const item of batch) this.failures.push({ id: item.id, reason });
        this.#reportProgress();
    }

    /**
     * @param {PromptItem[]} batch
     * @param {number} attempt
     */
    async #translateBatch(batch, attempt) {
        this.signal.throwIfAborted();
        const messages = [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: buildUserPrompt(batch) },
        ];

        let raw;
        let parseFailedInTransport = false;
        try {
            raw = await this.request(messages, { useSchema: this.useSchema, signal: this.signal });
        } catch (error) {
            if (this.signal.aborted) throw error;
            // ST parses structured output itself and throws SyntaxError (wrapped in `cause`) on invalid JSON.
            if (error instanceof SyntaxError || error?.cause instanceof SyntaxError) {
                parseFailedInTransport = true;
            } else if (this.useSchema && !this.schemaFallbackUsed) {
                // The backend may not support json_schema: keep going with the JSON-in-prompt instructions only.
                this.useSchema = false;
                this.schemaFallbackUsed = true;
                this.warnings.push(`Structured output failed (${describeError(error)}), continuing without JSON schema`);
                return this.#translateBatch(batch, attempt);
            } else if (attempt < this.settings.maxRetries) {
                await delay(this.retryDelayMs * (attempt + 1), this.signal);
                return this.#translateBatch(batch, attempt + 1);
            } else {
                return this.#fail(batch, describeError(error));
            }
        }

        const parsed = parseFailedInTransport ? null : parseModelResponse(raw);
        if (!parsed) {
            const truncated = parseFailedInTransport || looksTruncated(raw);
            if (truncated && batch.length > 1) {
                // The reply did not fit into the response length: halve the batch.
                const middle = Math.ceil(batch.length / 2);
                await this.#translateBatch(batch.slice(0, middle), attempt);
                await this.#translateBatch(batch.slice(middle), attempt);
                return;
            }
            if (attempt < this.settings.maxRetries) {
                return this.#translateBatch(batch, attempt + 1);
            }
            return this.#fail(batch, truncated ? 'reply was cut off (increase the response length)' : 'reply is not valid JSON');
        }

        const { results, missing, warnings } = validateBatchResponse(parsed, batch, { maxVariants: this.settings.maxVariants });
        for (const [id, translations] of results) this.results.set(id, translations);
        this.warnings.push(...warnings);
        this.#reportProgress();

        if (missing.length) {
            const missingItems = batch.filter(item => missing.includes(item.id));
            if (attempt < this.settings.maxRetries) {
                return this.#translateBatch(missingItems, attempt + 1);
            }
            return this.#fail(missingItems, 'missing in the reply');
        }
    }
}

function describeError(error) {
    // generateRawData throws the backend's JSON body (not an Error) on HTTP errors.
    if (error && typeof error === 'object' && !(error instanceof Error)) {
        return String(error.error?.message ?? error.message ?? JSON.stringify(error));
    }
    const cause = error?.cause?.message;
    const message = error?.message ?? String(error);
    return cause && cause !== message ? `${message}: ${cause}` : message;
}
