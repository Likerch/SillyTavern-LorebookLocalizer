import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Translator } from '../src/translator.js';
import { makeBatches, runPool } from '../src/batching.js';
import { resolveLanguage } from '../src/constants.js';

const settings = { maxVariants: 3, maxRetries: 2, maxBatchTokens: 10_000, maxTermsPerBatch: 100, useJsonSchema: true };
const lang = resolveLanguage({ language: 'ru' });
const countTokens = async (text) => Math.ceil(text.length / 4);

const items = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, book: 'B', terms: [`Term${i + 1}`] }));

/** Fake model that answers for the ids found in the user message. */
function answerFor(messages, { skip = [] } = {}) {
    const payload = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('\n') + 1));
    return JSON.stringify({
        results: payload.items.filter(it => !skip.includes(it.id)).map(it => ({
            id: it.id,
            translations: it.terms.map(term => ({ source: term, variants: [{ base: `Т${term}`, forms: [`Т${term}`, `Т${term}а`] }] })),
        })),
    });
}

function makeTranslator(request, extra = {}) {
    return new Translator({
        request, lang, settings: { ...settings, ...extra.settings }, concurrency: extra.concurrency ?? 2,
        countTokens, signal: extra.signal ?? new AbortController().signal, retryDelayMs: 1,
    });
}

test('happy path', async () => {
    const tr = makeTranslator(async (messages) => answerFor(messages));
    await tr.translate(items);
    assert.equal(tr.results.size, 6);
    assert.equal(tr.failures.length, 0);
});

test('missing ids are retried, then reported as failures', async () => {
    let calls = 0;
    const tr = makeTranslator(async (messages) => {
        calls++;
        return answerFor(messages, { skip: [6] });
    });
    await tr.translate(items);
    assert.equal(tr.results.size, 5);
    assert.deepEqual(tr.failures.map(f => f.id), [6]);
    assert.equal(calls, 3, 'initial + 2 retries');
});

test('truncated reply splits the batch', async () => {
    const sizes = [];
    const tr = makeTranslator(async (messages) => {
        const answer = answerFor(messages);
        const count = (answer.match(/"id"/g) ?? []).length;
        sizes.push(count);
        return count > 2 ? answer.slice(0, answer.length / 2) : answer;
    });
    await tr.translate(items);
    assert.equal(tr.results.size, 6);
    assert.deepEqual(sizes, [6, 3, 2, 1, 3, 2, 1]);
});

test('schema error falls back to prompt-only JSON once', async () => {
    const seen = [];
    const tr = makeTranslator(async (messages, { useSchema }) => {
        seen.push(useSchema);
        if (useSchema) throw new Error('API request failed', { cause: new Error('json_schema not supported') });
        return answerFor(messages);
    }, { concurrency: 1 });
    await tr.translate(items);
    assert.equal(tr.results.size, 6);
    assert.deepEqual(seen, [true, false]);
    assert.ok(tr.warnings.some(w => w.includes('json_schema not supported')));
});

test('SyntaxError from ST structured parsing is treated as a cut-off reply', async () => {
    let first = true;
    const tr = makeTranslator(async (messages) => {
        if (first) {
            first = false;
            throw new Error('API request failed', { cause: new SyntaxError('Unexpected end of JSON input') });
        }
        return answerFor(messages);
    }, { concurrency: 1 });
    await tr.translate(items);
    assert.equal(tr.results.size, 6);
    assert.equal(tr.useSchema, true, 'schema stays on');
});

test('network errors are retried and then fail the batch', async () => {
    let calls = 0;
    const tr = makeTranslator(async () => {
        calls++;
        throw new Error('500');
    }, { settings: { useJsonSchema: false } });
    await tr.translate(items);
    assert.equal(tr.failures.length, 6);
    assert.equal(calls, 3);
});

test('abort stops the run', async () => {
    const controller = new AbortController();
    const tr = makeTranslator(async (messages) => {
        controller.abort(new Error('stopped'));
        return answerFor(messages);
    }, { signal: controller.signal, concurrency: 1, settings: { maxTermsPerBatch: 1 } });
    await tr.translate(items);
    assert.equal(tr.results.size, 1, 'only the in-flight batch completes');
});

test('makeBatches respects the token and term limits', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i, terms: ['a', 'b', 'c'] }));
    const batches = await makeBatches(many, { countTokens: async () => 10, maxTokens: 45, maxTerms: 100 });
    assert.deepEqual(batches.map(b => b.length), [4, 4, 2]);
    const byTerms = await makeBatches(many, { countTokens: async () => 1, maxTokens: 1000, maxTerms: 7 });
    assert.deepEqual(byTerms.map(b => b.length), [2, 2, 2, 2, 2]);
    const failing = await makeBatches(many.slice(0, 2), { countTokens: async () => { throw new Error('x'); }, maxTokens: 1000, maxTerms: 100 });
    assert.equal(failing.length, 1, 'falls back to a length estimate');
});

test('runPool limits concurrency', async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 8 }, () => async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
    });
    await runPool(tasks, 3);
    assert.equal(peak, 3);
});
