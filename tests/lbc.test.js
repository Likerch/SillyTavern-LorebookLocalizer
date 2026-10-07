import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLbcApi, isLbcGenerating, LBC } from '../src/lbc/adapter.js';
import { compareVersions, compatibility, findLbcExtension, isLbcManifest, parseVersion, thirdPartyNames } from '../src/lbc/compat.js';
import { createScope } from '../src/lbc/scope.js';

const LBC_MANIFEST = { display_name: 'LoreBook Creator', author: 'virgilianshailer', version: '1.15.0', js: 'index.js' };

test('versions: parsing, comparing and judging against the tested list', () => {
    assert.deepEqual(parseVersion('1.15.0'), [1, 15, 0]);
    assert.deepEqual(parseVersion('v2.1'), [2, 1, 0]);
    assert.equal(parseVersion('banana'), null);
    assert.ok(compareVersions([1, 15, 0], [1, 9, 9]) > 0);
    assert.equal(compareVersions([1, 15], [1, 15, 0]), 0);
    assert.equal(compatibility('1.15.0'), 'tested');
    assert.equal(compatibility('1.16.0'), 'newer');
    assert.equal(compatibility('1.12.0'), 'older');
    assert.equal(compatibility(''), 'unknown');
    assert.equal(compatibility('1.0.0', []), 'unknown');
});

test('finding LBC: folders from script sources, the official folder first, any folder by its manifest', () => {
    const sources = [
        '/scripts/extensions/third-party/SillyTavern-Maestro/dist/index.js',
        'scripts/extensions/third-party/lorebook-creator-main/index.js',
        '/scripts/extensions/memory/index.js',
        'http://127.0.0.1:8000/scripts/extensions/third-party/My%20Copy/index.js',
    ];
    assert.deepEqual(thirdPartyNames(sources), ['third-party/SillyTavern-Maestro', 'third-party/lorebook-creator-main', 'third-party/My Copy']);
    // The official folder is asked first, so a match there needs no other lookups.
    const manifests = { 'third-party/lorebook-creator': LBC_MANIFEST, 'third-party/SillyTavern-Maestro': { display_name: 'Maestro' } };
    const asked = [];
    const found = findLbcExtension(['third-party/SillyTavern-Maestro'], name => { asked.push(name); return manifests[name] ?? null; });
    assert.equal(found?.name, 'third-party/lorebook-creator');
    assert.deepEqual(asked, ['third-party/lorebook-creator']);
    // Installed under another folder, renamed display name: the author still identifies it.
    const renamed = { 'third-party/lbc-fork': { display_name: 'LBC fork', author: 'VirgilianShailer', version: '1.15.0' } };
    assert.equal(findLbcExtension(['third-party/lbc-fork'], name => renamed[name] ?? null)?.name, 'third-party/lbc-fork');
    assert.equal(findLbcExtension(['third-party/other'], () => { throw new Error('unknown'); }), null);
    assert.ok(isLbcManifest({ display_name: ' lorebook creator ' }));
    assert.ok(!isLbcManifest({ display_name: 'Character Creator', author: 'someone' }));
});

test('adapter: the API and the generation flag are read from the given window', () => {
    assert.equal(getLbcApi({}), null);
    assert.equal(getLbcApi({ [LBC.apiGlobal]: { getData: () => ({}) } }), null, 'open() is required too');
    const api = { open() {}, getData: () => ({ entries: [] }) };
    assert.equal(getLbcApi({ [LBC.apiGlobal]: api }), api);
    assert.equal(isLbcGenerating({ [LBC.generationFlag]: true }), true);
    assert.equal(isLbcGenerating({ [LBC.generationFlag]: 1 }), false);
    assert.equal(isLbcGenerating(undefined), false);
});

test('scope: cleanups run once, in reverse order, and a failing one does not stop the rest', () => {
    const order = [];
    const errors = [];
    const scope = createScope(error => errors.push(String(error)));
    scope.add(() => order.push('a'));
    scope.add(() => { throw new Error('boom'); });
    scope.add(() => order.push('c'));
    scope.close();
    scope.close();
    assert.deepEqual(order, ['c', 'a']);
    assert.deepEqual(errors, ['Error: boom']);
    assert.equal(scope.closed, true);
    scope.add(() => order.push('late'));
    assert.deepEqual(order, ['c', 'a', 'late'], 'a cleanup added to a closed scope runs at once');
});

test('scope: listeners are removed, children close with the parent or on their own', () => {
    const calls = [];
    const source = {
        on: (event, fn) => calls.push(['on', event, fn]),
        makeLast: (event, fn) => calls.push(['last', event, fn]),
        removeListener: (event, fn) => calls.push(['off', event, fn]),
    };
    const fn = () => {};
    const parent = createScope();
    parent.on(source, 'A', fn);
    parent.onLast(source, 'B', fn);

    const early = parent.child();
    early.add(() => calls.push(['early']));
    early.close();
    const late = parent.child();
    late.add(() => calls.push(['late']));

    parent.close();
    assert.deepEqual(calls.map(c => c.slice(0, 2)), [['on', 'A'], ['last', 'B'], ['early'], ['late'], ['off', 'B'], ['off', 'A']]);
    assert.equal(late.closed, true);
});
