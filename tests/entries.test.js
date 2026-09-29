import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToEntry, buildProposals, collectEntryTerms, contextExcerpt, getMarker, removeFromEntry } from '../src/entries.js';
import { DEFAULT_SETTINGS, MARKER_KEY, resolveLanguage } from '../src/constants.js';

const ru = resolveLanguage({ language: 'ru' });
const settings = { ...DEFAULT_SETTINGS };

const makeEntry = (extra = {}) => ({
    uid: 7,
    key: ['Hermione', 'Granger', 'Гермиона', '/herm/i', ' '],
    keysecondary: ['Hogwarts', 'granger'],
    comment: 'Hermione Granger',
    content: 'Muggle-born witch,\n\n best friend of Harry.',
    constant: false,
    disable: false,
    ...extra,
});

test('collectEntryTerms skips regex, target-script and blank keys and merges fields', () => {
    const result = collectEntryTerms(makeEntry(), settings, ru);
    assert.deepEqual(result.terms, ['Hermione', 'Granger', 'Hogwarts']);
    assert.deepEqual(result.fieldsByTerm.get('Granger'), ['key', 'keysecondary']);
    assert.deepEqual(result.fieldsByTerm.get('Hogwarts'), ['keysecondary']);
    assert.deepEqual(result.skipped, { regex: 1, script: 1, done: 0 });
});

test('collectEntryTerms respects the entry filters', () => {
    assert.equal(collectEntryTerms(makeEntry({ constant: true }), settings, ru), null);
    assert.equal(collectEntryTerms(makeEntry({ disable: true }), settings, ru), null);
    assert.ok(collectEntryTerms(makeEntry({ disable: true }), { ...settings, includeDisabled: true }, ru));
    assert.deepEqual(collectEntryTerms(makeEntry(), { ...settings, includeSecondary: false }, ru).terms, ['Hermione', 'Granger']);
});

test('contextExcerpt collapses whitespace and truncates', () => {
    assert.equal(contextExcerpt(makeEntry(), 17), 'Muggle-born witch…');
    assert.equal(contextExcerpt(makeEntry(), 0), '');
});

test('apply → re-run skips done keys → force replaces → remove restores the original', () => {
    const entry = makeEntry();
    const original = structuredClone(entry);
    const items = [{ id: 1, book: 'B', uid: 7, title: 'Hermione Granger', terms: ['Hermione', 'Granger'], fieldsByTerm: new Map([['Hermione', ['key']], ['Granger', ['key', 'keysecondary']]]) }];
    const results = new Map([[1, [
        { source: 'Hermione', variants: [{ base: 'Гермиона', forms: ['Гермиона', 'Гермионы', 'Гермионе'] }] },
        { source: 'Granger', variants: [{ base: 'Грейнджер', forms: ['Грейнджер'] }] },
    ]]]);

    const { proposals, warnings } = buildProposals(items, results, settings, ru);
    assert.equal(warnings.length, 0);
    assert.equal(proposals.length, 2);
    assert.match(proposals[0].keys[0], /^\/\(\?<!\[\\p\{L\}\\p\{N\}\]\)г\[её\]рмион/);

    const added = applyToEntry(entry, proposals, ru);
    assert.equal(added, 3, 'Hermione → key, Granger → key + keysecondary');
    assert.equal(entry.key.length, original.key.length + 2);
    assert.equal(entry.keysecondary.length, original.keysecondary.length + 1);
    const state = getMarker(entry).languages.ru;
    assert.deepEqual(state.sources, ['Hermione', 'Granger']);

    // Applying the same proposals again adds nothing.
    assert.equal(applyToEntry(entry, proposals, ru), 0);

    // A re-run skips translated sources and our own keys.
    assert.deepEqual(collectEntryTerms(entry, settings, ru).terms, ['Hogwarts']);
    // Force re-translates them, still ignoring our own keys.
    assert.deepEqual(collectEntryTerms(entry, { ...settings, force: true }, ru).terms, ['Hermione', 'Granger', 'Hogwarts']);

    // Force replaces previously added keys instead of piling up.
    const replacement = [{ ...proposals[0], keys: ['/(?<![\\p{L}\\p{N}])гермиона(?![\\p{L}\\p{N}])/iu'] }];
    applyToEntry(entry, replacement, ru, { force: true });
    assert.equal(entry.key.length, original.key.length + 1);
    assert.deepEqual(getMarker(entry).languages.ru.sources, ['Hermione']);

    assert.equal(removeFromEntry(entry, 'ru'), 1);
    assert.deepEqual(entry.key, original.key);
    assert.deepEqual(entry.keysecondary, original.keysecondary);
    assert.equal(entry.extensions[MARKER_KEY], undefined, 'marker cleaned up');
    assert.equal(removeFromEntry(entry, 'ru'), null, 'nothing left to remove');
});

test('removeFromEntry keeps keys the user edited and other languages when asked', () => {
    const entry = makeEntry();
    const de = resolveLanguage({ language: 'de' });
    applyToEntry(entry, [{ source: 'Hermione', fields: ['key'], keys: ['/ru-key/iu'] }], ru);
    applyToEntry(entry, [{ source: 'Hermione', fields: ['key'], keys: ['/de-key/iu'] }], de);
    entry.key[entry.key.indexOf('/ru-key/iu')] = '/ru-key-edited/iu';
    assert.equal(removeFromEntry(entry, 'ru'), 0, 'edited key is not ours anymore');
    assert.ok(entry.key.includes('/ru-key-edited/iu'));
    assert.ok(entry.key.includes('/de-key/iu'), 'other language untouched');
    assert.equal(removeFromEntry(entry, null), 1, 'all languages');
});

test('plain key format and invalid regex handling in buildProposals', () => {
    const items = [{ id: 1, book: 'B', uid: 1, title: '', terms: ['Ron'], fieldsByTerm: new Map([['Ron', ['key']]]) }];
    const results = new Map([[1, [{ source: 'Ron', variants: [{ base: 'Рон', forms: ['Рон', 'Рона'] }] }]]]);
    const plain = buildProposals(items, results, { keyFormat: 'plain' }, ru);
    assert.deepEqual(plain.proposals[0].keys, ['Рон', 'Рона']);
    const broken = buildProposals(items, results, { keyFormat: 'regex' }, ru, () => null);
    assert.equal(broken.proposals.length, 0);
    assert.match(broken.warnings[0], /cannot parse/);
});

test('an entry without extensions gets one; existing extension data is preserved', () => {
    const entry = makeEntry({ extensions: { other: { a: 1 } } });
    applyToEntry(entry, [{ source: 'Hermione', fields: ['key'], keys: ['x'] }], ru);
    assert.deepEqual(entry.extensions.other, { a: 1 });
    assert.equal(entry.extensions[MARKER_KEY].version, 1);
});
