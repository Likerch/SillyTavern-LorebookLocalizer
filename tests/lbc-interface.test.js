import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDictionary, looksTranslatable, normalizeText, renderTemplate } from '../src/lbc/dictionary.js';
import { isEditorEmpty, snapshotDraft } from '../src/lbc/draft.js';
import { extractStrings } from '../tools/extract-lbc-strings.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const vendored = join(root, 'vendor', 'lorebook-creator', 'index.js');
const entries = JSON.parse(readFileSync(join(root, 'locales', 'ru.lorebook-creator.json'), 'utf8'));
const dictionary = createDictionary(entries);

test('dictionary: exact strings, icons and trailing punctuation around them, templates with numbers', () => {
    const d = createDictionary({
        Generate: 'Создать',
        'Template loaded': 'Шаблон загружен',
        '{#n} entries generated!': 'Создано записей: {n}!',
        'Key "{key}" fires {#n} entries at once': 'Ключ «{key}» включает {n} {n|запись|записи|записей}',
        'Edit Entry #{#n}': 'Правка №{n}',
        empty: '',
        __note: 'x',
    });
    assert.equal(d.size, 5);
    assert.equal(d.text('  Generate '), 'Создать');
    assert.equal(d.text('🎲 Generate'), '🎲 Создать');
    assert.equal(d.text('📋 Template loaded:'), '📋 Шаблон загружен:');
    assert.equal(d.text('12 entries generated!'), 'Создано записей: 12!');
    assert.equal(d.text('Key "harbor" fires 3 entries at once'), 'Ключ «harbor» включает 3 записи');
    assert.equal(d.text('Key "a" fires 21 entries at once'), 'Ключ «a» включает 21 запись');
    assert.equal(d.text('Edit Entry #about the war'), null, '{#n} only matches numbers');
    assert.equal(d.text('empty'), null, 'an empty translation means not translated yet');
    assert.equal(renderTemplate('{n|день|дня|дней}', { n: '5' }), 'дней');
    assert.ok(looksTranslatable('Load LoreBook'));
    assert.ok(!looksTranslatable('lbc-entry-title'));
    assert.ok(!looksTranslatable('Загрузить'));
});

test('the LBC dictionary is consistent: placeholders kept, no duplicate keys after normalizing', () => {
    const seen = new Map();
    for (const [key, value] of Object.entries(entries)) {
        if (key.startsWith('__')) continue;
        assert.equal(typeof value, 'string', key);
        assert.ok(value.trim(), `empty translation for "${key}"`);
        const normalized = normalizeText(key);
        assert.ok(!seen.has(normalized), `duplicate key "${key}"`);
        seen.set(normalized, key);
        const names = (text) => [...text.matchAll(/\{#?(\w+)(?:\|[^{}]*)?\}/g)].map(m => m[1]).sort();
        assert.deepEqual([...new Set(names(value))], [...new Set(names(key))], `placeholders differ for "${key}"`);
    }
});

test('the LBC dictionary translates messages the way LBC builds them', () => {
    assert.equal(dictionary.text('"Нижний Рынок" is not constant and has no keys — it can NEVER activate.'),
        '«Нижний Рынок» — не постоянная и без ключей: она НИКОГДА не сработает.');
    assert.equal(dictionary.text('Key "port" fires 2 entries at once (~840 tok): #0 Harbor | #3 Port'),
        'Ключ «port» включает сразу 2 записи (~840 ток.): #0 Harbor | #3 Port');
    assert.equal(dictionary.text('Delete entry "Old Fort"?'), 'Удалить запись «Old Fort»?');
    assert.equal(dictionary.text('5 entries'), '5 записей');
    assert.equal(dictionary.text('🌍 Realistic'), '🌍 Реализм');
    assert.equal(dictionary.text('⚡ CONST'), '⚡ ПОСТ.');
    assert.ok(dictionary.text('Replace current entries with the imported LoreBook?\n\nOK = replace all\nCancel = add imported entries to the current ones').includes('\n'),
        'a confirm() text keeps its line breaks in Russian');
});

test('every label, constant and markup text of the vendored LBC is in the dictionary', { skip: !existsSync(vendored) && 'vendor/lorebook-creator is not checked out' }, () => {
    const source = readFileSync(vendored, 'utf8').replace(/\r\n/g, '\n');
    const missing = [...extractStrings(source)]
        // Free-standing literals are mostly prompt fragments and log lines; the messages among them are covered by
        // the templates above.
        .filter(([, where]) => !where.startsWith('literal'))
        .filter(([text]) => dictionary.text(text) === null)
        .map(([text, where]) => `${where}: ${text}`);
    assert.deepEqual(missing, []);
});

test('draft: what is stored and when the editor counts as empty', () => {
    const entry = { comment: 'Перевод', content: 'перевод', _origComment: 'Harbor', _origContent: 'The harbor.', key: ['harbor'] };
    const data = { mode: 'advanced', worldName: 'X', entries: [entry], _translated: true, _trL: { a: 'b' }, editingEntryIdx: 0 };
    const link = { raw: { uid: 4 }, source: 'st:X' };
    const draft = snapshotDraft(data, (e) => (e === entry ? link : undefined));
    assert.equal(draft.version, 1);
    assert.deepEqual(draft.fields, { mode: 'advanced', worldName: 'X' });
    assert.deepEqual(draft.entries, [{ comment: 'Harbor', content: 'The harbor.', key: ['harbor'] }], 'the original, not LBC\'s machine translation');
    assert.deepEqual(draft.links, [link]);
    assert.equal(snapshotDraft({ entries: [], simpleIdea: '  ' }), null);
    assert.ok(isEditorEmpty({ entries: [], simpleIdea: '', worldName: '' }));
    assert.ok(!isEditorEmpty({ entries: [], simpleIdea: 'a city' }));
});
