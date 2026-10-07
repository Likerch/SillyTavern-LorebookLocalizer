import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLikeLbc } from '../src/lbc/adapter.js';
import { auditRussianKeys, entriesNeedingForms } from '../src/lbc/audit-ru.js';
import { reconcileLocalizedKeys, toWorldInfoEntry } from '../src/lbc/book.js';
import { buildKeyRegex } from '../src/regex-builder.js';

const ANNA = buildKeyRegex(['Анна', 'Анны', 'Анне', 'Анну', 'Анной']);

test('Russian audit: no Russian keys, one form only, common words, collisions through word forms', () => {
    const entries = [
        { comment: 'Harbor', key: ['harbor', 'port'] },
        { comment: 'Анна', key: ['Anna', ANNA] },
        { comment: 'Город', key: ['город', 'Гавань'] },
        { comment: 'Сестра', key: ['Анны'] },
        { comment: 'Rule', key: ['law'], constant: true },
        { comment: 'Off', key: ['x'], disable: true },
    ];
    const issues = auditRussianKeys(entries);
    const of = (type) => issues.filter(issue => issue.type === type).map(issue => [issue.idx, issue.key ?? null, issue.other ?? null]);
    assert.deepEqual(of('no_russian'), [[0, null, null]]);
    assert.deepEqual(of('generic_ru'), [[2, 'город', null]]);
    assert.deepEqual(of('single_form'), [[2, 'Гавань', null], [3, 'Анны', null]]);
    assert.deepEqual(of('forms_collision'), [[3, 'Анны', 1]]);
    assert.deepEqual(entriesNeedingForms(issues).sort(), [0, 2, 3]);
    // Constant and disabled entries are not judged by their keys.
    assert.ok(!issues.some(issue => issue.idx === 4 || issue.idx === 5));
});

test('Russian audit: an entry covered by a regex key is fine; the same group may share words', () => {
    assert.deepEqual(auditRussianKeys([{ key: ['Anna', ANNA, 'Анна'] }]), []);
    const grouped = auditRussianKeys([{ key: ['Анны'], group: 'g' }, { key: [ANNA], group: 'g' }]);
    assert.ok(!grouped.some(issue => issue.type === 'forms_collision'));
});

/** A World Info entry Lorebook Localizer has localized: "Anna" → Russian forms. */
const localized = () => ({
    uid: 3, comment: 'Anna', content: 'A smuggler.', key: ['Anna', ANNA], keysecondary: ['smuggler', '/контрабандист/iu'],
    extensions: {
        lorebook_localizer: {
            version: 1,
            languages: { ru: { language: 'Russian', sources: ['Anna', 'smuggler'], added: { key: [ANNA], keysecondary: ['/контрабандист/iu'] } } },
        },
        maestro: { passport: 1 },
    },
});

test('reconcile: keys an LLM rewrite dropped come back while their sources stay', () => {
    const out = localized();
    out.key = ['Anna', 'Anna Smith'];
    out.keysecondary = ['smuggler'];
    reconcileLocalizedKeys(out);
    assert.deepEqual(out.key, ['Anna', 'Anna Smith', ANNA]);
    assert.deepEqual(out.keysecondary, ['smuggler', '/контрабандист/iu']);
    assert.ok(out.extensions.lorebook_localizer.languages.ru);
});

test('reconcile: a renamed source drops that language\'s added keys and record, other data stays', () => {
    const out = localized();
    out.key = ['Hanna', ANNA];
    reconcileLocalizedKeys(out);
    assert.deepEqual(out.key, ['Hanna']);
    assert.deepEqual(out.keysecondary, ['smuggler']);
    assert.ok(!('lorebook_localizer' in out.extensions), 'the next localization starts fresh');
    assert.deepEqual(out.extensions.maestro, { passport: 1 });
});

test('saving: an Optimize patch that replaced the keys keeps the Russian forms in the book', () => {
    const raw = localized();
    const editor = { ...normalizeLikeLbc(raw), key: ['Anna', 'smuggler queen'] };
    const { entry, kind } = toWorldInfoEntry(editor, { raw, source: 'st:Book' }, {});
    assert.equal(kind, 'updated');
    assert.deepEqual(entry.key, ['Anna', 'smuggler queen', ANNA]);
    assert.deepEqual(entry.extensions.maestro, { passport: 1 });
});
