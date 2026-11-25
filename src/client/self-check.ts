/**
 * The browser half of the exported log.
 *
 * The server can say what the store DID. It cannot say what the page looked
 * like, and the failures that are hardest to reproduce live exactly there: a
 * panel that rendered nothing, a client bundle mounted twice, a browser
 * translation that replaced React's text nodes. Asking a non-developer to open
 * a console and paste an expression costs a day per question, and it is the one
 * step where a report goes quiet.
 *
 * So the browser answers, in the artefact people already know how to produce.
 * Everything here is a FACT the reporter can hand over without judging it:
 * "portal containers: 2" is useful; "your bundle is double-loaded" would be a
 * guess printed in someone's face, and wrong the first time a host legitimately
 * renders two stores.
 */

/** Where the browser-side counters live; `window` so a second copy sees them. */
interface SelfCheckGlobals {
  __dshSuiteStoreLoads?: number
  __dshSuiteStoreCrash?: { message: string; stack: string | null; at: string }
}

const globals = globalThis as typeof globalThis & SelfCheckGlobals

/**
 * Count this module's evaluation.
 *
 * Module scope runs once per module instance, so a value above 1 means the
 * client bundle was loaded twice — two React copies, two of every module
 * singleton, two portals. Counted on `window` rather than in a module
 * variable for the obvious reason: a module variable would be duplicated along
 * with everything else, and each copy would confidently report 1.
 */
globals.__dshSuiteStoreLoads = (globals.__dshSuiteStoreLoads ?? 0) + 1

/**
 * How many times this module has been evaluated in this page.
 *
 * @returns the count; 1 on a normal page.
 */
export function loadCount(): number {
  return globals.__dshSuiteStoreLoads ?? 0
}

/**
 * Record a crash the error boundary caught.
 *
 * Module/global scope rather than component state: the export runs outside the
 * crashed tree, and a crash the reader has already dismissed is still the most
 * useful line in their report.
 *
 * @param message - the thrown message.
 * @param stack - component stack or JS stack, when available.
 * @param at - ISO timestamp.
 */
export function recordCrash(message: string, stack: string | null, at: string): void {
  globals.__dshSuiteStoreCrash = { message, stack, at }
}

/**
 * Forget the recorded state, and restart the load count at 1.
 *
 * For tests, and for a fresh mount: the count answers "how many copies of this
 * module are alive in this page", so the reset value is 1 (this one), not 0 —
 * 0 would report a page that has no client bundle at all.
 */
export function resetSelfCheck(): void {
  globals.__dshSuiteStoreLoads = 1
  delete globals.__dshSuiteStoreCrash
}

/** Whether this is a browser worth inspecting. */
function hasDom(): boolean {
  return typeof document !== 'undefined' && document.body !== null
}

/**
 * Text the browser leaves on `<html>` when a page is translated.
 *
 * Chrome and Edge both add a `translated-*` class for the direction they
 * rendered into; Edge also tags the document it worked on. Reported verbatim
 * rather than reduced to a boolean, because which engine did it is the next
 * question after "was it translated at all".
 *
 * @returns the marks found, or null when there are none.
 */
function translatedMarks(): string | null {
  const root = document.documentElement
  const marks = [
    ...[...root.classList].filter((name) => name.startsWith('translated')),
    ...(root.hasAttribute('_msthash') ? ['edge (_msthash)'] : []),
    ...(root.hasAttribute('_msttexthash') ? ['edge (_msttexthash)'] : []),
  ]
  return marks.length === 0 ? null : marks.join(', ')
}

/** The crash the error boundary caught, as export lines. */
function crashLines(): string[] {
  const crash = globals.__dshSuiteStoreCrash
  if (crash === undefined) return []
  return [
    `market UI crashed at: ${crash.at}`,
    `market crash message: ${crash.message}`,
    ...(crash.stack === null ? [] : [`market crash component stack:${crash.stack}`]),
  ]
}

/**
 * The browser-side section of the exported log.
 *
 * Deliberately facts, not verdicts. Each line answers a question that has had
 * to be asked by hand at least once: "blank" can mean the section never
 * mounted or mounted and rendered nothing, and those have different causes; a
 * container that is not body's last child sits under whatever was appended
 * after it, which is one way a button is visible and unclickable.
 *
 * @returns the lines to append, or an empty array outside a browser.
 */
export function clientDiagnostics(): string[] {
  // The crash section is NOT DOM-dependent: a boundary that caught a throw is
  // the single most useful line in a report, and a test process (or a very
  // early crash before `body` exists) still has it.
  if (!hasDom()) return crashLines()
  const roots = document.querySelectorAll('[data-dsh-suite-store-root]')
  return [
    // Reported always, so a normal page proves the number is being read
    // rather than defaulting.
    `client bundle evaluations: ${String(loadCount())}`,
    `market roots in the document: ${String(roots.length)}`,
    // The mount point every request is resolved against: a surprising value
    // here explains a whole class of "nothing loads".
    `document baseURI: ${document.baseURI}`,
    `page URL: ${location.origin}${location.pathname}`,
    // A translated page is not a fault by itself; it IS the reported cause of
    // a blank panel once, and the browser marks the document when it does it.
    `page translated by the browser: ${translatedMarks() ?? 'no'}`,
    // A crash is the one line that already IS a diagnosis, so it comes after
    // the DOM facts and before the user agent.
    ...crashLines(),
    `user agent: ${navigator.userAgent}`,
  ]
}

/**
 * Download the exported log: the server's account plus what only the browser
 * can see.
 *
 * A free function rather than a hook, because the error boundary has to offer
 * it too — a crashed panel is exactly when the log matters, and it is exactly
 * when the button used to be missing.
 *
 * @param url - the export route, already resolved against the page.
 * @throws when the server half cannot be fetched; callers show their own state.
 */
export async function exportMarketLog(url: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const serverText = await response.text()
  const browser = clientDiagnostics()
  const blob = new Blob(
    [serverText, ...(browser.length === 0 ? [] : ['## browser\n', browser.join('\n'), '\n'])],
    { type: 'text/plain;charset=utf-8' },
  )
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = 'dsh-suite-store-log.txt'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(href)
}
