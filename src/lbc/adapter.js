// Everything the extension knows about LoreBook Creator (https://github.com/virgilianshailer/lorebook-creator) lives in
// this file: names, globals, DOM selectors, prompt signatures and its entry model. LBC is one closed ES module, so these
// are the only handles on it; a new LBC version that renames one of them breaks only this file. No SillyTavern imports
// (only `showLbcStatus` needs jQuery), so the rest is unit-tested in Node.
//
// Recon of the tested version with line references: docs/lbc-recon.md.

export const LBC = Object.freeze({
    displayName: 'LoreBook Creator',
    author: 'virgilianshailer',
    /** Folder name of the official repository; users may install it under another one. */
    defaultFolder: 'lorebook-creator',
    /** Versions whose DOM and prompts the module was checked against. */
    testedVersions: Object.freeze(['1.15.0']),
    /** `{open, close, openWorld, load, createFromLore, getData}`. `getData()` returns the live editor state. */
    apiGlobal: 'LorebookCreator',
    /** `true` on `window` while LBC waits for its own quiet generation (cleared 500 ms after the reply). */
    generationFlag: '_lbcOwnGeneration',
    selectors: Object.freeze({
        panel: '#lbc-panel',
        overlay: '#lbc-panel-overlay',
        body: '#lbc-body',
        status: '#lbc-status',
        chatButton: '#lbc-trigger',
        /** The header button that machine-translates the UI and the entries through Chat Translation. */
        translateButton: '#lbc-h-tr',
        /** "To English" next to the Simple-mode idea box. */
        translateIdea: '#lbc-tr-idea',
        /** LLM Edit, Merge Workspace, Optimizer, Lorebook from lore. */
        modals: Object.freeze(['#lbc-le-modal', '#lbc-mg-modal', '#lbc-opt-modal', '#lbc-fl-modal']),
        /** "Import to ST" in the footer and on the Export tab (both run `doUIImport`, bound on `document`). */
        importButtons: '#lbc-f-import, .lbc-exp-import',
        /** "Download JSON" on the Export tab. */
        downloadButton: '.lbc-exp-json',
        /** The hidden file input behind "Load LoreBook". */
        loadBookInput: '#lbc-file-loadbook',
        /** Everything LBC shows: the panel, the four windows, its block in Extensions, the chat-bar button. */
        uiRoots: '#lbc-panel, #lbc-le-modal, #lbc-mg-modal, #lbc-opt-modal, #lbc-fl-modal, #lbc-settings, #lbc-trigger',
        /** Where LBC puts those roots (the panel and windows go straight into <body>). */
        uiContainers: 'body, #extensions_settings2, #extensions_settings, #leftSendForm, #send_form',
        /** Elements that show book data, not interface: never translated. */
        uiData: [
            'input', 'textarea', '#lbc-ed-parent-add option:not([value=""])',
            '.lbc-entry-title', '.lbc-entry-keys', '.lbc-entry-content-preview', '.lbc-parent-chip', '.lbc-custom-cat',
            '.lbc-del-custom-cat', '.lbc-opt-reason', '.lbc-opt-diff', '.lbc-opt-patch b',
            '.lbc-mg-pv b', '.lbc-mg-snippet', '.lbc-mg-note', '.lbc-mg-slot-name', '.lbc-mg-uniq b',
            '.lbc-fl-etitle', '.lbc-fl-etext',
        ].join(', '),
    }),
});

/**
 * The editor state worth keeping across page reloads (LBC keeps it in memory only). Its own machine translation
 * (`_translated`, `_trL`, `_orig*` of entries) and transient UI state are left out.
 */
export const LBC_DRAFT_FIELDS = Object.freeze([
    'mode', 'activeTab', 'simpleIdea', 'worldName', 'worldDescription', 'era', 'eraCustom', 'worldType', 'worldScale',
    'userRole', 'userRoleDescription', 'tone', 'themes', 'mainConflict', 'geography', 'factions', 'magicSystem',
    'techLevel', 'history', 'coreRules', 'entries', 'customCategories', 'templateData', 'templateName', 'locked',
    'categoryFilter', '_origWorldName', '_loadedWorld',
]);

/**
 * Every LBC prompt (18 in `PROMPTS`, `PROMPTS.optimizeKeys` and two inline ones) is wrapped in `[OOC: … ]`.
 * The kinds are for logs and for the language rules of a later stage; an unknown `[OOC:` prompt is still LBC's.
 */
const PROMPT_KINDS = [
    ['simpleGenerate', /^You are a LoreBook \/ World Info creation assistant for a roleplaying system/],
    ['advancedGenerate', /^You are a LoreBook \/ World Info creation assistant\. Generate entries/],
    ['generateField', /^You are a world-building assistant\. Generate a value for/],
    ['generateAllFields', /^You are a world-building assistant\. Fill ALL parameters/],
    ['enhanceField', /^You are a creative world-building assistant\. Your task is to rewrite and greatly EXPAND the field/],
    ['addMoreField', /^You are a creative world-building assistant\. Your task is to ADD NEW/],
    ['enhanceEntry', /^You are a creative world-building assistant\. Your task is to deeply ENHANCE/],
    ['generateSingleEntry', /^Generate ONE detailed lorebook entry/],
    ['generateFromParents', /^Generate ONE lorebook entry GROUNDED IN/],
    ['regenerateEntry', /^Rewrite this entry with MORE detail/],
    ['expandSpecificCategory', /^Generate \S+ NEW lorebook entries specifically for the category/],
    ['expandEntries', /^Generate \S+ NEW lorebook entries/],
    ['reconstructWorld', /^You are a world-building analyst/],
    ['autoCategorize', /^You are a LoreBook \/ World Info librarian/],
    ['lorebookFromLore', /^You are an expert LoreBook \/ World Info author/],
    ['mergeLorebooks', /^You are an expert LoreBook \/ World Info editor\. You are given/],
    ['mergePair', /^You are an expert LoreBook \/ World Info editor\. Below are/],
    ['mergeAnalyze', /^You are a LoreBook \/ World Info analyst/],
    ['generateFieldText', /^Generate detailed content for the world parameter/],
    ['llmEdit', /^You are a lorebook entry editing assistant/],
    ['optimizeKeys', /^You are a SillyTavern World Info \/ LoreBook OPTIMIZER/],
];

/**
 * Whether a quiet prompt is one of LBC's.
 * @param {unknown} prompt
 */
export function isLbcPrompt(prompt) {
    return typeof prompt === 'string' && /^\s*\[OOC:/.test(prompt);
}

/**
 * @param {string} prompt
 * @returns {string} the kind name, or `unknown`
 */
export function classifyLbcPrompt(prompt) {
    const body = unwrapLbcPrompt(prompt);
    return PROMPT_KINDS.find(([, re]) => re.test(body))?.[0] ?? 'unknown';
}

/** Prompt kinds whose answer is plain text; the others must be JSON that LBC's `parseJSON` can read. */
const TEXT_KINDS = new Set(['generateField', 'enhanceField', 'addMoreField', 'generateFieldText']);

/**
 * @param {string} kind from `classifyLbcPrompt`
 * @returns {boolean|null} null for an unknown prompt
 */
export function lbcExpectsJson(kind) {
    if (kind === 'unknown') return null;
    return !TEXT_KINDS.has(kind);
}

/**
 * LBC's lenient `parseJSON`: the whole text, else the outermost `{…}`, else `[…]` (an array becomes `{entries}`).
 * @param {string} text
 * @returns {any} the parsed value, or null
 */
export function lbcParseJson(text) {
    const attempt = (value) => {
        try {
            return { value: JSON.parse(value) };
        } catch {
            return null;
        }
    };
    const source = String(text ?? '');
    const whole = attempt(source);
    if (whole) return whole.value;
    const object = source.match(/\{[\s\S]*\}/);
    const fromObject = object && attempt(object[0]);
    if (fromObject) return fromObject.value;
    const array = source.match(/\[[\s\S]*\]/);
    const fromArray = array && attempt(array[0]);
    return fromArray ? { entries: fromArray.value } : null;
}

const isList = (value) => Array.isArray(value);
const isEntry = (value) => typeof value.content === 'string' || typeof value.comment === 'string';
/** What LBC reads out of the reply of each JSON prompt (the shape its prompt asks for). */
const REPLY_SHAPES = {
    simpleGenerate: (v) => isList(v.entries),
    advancedGenerate: (v) => isList(v.entries),
    expandEntries: (v) => isList(v.entries),
    expandSpecificCategory: (v) => isList(v.entries),
    lorebookFromLore: (v) => isList(v.entries),
    mergeLorebooks: (v) => isList(v.entries),
    generateSingleEntry: isEntry,
    generateFromParents: isEntry,
    regenerateEntry: isEntry,
    enhanceEntry: isEntry,
    autoCategorize: (v) => isList(v.assignments),
    mergeAnalyze: (v) => isList(v.pairs) || isList(v.notes),
    mergePair: (v) => isList(v.merged),
    optimizeKeys: (v) => isList(v.patches) || isList(v.duplicates) || isList(v.contradictions),
};

/**
 * Why LBC would get nothing out of a reply, or null when it is fine. A wrong shape matters as much as broken JSON:
 * LBC replaces the whole editor with the `entries` it found, so a reply without them wipes the book.
 * @param {string} kind from `classifyLbcPrompt`
 * @param {string} text
 * @returns {'empty'|'notJson'|'shape'|null}
 */
export function lbcReplyProblem(kind, text) {
    if (!String(text ?? '').trim()) return 'empty';
    if (!lbcExpectsJson(kind)) return null;
    const value = lbcParseJson(text);
    if (value === null || typeof value !== 'object') return 'notJson';
    const shape = REPLY_SHAPES[kind];
    return shape && !shape(value) ? 'shape' : null;
}

/**
 * The prompt without the `[OOC: … ]` wrapper, which only makes sense inside a roleplay chat.
 * @param {string} prompt
 */
export function unwrapLbcPrompt(prompt) {
    const text = String(prompt ?? '').trim();
    if (!text.startsWith('[OOC:')) return text;
    return text.slice('[OOC:'.length).replace(/\]\s*$/, '').trim();
}

/**
 * The entry fields of LBC's editor model (`normalizeEntry`). Everything else in a World Info entry is dropped by
 * LBC on load, so the module carries it over itself.
 */
export const LBC_ENTRY_FIELDS = Object.freeze([
    'key', 'keysecondary', 'comment', 'content', 'constant', 'selective', 'selectiveLogic', 'order', 'position',
    'depth', 'disable', 'probability', 'group', 'groupWeight', 'useGroupScoring', 'preventRecursion',
    'excludeRecursion', 'matchWholeWords', 'sticky', 'cooldown',
]);

/**
 * The entries of a World Info JSON in the order LBC's `parseLorebookEntries` reads them.
 * @param {any} json
 * @returns {any[]}
 */
export function lbcRawEntryList(json) {
    const source = json?.entries;
    if (!source || typeof source !== 'object') return [];
    const list = Array.isArray(source) ? source : Object.keys(source).map(key => source[key]);
    return list.filter(entry => entry && typeof entry === 'object');
}

/**
 * What LBC's editor holds for a World Info entry after loading it (`parseLorebookEntries` + `normalizeEntry`,
 * including their quirks: `parseInt(x) || default` turns 0 into the default, an empty comment may become `true`).
 * @param {any} raw
 */
export function normalizeLikeLbc(raw) {
    const int = (value) => parseInt(value, 10);
    let category = raw.category || '';
    if (!category) {
        const match = String(raw.comment || '').match(/—\s*(.+)$/);
        if (match) category = match[1].trim();
    }
    return {
        comment: (raw.comment || raw.addMemo || 'Untitled Entry') || 'Untitled Entry',
        key: Array.isArray(raw.key) ? raw.key : (typeof raw.key === 'string' ? raw.key.split(',').map(s => s.trim()) : []),
        keysecondary: Array.isArray(raw.keysecondary) ? raw.keysecondary : [],
        content: raw.content || '',
        category: category || 'Supplementary',
        constant: !!raw.constant,
        selective: !!raw.selective,
        order: int(raw.order !== undefined ? raw.order : raw.insertion_order) || 100,
        position: int(raw.position) || 0,
        depth: int(raw.depth) || 4,
        disable: !!raw.disable,
        probability: (raw.probability !== undefined && raw.probability !== null) ? (int(raw.probability) || 100) : 100,
        selectiveLogic: (raw.selectiveLogic !== undefined && raw.selectiveLogic !== null) ? int(raw.selectiveLogic) : 0,
        group: raw.group || '',
        groupWeight: int(raw.groupWeight) || 100,
        useGroupScoring: raw.useGroupScoring === true,
        preventRecursion: !!raw.preventRecursion,
        excludeRecursion: !!raw.excludeRecursion,
        matchWholeWords: (raw.matchWholeWords === true || raw.matchWholeWords === false) ? raw.matchWholeWords : null,
        sticky: int(raw.sticky) || 0,
        cooldown: (raw.cooldown !== undefined && raw.cooldown !== null) ? (int(raw.cooldown) || null) : null,
    };
}

/**
 * An entry's text as LBC exports it: the original when its own machine translation is shown.
 * @param {any} entry an LBC editor entry
 */
export function lbcEntryText(entry) {
    return {
        comment: entry._origComment || entry.comment || '',
        content: entry._origContent || entry.content || '',
    };
}

/** Whether LBC's panel is open (its `togglePanel` adds `lbc-open`). */
export function isLbcPanelOpen() {
    return $(LBC.selectors.panel).hasClass('lbc-open');
}

/**
 * Shows a message in LBC's status bar the way its own `showStatus` does.
 * @param {string} message
 * @param {'info'|'success'|'error'} [type]
 */
export function showLbcStatus(message, type = 'info') {
    const bar = $(LBC.selectors.status).text(message).attr('class', `lbc-status-bar ${type}`).show();
    setTimeout(() => bar.fadeOut(300), 4000);
}

/**
 * The public object of a running LBC, or null while it is not loaded (yet).
 * @param {any} [win]
 * @returns {{open: () => void, close: () => void, openWorld: (name: string) => Promise<void>, getData: () => any}|null}
 */
export function getLbcApi(win = globalThis) {
    const api = win?.[LBC.apiGlobal];
    return api && typeof api.getData === 'function' && typeof api.open === 'function' ? api : null;
}

/**
 * Whether LBC is waiting for one of its own generations right now.
 * @param {any} [win]
 */
export function isLbcGenerating(win = globalThis) {
    return win?.[LBC.generationFlag] === true;
}
