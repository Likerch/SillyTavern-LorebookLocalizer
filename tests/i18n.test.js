import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Collects every t`...` template as SillyTavern's i18n key (`${expr}` → `${index}`). */
export function extractKeys() {
    const files = ['index.js', ...readdirSync(join(root, 'src')).map(f => join('src', f))].filter(f => f.endsWith('.js'));
    const keys = new Set();
    for (const file of files) {
        const source = readFileSync(join(root, file), 'utf8');
        for (const match of source.matchAll(/\bt`((?:[^`\\]|\\.)*)`/g)) {
            let index = 0;
            keys.add(match[1].replace(/\$\{[^}]*\}/g, () => `\${${index++}}`));
        }
    }
    return keys;
}

test('every UI string has a Russian translation with the same placeholders', () => {
    const ru = JSON.parse(readFileSync(join(root, 'i18n', 'ru-ru.json'), 'utf8'));
    const keys = extractKeys();
    const missing = [...keys].filter(key => !Object.hasOwn(ru, key));
    assert.deepEqual(missing, [], 'missing translations');
    for (const key of keys) {
        const placeholders = (s) => (s.match(/\$\{\d+\}/g) ?? []).sort().join();
        assert.equal(placeholders(ru[key]), placeholders(key), `placeholders differ for "${key}"`);
    }
    const unused = Object.keys(ru).filter(key => !keys.has(key));
    assert.deepEqual(unused, [], 'unused translations');
});
