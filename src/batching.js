// Pure helpers, no SillyTavern imports: this module is unit-tested in Node.

/**
 * Groups items into batches limited by input tokens and by the number of terms
 * (the reply lists many word forms per term, so output grows much faster than input).
 * @template {{terms: string[]}} T
 * @param {T[]} items
 * @param {{countTokens: (text: string) => Promise<number>, maxTokens: number, maxTerms: number}} options
 * @returns {Promise<T[][]>}
 */
export async function makeBatches(items, { countTokens, maxTokens, maxTerms }) {
    const batches = [];
    let current = [];
    let currentTokens = 0;
    let currentTerms = 0;

    for (const item of items) {
        const text = JSON.stringify(item);
        let tokens;
        try {
            tokens = await countTokens(text);
        } catch {
            tokens = Math.ceil(text.length / 3);
        }
        const terms = item.terms.length;
        if (current.length && (currentTokens + tokens > maxTokens || currentTerms + terms > maxTerms)) {
            batches.push(current);
            current = [];
            currentTokens = 0;
            currentTerms = 0;
        }
        current.push(item);
        currentTokens += tokens;
        currentTerms += terms;
    }
    if (current.length) batches.push(current);
    return batches;
}

/**
 * Runs async tasks with a concurrency limit. Stops starting new tasks once the signal is aborted.
 * Task errors are collected, not thrown.
 * @param {(() => Promise<void>)[]} tasks
 * @param {number} concurrency
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown[]>} Errors thrown by tasks.
 */
export async function runPool(tasks, concurrency, signal) {
    const errors = [];
    let next = 0;
    const worker = async () => {
        while (next < tasks.length && !signal?.aborted) {
            const task = tasks[next++];
            try {
                await task();
            } catch (error) {
                errors.push(error);
            }
        }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker);
    await Promise.all(workers);
    return errors;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(undefined);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Settles when `promise` settles (its result is ignored) or rejects with the signal's reason when it aborts first.
 * @param {Promise<unknown>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
export function settledOrAborted(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        const done = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        promise.then(done, done);
    });
}
