// One wrapper around window.fetch for the whole module. Handlers decide per request whether to answer it themselves;
// everything else goes to the fetch that was there before. No SillyTavern imports: unit-tested in Node.

/**
 * @typedef {(request: {url: string, init: RequestInit|undefined}, next: (init?: RequestInit) => Promise<Response>) => Promise<Response>|null} FetchHandler
 * A handler returns null to let the request through untouched, or a promise of the response. `next(init)` sends the
 * request on (with changed options if given).
 */

/** @type {Set<FetchHandler>} */
const handlers = new Set();
/** @type {{fn: typeof fetch, original: typeof fetch, active: boolean}|null} */
let installed = null;

/**
 * @param {RequestInfo|URL} input
 * @returns {string} the path of a same-origin URL, the URL as is otherwise
 */
export function requestPath(input) {
    const raw = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url ?? '');
    try {
        const base = globalThis.location?.origin ?? 'http://localhost';
        const url = new URL(raw, base);
        return url.origin === base ? url.pathname : url.href;
    } catch {
        return String(raw);
    }
}

/**
 * Adds a handler; the first one installs the wrapper.
 * @param {FetchHandler} handler
 * @param {any} [target] the object that owns `fetch` (tests pass a fake one)
 * @returns {() => void} removes the handler; the last one takes the wrapper off if nothing wrapped it since
 */
export function addFetchHandler(handler, target = globalThis) {
    handlers.add(handler);
    if (!installed) install(target);
    return () => {
        handlers.delete(handler);
        if (!handlers.size) uninstall(target);
    };
}

/** @param {any} target */
function install(target) {
    const previous = target.fetch;
    /** @type {{fn: typeof fetch, original: typeof fetch, active: boolean}} */
    const own = { fn: previous, original: previous, active: true };
    own.fn = async function (input, init) {
        const next = (changed = init) => previous.call(this ?? target, input, changed);
        if (own.active && handlers.size) {
            const request = { url: requestPath(input), init };
            for (const handler of [...handlers]) {
                const answer = handler(request, next);
                if (answer) return answer;
            }
        }
        return next();
    };
    target.fetch = own.fn;
    installed = own;
}

/** @param {any} target */
function uninstall(target) {
    if (!installed) return;
    // Another extension may have wrapped fetch after us: then our wrapper stays in its chain, inactive, and only
    // passes requests on (a later install wraps on top and never runs the handlers twice).
    installed.active = false;
    if (target.fetch === installed.fn) target.fetch = installed.original;
    installed = null;
}
