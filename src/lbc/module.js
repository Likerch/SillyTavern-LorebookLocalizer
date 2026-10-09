// The LoreBook Creator module: finds LBC, then starts and stops the parts that give it Russian support.
// Every part registers its hooks in its own scope, so switching it (or the whole module) off restores stock LBC.
import { EXTENSION_TITLE } from '../constants.js';
import { getSettings } from '../settings.js';
import { getLbcApi, LBC } from './adapter.js';
import { channelPart } from './channel.js';
import { compatibility, findLbcExtension, thirdPartyNames } from './compat.js';
import { draftPart } from './draft.js';
import { expandPart } from './expand.js';
import { interfacePart } from './interface.js';
import { keysPart } from './keys-ui.js';
import { languagePart } from './language-ui.js';
import { savingPart } from './saving.js';
import { createScope } from './scope.js';

/** LBC exposes its API at the end of an async start; this is how long we wait for it after SillyTavern is ready. */
const API_WAIT_MS = 60_000;
const API_POLL_MS = 500;

/**
 * @typedef {import('./scope.js').Scope} Scope
 * @typedef {import('./compat.js').LbcCompatibility} LbcCompatibility
 *
 * @typedef {object} LbcStatus
 * @property {'searching'|'missing'|'failed'|'ready'} state `failed`: installed, but its API never appeared
 * @property {string} [name] internal extension name, e.g. `third-party/lorebook-creator`
 * @property {string} [version]
 * @property {LbcCompatibility} [compat]
 * @property {boolean} active the module runs (LBC found and the module switched on)
 * @property {boolean} domParts parts that rely on LBC's markup and texts may run
 *
 * @typedef {object} LbcDeps what the rest of the extension lends the module
 * @property {ReturnType<import('../exclusive.js').createExclusive>} [exclusive] one Localizer job at a time
 *
 * @typedef {object} LbcEnv
 * @property {LbcStatus} status
 * @property {LbcDeps} deps
 * @property {() => ReturnType<typeof getLbcApi>} api
 * @property {(...args: any[]) => void} log
 *
 * @typedef {object} LbcPart
 * @property {string} id
 * @property {string} setting the boolean setting that switches the part on
 * @property {boolean} [needsDom] relies on LBC's markup or texts: off on an untested version unless allowed
 * @property {(scope: Scope, env: LbcEnv) => void} start
 */

/**
 * @type {LbcPart[]} The parts, in start order: the draft is put back after saving starts tracking entries; "Expand the
 * world" writes through saving.
 */
const PARTS = [channelPart, languagePart, savingPart, draftPart, keysPart, expandPart, interfacePart];

/** @type {Omit<LbcStatus, 'active'|'domParts'>} */
let found = { state: 'searching' };
/** @type {Scope|null} */
let root = null;
/** @type {Map<string, Scope>} */
const running = new Map();
/** @type {Set<(status: LbcStatus) => void>} */
const listeners = new Set();
let started = false;
/** @type {LbcDeps} */
let deps = {};

const log = (...args) => console.debug(`[${EXTENSION_TITLE}] LBC:`, ...args);

/** @returns {LbcStatus} */
export function getLbcStatus() {
    const settings = getSettings();
    return {
        ...found,
        active: Boolean(root),
        domParts: Boolean(root) && (found.compat === 'tested' || settings.lbcAllowUntested),
    };
}

/**
 * @param {(status: LbcStatus) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onLbcStatusChange(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function notify() {
    const status = getLbcStatus();
    for (const listener of [...listeners]) {
        try {
            listener(status);
        } catch (error) {
            console.error(`[${EXTENSION_TITLE}] LBC status listener failed`, error);
        }
    }
}

/**
 * Looks for LBC once SillyTavern has loaded every extension. Safe to call more than once.
 * @param {LbcDeps} [lent]
 */
export function startLbcModule(lent = {}) {
    if (started) return;
    started = true;
    deps = lent;
    const { eventSource, eventTypes } = SillyTavern.getContext();
    // APP_READY fires for late listeners too, and by then every enabled extension has its <script> in the page.
    eventSource.once(eventTypes.APP_READY, () => {
        detect().then(result => {
            found = result;
            log('detected', result);
            applySettings();
        }, error => {
            console.error(`[${EXTENSION_TITLE}] LoreBook Creator detection failed`, error);
            found = { state: 'missing' };
            notify();
        });
    });
}

/** @returns {Promise<Omit<LbcStatus, 'active'|'domParts'>>} */
async function detect() {
    const ctx = SillyTavern.getContext();
    const sources = [...document.querySelectorAll('script[src]')].map(script => script.getAttribute('src') ?? '');
    const extension = findLbcExtension(thirdPartyNames(sources), name => ctx.getExtensionManifest(name));
    if (!extension) return { state: 'missing' };

    const version = String(extension.manifest.version ?? '');
    const info = { name: extension.name, version, compat: compatibility(version) };
    const deadline = Date.now() + API_WAIT_MS;
    while (!getLbcApi() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, API_POLL_MS));
    }
    return { state: getLbcApi() ? 'ready' : 'failed', ...info };
}

/** Brings the running parts in line with the settings. Called after detection and on every settings change. */
export function applySettings() {
    const settings = getSettings();
    const wanted = found.state === 'ready' && settings.lbcEnabled;
    if (!wanted) {
        if (root) {
            root.close();
            root = null;
            running.clear();
            log('stopped');
        }
        notify();
        return;
    }

    if (!root) {
        root = createScope();
        log('started', found.version, found.compat);
    }
    const status = getLbcStatus();
    /** @type {LbcEnv} */
    const env = { status, deps, api: () => getLbcApi(), log };
    for (const part of PARTS) {
        const on = Boolean(settings[part.setting]) && (!part.needsDom || status.domParts);
        const scope = running.get(part.id);
        if (on && !scope) {
            const own = root.child();
            running.set(part.id, own);
            try {
                part.start(own, env);
            } catch (error) {
                console.error(`[${EXTENSION_TITLE}] LBC part "${part.id}" failed to start`, error);
                own.close();
                running.delete(part.id);
            }
        } else if (!on && scope) {
            scope.close();
            running.delete(part.id);
        }
    }
    notify();
}

/** For the settings panel: the folder LBC is installed in. */
export function lbcFolder() {
    return found.name?.replace(/^third-party\//, '') ?? LBC.defaultFolder;
}
