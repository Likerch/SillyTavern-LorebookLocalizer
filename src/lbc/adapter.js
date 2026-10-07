// Everything the extension knows about LoreBook Creator (https://github.com/virgilianshailer/lorebook-creator) lives in
// this file: names, globals, DOM selectors. LBC is one closed ES module, so these are the only handles on it; a new
// LBC version that renames one of them breaks only this map. Pure data and accessors, no SillyTavern imports.
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
    }),
});

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
