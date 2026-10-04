import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_GLOBAL, createApi, installApi, uninstallApi } from '../src/api.js';
import { DEFAULT_SETTINGS, resolveLanguage } from '../src/constants.js';
import { applyToEntry, collectEntryTerms, getMarker } from '../src/entries.js';
import { createExclusive } from '../src/exclusive.js';
import { createHeadless } from '../src/headless.js';
import { isProtectedBookData, protectionReason } from '../src/protected.js';
import { buildKeyRegex, parseRegexLikeST } from '../src/regex-builder.js';

const entriesOf = (list) => ({ entries: Object.fromEntries(list.map((entry, uid) => [uid, { uid, ...entry }])) });

test('protection: the main BunnyMo book, tag-keyed packs and wrapped packs; ordinary books and archives are not', () => {
    const core = entriesOf([
        { key: ['!fullsheet'], comment: 'sheet', content: 'x' },
        { key: ['jealous'], comment: '🔮 AUTO-TRIGGER: Jealousy Detection System', content: 'x' },
        { key: [], comment: 'Master - Kaomoji Library', content: 'x' },
        { key: ['Hermione'], comment: 'Hermione', content: 'x' },
    ]);
    assert.equal(protectionReason(core), 'bunnymo');
    const tagged = entriesOf([
        { key: ['<SPECIES:ELF>'], content: 'x' },
        { key: ['<SPECIES:ORC>', 'orc'], content: 'x' },
        { key: ['<ENFJ-U>'], content: 'x' },
        { key: ['Readme'], content: 'x' },
    ]);
    assert.equal(protectionReason(tagged), 'bunnymo-pack');
    const wrapped = entriesOf([
        { key: ['tsundere'], content: '<BunnymoTags:Dere>…</BunnymoTags:Dere>' },
        { key: ['yandere'], content: '  <BunnymoTags:Dere>…' },
        { key: ['kuudere'], content: '<BunnymoTags:Dere>…' },
    ]);
    assert.equal(protectionReason(wrapped), 'bunnymo-pack');
    assert.equal(protectionReason(entriesOf([{ key: ['<DEPRESSION>'], content: 'x' }])), 'bunnymo-pack', 'a tiny pack');
    const archive = entriesOf([
        { key: ['Аня'], content: '<BunnymoTags><Name:Аня>, <SPECIES:HUMAN></BunnymoTags>' },
        { key: ['Борис'], content: '<BunnymoTags><Name:Борис></BunnymoTags>' },
    ]);
    assert.equal(isProtectedBookData(archive), false, 'character archives are not packs');
    const ordinary = entriesOf([
        { key: ['Hogwarts'], content: 'A school.' },
        { key: ['<Elf>', 'elves'], content: 'x' },
        { key: ['Snape'], content: 'x' },
        { key: ['Dumbledore'], content: 'x' },
    ]);
    assert.equal(isProtectedBookData(ordinary), false);
    assert.equal(isProtectedBookData(null), false);
    assert.equal(isProtectedBookData({ entries: {} }), false);
});

test('exclusive: jobs run one at a time, in order, and a failed job does not block the next', async () => {
    const lock = createExclusive();
    const order = [];
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const first = lock.run(async () => { order.push('a+'); await sleep(20); order.push('a-'); return 1; });
    const second = lock.run(async () => { order.push('b'); throw new Error('boom'); });
    const third = lock.run(() => { order.push('c'); return 3; });
    assert.equal(lock.busy, true);
    assert.equal(await first, 1);
    await assert.rejects(second, /boom/);
    assert.equal(await third, 3);
    assert.deepEqual(order, ['a+', 'a-', 'b', 'c']);
    assert.equal(lock.busy, false);
});

/** A fake SillyTavern with one lorebook and a model that answers with Russian forms. */
function harness({ book = entriesOf([
    { key: ['Hermione'], comment: 'Hermione', content: 'A witch.' },
    { key: ['Snape'], comment: 'Snape', content: 'A teacher.' },
    { key: ['Hogwarts'], comment: 'Hogwarts', content: 'A school.' },
]), answers = {}, online = true } = {}) {
    const books = { HP: book, Packs: entriesOf([{ key: ['<SPECIES:ELF>'] }, { key: ['<SPECIES:ORC>'] }, { key: ['<ENFJ-U>'] }]) };
    const saved = [];
    const requests = [];
    const userSettings = { ...structuredClone(DEFAULT_SETTINGS), backupMode: 'download', language: 'ru' };
    const ctx = {
        onlineStatus: online ? 'connected' : 'no_connection',
        loadWorldInfo: async (name) => books[name] ?? null,
        getTokenCountAsync: async (text) => Math.ceil(text.length / 4),
    };
    const collectItems = async (names, settings, lang, { uids }) => {
        const items = [];
        let id = 1;
        for (const name of names) {
            for (const entry of Object.values(books[name].entries)) {
                if (uids && !uids.has(Number(entry.uid))) continue;
                const collected = collectEntryTerms(entry, settings, lang);
                if (!collected?.terms.length) continue;
                items.push({ id: id++, book: name, uid: entry.uid, title: entry.comment, context: '', terms: collected.terms, fieldsByTerm: collected.fieldsByTerm });
            }
        }
        return { items, stats: {} };
    };
    const applyChanges = async (accepted, settings, lang) => {
        saved.push({ backupMode: settings.backupMode, accepted });
        const report = { entries: 0, keys: 0 };
        for (const proposal of accepted) {
            const entry = books[proposal.book].entries[proposal.uid];
            const added = applyToEntry(entry, [proposal], lang);
            if (added) { report.entries++; report.keys += added; }
        }
        return report;
    };
    const request = async (messages) => {
        requests.push(messages);
        const { items } = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
        const results = items.map(item => ({
            id: item.id,
            translations: item.terms.filter(term => answers[term]).map(term => ({ source: term, variants: [answers[term]] })),
        })).filter(item => item.translations.length);
        return JSON.stringify({ results });
    };
    const headless = createHeadless({
        context: () => ctx,
        getSettings: () => userSettings,
        resolveConnection: (settings) => (settings.profileId === 'broken'
            ? { kind: 'error', message: 'no such profile' }
            : { kind: settings.profileId ? 'profile' : 'current', profileId: settings.profileId, isChat: true, label: 'x' }),
        createRequestFn: () => request,
        collectItems,
        applyChanges,
        parse: parseRegexLikeST,
        exclusive: createExclusive(),
        warn: () => {},
    });
    return { books, saved, requests, userSettings, headless };
}

const HERMIONE = { base: 'Гермиона', forms: ['Гермиона', 'Гермионы', 'Гермионе', 'Гермиону', 'Гермионой'] };
const SNAPE = { base: 'Снейп', forms: ['Снейп', 'Снейпа', 'Снейпу', 'Снейпом', 'Снейпе'] };

test('localizeEntries runs the dialog pipeline on the chosen entries only, without a backup', async () => {
    const { books, saved, headless, userSettings } = harness({ answers: { Hermione: HERMIONE, Snape: SNAPE } });
    const result = await headless.localizeEntries('HP', [0, 1]);
    assert.deepEqual(result, { added: 2, entries: 2, failures: 0 });
    assert.equal(saved[0].backupMode, 'none');
    assert.equal(userSettings.backupMode, 'download', 'the user setting is not changed');
    const hermione = books.HP.entries[0];
    assert.equal(hermione.key[1], buildKeyRegex(HERMIONE.forms));
    assert.ok(getMarker(hermione).languages.ru);
    assert.deepEqual(books.HP.entries[2].key, ['Hogwarts'], 'entry 2 was not asked for');
});

test('localizeEntries counts entries the model did not translate as failures', async () => {
    const { headless } = harness({ answers: { Hermione: HERMIONE } });
    const result = await headless.localizeEntries('HP', [0, 1, 2]);
    assert.equal(result.added, 1);
    assert.equal(result.entries, 1);
    assert.equal(result.failures, 2);
});

test('localizeEntries refuses protected books, unknown books and languages, broken profiles, no connection', async () => {
    const { headless } = harness();
    await assert.rejects(headless.localizeEntries('Packs', [0]), /BunnyMo/);
    await assert.rejects(headless.localizeEntries('Nope', [0]), /not found/);
    await assert.rejects(headless.localizeEntries('HP', [0], { language: 'xx' }), /unknown language/);
    await assert.rejects(headless.localizeEntries('HP', [0], { profileId: 'broken' }), /no such profile/);
    await assert.rejects(headless.localizeEntries('HP', 'all'), TypeError);
    await assert.rejects(headless.localizeEntries('HP', ['x']), TypeError);
    await assert.rejects(harness({ online: false }).headless.localizeEntries('HP', [0]), /no API connection/);
    assert.deepEqual(await headless.localizeEntries('HP', []), { added: 0, entries: 0, failures: 0 });
});

test('localizeEntries takes the language and the profile from options', async () => {
    const { books, headless, requests } = harness({ answers: { Snape: { base: 'Снейп', forms: ['Снейп', 'Снейпа'] } } });
    const result = await headless.localizeEntries('HP', [1], { language: 'uk', profileId: 'cheap' });
    assert.equal(result.added, 1);
    assert.ok(getMarker(books.HP.entries[1]).languages.uk, 'marked as Ukrainian');
    assert.match(requests[0][0].content, /Ukrainian/);
    assert.equal(resolveLanguage({ language: 'uk' }).id, 'uk');
});

test('isProtectedBook loads the book; the API object is frozen and versioned', async () => {
    const { headless } = harness();
    assert.equal(await headless.isProtectedBook('Packs'), true);
    assert.equal(await headless.isProtectedBook('HP'), false);
    assert.equal(await headless.isProtectedBook('Nope'), false);
    assert.equal(await headless.isProtectedBook(''), false);

    installApi(headless);
    const api = globalThis[API_GLOBAL];
    assert.equal(api.version, 1);
    assert.ok(Object.isFrozen(api));
    assert.deepEqual(Object.keys(api).sort(), ['buildKeyRegex', 'buildPlainKeys', 'cleanForms', 'isProtectedBook', 'localizeEntries', 'version']);
    assert.equal(api.buildKeyRegex(['Рон', 'Рона', 'Роне']), buildKeyRegex(['Рон', 'Рона', 'Роне']));
    assert.equal(api.buildKeyRegex(['Рон'], { boundaries: false }), '/рон/iu');
    assert.equal(api.buildKeyRegex([]), null);
    assert.deepEqual(api.buildPlainKeys([' Рон ', 'рон', 'Рона,']), ['Рон', 'Рона']);
    assert.deepEqual(api.cleanForms(['Ёж', 'еж', 7]), ['Ёж']);
    assert.equal(await api.isProtectedBook('Packs'), true);
    uninstallApi();
    assert.equal(API_GLOBAL in globalThis, false);
    assert.equal(typeof createApi(headless).localizeEntries, 'function');
});
