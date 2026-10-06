// Pure helper, no SillyTavern imports: unit-tested in Node.

/**
 * @typedef {'dialog'|'api'} JobOwner
 * @typedef {{running: boolean, by?: JobOwner}} BusyState
 */

/**
 * One localization at a time. `generateRawData` swaps the global response length through a single static slot,
 * and the dialog and the API share it, so jobs run strictly one after another: a job queued while another runs
 * starts when that one ends (whether it succeeded or failed). A job still waiting for its turn can be dropped
 * through its signal; a running job handles its signal itself.
 */
export function createExclusive() {
    /** @type {{by: JobOwner, started: boolean, start: () => void}[]} The head is the running job. */
    const queue = [];
    /** @type {Set<(state: BusyState) => void>} */
    const listeners = new Set();
    /** @type {BusyState} */
    let reported = { running: false };

    /** @returns {BusyState} */
    function state() {
        return queue.length ? { running: true, by: queue[0].by } : { running: false };
    }

    function notify() {
        const next = state();
        if (next.running === reported.running && next.by === reported.by) return;
        reported = next;
        for (const listener of [...listeners]) {
            // A listener started or dropped a job: the nested notify() has already told everybody the newer state.
            if (reported !== next) return;
            try {
                listener({ ...next });
            } catch (error) {
                console.error('[Lorebook Localizer] busy state listener failed', error);
            }
        }
    }

    return {
        /** A job is running or waiting. */
        get busy() {
            return queue.length > 0;
        },
        /** Who holds the lock now. Between two jobs it already names the next one, so there is no idle blink. */
        state,
        /**
         * @param {(state: BusyState) => void} listener called on every change of `state()`
         * @returns {() => void} unsubscribe
         */
        onChange(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        /**
         * @template T
         * @param {() => Promise<T>|T} job
         * @param {{by?: JobOwner, signal?: AbortSignal, onQueued?: () => void}} [options] `onQueued` is called at once
         *   when the job has to wait for another one; an abort while waiting rejects with the signal's reason
         * @returns {Promise<T>}
         */
        run(job, { by = 'api', signal, onQueued } = {}) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                const ticket = { by, started: false, start: () => {} };
                const onAbort = () => {
                    if (ticket.started) return;
                    const index = queue.indexOf(ticket);
                    if (index >= 0) queue.splice(index, 1);
                    notify();
                    reject(signal?.reason);
                };
                // The lock is released before the caller hears the result, so `state()` is already up to date then.
                const finish = () => {
                    queue.splice(queue.indexOf(ticket), 1);
                    const next = queue[0];
                    // Straight to the next job (no idle blink), or idle. A listener that starts a job on idle gets
                    // it started by run() itself, so it is never started twice.
                    if (next && !next.started) next.start();
                    else notify();
                };
                ticket.start = () => {
                    ticket.started = true;
                    signal?.removeEventListener('abort', onAbort);
                    notify();
                    Promise.resolve().then(job).then(
                        (value) => { finish(); resolve(value); },
                        (error) => { finish(); reject(error); },
                    );
                };
                queue.push(ticket);
                signal?.addEventListener('abort', onAbort, { once: true });
                if (queue.length === 1) {
                    ticket.start();
                } else {
                    try {
                        onQueued?.();
                    } catch (error) {
                        console.error('[Lorebook Localizer] onQueued failed', error);
                    }
                }
            });
        },
    };
}
