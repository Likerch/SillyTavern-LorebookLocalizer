// Finding LoreBook Creator among the installed extensions and judging its version. Pure helpers, unit-tested in Node.
import { LBC } from './adapter.js';

/**
 * @param {unknown} version
 * @returns {number[]|null} `[major, minor, patch]`
 */
export function parseVersion(version) {
    const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version ?? ''));
    if (!match) return null;
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} negative, 0 or positive
 */
export function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff) return diff;
    }
    return 0;
}

/**
 * Extension folders from the module scripts SillyTavern added (`/scripts/extensions/third-party/<folder>/<file>`).
 * @param {Iterable<string>} sources script `src` attributes or URLs
 * @returns {string[]} internal names, e.g. `third-party/lorebook-creator`
 */
export function thirdPartyNames(sources) {
    const names = new Set();
    for (const source of sources) {
        const match = /(?:^|\/)scripts\/extensions\/(third-party\/[^/]+)\//.exec(String(source ?? ''));
        if (match) names.add(decodeURIComponent(match[1]));
    }
    return [...names];
}

/**
 * Whether a manifest is LoreBook Creator's.
 * @param {any} manifest
 */
export function isLbcManifest(manifest) {
    const fold = (value) => String(value ?? '').trim().toLowerCase();
    return fold(manifest?.display_name) === fold(LBC.displayName) || fold(manifest?.author) === fold(LBC.author);
}

/**
 * Finds LBC among the loaded extensions. The official folder name is tried first.
 * @param {string[]} names internal extension names
 * @param {(name: string) => any} getManifest SillyTavern's `getExtensionManifest`
 * @returns {{name: string, manifest: any}|null}
 */
export function findLbcExtension(names, getManifest) {
    const preferred = `third-party/${LBC.defaultFolder}`;
    const ordered = [preferred, ...names.filter(name => name !== preferred)];
    for (const name of ordered) {
        let manifest = null;
        try {
            manifest = getManifest(name);
        } catch {
            // An unknown name: try the next one.
        }
        if (manifest && isLbcManifest(manifest)) return { name, manifest };
    }
    return null;
}

/**
 * @typedef {'tested'|'newer'|'older'|'unknown'} LbcCompatibility
 *
 * @param {unknown} version the manifest version
 * @param {readonly string[]} [tested]
 * @returns {LbcCompatibility}
 */
export function compatibility(version, tested = LBC.testedVersions) {
    const parsed = parseVersion(version);
    if (!parsed) return 'unknown';
    const known = tested.map(parseVersion).filter(Boolean);
    if (known.some(v => compareVersions(v, parsed) === 0)) return 'tested';
    if (!known.length) return 'unknown';
    const newest = known.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    return compareVersions(parsed, newest) > 0 ? 'newer' : 'older';
}
