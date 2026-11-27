/**
 * The store section: one page, and the wiring that keeps it alive (§8).
 *
 * Three things happen here and nowhere else:
 *
 * - **The query lives in the URL.** A filter, a sort and a search term are
 *   the kind of state a user sends to a colleague, and the host renders this
 *   page inside a shell whose URL is the only thing a reload preserves. A
 *   hash is used rather than history entries (§11④) because the shell owns
 *   the browser history: pushing entries from inside it would make the back
 *   button leave the store instead of undoing a filter.
 * - **Pagination is client-side.** The catalog arrives in one answer and the
 *   page draws it 24 at a time (§8.1). The sentinel below the grid appends
 *   the next page when it scrolls into view, and the button does the same for
 *   people who never scroll past it — neither one is the only way, because
 *   an IntersectionObserver that never fires (a short list, a hidden pane)
 *   would otherwise strand the rest of the catalog.
 * - **The progress stream is followed for the page's whole life.** Not while
 *   a dialog is open: an install started in one tab is visible in another,
 *   and the server has one operation at a time to describe.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import type { FilterOptions, SortMode } from '../catalog/types.ts'
import type { UninstallChoice } from '../install/uninstall.ts'
import type { MemberStateView } from '../server/routes.ts'
import {
  STORE_REPOSITORY_URL,
  categoryCounts,
  inView,
  isLiveStatus,
  orderChipsByCount,
  orderTabsByCount,
  pluginIdentity,
  pluginVersionLabel,
  progressOf,
} from './store-data.ts'
import type { StoreView } from './store-data.ts'
import { api } from './store-data.ts'
import { exportMarketLog } from './self-check.ts'
import type { PageStore } from './page-store.ts'
import { installedFrom, parseQuery, queryOf } from './page-store.ts'
import { selectBundles } from '../catalog/types.ts'
import { fill, t as copy } from './copy.ts'
import type { CopyKey, Locale } from './copy.ts'
import { Button, Icon, Input } from './ui.tsx'
import { BundleCardView, primaryLabel, secondaryLabel } from './Card.tsx'
import { DetailsDialog } from './Details.tsx'
import { SubmissionDialog } from './SubmissionDialog.tsx'
import { ProgressPanel } from './ProgressPanel.tsx'
import css from './Store.module.css'

/** Props of the page. */
export interface StorePageProps {
  store: PageStore
  locale: Locale
  /** The query string to start from, usually the URL's. */
  initialQuery: string
}

/** How many cards one page of the masonry holds (§8.1). */
const PAGE_SIZE = 24

/** Each view's label, keyed so the tab row can draw it. */
const VIEW_COPY = {
  discover: 'viewDiscover',
  installed: 'viewInstalled',
  enhance: 'viewEnhance',
} as const satisfies Record<StoreView, CopyKey>

/** Sort orders, in the order the select draws them. */
const SORTS: readonly { mode: SortMode; key: 'sortRecommended' | 'sortUpdated' | 'sortMembers' | 'sortHottest' }[] = [
  { mode: 'recommended', key: 'sortRecommended' },
  { mode: 'updated', key: 'sortUpdated' },
  { mode: 'members', key: 'sortMembers' },
  { mode: 'hottest', key: 'sortHottest' },
]

/**
 * §8.4's update-range filter, as the four choices the page offers.
 *
 * `undefined` is "any time" and is the absence of the option rather than a
 * value: sending 0 would be a range that keeps nothing, and the server reads
 * a missing key as no range at all.
 */
const UPDATED_RANGES: readonly { days: number | undefined; key: 'updatedAny' | 'updated7' | 'updated30' | 'updated90' }[] = [
  { days: undefined, key: 'updatedAny' },
  { days: 7, key: 'updated7' },
  { days: 30, key: 'updated30' },
  { days: 90, key: 'updated90' },
]

/**
 * The store page.
 *
 * @param props - see {@link StorePageProps}.
 * @returns the page.
 */
export function StorePage({ store, locale, initialQuery }: StorePageProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const [query, setQuery] = useState(initialQuery)
  const [filters, setFilters] = useState<FilterOptions>(() => parseQuery(initialQuery))
  /**
   * Which of the three lists the page is showing.
   *
   * Deliberately NOT part of `filters`: whether a bundle is installed is this
   * machine's fact, so it can neither be sent to the server nor round-trip
   * through the URL the way a category does.
   */
  const [mode, setMode] = useState<StoreView>('discover')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [open, setOpen] = useState<string | undefined>(undefined)
  /** What the user typed, before the debounce turns it into a request. */
  const [search, setSearch] = useState(filters.query ?? '')
  /**
   * The log export's own state, so the button says what it is doing.
   *
   * A plain `<a download>` gave no sign anything happened at all, which reads
   * as a broken button. `done` is not a state here: the file lands in the
   * browser's download list, and a toast for that would be noise.
   */
  const [exportState, setExportState] = useState<'idle' | 'busy'>('idle')
  const [submissionOpen, setSubmissionOpen] = useState(false)
  const body = useRef<HTMLDivElement | null>(null)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // The store is external and long-lived; the page is not. Both of these are
  // effects rather than constructor work so a second mount (a re-render of the
  // host's shell) does not double-subscribe.
  useEffect(() => {
    store.loadCapabilities().catch(() => undefined)
    const unfollow = store.follow()
    store.load(initialQuery).catch(() => undefined)
    // Every mount revalidates with the source (the catalog service no longer
    // serves a TTL cache). A failure is reported below rather than painted
    // with yesterday's bytes; installed counts come from a separate
    // `/api/cards` join on every request.
    // `follow()` opens an EventSource. Dropping its disposer left the old
    // stream alive after a remount, folding every event into the same store a
    // second time — the comment above was false until this return existed.
    return unfollow
    // `initialQuery` is deliberately ABSENT: it seeds `query`/`filters` on the
    // first render only, so re-running this on a late prop change would fetch a
    // query the seeded state is not showing — and the URL-sync effect below
    // would then rewrite the hash back to the stale one. A query that changes
    // without a remount is a new page, not a reload.
  }, [store])

  // Typing is debounced: every keystroke otherwise costs a request to a
  // catalog endpoint that a remote CDN may serve slowly.
  useEffect(() => {
    // Compared NORMALIZED: the timer writes the trimmed text, so comparing the
    // raw input never matched once the user typed a trailing space — each run
    // produced a new `filters` object, which re-armed this timer forever.
    const trimmed = search.trim()
    const nextQuery = trimmed === '' ? undefined : trimmed
    if (nextQuery === filters.query) return
    const timer = setTimeout(() => {
      // Functional update: a sort or category chosen while this timer was
      // pending must survive the write.
      setFilters((current) => ({ ...current, query: nextQuery }))
      setVisible(PAGE_SIZE)
    }, 200)
    return () => clearTimeout(timer)
    // `filters.query` is a primitive, so only a real query change re-arms the
    // debounce; a sort/category change no longer does.
  }, [search, filters.query])

  // Keep the URL in step with the filters, so a reload lands on the same view.
  useEffect(() => {
    const next = queryOf(filters)
    if (next === query) return
    setQuery(next)
    const target = `${window.location.pathname}${window.location.search}${next === '' ? '' : `#${next}`}`
    window.history.replaceState(null, '', target)
  }, [filters, query])

  const catalog = state.catalog
  const pluginVersion = pluginVersionLabel(state.capabilities?.version)
  // Filtering and ordering happen here, not on the server (§8.6): the wire
  // sends the whole catalog and the page selects. Skipping this step left
  // search, the category tabs and the sort menus drawing every bundle.
  // The catalog's answer, corrected by the last finished run. `state.installed`
  // only exists because the catalog snapshot is fetched once at mount: without
  // folding in what the run did, every card kept the pre-run state until a
  // reload. It is a superset keyed by member key, and `installedFrom` is what
  // filters both halves against the catalog.
  const installed = useMemo(
    () => (catalog === undefined ? new Set<string>() : installedFrom(catalog, [...state.installed])),
    [catalog, state.installed],
  )
  /**
   * How many bundles each view holds, for the tab row.
   *
   * The same `selectBundles` + `inView` pair the grid uses, so a tab's number
   * and the grid under it cannot disagree. Before this the counts ignored the
   * search and time filters entirely, and `discover` ignored `inView` too — so
   * a badge could report a total its own grid did not show.
   */
  const viewCounts = useMemo(() => {
    const all = selectBundles(catalog?.bundles ?? [], filters)
    const matching = (view: StoreView): number => all.filter((card) => inView(card, view, installed)).length
    // `discover` goes through the same predicate: it accepts every card, so the
    // number is still the filtered total.
    return { discover: matching('discover'), installed: matching('installed'), enhance: matching('enhance') }
  }, [catalog, filters, installed])
  // Narrowed here rather than inside selectBundles: the answer depends on
  // machine facts, and threading them through the filter function would add a
  // parameter every other caller has to know about.
  const cards = useMemo(() => {
    const list = selectBundles(catalog?.bundles ?? [], filters)
    return mode === 'discover' ? list : list.filter((card) => inView(card, mode, installed))
  }, [catalog, filters, installed, mode])
  const operation = state.operation
  // Only a LIVE operation reaches the cards. A finished one is history: the
  // progress panel shows it once, but a card that keeps saying "卸载中" after
  // the run ends is stuck — the derived counters have no status, so the card
  // cannot tell running from done without this gate.
  const liveOperation = operation !== undefined && isLiveStatus(operation.status) ? operation : undefined
  const runningBundle = liveOperation === undefined ? undefined : liveOperation.bundleId
  const runningProgress = liveOperation === undefined ? undefined : progressOf(liveOperation)
  const installable = state.capabilities?.installable ?? true

  // A finished run changed the profile, and every card's installed count is
  // derived from the catalog the page fetched at mount. Re-reading it is the
  // only answer that does not guess: the server joins the real inventory into
  // `installedMembers`, including members the client could not name.
  const finishedAt = operation !== undefined && !isLiveStatus(operation.status) ? operation.updatedAt : undefined
  useEffect(() => {
    if (finishedAt === undefined) return
    store.load(queryOf(filters)).catch(() => undefined)
    // `filters` is deliberately absent: this is a one-shot refresh for the run
    // that just ended, not a reload on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedAt, store])

  // A finished panel retires itself only when there is nothing left to read.
  // The refresh above already brought the cards up to date, so a clean banner
  // that stays reads as "still working" over a page that proves otherwise.
  // Two cases keep it: a failed member (a RESULT with something to repair) and
  // a member disabled instead of removed (an ACTION the reader has to take —
  // quitting DSH — which nothing else on the page would tell them).
  const lingering = operation !== undefined && !isLiveStatus(operation.status)
    && operation.members.some((member) => member.state === 'failed' || member.state === 'needs-restart')
  const finishedCleanly = operation !== undefined && !isLiveStatus(operation.status) && !lingering
  useEffect(() => {
    if (!finishedCleanly) return
    const timer = setTimeout(() => { store.dismissOperation() }, 6000)
    return () => { clearTimeout(timer) }
  }, [finishedCleanly, finishedAt, store])

  // The next page loads when the sentinel is visible. Guarded on `cards.length`
  // so an exhausted catalog stops the observer instead of re-arming it in a
  // loop that never appends anything.
  useEffect(() => {
    const node = sentinel.current
    if (node === null || visible >= cards.length) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible((current) => Math.min(current + PAGE_SIZE, cards.length))
      }
    }, { root: body.current, rootMargin: '200px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible, cards.length])

  const categories = catalog?.categories ?? {}
  // Counts for the tab and chip row, scoped to the CURRENT view. The tabs sit
  // under the view switch, so their numbers must describe the list they are
  // above: counting the whole catalog left 已安装 showing 发现's distribution.
  // The scope is the same `inView` predicate that keeps the cards, so the two
  // cannot drift.
  const counts = useMemo(() => {
    const scope = mode === 'discover'
      ? catalog?.bundles ?? []
      : (catalog?.bundles ?? []).filter((card) => inView(card, mode, installed))
    return categoryCounts(scope, filters, categories)
  }, [catalog, filters, categories, mode, installed])
  // 全部's own count is the sum of primaries, i.e. every bundle the non-category
  // filters kept. Summing the map rather than calling selectBundles again keeps
  // one definition of "how many".
  const totalCount = [...counts.primary.values()].reduce((sum, n) => sum + n, 0)
  // Every category name in both languages, straight from the catalog. Absent
  // on an older catalog, in which case the labels fall back to title-cased ids.
  const categoryLabels = catalog?.categoryLabels
  // No primary means the whole catalog. Clicking a tab narrows it; the 全部 tab
  // is how the narrowing is undone, and it must be a real tab rather than an
  // invisible default, or the first category silently becomes a trap (§8.4).
  const secondaries = filters.primary === undefined ? [] : categories[filters.primary] ?? []

  const detailLoad = useCallback((bundleId: string) => store.detail(bundleId), [store])
  const previewLoad = useCallback(
    async (bundleId: string): Promise<readonly UninstallChoice[]> => (await store.uninstallPreview(bundleId)).members,
    [store],
  )
  const onUninstall = useCallback(
    (bundleId: string, ids: readonly string[]) => store.uninstall(bundleId, ids),
    [store],
  )
  const preflightLoad = useCallback((bundleId: string) => store.preflight(bundleId), [store])
  const memberStateLoad = useCallback(
    async (bundleId: string): Promise<readonly MemberStateView[]> => (await store.memberStates(bundleId)).members,
    [store],
  )

  const openCard = open === undefined ? undefined : cards.find((card) => card.id === open)

  /**
   * Forget the open sheet when its card leaves the current view.
   *
   * Uninstalling from the 已安装 view removes the card from `cards`, so the
   * dialog renders nothing while `open` still held its id. Switching back to
   * 发现 made the same card appear again and the sheet re-opened on its own —
   * a closed dialog must not be restorable from state nobody can see. Clearing
   * the id is what makes "closed" mean closed.
   */
  useEffect(() => {
    if (open === undefined || openCard !== undefined) return
    setOpen(undefined)
  }, [open, openCard])

  return (
    <div className={css.root}>
      {/* A title and one fact, kept deliberately quiet. No backdrop, no
          display type, no button: the first card is 40px below and is what the
          page is for. */}
      <header className={css.head}>
        <div className={css.headRow}>
          <h1 className={css.title}>{copy('pageTitle', locale)}</h1>
          {/* The log export, top right. It used to sit inside the view row,
              which is a `role="tablist"` — a non-tab button there is a lie to a
              screen reader, and it also read as a fourth view. This is a
              diagnostic action a reader needs once, on the way to writing a
              report, so it belongs beside the title rather than among the
              filters. */}
          <div className={css.headActions}>
            <a
              className={css.submissionLink}
              href="#submit-suite"
              onClick={(event) => {
                event.preventDefault()
                setSubmissionOpen(true)
              }}
            >
              <svg className={css.submissionLinkIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M4 1.75h4.5L12 5.25v2.5M8.5 1.75v3.5H12M4 1.75v12.5h4.25M11.5 8.5v5M9 11h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{copy('submitSuite', locale)}</span>
            </a>
            <Button
              tone="secondary"
              disabled={exportState === 'busy'}
              onClick={() => {
                setExportState('busy')
                exportMarketLog(api('/dsh-suite-store/api/logs')).then(
                  () => setExportState('idle'),
                  (why: unknown) => {
                    setExportState('idle')
                    // The page has no toast surface, and this is a diagnostic
                    // action: the console is where a failure belongs rather
                    // than a banner over a working store.
                    console.error('[dsh-suite-store] log export failed', why)
                  },
                )
              }}
            >
              {exportState === 'busy' ? copy('exportingLog', locale) : copy('exportLog', locale)}
            </Button>
          </div>
        </div>
        <p className={css.sub}>
          <span className={css.subSummary}>
            {catalog === undefined
              ? copy('pageSubtitleLoading', locale)
              : fill('pageSubtitle', locale, {
                count: cards.length,
                date: catalog.generatedAt.slice(0, 10),
              })}
          </span>
          {catalog === undefined ? null : (
            <span className={css.pluginMeta}>
              <a
                className={css.pluginLink}
                href={STORE_REPOSITORY_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                {pluginIdentity(locale)}
              </a>
              {pluginVersion === undefined ? null : (
                <span className={css.pluginVersion}>{pluginVersion}</span>
              )}
            </span>
          )}
        </p>
      </header>

      <div className={css.views} role="tablist">
        {/* Three views of one catalog: everything, what this profile already
            has, and what it has only part of. The third is where a reader
            finds the suites they could complete. */}
        {(['discover', 'installed', 'enhance'] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={mode === view}
            className={[css.viewTab, mode === view ? css.viewOn : ''].filter(Boolean).join(' ')}
            onClick={() => {
              // A category chosen in 发现 may not exist in another view:
              // leaving it selected would open the new view on an empty grid
              // with no obvious way back. Each view starts on 全部.
              setFilters({ ...filters, primary: undefined, secondary: undefined })
              setMode(view)
              setVisible(PAGE_SIZE)
            }}
          >
            {copy(VIEW_COPY[view], locale)}
            <span className={css.filterCount}>{viewCounts[view]}</span>
          </button>
        ))}
      </div>

      <div className={css.toolbar}>
        {/* One row for the controls that take typing or a menu, one row for
            the controls that are a single tap: two stacked selects under a
            search box is a form, not a store. */}
        <div className={css.searchRow}>
          {/* A placeholder is not a label: each control carries a real one,
              visible above it, so the row is readable without guessing. */}
          <label className={[css.field, css.fieldGrow].join(' ')}>
            <span className={css.fieldLabel}>{copy('searchLabel', locale)}</span>
            <Input
              className={css.search}
              value={search}
              placeholder={copy('searchPlaceholder', locale)}
              onChange={setSearch}
            />
          </label>
          <label className={[css.field, css.fieldSelect].join(' ')}>
            <span className={css.fieldLabel}>{copy('sortLabel', locale)}</span>
            <select
              className={css.select}
              value={filters.sort ?? 'recommended'}
              onChange={(event) => {
                setFilters({ ...filters, sort: event.target.value as SortMode })
                setVisible(PAGE_SIZE)
              }}
            >
              {SORTS.map((sort) => (
                <option key={sort.mode} value={sort.mode}>{copy(sort.key, locale)}</option>
              ))}
            </select>
          </label>
          <label className={[css.field, css.fieldSelect].join(' ')}>
            <span className={css.fieldLabel}>{copy('updatedWithinLabel', locale)}</span>
            <select
              className={css.select}
              value={filters.updatedWithinDays === undefined ? '' : String(filters.updatedWithinDays)}
              onChange={(event) => {
                const days = event.target.value === '' ? undefined : Number.parseInt(event.target.value, 10)
                setFilters({ ...filters, updatedWithinDays: days })
                setVisible(PAGE_SIZE)
              }}
            >
              {UPDATED_RANGES.map((range) => (
                <option key={range.key} value={range.days === undefined ? '' : String(range.days)}>
                  {copy(range.key, locale)}
                </option>
              ))}
            </select>
          </label>
          {/* No refresh button: every load already revalidates with the
              source. A failed load keeps the last list on screen with an
              error banner and a retry, so a click would add nothing. */}
        </div>

        {Object.keys(categories).length === 0 ? null : (
          <div className={css.filterRow}>
            <div className={css.tabs} role="tablist">
              {/* §8.4: 全部 comes before the categories, and it is the only way
                  back to the full list. `categoryTabs` puts it first and
                  `undefined` is its key, so "no primary filter" and "the 全部
                  tab is current" are the same value and cannot disagree. */}
              {orderTabsByCount(categoryTabs(categories), counts.primary).map((name) => (
                <button
                  key={name ?? 'all'}
                  type="button"
                  role="tab"
                  aria-selected={name === filters.primary}
                  className={[css.tab, name === filters.primary ? css.on : ''].filter(Boolean).join(' ')}
                  onClick={() => {
                    setFilters({ ...filters, primary: name, secondary: undefined })
                    setVisible(PAGE_SIZE)
                  }}
                >
                  {name === undefined ? copy('allCategories', locale) : primaryLabel(name, locale, categoryLabels)}
                  {/* A zero is noise: the tab already reads as "nothing here"
                      from its position at the far end of the row, so the count
                      only renders when it says something. */}
                  {(name === undefined && totalCount > 0) || (name !== undefined && (counts.primary.get(name) ?? 0) > 0) ? (
                    <span className={css.filterCount}>{name === undefined ? totalCount : counts.primary.get(name)}</span>
                  ) : null}
                </button>
              ))}
            </div>
            {secondaries.length === 0 ? null : (
              <>
                <span className={css.filterDivider} aria-hidden />
                <div className={css.chips}>
                  <button
                    type="button"
                    className={[css.chip, filters.secondary === undefined ? css.on : ''].filter(Boolean).join(' ')}
                    onClick={() => { setFilters({ ...filters, secondary: undefined }); setVisible(PAGE_SIZE) }}
                  >
                    {copy('allChips', locale)}
                  </button>
                  {orderChipsByCount(secondaries, counts.secondary.get(filters.primary ?? '') ?? new Map()).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={[css.chip, filters.secondary === name ? css.on : ''].filter(Boolean).join(' ')}
                      onClick={() => { setFilters({ ...filters, secondary: name }); setVisible(PAGE_SIZE) }}
                    >
                      {secondaryLabel(name, locale, categoryLabels)}
                      {(counts.secondary.get(filters.primary ?? '')?.get(name) ?? 0) > 0 ? (
                        <span className={css.filterCount}>{counts.secondary.get(filters.primary ?? '')?.get(name)}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* §5.6: both orders below the default sort are driven by member
            hotness, and "推荐" multiplies it too. The note is not decoration —
            without it "最热" reads as "most installed", which D26 says v1 does
            not track at all. */}
        {filters.sort === 'hottest' || (filters.sort ?? 'recommended') === 'recommended' ? (
          <div className={css.sortNote}>{copy('hotnessNote', locale)}</div>
        ) : null}

        {state.capabilities?.installable === false ? (
          <div className={css.banner}>
            <span className={css.bannerIcon}><Icon name="warning" size={13} /></span>
            <span className={css.grow}>{copy('bannerNoInstall', locale)}</span>
          </div>
        ) : null}

        {state.actionError === undefined ? null : (
          <div className={[css.banner, css.bannerError].join(' ')}>
            <span className={css.bannerIcon}><Icon name="warning" size={13} /></span>
            <span className={css.grow}>{fill('errorInstall', locale, { reason: state.actionError })}</span>
          </div>
        )}

      </div>

      {/* A failed REFRESH over an existing catalog keeps the old cards on
          screen (the store deliberately stays `ready`), so the full-page error
          block below never ran and the failure was silent — while the toolbar
          comment promises a banner and a retry. This is that banner. */}
      {state.error === undefined || cards.length === 0 ? null : (
        <div className={[css.banner, css.bannerError].join(' ')}>
          <span className={css.bannerIcon}><Icon name="warning" size={13} /></span>
          <span className={css.grow}>{fill('errorLoad', locale, { reason: state.error })}</span>
          <Button
            className={css.stAction}
            tone="secondary"
            onClick={() => { store.load(queryOf(filters)).catch(() => undefined) }}
          >
            {copy('retry', locale)}
          </Button>
        </div>
      )}

      <div className={css.body} ref={body}>
        {operation === undefined ? null : (
          <ProgressPanel
            operation={operation}
            locale={locale}
            cancelable={state.capabilities?.canRestart ?? false}
            onCancel={() => { store.cancel().catch(() => undefined) }}
            // A finished panel is history. It offers an explicit close, and
            // retires itself after a few seconds so a reader who walks away
            // does not come back to a stale "卸载完成" banner over a page whose
            // cards have already caught up.
            onDismiss={liveOperation === undefined ? () => { store.dismissOperation() } : undefined}
            // §7.5: a partial record is a resumable one. The server re-reads
            // the persisted record, so "continue" never redoes a member that
            // already finished.
            onResume={
              operation.status === 'partial' && operation.kind !== 'uninstall'
                ? () => { store.resume(operation.opId).catch(() => undefined) }
                : undefined
            }
          />
        )}

        {state.status === 'loading' && cards.length === 0 ? (
          <div className={css.loading}>{copy('loadingCatalog', locale)}</div>
        ) : null}

        {state.status === 'error' && cards.length === 0 ? (
          <div className={css.empty}>
            <p className={css.dangerText}>{fill('errorLoad', locale, { reason: state.error ?? '' })}</p>
            <Button className={css.stAction} tone="secondary" onClick={() => { store.load(queryOf(filters)).catch(() => undefined) }}>
              {copy('retry', locale)}
            </Button>
          </div>
        ) : null}

        {state.status !== 'loading' && cards.length === 0 && state.error === undefined ? (
          <div className={css.empty}>
            {/* A filtered zero is not an empty catalog: telling someone a
                search found nothing that the catalog has no suites at all
                reads as "it does not exist" (§6.5). The two states say
                different sentences. */}
            {catalog === undefined
              ? copy('emptyCatalog', locale)
              : copy('noMatches', locale)}
          </div>
        ) : null}

        {cards.length === 0 ? null : (
          <div className={css.grid}>
            {cards.slice(0, visible).map((card) => (
              <BundleCardView
                key={card.id}
                card={card}
                installed={installed}
                operationBundleId={runningBundle}
                operationKind={operation?.kind}
                progress={runningBundle === card.id ? runningProgress : undefined}
                installable={installable}
                hostBusy={runningBundle !== undefined && runningBundle !== card.id}
                locale={locale}
                categoryLabels={categoryLabels}
                // A card's one-click install never approves a build script on
                // its own — that would be the one place a user runs code
                // without being told. It asks first: with a pending approval
                // the sheet opens on the question instead of starting a run
                // that is guaranteed to fail on that member.
                onInstall={(bundleId) => {
                  store.preflight(bundleId).then(
                    (answer) => {
                      if (answer.summary.needsBuildApproval) { setOpen(bundleId); return }
                      store.install(bundleId).catch(() => undefined)
                    },
                    // A failed preflight is not a failed install: the run
                    // reports its own refusals, and blocking on a question that
                    // could not be asked would hide the bundle entirely.
                    () => { store.install(bundleId).catch(() => undefined) },
                  )
                }}
                onCancel={() => { store.cancel().catch(() => undefined) }}
                onOpen={(bundleId) => setOpen(bundleId)}
              />
            ))}
          </div>
        )}

        <div ref={sentinel} className={css.sentinel} aria-hidden="true" />

        {visible >= cards.length ? null : (
          <div className={css.loadMore}>
            <Button className={css.stAction}
              tone="secondary"
              onClick={() => setVisible((current) => Math.min(current + PAGE_SIZE, cards.length))}
            >
              {fill('loadMore', locale, { remaining: cards.length - visible })}
            </Button>
          </div>
        )}
      </div>

      {submissionOpen ? (
        <SubmissionDialog
          locale={locale}
          categories={catalog?.categories ?? {}}
          categoryLabels={catalog?.categoryLabels}
          loadInstalled={store.submissionInstalled}
          search={store.submissionSearch}
          onClose={() => setSubmissionOpen(false)}
        />
      ) : null}

      {openCard === undefined ? null : (
        <DetailsDialog
          card={openCard}
          locale={locale}
          // The same table the card row and the filter tabs read, so the
          // sheet cannot name a category differently from the grid behind it.
          categoryLabels={catalog?.categoryLabels}
          hostKind={state.capabilities?.hostKind}
          installed={installed}
          installable={installable}
          onClose={() => setOpen(undefined)}
          onCancel={() => { store.cancel().catch(() => undefined) }}
          runningThisBundle={runningBundle === openCard.id}
          // The dialog draws the same bar and counter the card does: a reader
          // who opened the sheet to watch a run should not have to close it to
          // find out how far the run got.
          runningProgress={runningBundle === openCard.id ? runningProgress : undefined}
          runningKind={runningBundle === openCard.id ? liveOperation?.kind : undefined}
          // The members that did not land, with the sentence that explains
          // each one. Read from `operation`, not `liveOperation`: a failed run
          // is exactly the case the banner refuses to auto-dismiss, so the sheet
          // must keep saying the same thing for as long as the banner does.
          failedMembers={(operation?.bundleId === openCard.id ? operation.members : [])
            .filter((member) => member.state === 'failed' || member.state === 'needs-restart')}
          onInstall={(bundleId, approvedBuilds) => {
            store.install(bundleId, approvedBuilds).catch(() => undefined)
          }}
          preflight={preflightLoad}
          load={detailLoad}
          preview={previewLoad}
          uninstall={onUninstall}
          memberStates={memberStateLoad}
          setMemberEnabled={(id, enabled) => store.setMemberEnabled(id, enabled)}
          installMember={(bundleId, key) => store.installMember(bundleId, key)}
        />
      )}
    </div>
  )
}

/**
 * The category tabs, in drawing order, with `undefined` standing for 全部.
 *
 * 全部 is not a category the catalog publishes — it is the absence of the
 * `primary` filter — so it is modelled as `undefined` rather than a magic
 * string like `all`. A magic string would have to be special-cased in
 * `parseQuery`, `queryOf`, `selectBundles` and the URL, and the one call site
 * that forgot would either match no bundle (an empty store) or match a real
 * category named `all`.
 *
 * `undefined` sorts first, which is the order the row draws: the escape hatch
 * before the narrowings.
 *
 * @param categories - primary category id → its secondary ids.
 * @returns the tab keys, 全部 first, then the catalog's own order.
 */
export function categoryTabs(categories: Record<string, string[]>): (string | undefined)[] {
  return [undefined, ...Object.keys(categories)]
}

