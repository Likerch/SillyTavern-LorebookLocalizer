// Pure helper, no SillyTavern imports: unit-tested in Node.

/**
 * One localization at a time. `generateRawData` swaps the global response length through a single static slot,
 * and the dialog and the API share it, so jobs run strictly one after another: a job queued while another runs
 * starts when that one ends (whether it succeeded or failed).
 */
export function createExclusive() {
    let tail = Promise.resolve();
    let pending = 0;
    return {
        /** A job is running or waiting. */
        get busy() {
            return pending > 0;
        },
        /**
         * @template T
         * @param {() => Promise<T>|T} job
         * @returns {Promise<T>}
         */
        run(job) {
            pending++;
            const result = tail.then(() => job());
            const done = () => { pending--; };
            tail = result.then(done, done);
            return result;
        },
    };
}
