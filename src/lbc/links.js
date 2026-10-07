// Where the entries in LoreBook Creator's editor came from: the original World Info entry of each loaded entry
// (see book.js). Filled by the saving part, kept across reloads by the draft part.

/**
 * @typedef {import('./book.js').EntryLink} EntryLink
 * @type {WeakMap<object, EntryLink>}
 */
export const entryLinks = new WeakMap();
