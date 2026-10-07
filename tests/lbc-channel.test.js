import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    classifyLbcPrompt, isLbcPrompt, lbcExpectsJson, lbcParseJson, lbcReplyProblem, normalizeLikeLbc, unwrapLbcPrompt,
} from '../src/lbc/adapter.js';
import {
    BASE_RULES, buildMessages, completionBody, errorBody, excerpt, LBC_PROFILE_INHERIT, reasoningEffort,
    resolveLbcProfileId,
} from '../src/lbc/channel-core.js';
import { addFetchHandler, requestPath } from '../src/lbc/fetch-hook.js';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const vendored = join(root, 'vendor', 'lorebook-creator', 'index.js');

test('LBC prompts: recognized by their [OOC: wrapper, unwrapped, classified', () => {
    assert.ok(isLbcPrompt('  [OOC: Generate ONE detailed lorebook entry.\n…]'));
    assert.ok(!isLbcPrompt('Summarize the chat'));
    assert.ok(!isLbcPrompt(undefined));
    assert.equal(unwrapLbcPrompt('[OOC: Rewrite this entry.\nONLY valid JSON!]'), 'Rewrite this entry.\nONLY valid JSON!');
    assert.equal(unwrapLbcPrompt('plain text'), 'plain text');
    assert.equal(classifyLbcPrompt('[OOC: Generate 5 NEW lorebook entries specifically for the category: "Location".\n]'), 'expandSpecificCategory');
    assert.equal(classifyLbcPrompt('[OOC: Generate 5 NEW lorebook entries to fill gaps.\n]'), 'expandEntries');
    assert.equal(classifyLbcPrompt('[OOC: Something new]'), 'unknown');
    assert.equal(lbcExpectsJson('enhanceField'), false);
    assert.equal(lbcExpectsJson('simpleGenerate'), true);
    assert.equal(lbcExpectsJson('unknown'), null);
});

test('every prompt of the vendored LBC is classified, each as its own kind', { skip: !existsSync(vendored) && 'vendor/lorebook-creator is not checked out' }, () => {
    const source = readFileSync(vendored, 'utf8');
    const starts = [...source.matchAll(/'\[OOC:(?:[^'\\]|\\.)*'/g)].map(match => Function(`return ${match[0]}`)());
    assert.equal(starts.length, 21);
    const kinds = starts.map(text => classifyLbcPrompt(text.replace(/\{\{COUNT\}\}/g, '7')));
    assert.deepEqual(kinds.filter(kind => kind === 'unknown'), []);
    assert.equal(new Set(kinds).size, 21);
});

test('LBC reply check: its lenient parseJSON and the shape each prompt asks for', () => {
    assert.deepEqual(lbcParseJson('{"entries":[]}'), { entries: [] });
    assert.deepEqual(lbcParseJson('Here you go:\n```json\n{"entries":[{"comment":"A"}]}\n```'), { entries: [{ comment: 'A' }] });
    // A whole-text array comes back as it is (LBC then finds no `entries`); an array inside text becomes {entries}.
    assert.deepEqual(lbcParseJson('[{"comment":"A"}]'), [{ comment: 'A' }]);
    assert.deepEqual(lbcParseJson('Keys: ["a", "b"] done'), { entries: ['a', 'b'] });
    assert.deepEqual(lbcParseJson('Entries: [{"comment":"A"}] done'), { comment: 'A' }, 'an object inside wins, as in LBC');
    assert.equal(lbcReplyProblem('simpleGenerate', '[{"comment":"A"}]'), 'shape');
    assert.equal(lbcParseJson('Свет фонарей дрожит на мокрой мостовой.'), null);
    assert.equal(lbcParseJson('{"entries": [ {"comment": "A" '), null);

    assert.equal(lbcReplyProblem('simpleGenerate', '  '), 'empty');
    assert.equal(lbcReplyProblem('simpleGenerate', 'Свет фонарей.'), 'notJson');
    // A roleplay reply with a DES tracker block is JSON, but not a book: LBC would wipe the editor with it.
    assert.equal(lbcReplyProblem('simpleGenerate', '```json\n{"quests":{},"characters":[]}\n```\nСвет фонарей.'), 'shape');
    assert.equal(lbcReplyProblem('simpleGenerate', '{"worldName":"X","entries":[]}'), null);
    assert.equal(lbcReplyProblem('regenerateEntry', '{"comment":"A","content":"a"}'), null);
    assert.equal(lbcReplyProblem('autoCategorize', '{"entries":[]}'), 'shape');
    assert.equal(lbcReplyProblem('autoCategorize', '[{"index":0,"category":"Character"}]'), null, 'LBC takes a bare array');
    assert.equal(lbcReplyProblem('mergePair', '{"entries":[{"pair":0,"content":"x"}]}'), null, 'LBC falls back to entries');
    assert.equal(lbcReplyProblem('llmEdit', '{}'), null, 'no changes is a valid edit');
    assert.equal(lbcReplyProblem('enhanceField', 'A longer text.'), null);
    assert.equal(lbcReplyProblem('unknown', 'anything'), null);
});

test('LBC normalization quirks are mirrored: zeros become defaults, the category comes from the comment', () => {
    const loaded = normalizeLikeLbc({ comment: 'Port — Location', key: 'harbor, port', content: 'x', depth: 0, order: 0, probability: 0, sticky: null, cooldown: 0, useGroupScoring: null });
    assert.equal(loaded.depth, 4);
    assert.equal(loaded.order, 100);
    assert.equal(loaded.probability, 100);
    assert.equal(loaded.sticky, 0);
    assert.equal(loaded.cooldown, null);
    assert.equal(loaded.useGroupScoring, false);
    assert.equal(loaded.category, 'Location');
    assert.deepEqual(loaded.key, ['harbor', 'port']);
    assert.equal(normalizeLikeLbc({ addMemo: true }).comment, true, 'an empty comment becomes addMemo, as in LBC');
    assert.equal(normalizeLikeLbc({ insertion_order: 7 }).order, 7);
});

test('channel settings: profile inheritance and reasoning effort', () => {
    assert.equal(resolveLbcProfileId({ lbcProfileId: LBC_PROFILE_INHERIT, profileId: 'p1' }), 'p1');
    assert.equal(resolveLbcProfileId({ profileId: 'p1' }), 'p1', 'missing setting = inherit');
    assert.equal(resolveLbcProfileId({ lbcProfileId: LBC_PROFILE_INHERIT, profileId: '' }), '');
    assert.equal(resolveLbcProfileId({ lbcProfileId: '', profileId: 'p1' }), '');
    assert.equal(resolveLbcProfileId({ lbcProfileId: 'p2', profileId: 'p1' }), 'p2');
    assert.equal(reasoningEffort('off', 'openrouter'), 'none');
    assert.equal(reasoningEffort('off', 'deepseek'), undefined);
    assert.equal(reasoningEffort('auto', 'openrouter'), undefined);
    assert.equal(reasoningEffort('low', 'custom'), 'low');
});

test('channel messages: our rules as system, LBC prompt unwrapped and untouched as user', () => {
    const raw = '[OOC: You are a LoreBook / World Info creation assistant.\nUSER IDEA:\n{{user}} dives for salvage.\nONLY valid JSON!]';
    const messages = buildMessages(raw, ['Write in English.', '']);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.startsWith(BASE_RULES));
    assert.ok(messages[0].content.endsWith('Write in English.'));
    assert.equal(messages[1].role, 'user');
    assert.ok(messages[1].content.includes('{{user}} dives for salvage.'));
    assert.ok(!messages[1].content.startsWith('[OOC:'));
    assert.equal(completionBody('x').choices[0].message.content, 'x');
    assert.equal(errorBody('boom').error.message, 'boom');
    assert.equal(excerpt('a  b\n\nc', 3), 'a b…');
});

test('fetch hook: handlers answer or pass, next() can change the options, the wrapper comes off cleanly', async () => {
    const calls = [];
    const target = { fetch: async (input, init) => { calls.push([input, init?.body]); return `real:${init?.body ?? ''}`; } };
    const original = target.fetch;
    const off = addFetchHandler((request, next) => {
        if (request.url === '/api/answer') return Promise.resolve('fake');
        if (request.url === '/api/change') return next({ body: 'changed' });
        return null;
    }, target);
    assert.notEqual(target.fetch, original);
    assert.equal(await target.fetch('/api/answer', { body: 'a' }), 'fake');
    assert.equal(await target.fetch('/api/change', { body: 'b' }), 'real:changed');
    assert.equal(await target.fetch('/api/other', { body: 'c' }), 'real:c');
    assert.deepEqual(calls, [['/api/change', 'changed'], ['/api/other', 'c']]);
    off();
    assert.equal(target.fetch, original);

    // Wrapped by someone else meanwhile: ours stays in the chain but no longer runs handlers.
    let seen = 0;
    const off2 = addFetchHandler(() => { seen++; return null; }, target);
    const ours = target.fetch;
    target.fetch = async (input, init) => ours(input, init);
    off2();
    await target.fetch('/api/x', {});
    assert.equal(seen, 0);
    assert.equal(requestPath('/api/backends/chat-completions/generate'), '/api/backends/chat-completions/generate');
});
