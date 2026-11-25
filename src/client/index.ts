/**
 * The client half's entry: one sidebar page, registered once (§8.1).
 *
 * The page is a `main` panel plus its row in `sidebar.panellist` — the only
 * destination the host's public contracts offer for a full page. Two
 * consequences of that choice are visible in the code below:
 *
 * - **The row is unconditional.** §8.1 asks for a standalone sidebar entry
 *   beside the host's Plugins page, not a settings-dialog section, so this row
 *   is simply there whenever the host declares the slot. A host that never
 *   declares `sidebar.panellist` simply
 *   never calls the registration, and the page goes missing quietly, which is
 *   the correct outcome for a host that has no sidebar.
 * - **Both registrations are disposed together.** A panel whose row is gone
 *   can still be selected by a stale `activePanelId`, and a selected key that
 *   no longer exists strands the main column on an empty page. Leaving the
 *   page first is what keeps a reload of the shell from painting a blank
 *   column (§8.1).
 *
 * Everything that can fail is contained: the module loader runs this factory
 * on the host's boot path, so a throw here would be a throw inside the shell.
 * The page is a guest and must never be able to take the app down with it.
 */

import { createElement as h, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import { createPageStore } from './page-store.ts'
import { createStoreClient } from './store-data.ts'
import { LocaleContext, localeOfSnapshot, pickLocale } from './copy.ts'
import { StorePage } from './StorePage.tsx'
import { StoreErrorBoundary } from './ErrorBoundary.tsx'
// The stylesheet is loaded for its SIDE EFFECT only: this entry point owns no
// class names, but the panel's sheet must be in the page even if every child
// module somehow failed to import it. (`import css` + `void css` was neither:
// the binding was never read, and the import is static, so a plain side-effect
// import says what is meant.)
import './Store.module.css'
/** The `main` panel key and the `sidebar.panellist` id this package owns. */
export const PANEL_ID = 'dsh-suite-store'

/**
 * Directly below the plugin-market row (order 1) and above Scheduled tasks
 * (10): a suite is a thing distributed through a market, so the two belong
 * together.
 */
export const PANEL_ORDER = 2

/** The absolute URL of the store's page, for the "forget me" console note. */
const ROUTE_PREFIX = '/dsh-suite-store'

/** What the host's client context offers, as much as this page uses. */
interface StoreClientContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  slots: {
    /** Run a contribution for each declaration lifetime of a slot. */
    inject(name: string, register: () => unknown): (() => void) | void
    register(options: Record<string, unknown>, render: (owner: unknown) => unknown): unknown
    /** Raw registrations for a key, used to confirm our row really landed. */
    entries?(name: string): { options?: Record<string, unknown> }[]
  }
  locale?: {
    /**
     * The host's current language.
     *
     * The shipped service answers `{ active, locales, revision }`; older or
     * partial shims have been seen answering a bare tag or `{locale}` /
     * `{language}`. All four shapes are read because the failure mode is
     * silent: an unread snapshot falls back to the browser, and a Chinese
     * desktop keeps showing Chinese after the user switches to English.
     */
    getSnapshot?: () => { active?: string; locale?: string; language?: string } | string
    /**
     * Notified on every language switch (and on dictionary registration).
     * Optional: without it the page can only read the language at mount.
     */
    subscribe?: (fn: () => void) => (() => void) | void
  }
}

/**
 * The host's language, when it publishes one this page can read.
 *
 * The shapes are enumerated in {@link localeOfSnapshot}; a host that
 * publishes none of them is not an error: the browser's own
 * `navigator.languages` is the next best answer, and it is the one that
 * matches what the rest of the UI does on a fresh install.
 */
function hostLocale(ctx: StoreClientContext): 'zh' | 'en' | undefined {
  try {
    // The MAPPING is inside the guard, not after it: a host snapshot is a
    // foreign object (a reactive proxy, or one with throwing getters), and this
    // runs during LocaleGate's render — above the panel's error boundary, where
    // a throw would take the shell's boot path with it.
    return localeOfSnapshot(ctx.locale?.getSnapshot?.())
  } catch {
    return undefined
  }
}

/** The browser's preference, when there is a browser to ask. */
function browserLocale(): 'zh' | 'en' {
  const languages = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? [navigator.language])]
  return pickLocale(languages)
}

/** The filter query the URL carries, so a reload lands on the same view. */
function queryFromLocation(): string {
  if (typeof window === 'undefined') return ''
  // A hash is used rather than history entries (§11④): the shell owns the
  // browser history, so pushing entries here would make Back leave the store
  // instead of undoing a filter.
  return window.location.hash === '' ? window.location.search.replace(/^\?/, '') : window.location.hash.slice(1)
}

/**
 * The retry schedule for the deferred mount pass.
 *
 * Now, then a few animation frames, then a slow host's pace. `retry` caps the
 * loop at 20 attempts, so the last wait is about 1.7 s. Extracted because the
 * nested `?:` chain that used to express this hid the schedule behind two
 * conditionals in one expression.
 *
 * @param attempt - 0-based retry index.
 * @returns milliseconds to wait before this pass.
 */
function delayFor(attempt: number): number {
  if (attempt === 0) return 0
  return attempt < 5 ? 16 : 100
}

export const name = 'dsh-suite-store'
// The dependency set is load-bearing, not cosmetic. Client fibers activate in
// module-graph order, and a fiber that names only `slots` activates before the
// sidebar has declared `sidebar.panellist`; by then its `inject` waiter can
// already have been resolved as "never fires" (the host documents inject as
// "fires synchronously ... or never"). Requiring the full set of services
// places this page after those fibers in the activation order. `locale` is read
// through the host's service here; `theme` is only an ordering dependency,
// never dereferenced.
export const inject = ['slots', 'locale', 'theme']

/**
 * Register the page.
 *
 * @param ctx - the host's client context.
 */
export function apply(ctx: StoreClientContext): void {
  report('apply entered')
  try {
    mount(ctx)
    report('mounted')
  } catch (error) {
    // A throw here would land inside the shell's own bootstrap. The store
    // goes missing for this session and says where it happened; everything
    // else in the app is untouched.
    report(`mounting failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error(
      '[dsh-suite-store] mounting failed, so the store page is missing for this session. '
      + 'The rest of the app is unaffected. Open ' + ROUTE_PREFIX + ' in the host to report it, with this error:',
      error,
    )
  }
}

/**
 * Tell the server how far this page's client half got.
 *
 * A desktop host offers no console, so a client plugin that never mounts is
 * undiagnosable from the outside: the server routes keep working (they are
 * the host half) while the page stays missing. `/api/capabilities` echoes the
 * last report, so `curl` can answer "did apply() run, and did it throw".
 *
 * Best-effort and fire-and-forget on purpose: telemetry must never be the
 * reason a page fails to mount.
 */
function report(note: string): void {
  try {
    void fetch(`${ROUTE_PREFIX}/api/client-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note }),
    }).catch(() => undefined)
  } catch {
    // A host without fetch, or one that refuses the POST, must not matter.
  }
}

/**
 * The registrations, split out only so {@link apply} can contain a throw.
 *
 * Both registrations are deferred. `main` and `sidebar.panellist` are child
 * slots declared by `root`, which `dsh-client-ui-layout` registers in its own
 * `apply()`. Our fiber activates earlier in the module graph; registering at
 * that moment throws "slot main is not declared" and aborts the mount — the
 * cold-boot failure a desktop host could only reveal through the self-report.
 * The fix is to defer registration and refresh on the next tick.
 */
function mount(ctx: StoreClientContext): void {
  const store = createPageStore(createStoreClient())
  /**
   * The language the page draws in.
   *
   * Resolved at mount and then kept live by {@link LocaleGate}: the host's
   * slot callback runs once, so a value read only here would freeze the page
   * in whatever language it was opened in — which is what happened when the
   * host switched to English with the page already mounted.
   */
  const readLocale = (): 'zh' | 'en' => hostLocale(ctx) ?? browserLocale()

  const render = (): ReactNode =>
    h(LocaleGate, {
      ctx,
      initial: readLocale(),
      children: (locale: 'zh' | 'en') =>
        h(
          LocaleContext.Provider,
          { value: locale },
          h(
            StoreErrorBoundary,
            { locale },
            h(StorePage, { store, locale, initialQuery: queryFromLocation() }),
          ),
        ),
    })

  const rowOptions = {
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    // The display name, in both languages. It matches pageTitle and the
    // package's locale/meta.title on purpose: three strings for one plugin is
    // how it ends up with three names.
    label: (): string => (readLocale() === 'zh' ? '插件整合包商店' : 'Plugin Suite Store'),
    locale: 'dsh-suite-store',
  }
  const glyph = (): ReactNode => h(StoreGlyph)

  let offPanel: (() => void) | void
  let offRow: (() => void) | void
  let panelSettled = false
  let rowSettled = false
  let retired = false

  const keyed = (name: string, key: string): boolean =>
    (ctx.slots.entries?.(name) ?? []).some((entry) => entry.options?.key === key)
  const rowLanded = (): boolean => {
    const entries = ctx.slots.entries?.('sidebar.panellist')
    if (entries === undefined) return typeof offRow === 'function'
    return entries.some((entry) => entry.options?.id === PANEL_ID)
  }

  /** One pass: register anything missing, then verify both landed. */
  const pass = (): void => {
    if (retired) return
    if (!panelSettled) {
      if (typeof offPanel === 'function') offPanel()
      offPanel = undefined
      if (keyed('main', PANEL_ID)) {
        panelSettled = true
      } else {
        try {
          offPanel = ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: 'dsh-suite-store' },
            render,
          ) as (() => void) | void
          // A registry the host does not expose cannot be inspected, so a
          // successful `register` IS the settled answer. Without this the
          // panel was disposed and re-registered on every retry pass — which
          // reset the live UI (a typed search, the scroll position) 20 times.
          panelSettled = ctx.slots.entries === undefined || keyed('main', PANEL_ID)
        } catch {
          // `root` has not declared `main` yet. The next pass will try again.
        }
      }
    }
    if (!rowSettled) {
      if (rowLanded()) {
        rowSettled = true
      } else {
        if (typeof offRow === 'function') offRow()
        offRow = undefined
        try {
          offRow = ctx.slots.register(rowOptions, glyph) as (() => void) | void
          // The row's twin of the panel rule above: on a host with no
          // `entries`, `rowLanded()` falls back to "did register give me a
          // disposer", which is false for a host that returns nothing — so the
          // row churned even when the panel had already settled.
          rowSettled = ctx.slots.entries === undefined || rowLanded()
        } catch {
          // The parent has not declared the slot yet; retry below.
        }
      }
    }
    report(`pass: panel=${panelSettled} row=${rowSettled}`)
  }

  // Defer past the whole synchronous apply pass so `root` (and therefore
  // `main` and `sidebar.panellist`) is declared. A bounded retry covers a
  // host whose declaration arrives even later; each pass drops its previous
  // registration first, so no host ever ends up with a twin panel or row.
  const retry = (attempt: number): void => {
    if (retired || (panelSettled && rowSettled) || attempt > 20) return
    setTimeout(() => {
      if (retired) return
      try {
        pass()
      } catch (error) {
        // A slot registry that throws — or an entry with a throwing getter —
        // must not escape into the host's timer callback, and must not break
        // the retry chain below: the page can still settle on a later pass.
        report(`pass threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      retry(attempt + 1)
    }, delayFor(attempt))
  }
  retry(0)

  // Language changes are handled by LocaleGate, which subscribes to the host's
  // own snapshot. The old `locale/changed` listener here never fired: the
  // shipped service emits `locale/change` (singular) and, more importantly, a
  // React tree that already mounted cannot be re-rendered by mutating a
  // closure variable.

  ctx.effect(() => () => {
    retired = true
    if (typeof offRow === 'function') offRow()
    if (typeof offPanel === 'function') offPanel()
  }, 'dsh-suite-store: sidebar page')
}

/**
 * Re-renders its child whenever the host's language changes.
 *
 * A subscription rather than a prop: the host calls a slot's render callback
 * once, so a `locale` captured at mount is a language the page can never
 * leave. `useSyncExternalStore` reads the host's own snapshot each render,
 * which also means a dictionary registered late is picked up without this
 * page knowing when registration happened.
 *
 * A host with no `subscribe` (or no locale service at all) simply keeps
 * `initial`, which is the browser-derived answer.
 *
 * @param props.ctx - the client context, for the host's locale service.
 * @param props.initial - the language already resolved before mounting.
 * @param props.children - rendered with the current language.
 */
function LocaleGate(props: {
  ctx: StoreClientContext
  initial: 'zh' | 'en'
  children: (locale: 'zh' | 'en') => ReactNode
}): ReactNode {
  const service = props.ctx.locale
  const locale = useSyncExternalStore(
    (onChange) => {
      if (typeof service?.subscribe !== 'function') return () => undefined
      const off = service.subscribe(onChange)
      return typeof off === 'function' ? off : () => undefined
    },
    () => hostLocale(props.ctx) ?? props.initial,
    () => props.initial,
  )
  return props.children(locale)
}

/**
 * The row's glyph: three stacked panes, the smallest drawing that reads as
 * "a set of things" at 16px. Inline SVG rather than an icon dependency,
 * because a missing glyph must never be the reason the row is blank.
 */
function StoreGlyph(): ReactNode {
  return h(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('rect', { x: 2.5, y: 2.5, width: 11, height: 3.4, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('rect', { x: 2.5, y: 6.9, width: 11, height: 3.4, rx: 1, stroke: 'currentColor', strokeWidth: 1.2 }),
    h('rect', { x: 2.5, y: 11.3, width: 6.6, height: 2.2, rx: 1, fill: 'currentColor', opacity: 0.55 }),
  )
}
