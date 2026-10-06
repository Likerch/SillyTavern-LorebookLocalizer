import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestFn } from '../src/connection.js';
import { RequestTimeoutError } from '../src/translator.js';

const STOPPED = 'generation_stopped';
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];

/**
 * A fake SillyTavern whose generateRawData behaves like the real one: it adds its own GENERATION_STOPPED hook
 * synchronously, waits for the "network" and removes the hook when it settles. With `findableHook: false` the
 * listeners are not reachable (another SillyTavern version): only stopGeneration() stops a call.
 */
function fakeContext({ findableHook = true } = {}) {
    const listeners = [() => {}]; // somebody else's listener (the reasoning UI, for example)
    const calls = [];
    const ctx = {
        eventSource: findableHook ? { events: { [STOPPED]: listeners } } : {},
        eventTypes: { GENERATION_STOPPED: STOPPED },
        calls,
        active: 0,
        peak: 0,
        chatStops: 0,
        stopGeneration() {
            ctx.chatStops++;
            for (const listener of [...listeners]) listener();
        },
        extractMessageFromData: (data) => data.text,
        generateRawData(params) {
            let answer = (_data) => {};
            let fail = (_error) => {};
            const network = new Promise((resolve, reject) => { answer = resolve; fail = reject; });
            const call = { params, aborted: false, answer, settled: false };
            const hook = () => {
                call.aborted = true;
                setTimeout(() => fail(new Error('Cancelled by stop event')), 5);
            };
            listeners.push(hook);
            calls.push(call);
            ctx.active++;
            ctx.peak = Math.max(ctx.peak, ctx.active);
            return (async () => {
                try {
                    return await network;
                } finally {
                    ctx.active--;
                    call.settled = true;
                    listeners.splice(listeners.indexOf(hook), 1);
                }
            })();
        },
    };
    return { ctx, listeners };
}

const current = { kind: 'current', isChat: false, api: 'textgenerationwebui', label: 'x' };
const settings = { responseTokens: 321, temperature: 0.2 };

test('current connection: a timeout aborts only this request, through its own stop hook', async () => {
    const { ctx, listeners } = fakeContext();
    const request = createRequestFn(current, settings, ctx);
    const attempt = new AbortController();
    const pending = request(messages, { useSchema: false, signal: attempt.signal });
    await tick();
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].params.responseLength, 321);
    assert.equal(listeners.length, 2);

    attempt.abort(new RequestTimeoutError(90_000));
    await assert.rejects(pending);
    assert.equal(ctx.calls[0].aborted, true);
    assert.equal(ctx.chatStops, 0, "the user's chat generation is left alone");
    assert.equal(listeners.length, 1, "only the call's own hook was used and removed");

    const next = request(messages, { useSchema: false, signal: new AbortController().signal });
    await tick();
    ctx.calls[1].answer({ text: 'reply' });
    assert.equal(await next, 'reply');
});

test('current connection: the next request waits until an abandoned one has settled (no overlap)', async () => {
    const { ctx } = fakeContext({ findableHook: false });
    const request = createRequestFn(current, settings, ctx);
    const first = new AbortController();
    const abandoned = request(messages, { useSchema: false, signal: first.signal });
    abandoned.catch(() => {});
    await tick();
    first.abort(new RequestTimeoutError(90_000));
    assert.equal(ctx.chatStops, 0, 'a timeout never stops the chat generation');

    const retry = request(messages, { useSchema: false, signal: new AbortController().signal });
    await tick(20);
    assert.equal(ctx.calls.length, 1, 'the retry waits for the abandoned call');

    ctx.calls[0].answer({ text: 'late' });
    await assert.rejects(abandoned, (error) => error instanceof RequestTimeoutError, 'the late answer is ignored');
    await tick();
    assert.equal(ctx.calls.length, 2, 'the retry starts once the first call settled');
    ctx.calls[1].answer({ text: 'fresh' });
    assert.equal(await retry, 'fresh');
    assert.equal(ctx.peak, 1, 'generateRawData never ran twice at once');
});

test('current connection: without a findable hook a stop by the user still stops the generation', async () => {
    const { ctx } = fakeContext({ findableHook: false });
    const request = createRequestFn(current, settings, ctx);
    const attempt = new AbortController();
    const pending = request(messages, { useSchema: false, signal: attempt.signal });
    await tick();
    attempt.abort(new DOMException('Stopped by user', 'AbortError'));
    await assert.rejects(pending);
    assert.equal(ctx.chatStops, 1);
    assert.equal(ctx.calls[0].settled, true);
});

test('current connection: a request stopped while waiting for its turn never starts and does not block the next', async () => {
    const { ctx } = fakeContext();
    const request = createRequestFn(current, settings, ctx);
    const running = request(messages, { useSchema: false, signal: new AbortController().signal });
    const waiting = new AbortController();
    const dropped = request(messages, { useSchema: false, signal: waiting.signal });
    const last = request(messages, { useSchema: false, signal: new AbortController().signal });
    await tick();
    waiting.abort(new Error('stop'));
    await assert.rejects(dropped, /stop/);
    ctx.calls[0].answer({ text: 'one' });
    assert.equal(await running, 'one');
    await tick();
    assert.equal(ctx.calls.length, 2, 'the dropped request never reached generateRawData');
    ctx.calls[1].answer({ text: 'two' });
    assert.equal(await last, 'two');
    assert.equal(ctx.peak, 1);
});

test('profile: the attempt signal goes down to sendRequest', async () => {
    const sent = [];
    const ctx = {
        ConnectionManagerRequestService: {
            sendRequest: async (profileId, prompt, maxTokens, custom, overridePayload) => {
                sent.push({ profileId, maxTokens, custom, overridePayload });
                return { content: '{"results":[]}' };
            },
        },
    };
    const request = createRequestFn({ kind: 'profile', profileId: 'cheap', isChat: true, label: 'Cheap' }, settings, ctx);
    const attempt = new AbortController();
    assert.equal(await request(messages, { useSchema: true, signal: attempt.signal }), '{"results":[]}');
    assert.equal(sent[0].custom.signal, attempt.signal);
    assert.equal(sent[0].profileId, 'cheap');
    assert.ok(sent[0].overridePayload.json_schema);
});
