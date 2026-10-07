// Translates another extension's interface in the page by a dictionary. A lighter port of SillyTavern-DES-RU's
// translator (same author, relicensed under MIT): LoreBook Creator has no chat-feed parts and no rich hints, so only
// text nodes and a few attributes are handled.
//
// - Roots are found among the direct children of <body> and inside the Extensions panel; inside a root a
//   MutationObserver follows every re-render.
// - Only strings found in the dictionary change. Elements that hold data (entry titles, keys, texts, values of
//   inputs) are excluded, so a book entry called "Location" stays "Location".
// - Idempotent by content: for every node we remember the source and our translation; a node the extension re-renders
//   is translated again, and switching off restores the English.
// - Strings with English words that the dictionary lacks are collected (bounded) for the dictionary's next update.
import { looksTranslatable, normalizeText } from './dictionary.js';

/** Attributes that carry interface text. `value` only on buttons (see VALUE_BUTTONS). */
const ATTRIBUTES = ['title', 'placeholder', 'value'];
const VALUE_BUTTONS = 'input[type="button"], input[type="submit"]';
const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES };
const UNTRANSLATED_LIMIT = 500;

/**
 * @typedef {object} UiTranslatorConfig
 * @property {() => ReturnType<import('./dictionary.js').createDictionary>} dictionary
 * @property {string} roots selector list of the extension's root elements
 * @property {string} containers selector list of the elements whose direct children may become roots
 * @property {string} exclude selector list of data elements (not translated, not collected)
 */

/** @param {string} original @param {string} translation */
function keepWhitespace(original, translation) {
    const lead = original.match(/^\s*/)[0];
    const trail = original.match(/\s*$/)[0];
    return `${lead}${translation}${trail}`;
}

/** @param {UiTranslatorConfig} config */
export function createUiTranslator({ dictionary, roots: rootSelector, containers, exclude }) {
    /** @type {WeakMap<Text, {source: string, value: string}>} */
    const textState = new WeakMap();
    /** @type {WeakMap<Element, Map<string, {source: string, value: string}>>} */
    const attributeState = new WeakMap();
    /** @type {Map<Element, MutationObserver>} */
    const roots = new Map();
    /** @type {MutationObserver[]} */
    let watchers = [];
    /** @type {Map<string, number>} */
    const untranslated = new Map();
    let running = false;

    /** @param {string} text */
    function collect(text) {
        const key = normalizeText(text);
        if (!looksTranslatable(key)) return;
        if (untranslated.has(key)) untranslated.set(key, untranslated.get(key) + 1);
        else if (untranslated.size < UNTRANSLATED_LIMIT) untranslated.set(key, 1);
    }

    /**
     * A label after a number badge (`<span>4</span> entries`) is translated with the number, so Russian gets the
     * right plural form: "{#n} entries" → «4 записи», and only the words are written back.
     * @param {Text} node
     * @param {string} text
     */
    function withNumberBefore(node, text) {
        const badge = node.previousSibling;
        const number = badge?.nodeType === Node.ELEMENT_NODE ? badge.textContent?.trim() : '';
        if (!number || !/^-?\d+$/.test(number)) return null;
        const translated = dictionary().text(`${number} ${text.trim()}`);
        return translated?.startsWith(`${number} `) ? translated.slice(number.length + 1) : null;
    }

    /** @param {Text} node */
    function translateText(node) {
        const current = node.nodeValue ?? '';
        if (!current.trim()) return;
        const state = textState.get(node);
        if (state && current === state.value) return;
        const translation = withNumberBefore(node, current) ?? dictionary().text(current);
        if (translation === null) {
            textState.delete(node);
            collect(current);
            return;
        }
        const value = keepWhitespace(current, translation);
        if (value !== current) node.nodeValue = value;
        textState.set(node, { source: current, value });
    }

    /** @param {Element} element */
    function translateAttributes(element) {
        for (const name of ATTRIBUTES) {
            if (name === 'value' && !element.matches(VALUE_BUTTONS)) continue;
            const current = element.getAttribute(name);
            if (current === null || !current.trim()) continue;
            let states = attributeState.get(element);
            const state = states?.get(name);
            if (state && current === state.value) continue;
            const translation = dictionary().text(current);
            if (translation === null) {
                states?.delete(name);
                collect(current);
                continue;
            }
            if (translation !== current) element.setAttribute(name, translation);
            if (!states) attributeState.set(element, states = new Map());
            states.set(name, { source: current, value: translation });
        }
    }

    /** @param {Element} element */
    function visit(element) {
        if (element.matches(exclude)) {
            // A data field still has an interface hint (placeholder, title).
            if (element.matches('input, textarea, select')) translateAttributes(element);
            return;
        }
        translateAttributes(element);
        for (const child of [...element.childNodes]) {
            if (child.nodeType === Node.TEXT_NODE) translateText(/** @type {Text} */ (child));
            else if (child.nodeType === Node.ELEMENT_NODE) visit(/** @type {Element} */ (child));
        }
    }

    /** @param {Node} node */
    function translateNode(node) {
        if (!node.isConnected) return;
        const element = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
        if (!element) return;
        if (element.closest(exclude)) {
            if (node === element && element.matches('input, textarea, select')) translateAttributes(element);
            return;
        }
        if (node.nodeType === Node.TEXT_NODE) translateText(/** @type {Text} */ (node));
        else visit(element);
    }

    /** @param {Element} element */
    function attach(element) {
        if (roots.has(element)) return;
        // A root inside a known root is served by that root's observer.
        if ([...roots.keys()].some(root => root.contains(element))) return;
        const observer = new MutationObserver((records) => {
            const touched = new Set();
            for (const record of records) {
                if (record.type === 'childList') record.addedNodes.forEach(node => touched.add(node));
                else touched.add(record.target);
            }
            for (const node of touched) translateNode(node);
            observer.takeRecords();
        });
        observer.observe(element, OBSERVE);
        roots.set(element, observer);
        visit(element);
        observer.takeRecords();
    }

    function prune() {
        for (const [root, observer] of roots) {
            if (root.isConnected) continue;
            observer.disconnect();
            roots.delete(root);
        }
    }

    /** @param {Node} node */
    function discover(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = /** @type {Element} */ (node);
        if (element.matches(rootSelector)) attach(element);
        element.querySelectorAll(rootSelector).forEach(attach);
    }

    /** Puts the English back in every node we translated. */
    function restore() {
        for (const root of roots.keys()) {
            if (!root.isConnected) continue;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
            const nodes = [root];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            for (const node of nodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const state = textState.get(/** @type {Text} */ (node));
                    if (state && node.nodeValue === state.value) node.nodeValue = state.source;
                    continue;
                }
                const element = /** @type {Element} */ (node);
                for (const [name, state] of attributeState.get(element) ?? []) {
                    if (element.getAttribute(name) === state.value) element.setAttribute(name, state.source);
                }
            }
        }
    }

    return {
        get running() {
            return running;
        },
        start() {
            if (running) return;
            running = true;
            for (const container of document.querySelectorAll(containers)) {
                const watcher = new MutationObserver((records) => {
                    for (const record of records) record.addedNodes.forEach(discover);
                    if (records.some(record => record.removedNodes.length)) prune();
                });
                watcher.observe(container, { childList: true });
                watchers.push(watcher);
            }
            document.querySelectorAll(rootSelector).forEach(attach);
        },
        /** Translates every known root again (after the dictionary changed). */
        refresh() {
            if (!running) return;
            prune();
            for (const [root, observer] of roots) {
                visit(root);
                observer.takeRecords();
            }
        },
        stop() {
            if (!running) return;
            running = false;
            watchers.forEach(watcher => watcher.disconnect());
            watchers = [];
            for (const observer of roots.values()) observer.disconnect();
            restore();
            roots.clear();
        },
        /** @returns {{text: string, count: number}[]} strings with English words the dictionary does not cover */
        untranslated: () => [...untranslated].map(([text, count]) => ({ text, count })),
    };
}
