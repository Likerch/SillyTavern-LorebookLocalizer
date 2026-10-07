import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    applyContentLanguage, canonicalCategory, canonicalizeReplyCategories, LBC_CATEGORIES, languageRules,
} from '../src/lbc/language.js';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const vendored = join(root, 'vendor', 'lorebook-creator', 'index.js');

/** Every prompt text of the vendored LBC: PROMPTS, PROMPTS.optimizeKeys and the merge language line. */
function vendoredPrompts() {
    const source = readFileSync(vendored, 'utf8').replace(/\r\n/g, '\n');
    const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
    const categories = slice('var ENTRY_CATEGORIES =', ';\n');
    const prompts = slice('var PROMPTS = {', '\n};') + '\n};';
    const optimize = slice('PROMPTS.optimizeKeys =', ';\n') + ';';
    const langLine = slice('function lbcLangSample(entryLists) {', '\n}\n') + '\n}\n'
        + slice('function lbcLangLine(entryLists) {', '\n}\n') + '\n}';
    const result = Function(`${categories};\n${prompts}\n${optimize}\n${langLine}\nreturn { PROMPTS, langLine: lbcLangLine([[{ content: 'Пример текста книги.' }]]) };`)();
    return [...Object.values(result.PROMPTS), `Analyze.\n${result.langLine}Indices refer to the digests above.`];
}

test('categories: Russian and variant names map to LBC\'s English ones, custom categories stay', () => {
    assert.equal(canonicalCategory('Персонаж'), 'Character');
    assert.equal(canonicalCategory('  локации '), 'Location');
    assert.equal(canonicalCategory('Предмет / Артефакт'), 'Item / Artifact');
    assert.equal(canonicalCategory('Существо / вид'), 'Creature / Species');
    assert.equal(canonicalCategory('Предание / легенда'), 'Lore / Legend');
    assert.equal(canonicalCategory('Ёлки'), 'Ёлки');
    assert.equal(canonicalCategory('core rule'), 'Core Rule');
    assert.equal(canonicalCategory('Божество'), 'Божество', 'a custom category is kept');
    assert.equal(canonicalCategory(undefined), undefined);
    // Every Russian label of our interface dictionary maps back.
    const dictionary = JSON.parse(readFileSync(join(root, 'locales', 'ru.lorebook-creator.json'), 'utf8'));
    for (const category of LBC_CATEGORIES) assert.equal(canonicalCategory(dictionary[category]), category, category);
});

test('replies: categories fixed in books, single entries, auto-categorize and merges', () => {
    const book = { worldName: 'X', entries: [{ category: 'Персонаж' }, { category: 'Location' }, { category: 'Божество' }] };
    assert.equal(canonicalizeReplyCategories(book), 1);
    assert.deepEqual(book.entries.map(e => e.category), ['Character', 'Location', 'Божество']);
    const entry = { comment: 'A', content: 'a', category: 'Фракция' };
    assert.equal(canonicalizeReplyCategories(entry), 1);
    assert.equal(entry.category, 'Faction');
    const assignments = { assignments: [{ index: 0, category: 'Место' }] };
    assert.equal(canonicalizeReplyCategories(assignments), 1);
    assert.equal(assignments.assignments[0].category, 'Location');
    assert.equal(canonicalizeReplyCategories({ merged: [{ pair: 0, category: 'Organization' }] }), 0);
    assert.equal(canonicalizeReplyCategories(null), 0);
    const bare = [{ index: 0, category: 'Персонаж' }];
    assert.equal(canonicalizeReplyCategories(bare), 1, 'a bare array (auto-categorize) too');
    assert.equal(bare[0].category, 'Character');
    const own = { entries: [{ category: 'Легенды' }, { category: 'Легенда' }] };
    assert.equal(canonicalizeReplyCategories(own, ['легенды']), 1, 'the user\'s own category stays');
    assert.deepEqual(own.entries.map(e => e.category), ['Легенды', 'Lore / Legend']);
});

test('prompts: "same language" sentences give way to the chosen language; idea mode leaves them', () => {
    const prompt = 'Write in the SAME LANGUAGE as the user idea.\nSame language as context. ONLY JSON!]\n5. Keep keys in the SAME LANGUAGE as the entry content.';
    assert.equal(applyContentLanguage(prompt, 'idea'), prompt);
    const english = applyContentLanguage(prompt, 'en');
    assert.ok(!/same language/i.test(english));
    assert.ok(english.includes('Write all text in English (see the language rules). ONLY JSON!]'));
    assert.ok(english.includes('5. Keys: see the language rules.'));
    assert.ok(applyContentLanguage(prompt, 'ru').includes('Write all text in Russian'));
});

test('every vendored LBC prompt loses its "same language" rule in en and ru modes', { skip: !existsSync(vendored) && 'vendor/lorebook-creator is not checked out' }, () => {
    const prompts = vendoredPrompts();
    assert.ok(prompts.length >= 19);
    for (const language of ['en', 'ru']) {
        for (const prompt of prompts) {
            const result = applyContentLanguage(prompt, language);
            assert.ok(!/same language|CRITICAL LANGUAGE RULE/i.test(result), `${language}: ${result.slice(0, 120)}`);
            assert.ok(!result.includes('Пример текста книги'), 'the merge prompts\' language sample is gone');
        }
    }
});

test('rules: language, names and keys per mode; categories always English', () => {
    const [en] = languageRules('en');
    assert.ok(en.includes('natural English'));
    assert.ok(en.includes('Russian form in the nominative case'));
    const [ru] = languageRules('ru');
    assert.ok(ru.includes('literary Russian'));
    assert.ok(ru.includes('Russian words in the nominative case'));
    const [idea] = languageRules('idea');
    assert.ok(!/English\)|Russian\)/.test(idea));
    for (const rules of [en, ru, idea]) assert.ok(rules.includes(LBC_CATEGORIES.join(', ')));
});
