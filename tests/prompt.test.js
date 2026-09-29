import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, looksTruncated, parseModelResponse, validateBatchResponse } from '../src/prompt.js';
import { LANGUAGES, resolveLanguage } from '../src/constants.js';

test('parseModelResponse handles fences, reasoning and surrounding text', () => {
    const json = '{"results":[{"id":1,"translations":[]}]}';
    assert.deepEqual(parseModelResponse(json).results[0].id, 1);
    assert.equal(parseModelResponse('```json\n' + json + '\n```').results.length, 1);
    assert.equal(parseModelResponse('<think>{"no": 1}</think>Sure! ' + json + ' Done.').results.length, 1);
    assert.equal(parseModelResponse({ results: [] }).results.length, 0, 'objects pass through');
    assert.equal(parseModelResponse('not json'), null);
    assert.equal(parseModelResponse('{"results":[{"id":1,'), null);
});

test('looksTruncated', () => {
    assert.equal(looksTruncated('{"results":[{"id":1,'), true);
    assert.equal(looksTruncated('{"results":[]}'), false);
    assert.equal(looksTruncated('I cannot help'), false);
});

const batch = [
    { id: 1, terms: ['Hermione', 'Granger'] },
    { id: 2, terms: ['Snape'] },
    { id: 3, terms: ['Hogwarts'] },
];

test('validateBatchResponse: maps sources, dedupes, caps variants, reports missing ids', () => {
    const parsed = {
        results: [
            {
                id: 1, translations: [
                    { source: 'hermione', variants: [{ base: 'Гермиона', forms: ['Гермиона', 'Гермионы', 'гермионы'] }] },
                    { source: 'Granger', variants: [{ base: 'Грейнджер', forms: [] }] },
                    { source: 'Ron', variants: [{ base: 'Рон', forms: ['Рон'] }] },
                ],
            },
            {
                id: 2, translations: [{
                    source: 'Snape', variants: [
                        { base: 'Снейп', forms: ['Снейп', 'Снейпа'] },
                        { base: 'Снегг', forms: ['Снегг'] },
                        { base: 'Злей', forms: ['Злей'] },
                        { base: 'Снейп', forms: ['Снейп'] },
                    ],
                }],
            },
            { id: 2, translations: [] },
            { id: 99, translations: [] },
        ],
    };
    const { results, missing, warnings } = validateBatchResponse(parsed, batch, { maxVariants: 2 });
    assert.deepEqual(missing, [3]);
    const first = results.get(1);
    assert.equal(first.length, 2, 'unknown source "Ron" dropped');
    assert.equal(first[0].source, 'Hermione', 'source restored to original spelling');
    assert.deepEqual(first[0].variants[0].forms, ['Гермиона', 'Гермионы']);
    assert.deepEqual(first[1].variants[0].forms, ['Грейнджер'], 'base is always a form');
    assert.equal(results.get(2)[0].variants.length, 2, 'capped at maxVariants');
    assert.ok(warnings.some(w => w.includes('Ron')));
});

test('validateBatchResponse: untranslated echo is dropped, empty variants kept as "no translation"', () => {
    const parsed = { results: [{ id: 3, translations: [{ source: 'Hogwarts', variants: [{ base: 'Hogwarts', forms: ['hogwarts'] }] }] }] };
    const { results, missing } = validateBatchResponse(parsed, batch, { maxVariants: 3 });
    assert.deepEqual(results.get(3), [{ source: 'Hogwarts', variants: [] }]);
    assert.deepEqual(missing, [1, 2]);
});

test('validateBatchResponse: accepts a paraphrased source when the item has one term', () => {
    const parsed = { results: [{ id: 2, translations: [{ source: 'Severus Snape', variants: [{ base: 'Снейп', forms: ['Снейп'] }] }] }] };
    const { results } = validateBatchResponse(parsed, batch, { maxVariants: 3 });
    assert.equal(results.get(2)[0].source, 'Snape');
});

test('system prompt mentions the language and grammar for every preset language', () => {
    for (const lang of LANGUAGES) {
        const prompt = buildSystemPrompt(resolveLanguage({ language: lang.id }), { maxVariants: 3 });
        assert.ok(prompt.includes(lang.name));
        assert.ok(prompt.includes(lang.grammar));
    }
});

test('custom language', () => {
    const lang = resolveLanguage({ language: 'custom', customLanguage: 'Esperanto' });
    assert.equal(lang.name, 'Esperanto');
    assert.equal(lang.id, 'custom:esperanto');
    assert.equal(resolveLanguage({ language: 'custom', customLanguage: '  ' }).id, '');
});
