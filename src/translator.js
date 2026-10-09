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
 * @typedef {'timeout'|'invalid'|'error'} FailureKind
 *   `timeout` no reply in time, `invalid` the reply was unusable (not JSON, cut off, entry missing), `error` the
 *   request failed
 *
 * @callback RequestFn
 * @param {{role: string, content: string}[]} messages
 * @param {{useSchema: boolean, signal: AbortSignal, schema?: {name: string, value: object}}} options The signal aborts
 *   on a stop and on a timeout (its reason is then a `TimeoutError`); the request should stop and settle soon after.
 *   Its late answer is ignored either way. `schema` replaces the key translation schema.
 * @returns {Promise<unknown>} Raw model output (string or already parsed object).
 */

/** The reason of an attempt's signal when the batch got no reply in time. */
export class RequestTimeoutError extends Error {
    /** @param {number} ms */
    constructor(ms) {
        super(`no reply in ${Math.round(ms / 1000)} s`);
        this.name = 'TimeoutError';
    }
}

/** @param {unknown} error */
export function isTimeoutError(error) {
    return /** @type {{name?: unknown}} */ (error)?.name === 'TimeoutError';
}

export class Translator {
    /** @type {Map<number, Translation[]>} */
    results = new Map();
    /** @type {{id: number, reason: string, kind: FailureKind}[]} */
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
     * @param {number} [options.batchTimeoutMs] an attempt with no reply in this time is stopped and counts as failed
     *   (retried like an error); 0 or Infinity: no limit
     */
    constructor({ request, lang, settings, concurrency, countTokens, signal, onProgress, retryDelayMs = 1500, batchTimeoutMs = 0 }) {
        this.request = request;
        this.settings = settings;
        this.concurrency = concurrency;
        this.countTokens = countTokens;
        this.signal = signal;
        this.onProgress = onProgress ?? (() => { });
        this.retryDelayMs = retryDelayMs;
        this.batchTimeoutMs = Number.isFinite(batchTimeoutMs) && batchTimeoutMs > 0 ? batchTimeoutMs : 0;
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

    /** Entries finished so far, translated or failed. */
    get done() {
        return this.results.size + this.failures.length;
    }

    #reportProgress() {
        this.onProgress(this.done, this.total);
    }

    /**
     * @param {PromptItem[]} batch
     * @param {string} reason
     * @param {FailureKind} kind
     */
    #fail(batch, reason, kind) {
        for (const item of batch) this.failures.push({ id: item.id, reason, kind });
        this.#reportProgress();
    }

    /**
     * One attempt. Rejects at once on a stop or a timeout, without waiting for the transport: its late answer is
     * ignored, and the transport itself makes sure an abandoned call cannot overlap with the next one.
     * @param {{role: string, content: string}[]} messages
     */
    async #send(messages) {
        this.signal.throwIfAborted();
        const attempt = new AbortController();
        const forwardStop = () => attempt.abort(this.signal.reason);
        this.signal.addEventListener('abort', forwardStop, { once: true });
        const stopped = new Promise((_, reject) => {
            attempt.signal.addEventListener('abort', () => reject(attempt.signal.reason), { once: true });
        });
        const timer = this.batchTimeoutMs
            ? setTimeout(() => attempt.abort(new RequestTimeoutError(this.batchTimeoutMs)), this.batchTimeoutMs)
            : undefined;
        const reply = (async () => this.request(messages, { useSchema: this.useSchema, signal: attempt.signal }))();
        reply.catch(() => { });
        try {
            return await Promise.race([reply, stopped]);
        } finally {
            clearTimeout(timer);
            this.signal.removeEventListener('abort', forwardStop);
        }
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
            raw = await this.#send(messages);
        } catch (error) {
            if (this.signal.aborted) throw error;
            if (isTimeoutError(error)) {
                // Not a sign of a missing json_schema support: retried as is.
                if (attempt < this.settings.maxRetries) {
                    await delay(this.retryDelayMs * (attempt + 1), this.signal);
                    return this.#translateBatch(batch, attempt + 1);
                }
                return this.#fail(batch, describeError(error), 'timeout');
            }
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
                return this.#fail(batch, describeError(error), 'error');
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
            return this.#fail(batch, truncated ? 'reply was cut off (increase the response length)' : 'reply is not valid JSON', 'invalid');
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
            return this.#fail(missingItems, 'missing in the reply', 'invalid');
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
