/**
 * Request-scoped "probe" suppression, for code that replays work to inspect it.
 *
 * A route that only LOOKS at state sometimes has to run the same validation an
 * operation would. That replay must not leave a trace: no log lines, no writes,
 * no side effects a later reader would mistake for something that happened.
 *
 * `AsyncLocalStorage` rather than a module-level boolean, because a boolean is
 * not request-scoped: it would also silence the concurrent status reads and
 * installs that have nothing to do with the probe, for as long as the probe
 * waits.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<true>()

/** Whether the current async call chain is a probe. */
export function inProbe(): boolean {
  return storage.getStore() === true
}

/**
 * Run one operation with probe-only side effects suppressed.
 *
 * @param operation - the work to run; its async continuations inherit the flag.
 * @returns whatever the operation returns.
 */
export function runInProbe<T>(operation: () => T): T {
  return storage.run(true, operation)
}
