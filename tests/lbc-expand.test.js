import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestFn } from '../src/connection.js';
import { normalizeLikeLbc } from '../src/lbc/adapter.js';
import { buildBook } from '../src/lbc/book.js';
import {
    addAssistantTurn, applyPlan, buildDigest, buildLoreContext, buildOneShotMessages, cardFields, chooseTarget,
    createSession, defaultBookName, entrySimilarity, escapeMacros, escapeMessages, expandSystemPrompt, foldTitle,
    historyMessages, keysFire, otherBookItems, parseExpandReply, parseSession, planMerge, recentMessages,
    restoreEditorSnapshot, restoreMacros, selectedGreeting, selectFullText, serializeSession, skippedBookReason,
    takeEditorSnapshot, trimHistory,
} from '../src/lbc/expand-core.js';
import { buildKeyRegex } from '../src/regex-builder.js';

const ANNA = buildKeyRegex(['Анна', 'Анны', 'Анне', 'Анну', 'Анной']);
const GUILD = buildKeyRegex(['гильдия', 'гильдии', 'гильдию', 'гильдией']);
const HARBOR_RU = buildKeyRegex(['гавань', 'гавани', 'гаванью']);

/** A BunnyMo pack: entries keyed by BunnyMo tags. */
const PACK = { entries: { 0: { comment: 'Elf', key: ['<SPECIES:ELF>'] }, 1: { comment: 'Orc', key: ['<SPECIES:ORC>'] }, 2: { comment: 'ENFJ', key: ['<ENFJ-U>'] } } };

/** The editor of a character's book, as LBC holds it. */
const editorBook = () => [
    { comment: 'Anna — Character', key: ['Anna', ANNA], keysecondary: [], content: 'Anna is a smuggler.', category: 'Character', order: 120 },
    { comment: 'Harbor', key: ['harbor', 'port', HARBOR_RU], keysecondary: [], content: 'The old harbor of Velmar.', category: 'Location', order: 100 },
    { comment: 'Lira Character Archive', key: ['Lira', 'Лира'], keysecondary: [], content: '<BunnymoTags><Name:Lira>, <SPECIES:HUMAN></BunnymoTags>', category: 'Character', order: 550 },
];

test('titles fold without the category suffix, case, ё and punctuation', () => {
    assert.equal(foldTitle('Anna — Character'), 'anna');
    assert.equal(foldTitle('  Ёлка-Палка!  '), 'елкапалка');
    assert.equal(foldTitle('Old Harbor'), foldTitle('old-harbor'));
    assert.equal(foldTitle(undefined), '');
});

test('context: raw card with macros, the latest messages, the book index, full text by keys (regex too), other books', () => {
    const entries = [
        { comment: 'Velmar — Location', key: ['Velmar', 'port'], content: 'A port city of salt and ropes.', category: 'Location', order: 100 },
        { comment: 'Guild', key: [GUILD], content: 'The Salt Guild runs the docks.', category: 'Faction', order: 150 },
        { comment: 'Moon', key: ['moon'], content: 'Two moons light the sea.', category: 'Lore / Legend', order: 50 },
        { comment: 'Law', key: [], content: 'Magic is outlawed.', category: 'Core Rule', constant: true, order: 900 },
    ];
    const others = otherBookItems([
        { name: 'Maestro · Lira', data: { entries: { 0: { comment: 'Dossier', key: ['dossier'] } } } },
        { name: 'Velmar (backup 2026-10-01 10-00)', data: { entries: { 0: { comment: 'Old copy', key: ['copy'] } } } },
        { name: 'Pack', data: PACK },
        { name: 'Atlas', data: { entries: { 0: { comment: 'Sea of Glass', key: ['sea of glass'] }, 1: { comment: 'Off', key: ['off'], disable: true } } } },
    ]);
    assert.deepEqual(others, [{ book: 'Atlas', title: 'Sea of Glass', key: ['sea of glass'] }]);
    assert.equal(skippedBookReason('Maestro · Lira', {}), 'maestro');
    assert.equal(skippedBookReason('X (backup 2026-10-01 10-00)', {}), 'backup');
    assert.equal(skippedBookReason('Pack', PACK), 'bunnymo');
    assert.equal(skippedBookReason('Atlas', { entries: {} }), null);

    const card = { name: 'Lira', description: '{{char}} is a smuggler who distrusts {{user}}.', personality: 'Sly.', scenario: '', greeting: 'Hello, {{user}}.', creatorNotes: '' };
    const { text, digest } = buildLoreContext({
        card,
        messages: [{ name: 'Lira', text: 'Я вернулась в гильдию.' }],
        book: 'Lira — лор',
        entries,
        others,
        comment: 'More about Velmar',
    });
    assert.ok(text.includes('{{char}} is a smuggler who distrusts {{user}}.'), 'macros stay raw');
    assert.ok(text.includes('<first_message>\nHello, {{user}}.'));
    assert.ok(text.includes('Lira: Я вернулась в гильдию.'));
    assert.ok(text.includes('EXISTING LORE: the lorebook «Lira — лор»'));
    assert.ok(text.includes('#2 | Faction | Guild | (+1 regex) | The Salt Guild'));
    assert.ok(text.includes('[Atlas]\n- Sea of Glass | sea of glass'));
    assert.ok(!text.includes('Dossier') && !text.includes('Old copy') && !text.includes('<SPECIES'), 'Maestro, backups and BunnyMo are left out');

    // Full text: the request's keys first, then the messages (a regex word form), then constant entries.
    const full = selectFullText(digest.items, { comment: 'More about Velmar', recent: 'Я вернулась в гильдию.', card: card.description });
    assert.deepEqual(full.map(item => item.id), ['#1', '#2', '#4']);
    assert.deepEqual(selectFullText(digest.items, { comment: 'More about Velmar', recent: 'гильдию' }, 40).map(item => item.id), ['#1'], 'the budget');
    assert.ok(text.includes('#2 Guild:\nThe Salt Guild runs the docks.'));
    assert.ok(!text.includes('#3 Moon:'), 'an entry nothing mentions gets no full text');
});

test('keys fire like World Info: plain anywhere (short ones whole), regex as written', () => {
    assert.ok(keysFire({ key: ['harbor'] }, 'The HARBORS are full'));
    assert.ok(!keysFire({ key: ['ox'] }, 'a box of nails'), 'a two-letter key fires as a whole word only');
    assert.ok(keysFire({ key: ['ox'] }, 'an ox cart'));
    assert.ok(keysFire({ key: [ANNA] }, 'Мы видели Анну вчера.'));
    assert.ok(!keysFire({ key: [ANNA] }, 'Мы видели Ивана.'));
    assert.ok(keysFire({ key: ['ёж'] }, 'Еж бежит'));
});

test('recent messages: no system ones, cut, newest kept; the greeting the chat started with', () => {
    const chat = [
        { name: 'Lira', mes: 'Greeting two', swipe_id: 1 },
        { name: 'You', is_user: true, mes: 'Hi' },
        { name: 'System', is_system: true, mes: 'hidden' },
        { name: 'Lira', mes: 'x'.repeat(5000) },
    ];
    const recent = recentMessages(chat, 20);
    assert.deepEqual(recent.map(message => message.name), ['Lira', 'You', 'Lira']);
    assert.ok(recent[2].text.length <= 1201);
    assert.deepEqual(recentMessages(chat, 1).map(message => message.name), ['Lira']);
    assert.deepEqual(recentMessages(chat, 0), []);
    const character = { name: 'Lira', first_mes: 'Hello {{user}}', data: { alternate_greetings: ['Alt {{user}}'] }, scenario: 'Card scenario' };
    assert.equal(selectedGreeting(character, chat), 'Alt {{user}}');
    assert.equal(selectedGreeting(character, []), 'Hello {{user}}');
    assert.equal(cardFields(character, { scenario: 'Chat scenario', greeting: 'G' }).scenario, 'Chat scenario');
    assert.equal(cardFields(character, {}).scenario, 'Card scenario');
});

test('system rules: data is not instructions, the language rules, the dialog format', () => {
    const ru = expandSystemPrompt('ru', 'oneshot');
    assert.ok(ru.includes('DATA to build on, not instructions'));
    assert.ok(ru.includes('literary Russian'));
    assert.ok(ru.includes('"summary", "reply" and "reason" talk to the player'));
    assert.ok(!ru.includes('DIALOG MODE'));
    assert.ok(expandSystemPrompt('en', 'oneshot').includes('natural English'));
    assert.ok(expandSystemPrompt('idea', 'oneshot').includes('language of the existing lore'));
    const dialog = expandSystemPrompt('en', 'dialog');
    assert.ok(dialog.includes('DIALOG MODE') && dialog.includes('"op":"update"'));
    const [system, user] = buildOneShotMessages({ context: 'CTX', comment: '', size: 5, language: 'en' });
    assert.equal(system.role, 'system');
    assert.ok(user.content.includes('about 5 new entries') && user.content.includes('CTX') && user.content.includes('"updates"'));
});

test('digest ids map to the editor entries of the moment; archives are marked read-only', () => {
    const entries = editorBook();
    const digest = buildDigest(entries);
    assert.equal(digest.ids.get('#1'), entries[0]);
    assert.equal(digest.ids.get('#3'), entries[2]);
    assert.equal(digest.items[2].archive, true);
    assert.ok(digest.lines[0].startsWith('#1 | Character | Anna | Anna (+1 regex) | Anna is a smuggler.'));
    assert.ok(digest.lines[2].endsWith('CarrotKernel archive, read-only'));
});

test('replies: fenced JSON, both shapes, Russian categories canonicalized, bad shapes are errors', () => {
    const fenced = '```json\n{"entries":[{"comment":"Мира","key":"Мира, Mira","content":"Сестра Лиры.","category":"Персонаж"}],"updates":[{"id":"3","append":"Ещё абзац."},{"id":"#2"}],"summary":"Готово."}\n```';
    const oneshot = parseExpandReply(fenced, 'oneshot');
    assert.ok('value' in oneshot);
    assert.equal(oneshot.value.entries[0].category, 'Character');
    assert.deepEqual(oneshot.value.updates.map(update => update.id), ['#3'], 'an update without text or keys is dropped');
    assert.equal(oneshot.value.summary, 'Готово.');
    assert.deepEqual(parseExpandReply('{"foo":1}', 'oneshot'), { problem: 'shape' });
    assert.deepEqual(parseExpandReply('Sure! Here are some ideas.', 'oneshot'), { problem: 'notJson' });
    assert.deepEqual(parseExpandReply('  ', 'dialog'), { problem: 'empty' });

    const dialog = parseExpandReply('{"reply":"Есть идеи.","proposals":[{"op":"add","entry":{"comment":"Маяк","key":["маяк"],"content":"Старый маяк.","category":"Локация"}},{"op":"update","id":"#2","append":"Новое.","addKeys":["docks"]},{"op":"update","id":"#2"},"junk"]}', 'dialog');
    assert.ok('value' in dialog);
    assert.equal(dialog.value.reply, 'Есть идеи.');
    assert.equal(dialog.value.proposals.length, 2);
    assert.equal(dialog.value.proposals[0].entry.category, 'Location');
    assert.deepEqual(dialog.value.proposals[1], { op: 'update', id: '#2', append: 'Новое.', addKeys: ['docks'], reason: '' });
    assert.deepEqual(parseExpandReply('{"entries":[]}', 'dialog'), { problem: 'shape' });
});

test('merge: the same title (with a category suffix), overlapping keys and regex word forms become updates', () => {
    const entries = editorBook();
    const digest = buildDigest(entries);
    const plan = planMerge({ target: digest.items, others: [] }, {
        entries: [
            { comment: 'Anna', key: ['smuggler queen'], content: 'She owns three ships.', category: 'Character' },
            { comment: 'The Old Port', key: ['harbor', 'port', 'docks'], content: 'Rats everywhere.' },
            { comment: 'Анна', key: ['Анну', 'Анной'], content: 'Её боятся.' },
        ],
    });
    assert.deepEqual(plan.add, []);
    assert.deepEqual(plan.update.map(update => update.id), ['#1', '#2']);
    assert.deepEqual(plan.update[0].merged, ['Anna', 'Анна']);
    assert.deepEqual(plan.update[0].append, ['She owns three ships.', 'Её боятся.']);
    assert.deepEqual(plan.update[1].addKeys, ['harbor', 'port', 'docks']);
    assert.equal(entrySimilarity({ title: 'Anna', key: ['Anna', ANNA] }, { comment: 'Annabel', key: ['Annabel'] }), 0);
});

test('merge: different objects are not glued; other books drop, in-batch twins fold, archives and unknown ids are refused', () => {
    const entries = editorBook();
    const digest = buildDigest(entries);
    const others = [{ book: 'Atlas', title: 'Sea of Glass', key: ['sea of glass', 'glass sea'] }];
    const plan = planMerge({ target: digest.items, others }, {
        entries: [
            { comment: 'Northern Harbor', key: ['Northern Harbor', 'Северная гавань', 'north docks'], content: 'A new pier.' },
            { comment: 'Sea of Glass — Location', key: ['sea'], content: 'Again.' },
            { comment: 'Moon Temple', key: ['moon temple', 'temple'], content: 'A temple.' },
            { comment: 'Temple of the Moon', key: ['temple', 'Moon Temple', 'shrine'], content: 'Priests live here.' },
            { comment: 'Lira', key: ['Lira', 'Лира'], content: 'Lira grew up in the harbor.' },
        ],
        updates: [{ id: '#3', append: 'Tags.' }, { id: '#9', append: 'Nowhere.' }],
    });
    assert.deepEqual(plan.add.map(entry => entry.comment), ['Northern Harbor', 'Moon Temple', 'Lira'], 'an archive is never a match');
    assert.deepEqual(plan.add[1].key, ['moon temple', 'temple', 'shrine']);
    assert.equal(plan.add[1].content, 'A temple.\n\nPriests live here.');
    assert.deepEqual(plan.dropped.map(item => item.kind).sort(), ['archive', 'duplicate', 'otherBook', 'unknownId']);
    assert.equal(plan.dropped.find(item => item.kind === 'otherBook')?.book, 'Atlas');
    assert.deepEqual(plan.update, []);
});

test('apply: keys merge case-insensitively (regex forms count), appends are idempotent, deleted entries are skipped', () => {
    const entries = editorBook();
    const anna = entries[0];
    const digest = buildDigest(entries);
    const plan = planMerge({ target: digest.items }, {
        entries: [{ comment: 'Mira', key: ['Mira', 'Мира'], content: 'Anna\'s sister.', category: 'Персонаж' }],
        updates: [{ id: '#1', append: 'She owns three ships.', addKeys: ['anna', 'ANNA', 'Анну', 'Smith', 'smith'] }],
    });
    const first = applyPlan(entries, plan, digest.ids);
    assert.deepEqual(anna.key, ['Anna', ANNA, 'Smith'], 'the old keys stay first and whole');
    assert.equal(anna.content, 'Anna is a smuggler.\n\nShe owns three ships.');
    assert.equal(first.updated.length, 1);
    assert.equal(first.updated[0].keys, 1);
    assert.equal(first.added.length, 1);
    assert.equal(entries.at(-1), first.added[0]);
    assert.equal(first.added[0].category, 'Character');
    assert.equal(first.added[0].order, 100);

    const again = applyPlan(entries, { add: [], update: plan.update, dropped: [] }, digest.ids);
    assert.deepEqual(again.updated, [], 'the same addition twice changes nothing');
    assert.equal(anna.content, 'Anna is a smuggler.\n\nShe owns three ships.');

    entries.splice(1, 1);
    const late = applyPlan(entries, { add: [], update: [{ id: '#2', title: 'Harbor', append: ['x'], addKeys: [], reasons: [], merged: [] }], dropped: [] }, digest.ids);
    assert.deepEqual(late.dropped, [{ kind: 'deleted', id: '#2', title: 'Harbor' }]);
});

/** SillyTavern 1.19's newWorldInfoEntryTemplate (the fields that matter here). */
const TEMPLATE = Object.freeze({
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true,
    selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false, probability: 100, useProbability: true,
    depth: 4, group: '', groupWeight: 100, matchWholeWords: null, useGroupScoring: null, role: 0, sticky: null,
    cooldown: null, delay: null, triggers: [],
});

test('saving in patch mode keeps the book\'s other entries, updates linked ones, puts new ones after the largest uid', () => {
    const raw = (uid, comment) => ({ ...TEMPLATE, uid, comment, content: comment.toLowerCase(), key: [comment], displayIndex: uid, extensions: { maestro: { uid } } });
    const existing = { name: 'Book', entries: { 3: raw(3, 'A'), 7: raw(7, 'B'), 12: raw(12, 'C') } };
    const a = { ...normalizeLikeLbc(existing.entries[3]), content: 'a, enriched' };
    const fresh = { ...normalizeLikeLbc({ comment: 'New', key: ['new'], content: 'n' }) };
    const links = new Map([[a, { raw: structuredClone(existing.entries[3]), source: 'st:Book' }]]);
    const options = { target: 'Book', template: TEMPLATE, existing };

    const patch = buildBook([a, fresh], entry => links.get(entry), { ...options, mode: 'patch' });
    assert.deepEqual(Object.keys(patch.data.entries).map(Number).sort((x, y) => x - y), [3, 7, 12, 13]);
    assert.equal(patch.data.entries[3].content, 'a, enriched');
    assert.deepEqual(patch.data.entries[3].extensions, { maestro: { uid: 3 } });
    assert.deepEqual(patch.data.entries[7], existing.entries[7]);
    assert.notEqual(patch.data.entries[7], existing.entries[7], 'a copy: the saved object is never shared');
    assert.equal(patch.data.entries[13].comment, 'New');
    assert.equal(patch.data.entries[13].displayIndex, 13);
    assert.deepEqual(patch.uids, [3, 13]);
    assert.deepEqual(patch.stats, { kept: 0, updated: 1, added: 1 });
    assert.equal(patch.data.name, 'Book');

    const full = buildBook([a, fresh], entry => links.get(entry), options);
    assert.deepEqual(Object.keys(full.data.entries).map(Number).sort((x, y) => x - y), [3, 13], '"Import to ST" still replaces the book');
});

test('target book: primary, a missing primary, a BunnyMo primary, an embedded book, no member; names', () => {
    assert.deepEqual(chooseTarget({ name: 'Lira', world: 'Velmar' }, ['Velmar']), { book: 'Velmar', status: 'primary', attach: null });
    assert.deepEqual(chooseTarget({ name: 'Lira', world: 'Gone' }, ['Velmar']), { book: 'Lira — лор', status: 'create', attach: 'primary' });
    assert.deepEqual(chooseTarget({ name: 'Lira' }, ['Lira — лор', 'Lira — лор (2)']), { book: 'Lira — лор (3)', status: 'create', attach: 'primary' });
    assert.deepEqual(chooseTarget({ name: 'Lira', world: 'Pack' }, ['Pack'], { primaryProtected: true }), { book: 'Lira — лор', status: 'createExtra', attach: 'extra' });
    assert.deepEqual(
        chooseTarget({ name: 'Lira', world: 'Pack', extraBooks: ['Other', 'Lira — лор (2)'] }, ['Pack', 'Other', 'Lira — лор', 'Lira — лор (2)'], { primaryProtected: true }),
        { book: 'Lira — лор (2)', status: 'extra', attach: null },
        'a book of ours among the additional ones is reused',
    );
    const characterBook = { name: 'Lira: World?', entries: [{ keys: ['a'], content: 'x' }] };
    assert.deepEqual(chooseTarget({ name: 'Lira', characterBook }, []), { book: 'Lira World', status: 'import', attach: 'primary' });
    assert.deepEqual(chooseTarget({ name: 'Lira', characterBook: { entries: [] } }, []), { book: 'Lira — лор', status: 'create', attach: 'primary' });
    assert.equal(chooseTarget(null, ['Velmar']), null);
    assert.equal(defaultBookName('A/B: "C"'), 'AB C — лор');
    assert.equal(defaultBookName('  '), 'Character — лор');
});

test('dialog session: decisions become notes, history is trimmed to a budget, the session survives storage', async () => {
    const entries = editorBook();
    const digest = buildDigest(entries);
    const session = createSession({ avatar: 'lira.png', name: 'Lira', book: 'Lira — лор' });
    session.turns.push({ role: 'user', text: 'Tell me about her family.' });
    const turn = addAssistantTurn(session, {
        reply: 'She has a sister.',
        proposals: [
            { op: 'add', entry: { comment: 'Mira — Character', key: ['Mira'], content: 'Sister.' } },
            { op: 'update', id: '#1', append: 'Anna knew them.', addKeys: [] },
            { op: 'add', entry: { comment: 'Father', key: ['father'], content: 'Dead.' } },
        ],
    }, digest.ids);
    assert.deepEqual(turn.proposals?.map(proposal => proposal.pid), ['1.0', '1.1', '1.2']);
    assert.equal(turn.proposals?.[1].targetTitle, 'Anna — Character');
    turn.proposals[0].state = 'accepted';
    turn.proposals[1].state = 'rejected';
    session.turns.push({ role: 'user', text: 'And the father?' });

    const history = historyMessages(session);
    assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'user']);
    assert.deepEqual(JSON.parse(history[1].content), { reply: 'She has a sister.', proposals: [{ op: 'add', title: 'Mira' }, { op: 'update', id: '#1', title: 'Anna' }, { op: 'add', title: 'Father' }] });
    assert.equal(history[2].content, '[accepted: Mira]\n[rejected: Anna]\nAnd the father?');

    const count = (text) => Math.ceil(text.length / 10);
    const long = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index} ${'w'.repeat(398)}` }));
    assert.deepEqual(await trimHistory(long, { budget: 10_000, countTokens: count }), long, 'everything fits');
    const trimmed = await trimHistory(long, { budget: 150, countTokens: count });
    assert.equal(trimmed[0].role, 'system');
    assert.ok(trimmed[0].content.startsWith('EARLIER IN THIS CONVERSATION'));
    assert.deepEqual(trimmed.slice(1), long.slice(-3));
    assert.ok(trimmed[0].content.split('\n').length >= 2, 'at least one compressed line');
    const tiny = await trimHistory(long, { budget: 5, countTokens: count });
    assert.deepEqual(tiny, [long.at(-1)], 'the newest message is always sent');

    const stored = JSON.parse(JSON.stringify(serializeSession(session)));
    const back = parseSession(stored);
    assert.deepEqual(back?.turns, session.turns);
    assert.equal(back?.book, 'Lira — лор');
    assert.equal(parseSession(JSON.stringify(stored))?.avatar, 'lira.png');
    assert.equal(parseSession({ ...stored, version: 99 }), null);
    assert.equal(parseSession('not json'), null);
});

test('macros survive the current connection: escaped for generateRawData, restored in the answer', () => {
    const text = '{{user}} meets {{char}} at <USER>\'s door. {{random::a,b}}';
    const escaped = escapeMacros(text);
    assert.ok(!escaped.includes('{{') && !escaped.includes('}}') && !escaped.includes('<USER>'));
    assert.equal(restoreMacros(escaped), text);
    assert.equal(restoreMacros('{"content":"{​{char}​} waits"}'), '{"content":"{{char}} waits"}');
    assert.deepEqual(escapeMessages([{ role: 'system', content: '{{char}}' }]).map(message => message.role), ['system']);
});

test('undo: the editor goes back to the same objects with their old contents and links', () => {
    const entries = editorBook();
    const anna = entries[0];
    const links = new WeakMap([[anna, { raw: { uid: 1 }, source: 'st:Book' }]]);
    const snapshot = takeEditorSnapshot(entries, entry => links.get(entry));
    const digest = buildDigest(entries);
    applyPlan(entries, planMerge({ target: digest.items }, {
        entries: [{ comment: 'Mira', key: ['Mira'], content: 'Sister.' }],
        updates: [{ id: '#1', append: 'More.', addKeys: ['Smith'] }],
    }), digest.ids);
    links.set(anna, { raw: { uid: 1, content: 'changed' }, source: 'st:Book' });
    links.set(entries[3], { raw: { uid: 4 }, source: 'st:Book' });
    anna.extra = true;
    assert.equal(entries.length, 4);

    restoreEditorSnapshot(entries, snapshot, (entry, link) => (link ? links.set(entry, link) : links.delete(entry)));
    assert.equal(entries.length, 3);
    assert.equal(entries[0], anna, 'the same object');
    assert.deepEqual(anna, editorBook()[0]);
    assert.deepEqual(links.get(anna), { raw: { uid: 1 }, source: 'st:Book' });
    assert.equal(links.has(entries[1]), false);
});

test('requests: a custom JSON schema or none at all', async () => {
    const calls = [];
    const ctx = { ConnectionManagerRequestService: { sendRequest: async (...args) => { calls.push(args); return { content: '{}' }; } } };
    const connection = { kind: 'profile', profileId: 'p', isChat: true, api: 'openrouter', label: 'P' };
    const request = createRequestFn(connection, { responseTokens: 16000, temperature: 0.8, reasoning: 'off' }, ctx);
    const signal = new AbortController().signal;
    const schema = { name: 'lorebook_expansion', value: { type: 'object' } };
    assert.equal(await request([{ role: 'user', content: 'x' }], { useSchema: true, schema, signal }), '{}');
    assert.deepEqual(calls[0][4].json_schema, { name: 'lorebook_expansion', strict: true, value: { type: 'object' } });
    assert.equal(calls[0][4].reasoning_effort, 'none');
    assert.equal(calls[0][2], 16000);
    await request([{ role: 'user', content: 'x' }], { useSchema: false, signal });
    assert.equal('json_schema' in calls[1][4], false);
});
