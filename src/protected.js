// Pure helpers, no SillyTavern imports: this module is unit-tested in Node.
//
// Protected lorebooks are never localized: BunnyMo's own lorebook and its packs. Pack entries are keyed by BunnyMo
// tags (`<SPECIES:ELF>`, `<ENFJ-U>`) that BunnyMo and CarrotKernel match exactly as written, and the main BunnyMo
// book is patched at runtime by DES-RU; translated keys would only add false triggers. Books are recognized by their
// content, not by name: people rename the files.

/** Commands of BunnyMo's sheet entries (keys of the main book). */
const SHEET_COMMANDS = ['!fullsheet', '!quicksheet', '!tagsheet', '!memsheet', '!updatesheet', '!physheet'];
/** Titles of well-known entries of the main BunnyMo book. */
const CORE_COMMENT = /Master - |AUTO-TRIGGER:|AUTO-FILTRATION:|ANTI[\s-]*CLANKER|HawThorne Link/i;
/** A BunnyMo tag as a whole key: <SPECIES:ELF>, <DEPRESSION>, <ENFJ-U>. */
const TAG_KEY = /^<[A-Za-z][A-Za-z0-9_-]*(?::[^<>]+)?>$/;
/** BunnyMo's entry wrapper: <BunnymoTags:Title>…</BunnymoTags:Title> (character archives use <BunnymoTags> without a colon). */
const WRAPPED = /^<BunnymoTags:/i;
/** Entries that must look like BunnyMo before a book counts as one (fewer when the book itself is smaller). */
const MIN_ENTRIES = 3;
/** Share of keyed entries that are keyed by tags in a pack. */
const TAGGED_SHARE = 0.6;

function entryList(data) {
    const entries = data?.entries;
    if (Array.isArray(entries)) return entries;
    return entries && typeof entries === 'object' ? Object.values(entries) : [];
}

function keysOf(entry) {
    return [...(Array.isArray(entry?.key) ? entry.key : []), ...(Array.isArray(entry?.keysecondary) ? entry.keysecondary : [])]
        .map(key => String(key).trim())
        .filter(Boolean);
}

/**
 * Why a lorebook is protected: `bunnymo` (the main BunnyMo book), `bunnymo-pack` (tag-keyed or BunnyMo-wrapped
 * entries) or null when it may be localized.
 * @param {{entries?: object}|null|undefined} data lorebook data as `loadWorldInfo` returns it
 * @returns {'bunnymo'|'bunnymo-pack'|null}
 */
export function protectionReason(data) {
    const entries = entryList(data).filter(entry => entry && typeof entry === 'object');
    if (!entries.length) return null;
    let core = 0;
    let keyed = 0;
    let tagged = 0;
    let wrapped = 0;
    for (const entry of entries) {
        const keys = keysOf(entry);
        if (keys.some(key => SHEET_COMMANDS.includes(key.toLowerCase())) || CORE_COMMENT.test(String(entry.comment ?? ''))) core++;
        if (WRAPPED.test(String(entry.content ?? '').trimStart())) wrapped++;
        if (keys.length) {
            keyed++;
            if (keys.some(key => TAG_KEY.test(key))) tagged++;
        }
    }
    const enough = (count, of) => count > 0 && count >= Math.min(MIN_ENTRIES, of);
    if (core >= MIN_ENTRIES) return 'bunnymo';
    if (enough(wrapped, entries.length)) return 'bunnymo-pack';
    if (enough(tagged, keyed) && tagged / keyed >= TAGGED_SHARE) return 'bunnymo-pack';
    return null;
}

/**
 * @param {{entries?: object}|null|undefined} data
 */
export function isProtectedBookData(data) {
    return protectionReason(data) !== null;
}
