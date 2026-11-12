// 0.6.0: «Расширить мир» as Maestro's built-in agent on Localizer's own channel — registered once per Maestro API object,
// the system message replaced by the instruction Maestro gives, the user's parameters, runs reported; nothing without
// Maestro 1.34.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    EXPAND_AGENT_ID, expandDefaults, installMaestroAgents, maestroAgents, reportExpand, tuneExpand,
} from '../src/maestro-agents.js';
import { expandSystemPrompt } from '../src/lbc/expand-core.js';

function fakeMaestro({ instruction } = {}) {
    const calls = { registered: [], reports: [], offs: 0 };
    globalThis.MAESTRO_API = {
        version: 1,
        agents: {
            registerBuiltIn: (spec) => {
                calls.registered.push(spec);
                return () => { calls.offs++; };
            },
            instruction: instruction ?? ((id, text) => ({ text })),
            report: (id, run) => calls.reports.push({ id, run }),
        },
    };
    return calls;
}

test('without Maestro 1.34 nothing changes', () => {
    delete globalThis.MAESTRO_API;
    assert.equal(maestroAgents(), null);
    const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
    assert.deepEqual(tuneExpand(messages), { messages });
    reportExpand({ ok: true, ms: 1 });
    globalThis.MAESTRO_API = { version: 1, llm: {} };
    assert.equal(maestroAgents(), null);
    delete globalThis.MAESTRO_API;
});

test('registered once per Maestro, on its own channel, with every default text', () => {
    const calls = fakeMaestro();
    const remove = installMaestroAgents();
    installMaestroAgents();
    assert.equal(calls.registered.length, 1);
    const spec = calls.registered[0];
    assert.equal(spec.id, EXPAND_AGENT_ID);
    assert.equal(spec.channel, 'own');
    assert.equal(spec.interactive, true);
    const texts = spec.defaultInstructions();
    assert.ok(texts.includes(expandSystemPrompt('ru', 'oneshot')));
    assert.ok(texts.includes(expandSystemPrompt('en', 'dialog')));
    assert.deepEqual(texts, expandDefaults());
    remove();
    assert.equal(calls.offs, 1);
    delete globalThis.MAESTRO_API;
});

test('the user’s instruction and parameters go into the request; runs are reported', () => {
    const calls = fakeMaestro({
        instruction: (id, text) => ({ text: `${text}\n\nAdditional instructions:\nMore taverns.`, temperature: 0.4, maxTokens: 3000 }),
    });
    const tuned = tuneExpand([{ role: 'system', content: 'RULES' }, { role: 'user', content: 'TASK' }]);
    assert.deepEqual(tuned, {
        messages: [
            { role: 'system', content: 'RULES\n\nAdditional instructions:\nMore taverns.' },
            { role: 'user', content: 'TASK' },
        ],
        temperature: 0.4,
        maxTokens: 3000,
    });
    reportExpand({ ok: true, ms: 1500, raw: '{}' });
    assert.deepEqual(calls.reports, [{ id: EXPAND_AGENT_ID, run: { ok: true, ms: 1500, raw: '{}' } }]);
    delete globalThis.MAESTRO_API;
});
