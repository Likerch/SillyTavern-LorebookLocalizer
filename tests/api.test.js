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

test('exclusive: a busy listener that starts the next job on idle gets it run once, with consistent states', async () => {
    const lock = createExclusive();
    const states = [];
    const later = [];
    let runs = 0;
    let follow = null;
    lock.onChange((state) => {
        states.push(state);
        if (!state.running && !follow) follow = lock.run(() => { runs++; return 'next'; }, { by: 'api' });
    });
    lock.onChange((state) => later.push(state));
    await lock.run(() => 'first', { by: 'dialog' });
    assert.equal(await follow, 'next');
    assert.equal(runs, 1);
    assert.deepEqual(states, [
        { running: true, by: 'dialog' }, { running: false }, { running: true, by: 'api' }, { running: false },
    ]);
    assert.deepEqual(later.at(-1), { running: false }, 'a later listener never ends on a stale state');
    assert.deepEqual(lock.state(), { running: false });
});

/**
 * A fake SillyTavern with one lorebook and a model that answers with Russian forms.
 * `respond(messages, {signal, terms, answer})` replaces the model: `answer()` is the normal reply.
 */
function harness({ book = entriesOf([
    { key: ['Hermione'], comment: 'Hermione', content: 'A witch.' },
    { key: ['Snape'], comment: 'Snape', content: 'A teacher.' },
    { key: ['Hogwarts'], comment: 'Hogwarts', content: 'A school.' },
]), answers = {}, online = true, settings = {}, respond = null, exclusive = createExclusive() } = {}) {
    const books = { HP: book, Packs: entriesOf([{ key: ['<SPECIES:ELF>'] }, { key: ['<SPECIES:ORC>'] }, { key: ['<ENFJ-U>'] }]) };
    const saved = [];
    const requests = [];
    const userSettings = { ...structuredClone(DEFAULT_SETTINGS), backupMode: 'download', language: 'ru', ...settings };
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
    const request = async (messages, { signal }) => {
        requests.push(messages);
        const { items } = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
        const answer = () => {
            const results = items.map(item => ({
                id: item.id,
                translations: item.terms.filter(term => answers[term]).map(term => ({ source: term, variants: [answers[term]] })),
            })).filter(item => item.translations.length);
            return JSON.stringify({ results });
        };
        return respond ? respond(messages, { signal, terms: items.flatMap(item => item.terms), answer }) : answer();
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
        exclusive,
        warn: () => {},
        retryDelayMs: 1,
    });
    return { books, saved, requests, userSettings, headless, exclusive };
}

const HERMIONE = { base: 'Гермиона', forms: ['Гермиона', 'Гермионы', 'Гермионе', 'Гермиону', 'Гермионой'] };
const SNAPE = { base: 'Снейп', forms: ['Снейп', 'Снейпа', 'Снейпу', 'Снейпом', 'Снейпе'] };

test('localizeEntries runs the dialog pipeline on the chosen entries only, without a backup', async () => {
    const { books, saved, headless, userSettings } = harness({ answers: { Hermione: HERMIONE, Snape: SNAPE } });
    const result = await headless.localizeEntries('HP', [0, 1]);
    assert.deepEqual(result, { added: 2, entries: 2, failures: 0, cancelled: false, failed: [] });
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
    assert.deepEqual(result.failed, [{ uid: 1, reason: 'invalid' }, { uid: 2, reason: 'invalid' }], 'missing in the reply');
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
    assert.deepEqual(await headless.localizeEntries('HP', []), { added: 0, entries: 0, failures: 0, cancelled: false, failed: [] });
    await assert.rejects(headless.localizeEntries('HP', [0], { batchTimeoutMs: -1 }), TypeError);
    await assert.rejects(headless.localizeEntries('HP', [0], { batchTimeoutMs: '90' }), TypeError);
    await assert.rejects(headless.localizeEntries('HP', [0], { signal: {} }), TypeError);
    await assert.rejects(headless.localizeEntries('HP', [0], { onProgress: 'yes' }), TypeError);
    assert.throws(() => headless.onBusyChange(null), TypeError);
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
    assert.deepEqual(Object.keys(api).sort(), [
        'buildKeyRegex', 'buildPlainKeys', 'busy', 'cleanForms', 'features', 'isProtectedBook', 'localizeEntries', 'onBusyChange', 'version',
    ]);
    for (const feature of ['progress', 'cancel', 'busy', 'timeout']) assert.ok(api.features.includes(feature), feature);
    assert.ok(Object.isFrozen(api.features));
    assert.deepEqual(api.busy(), { running: false });
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

const HOGWARTS = { base: 'Хогвартс', forms: ['Хогвартс', 'Хогвартса', 'Хогвартсу', 'Хогвартсом', 'Хогвартсе'] };
const ALL_ANSWERS = { Hermione: HERMIONE, Snape: SNAPE, Hogwarts: HOGWARTS };
/** One entry per request, so a run has several batches. */
const ONE_PER_BATCH = { maxTermsPerBatch: 1 };
const never = () => new Promise(() => {});

/** A job that holds the lock until `release()` is called. */
function holdLock(exclusive, by = 'dialog') {
    let release = () => {};
    const gate = new Promise(resolve => { release = resolve; });
    const done = exclusive.run(() => gate, { by });
    return { release, done };
}

test('progress: running with entry counts after every batch, then saving; no queued phase when the lock is free', async () => {
    const { headless } = harness({ answers: ALL_ANSWERS, settings: ONE_PER_BATCH });
    const events = [];
    const result = await headless.localizeEntries('HP', [0, 1, 2], { onProgress: (progress) => events.push(progress) });
    assert.equal(result.entries, 3);
    assert.deepEqual(events, [
        { phase: 'running', done: 0, total: 3 },
        { phase: 'running', done: 1, total: 3 },
        { phase: 'running', done: 2, total: 3 },
        { phase: 'running', done: 3, total: 3 },
        { phase: 'saving', done: 3, total: 3 },
    ]);
});

test('progress: a job that has to wait reports queued at once and runs when the other job ends', async () => {
    const { headless, exclusive, requests } = harness({ answers: ALL_ANSWERS });
    const dialog = holdLock(exclusive);
    const events = [];
    const pending = headless.localizeEntries('HP', [0, 1, 1], { onProgress: (progress) => events.push(progress) });
    assert.deepEqual(events, [{ phase: 'queued', done: 0, total: 2 }], 'reported synchronously, total = requested entries');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(requests.length, 0, 'nothing is sent while the dialog holds the lock');
    dialog.release();
    const result = await pending;
    assert.equal(result.entries, 2);
    assert.deepEqual(events.map(event => event.phase), ['queued', 'running', 'running', 'saving']);
    assert.ok(events.slice(1).every(event => event.total === 2));
});

test('cancel mid-run: the batch in flight is dropped, finished batches are saved, the promise resolves', async () => {
    const controller = new AbortController();
    let calls = 0;
    const { headless, books, saved } = harness({
        answers: ALL_ANSWERS,
        settings: ONE_PER_BATCH,
        respond: (messages, { answer }) => {
            calls++;
            if (calls === 1) return answer();
            setTimeout(() => controller.abort(), 5);
            return never(); // a transport that ignores the abort must not hold the job
        },
    });
    const events = [];
    const result = await headless.localizeEntries('HP', [0, 1, 2], { signal: controller.signal, onProgress: (progress) => events.push(progress) });
    assert.deepEqual(result, { added: 1, entries: 1, failures: 0, cancelled: true, failed: [] });
    assert.equal(calls, 2, 'no request after the stop');
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].accepted.map(proposal => proposal.uid), [0]);
    assert.equal(books.HP.entries[0].key[1], buildKeyRegex(HERMIONE.forms));
    assert.deepEqual(books.HP.entries[1].key, ['Snape']);
    assert.deepEqual(events.at(-1), { phase: 'saving', done: 1, total: 3 });
});

test('cancel: an aborted signal resolves at once, also while waiting for another job, which then runs nothing', async () => {
    const { headless, exclusive, requests } = harness({ answers: ALL_ANSWERS });
    const aborted = AbortSignal.abort();
    assert.deepEqual(await headless.localizeEntries('HP', [0], { signal: aborted }), { added: 0, entries: 0, failures: 0, cancelled: true, failed: [] });

    const dialog = holdLock(exclusive);
    const controller = new AbortController();
    const events = [];
    const pending = headless.localizeEntries('HP', [0, 1], { signal: controller.signal, onProgress: (progress) => events.push(progress) });
    controller.abort();
    assert.deepEqual(await pending, { added: 0, entries: 0, failures: 0, cancelled: true, failed: [] });
    assert.deepEqual(headless.busy(), { running: true, by: 'dialog' }, 'the dialog still holds the lock');
    dialog.release();
    await dialog.done;
    assert.deepEqual(headless.busy(), { running: false });
    assert.equal(requests.length, 0);
    assert.deepEqual(events.map(event => event.phase), ['queued']);
});

test('timeout: a batch with no reply in time is retried, then the entry fails with reason timeout', async () => {
    const attempts = [];
    const { headless } = harness({
        answers: ALL_ANSWERS,
        settings: { ...ONE_PER_BATCH, maxRetries: 1 },
        respond: (messages, { signal, terms, answer }) => {
            if (!terms.includes('Snape')) return answer();
            attempts.push(signal);
            return never();
        },
    });
    const started = Date.now();
    const result = await headless.localizeEntries('HP', [0, 1, 2], { batchTimeoutMs: 20 });
    assert.ok(Date.now() - started < 2000, 'the run does not hang');
    assert.equal(result.entries, 2);
    assert.equal(result.failures, 1);
    assert.deepEqual(result.failed, [{ uid: 1, reason: 'timeout' }]);
    assert.equal(result.cancelled, false);
    assert.equal(attempts.length, 2, 'the first attempt and one retry');
    for (const signal of attempts) {
        assert.ok(signal.aborted, 'the transport is told to stop the request');
        assert.equal(signal.reason.name, 'TimeoutError');
    }
});

test('timeout: the default comes from the reply timeout setting; 0 means no limit', async () => {
    let hang = true;
    const { headless, userSettings } = harness({
        answers: ALL_ANSWERS,
        settings: { maxRetries: 0, requestTimeout: 0.02 },
        respond: async (messages, { answer }) => {
            if (hang) return never();
            await new Promise(resolve => setTimeout(resolve, 40));
            return answer();
        },
    });
    assert.deepEqual((await headless.localizeEntries('HP', [0])).failed, [{ uid: 0, reason: 'timeout' }]);
    hang = false;
    assert.equal((await headless.localizeEntries('HP', [1], { batchTimeoutMs: 0 })).entries, 1, 'slower than the setting, no limit');
    userSettings.requestTimeout = 0;
    assert.equal((await headless.localizeEntries('HP', [2])).entries, 1);
});

test('busy and onBusyChange follow dialog and API jobs without an idle blink between them', async () => {
    const { headless, exclusive } = harness({ answers: ALL_ANSWERS });
    installApi(headless);
    const api = globalThis[API_GLOBAL];
    const states = [];
    const unsubscribe = api.onBusyChange((state) => states.push(state));
    assert.deepEqual(api.busy(), { running: false });

    const dialog = holdLock(exclusive);
    assert.deepEqual(api.busy(), { running: true, by: 'dialog' });
    const pending = api.localizeEntries('HP', [0]);
    assert.deepEqual(api.busy(), { running: true, by: 'dialog' }, 'a waiting API job does not change the owner');
    dialog.release();
    await pending;
    assert.deepEqual(api.busy(), { running: false }, 'released before the promise resolves');
    assert.deepEqual(states, [{ running: true, by: 'dialog' }, { running: true, by: 'api' }, { running: false }]);

    unsubscribe();
    await api.localizeEntries('HP', [1]);
    assert.equal(states.length, 3, 'no calls after unsubscribing');

    const failing = harness({ online: false });
    const failingStates = [];
    failing.headless.onBusyChange((state) => failingStates.push(state));
    await assert.rejects(failing.headless.localizeEntries('HP', [0]), /no API connection/);
    assert.deepEqual(failingStates, [{ running: true, by: 'api' }, { running: false }], 'a failed job releases the lock too');
    uninstallApi();
});
