import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLikeLbc } from '../src/lbc/adapter.js';
import {
    buildBook, changedFields, freeBookName, pairLoadedEntries, sanitizeBookName, toWorldInfoEntry,
} from '../src/lbc/book.js';

/** SillyTavern 1.19's newWorldInfoEntryTemplate (the fields that matter here). */
const TEMPLATE = Object.freeze({
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true,
    selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false, ignoreBudget: false,
    excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '', group: '',
    groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null,
    useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
});

/** A World Info entry with everything LBC drops. */
const RICH = Object.freeze({
    uid: 12, key: ['Anna', '/(?<![\\p{L}\\p{N}])анн(?:а|ы|е)(?![\\p{L}\\p{N}])/iu'], keysecondary: [], comment: 'Deep note',
    content: 'Anna is a smuggler.', constant: false, vectorized: true, selective: true, selectiveLogic: 0, addMemo: true,
    order: 0, position: 4, disable: false, ignoreBudget: true, excludeRecursion: false, preventRecursion: false,
    delayUntilRecursion: 1, probability: 0, useProbability: true, depth: 0, outletName: 'x', group: '',
    groupOverride: false, groupWeight: 100, scanDepth: 3, caseSensitive: true, matchWholeWords: null,
    useGroupScoring: null, automationId: '', role: 2, sticky: 0, cooldown: 0, delay: 0, triggers: ['normal'],
    displayIndex: 12, characterFilter: { isExclude: true, names: ['Seraphina'], tags: [] },
    extensions: { lorebook_localizer: { v: 1 }, maestro: { passport: { look: 'red coat' } } },
});

/** What LBC's editor holds for an entry right after loading it. */
const loaded = (raw) => ({ ...normalizeLikeLbc(raw) });

test('book names: cleaned like SillyTavern cleans file names; copies get a free number', () => {
    assert.equal(sanitizeBookName('Мир Тьмы'), 'Мир Тьмы');
    assert.equal(sanitizeBookName('  A/B: "C"? '), 'AB C');
    assert.equal(sanitizeBookName('con'), '');
    assert.equal(sanitizeBookName('..'), '');
    assert.equal(freeBookName('Мир Тьмы', ['Мир Тьмы', 'Мир Тьмы (2)']), 'Мир Тьмы (3)');
    assert.equal(freeBookName('Мир Тьмы (2)', ['Мир Тьмы (2)']), 'Мир Тьмы (3)');
});

test('an untouched loaded entry is written back exactly as it was', () => {
    const editor = loaded(RICH);
    assert.deepEqual(changedFields(editor, RICH), []);
    const { entry, kind } = toWorldInfoEntry(editor, { raw: RICH, source: 'st:Book' }, TEMPLATE);
    assert.equal(kind, 'kept');
    assert.deepEqual(entry, RICH);
});

test('only the fields changed in LBC are taken from it; zeros LBC showed as defaults stay zeros', () => {
    const editor = { ...loaded(RICH), content: 'Anna runs the smugglers.', key: ['Anna', 'smuggler'], order: 250 };
    assert.deepEqual(changedFields(editor, RICH).sort(), ['content', 'key', 'order']);
    const { entry, kind } = toWorldInfoEntry(editor, { raw: RICH, source: 'st:Book' }, TEMPLATE);
    assert.equal(kind, 'updated');
    assert.equal(entry.content, 'Anna runs the smugglers.');
    assert.deepEqual(entry.key, ['Anna', 'smuggler']);
    assert.equal(entry.order, 250);
    assert.equal(entry.depth, 0, 'LBC showed 4, the user did not touch it');
    assert.equal(entry.probability, 0);
    assert.equal(entry.role, 2);
    assert.deepEqual(entry.extensions, RICH.extensions);
    assert.deepEqual(entry.characterFilter, RICH.characterFilter);
    assert.deepEqual(entry.triggers, ['normal']);
    assert.equal(entry.uid, 12);
    assert.ok(!('category' in entry), 'no category field is added for a category LBC derives itself');
});

test('a new entry is built on SillyTavern\'s template with LBC\'s values', () => {
    const editor = {
        comment: 'Harbor', key: ['harbor'], keysecondary: ['night'], content: 'The harbor.', category: 'Location',
        constant: false, selective: true, selectiveLogic: 0, order: 560, position: 4, depth: 2, disable: false,
        probability: 100, group: '', groupWeight: 100, useGroupScoring: false, preventRecursion: true,
        excludeRecursion: false, matchWholeWords: null, sticky: 0, cooldown: null,
    };
    const { entry, kind } = toWorldInfoEntry(editor, undefined, TEMPLATE);
    assert.equal(kind, 'added');
    assert.equal(entry.comment, 'Harbor');
    assert.deepEqual(entry.keysecondary, ['night']);
    assert.equal(entry.position, 4);
    assert.equal(entry.role, 0, '@depth gets the system role');
    assert.equal(entry.depth, 2);
    assert.equal(entry.sticky, null, 'LBC\'s 0 becomes the template\'s empty value');
    assert.equal(entry.useGroupScoring, null);
    assert.equal(entry.category, 'Location', 'not derivable from the comment, so it is kept for LBC');
    assert.equal(entry.vectorized, false);
    assert.equal(entry.useProbability, true);
});

test('uids: same-book entries keep theirs, others keep theirs when free, new ones never reuse a taken uid', () => {
    const existing = { entries: { 3: { uid: 3, comment: 'old A' }, 7: { uid: 7, comment: 'old B' }, 9: { uid: 9, comment: 'deleted' } }, extensions: { book: 1 } };
    const fromBook = { ...loaded({ uid: 7, comment: 'B', content: 'b' }) };
    const fromOther = { ...loaded({ uid: 3, comment: 'C', content: 'c' }) };
    const fromOtherFree = { ...loaded({ uid: 20, comment: 'D', content: 'd' }) };
    const brandNew = { comment: 'E', content: 'e', key: ['e'] };
    const links = new Map([
        [fromBook, { raw: { uid: 7, comment: 'B', content: 'b' }, source: 'st:Book' }],
        [fromOther, { raw: { uid: 3, comment: 'C', content: 'c' }, source: 'st:Other' }],
        [fromOtherFree, { raw: { uid: 20, comment: 'D', content: 'd' }, source: 'file:d.json' }],
    ]);
    const { data, uids, stats } = buildBook([fromBook, fromOther, fromOtherFree, brandNew], entry => links.get(entry), { target: 'Book', template: TEMPLATE, existing });
    assert.deepEqual(uids, [7, 21, 20, 22]);
    assert.deepEqual(Object.keys(data.entries).map(Number).sort((a, b) => a - b), [7, 20, 21, 22]);
    assert.equal(data.entries[21].comment, 'C');
    assert.deepEqual(data.extensions, { book: 1 }, 'book-level fields of the target survive');
    assert.deepEqual(stats, { kept: 3, updated: 0, added: 1 });
});

test('two editor entries from the same original get different uids', () => {
    const raw = { uid: 5, comment: 'A', content: 'a' };
    const first = loaded(raw);
    const second = loaded(raw);
    const { uids } = buildBook([first, second], () => ({ raw, source: 'file:a.json' }), { target: 'New', template: TEMPLATE });
    assert.deepEqual(uids, [5, 6]);
});

test('pairing a load: the loaded entries are the tail of the list and must match LBC\'s view of the originals', () => {
    const rawList = [{ uid: 0, comment: 'A', content: 'a' }, { uid: 1, comment: 'B', content: 'b' }];
    const earlier = { comment: 'Old', content: 'o' };
    const list = [earlier, loaded(rawList[0]), loaded(rawList[1])];
    const pairs = pairLoadedEntries(list, rawList, () => false);
    assert.deepEqual(pairs.map(pair => pair.raw.uid), [0, 1]);
    assert.equal(pairs[0].entry, list[1]);
    // A generated list that only looks similar is not paired.
    assert.deepEqual(pairLoadedEntries([{ comment: 'A', content: 'different' }, loaded(rawList[1])], rawList, () => false).map(p => p.raw.uid), [1]);
    assert.deepEqual(pairLoadedEntries([loaded(rawList[0])], rawList, () => false), [], 'shorter than the book');
    assert.deepEqual(pairLoadedEntries(list, rawList, entry => entry === list[1]).map(p => p.raw.uid), [1], 'already linked entries are skipped');
});
