// Pure helper, no SillyTavern imports: unit-tested in Node.

/**
 * @typedef {object} Scope
 * @property {(dispose: () => void) => void} add registers a cleanup; added to a closed scope, it runs at once
 * @property {(source: {on: Function, removeListener: Function}, event: string, listener: Function) => void} on
 * @property {(source: {makeLast: Function, removeListener: Function}, event: string, listener: Function) => void} onLast
 * @property {() => Scope} child a nested scope that is closed with this one (or earlier on its own)
 * @property {() => void} close runs every cleanup in reverse order; a second call does nothing
 * @property {boolean} closed
 */

/**
 * Everything a part of the module hooks into (event listeners, observers, patched functions) is registered in a
 * scope, so switching the part off undoes all of it and leaves LoreBook Creator as it was.
 * @param {(error: unknown) => void} [onError] a failing cleanup is reported and the others still run
 * @returns {Scope}
 */
export function createScope(onError = (error) => console.error('[Lorebook Localizer] cleanup failed', error)) {
    /** @type {(() => void)[]} */
    let disposers = [];
    let closed = false;

    const scope = {
        get closed() {
            return closed;
        },
        add(dispose) {
            if (closed) {
                runSafely(dispose);
                return;
            }
            disposers.push(dispose);
        },
        on(source, event, listener) {
            source.on(event, listener);
            scope.add(() => source.removeListener(event, listener));
        },
        onLast(source, event, listener) {
            source.makeLast(event, listener);
            scope.add(() => source.removeListener(event, listener));
        },
        child() {
            const nested = createScope(onError);
            const closeNested = nested.close;
            const dispose = () => closeNested();
            scope.add(dispose);
            // Closed on its own (a part switched off): the parent forgets it instead of keeping it until the end.
            nested.close = () => {
                disposers = disposers.filter(item => item !== dispose);
                closeNested();
            };
            return nested;
        },
        close() {
            if (closed) return;
            closed = true;
            const list = disposers;
            disposers = [];
            for (const dispose of list.reverse()) runSafely(dispose);
        },
    };

    /** @param {() => void} dispose */
    function runSafely(dispose) {
        try {
            dispose();
        } catch (error) {
            onError(error);
        }
    }

    return scope;
}
