import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyRegex, buildPlainKeys, cleanForms, looksLikeRegexKey, parseRegexLikeST, validateKeyRegex } from '../src/regex-builder.js';

const cases = [
    {
        name: 'feminine name with two-letter endings',
        forms: ['Гермиона', 'Гермионы', 'Гермионе', 'Гермиону', 'Гермионой', 'Гермионою'],
        negative: ['Гермионовна', 'гермионный'],
    },
    {
        name: 'fleeting vowel',
        forms: ['Лев', 'Льва', 'Льву', 'Львом', 'Льве'],
        negative: ['левый', 'Львов', 'хлев'],
    },
    {
        name: 'adjective + noun phrase',
        forms: ['Тёмный Лорд', 'Тёмного Лорда', 'Тёмному Лорду', 'Тёмным Лордом', 'Тёмном Лорде'],
        negative: ['тёмный лордик', 'Тёмная'],
    },
    {
        name: 'indeclinable name',
        forms: ['Гарри'],
        negative: ['Гаррисон', 'Гарр'],
    },
    {
        name: 'short name must not match inside words',
        forms: ['Рон', 'Рона', 'Рону', 'Роном', 'Роне'],
        negative: ['корона', 'ронять', 'Хрон'],
    },
    {
        name: 'plural forms of a common noun',
        forms: ['эльф', 'эльфа', 'эльфу', 'эльфом', 'эльфе', 'эльфы', 'эльфов', 'эльфам', 'эльфами', 'эльфах'],
        negative: ['эльфийка', 'дельфин'],
    },
];

for (const c of cases) {
    test(`buildKeyRegex: ${c.name}`, () => {
        const key = buildKeyRegex(c.forms);
        assert.ok(key, 'key is built');
        assert.deepEqual(validateKeyRegex(key, c.forms), { ok: true });
        const regex = parseRegexLikeST(key);
        for (const form of c.forms) {
            assert.ok(regex.test(`\x01Гарри: смотри, ${form.toUpperCase()}!`), `matches "${form}" in a sentence, any case`);
        }
        for (const word of c.negative) {
            assert.equal(regex.test(`\x01User: ${word}`), false, `does not match "${word}"`);
        }
    });
}

test('ё and е are interchangeable', () => {
    const regex = parseRegexLikeST(buildKeyRegex(['Тёмный Лорд', 'Тёмного Лорда']));
    assert.ok(regex.test('Темного Лорда'));
    assert.ok(regex.test('тёмного   лорда'), 'flexible whitespace');
});

test('special characters are escaped and ST still parses the key', () => {
    for (const forms of [['Mr. Smith'], ['AC/DC'], ['{{char}} (clone)'], ['C++', 'C#'], ['a|b', '[x]']]) {
        const key = buildKeyRegex(forms);
        assert.ok(!key.includes('{{'), 'no macro braces survive');
        assert.deepEqual(validateKeyRegex(key, forms), { ok: true }, `valid for ${forms}`);
        const regex = parseRegexLikeST(key);
        assert.equal(regex.test('Mr1 Smith'), false, 'dot is literal');
    }
});

test('no boundaries mode matches inside unspaced text (CJK)', () => {
    const key = buildKeyRegex(['ハリー'], { boundaries: false });
    const regex = parseRegexLikeST(key);
    assert.ok(regex.test('ハリーは言った'));
});

test('surrogate pairs are never split', () => {
    const key = buildKeyRegex(['𠮷野家', '𠮷田']);
    assert.deepEqual(validateKeyRegex(key, ['𠮷野家', '𠮷田']), { ok: true });
});

test('cleanForms trims, removes commas, dedupes case- and ё-insensitively', () => {
    assert.deepEqual(cleanForms([' Ёж ', 'еж', 'ежа,', '', null, 42, 'ежу']), ['Ёж', 'ежа', 'ежу']);
});

test('buildPlainKeys returns clean unique forms', () => {
    assert.deepEqual(buildPlainKeys(['Рон', 'рон', 'Рона']), ['Рон', 'Рона']);
});

test('looksLikeRegexKey', () => {
    assert.equal(looksLikeRegexKey('/abc/i'), true);
    assert.equal(looksLikeRegexKey('  /a,b/  '), true);
    assert.equal(looksLikeRegexKey('AC/DC'), false);
    assert.equal(looksLikeRegexKey('Hermione'), false);
});

test('validateKeyRegex rejects broken keys', () => {
    assert.equal(validateKeyRegex('/(?:/iu', ['x']).ok, false);
    assert.equal(validateKeyRegex('/a/b/iu', ['a']).ok, false, 'unescaped slash');
    assert.equal(validateKeyRegex('/x?/iu', ['x']).ok, false, 'matches empty');
    assert.equal(validateKeyRegex('/abc/iu', ['abd']).ok, false, 'does not match its form');
});
