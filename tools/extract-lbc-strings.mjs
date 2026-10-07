#!/usr/bin/env node
// Collects the interface strings of LoreBook Creator from its source and compares them with our dictionary.
//
//   node tools/extract-lbc-strings.mjs [--source <index.js>] [--missing] [--stale] [--json]
//
// --missing  strings of LBC that the dictionary does not translate (exactly or through a template)
// --stale    dictionary keys that no longer occur in LBC (renamed or removed strings)
// default    both lists, plus counts. The source defaults to vendor/lorebook-creator/index.js.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDictionary, normalizeText } from '../src/lbc/dictionary.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
};
const sourcePath = option('--source') ?? join(root, 'vendor', 'lorebook-creator', 'index.js');
const dictionaryPath = join(root, 'locales', 'ru.lorebook-creator.json');

/** Evaluates one JS string literal from LBC's source (its own escapes: \n, \', \"). */
const literal = (text) => Function(`return ${text}`)();
const STRING = /'(?:[^'\\\n]|\\.)*'/g;

/**
 * @param {string} source LBC's index.js
 * @returns {Map<string, string>} interface string → where it was found
 */
export function extractStrings(source) {
    const found = new Map();
    const add = (text, where) => {
        const value = normalizeText(text);
        if (value && /\p{L}{2}/u.test(value) && !found.has(value)) found.set(value, where);
    };

    // 1. The UI dictionary.
    const ui = source.slice(source.indexOf('var UI = {'), source.indexOf('\n};', source.indexOf('var UI = {')));
    for (const match of ui.matchAll(/^\s+(\w+):\s*('(?:[^'\\]|\\.)*')\s*,?\s*$/gm)) add(literal(match[2]), `UI.${match[1]}`);

    // 2. Constants shown in the window.
    for (const name of ['WORLD_TYPES', 'ERA_PRESETS', 'USER_ROLES', 'SCALE_LABELS', 'ENTRY_CATEGORIES']) {
        const start = source.indexOf(`var ${name} =`);
        const block = source.slice(start, source.indexOf(';\n', start));
        for (const match of block.matchAll(/(?:label|desc|range|entries):\s*('(?:[^'\\]|\\.)*')/g)) add(literal(match[1]), name);
        if (name === 'ENTRY_CATEGORIES') for (const match of block.matchAll(STRING)) add(literal(match[0]), name);
    }

    // 3. Text inside markup and messages, outside the prompts and the keyword lists.
    const skip = [
        [source.indexOf('var PROMPTS = {'), source.indexOf('var LBC_DEFAULTS')],
        [source.indexOf('var CATEGORY_SYNONYMS'), source.indexOf('function canonicalizeCategory')],
        [source.indexOf('var LBC_GENERIC_KEYS'), source.indexOf('var LBC_OPT')],
        [source.indexOf('PROMPTS.optimizeKeys ='), source.indexOf('function lbcBuildDigest')],
        [source.indexOf('var UI = {'), source.indexOf('function T(key)')],
    ];
    const skipped = (index) => skip.some(([from, to]) => index >= from && index < to);
    for (const match of source.matchAll(STRING)) {
        if (skipped(match.index)) continue;
        let text;
        try {
            text = literal(match[0]);
        } catch {
            continue;
        }
        const line = source.slice(0, match.index).split('\n').length;
        if (/[<>]/.test(text)) {
            for (const part of text.matchAll(/>([^<>]+)</g)) add(part[1], `html:${line}`);
            for (const part of text.matchAll(/(?:title|placeholder)="([^"]+)"/g)) add(part[1], `attr:${line}`);
            continue;
        }
        // A message, not an identifier, selector, class list, CSS or URL.
        if (!/[A-Za-z]{3}/.test(text) || !/\s/.test(text.trim())) continue;
        if (/^[#.][\w-]|^\/api\/|[{};]\s*$|^[\w-]+(?:\s+[\w-]+)*$/.test(text.trim()) && !/[A-Z]/.test(text)) continue;
        if (/\b(?:fa-|lbc-|menu_button|px\b|rgba\()/.test(text)) continue;
        add(text, `literal:${line}`);
    }
    return found;
}

function main() {
    if (!existsSync(sourcePath)) {
        console.error(`No LBC source at ${sourcePath}. Clone it into vendor/lorebook-creator or pass --source.`);
        process.exit(1);
    }
    // A Windows checkout may have CRLF; the block boundaries below look for LF.
    const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
    const strings = extractStrings(source);
    const entries = existsSync(dictionaryPath) ? JSON.parse(readFileSync(dictionaryPath, 'utf8')) : {};
    const dictionary = createDictionary(entries);
    const missing = [...strings].filter(([text]) => dictionary.text(text) === null);
    const flat = normalizeText(source.replace(/\\n/g, ' ').replace(/\\'/g, '\''));
    const stale = Object.keys(entries).filter((key) => {
        if (key.startsWith('__') || /\{#?\w+\}/.test(key)) return false;
        return !strings.has(normalizeText(key)) && !flat.includes(normalizeText(key));
    });

    if (args.includes('--json')) {
        console.log(JSON.stringify(Object.fromEntries(missing.map(([text]) => [text, ''])), null, 4));
        return;
    }
    const showMissing = !args.includes('--stale') || args.includes('--missing');
    const showStale = !args.includes('--missing') || args.includes('--stale');
    console.log(`LBC strings: ${strings.size}; dictionary: ${dictionary.size}; missing: ${missing.length}; stale: ${stale.length}`);
    if (showMissing) for (const [text, where] of missing) console.log(`missing  ${where.padEnd(14)} ${JSON.stringify(text)}`);
    if (showStale) for (const key of stale) console.log(`stale    ${JSON.stringify(key)}`);
    if ((showMissing && missing.length) || (showStale && stale.length)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
