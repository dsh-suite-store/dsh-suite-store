/**
 * The browser half's data module: the wire shapes the page reads, the URL it
 * builds, and the pure helpers the components share.
 *
 * Two rules shape everything here.
 *
 * - **Types are declared, not inferred; values come only from pure modules.**
 *   `src/catalog/types.ts` and `src/install/operation.ts` are imported with
 *   `import type` only, so the page's *shape* knowledge is the server's but its
 *   *weight* is not. The one value import, `selectBundles`, is allowed because
 *   that module is declared pure at its own head: the parser and the scorer are
 *   pure functions with no fs, network or tarball dependency, so they cost the
 *   page a few kilobytes of arithmetic and nothing else. Any *other* value
 *   import from a server-only module would drag the tarball parser and the
 *   fs-backed store into the browser bundle — the single most expensive
 *   mistake available to this file.
 * - **Untrusted text stays text.** The catalog is community-authored and the
 *   detail document is a README. Nothing from it is ever handed to
 *   `dangerouslySetInnerHTML`; the markdown reducer below produces React
 *   children only. The only URL form it accepts is an absolute `https:`
 *   destination, rendered as a new-tab anchor with `rel="noreferrer noopener"`:
 *   the page never navigates itself and never runs the author's script, but the
 *   destination host is the author's choice, not this plugin's — there is no
 *   host allowlist, and pretending otherwise in this comment hid that.
 */

import { selectBundles } from '../catalog/types.ts'
import type { BundleCard, BundleDetail, FilterOptions, LocalizedText, SortMode } from '../catalog/types.ts'
import { fill, localeTag, t, type Locale } from './copy.ts'
import type { OperationKind, OperationRecord } from '../install/operation.ts'
import type { UninstallChoice } from '../install/uninstall.ts'
import type { InstallReport } from '../install/executor.ts'
import type { UninstallReport } from '../server/routes.ts'
import type { MemberStateView } from '../server/routes.ts'
import type { CuratedMember } from '../submission/curated.ts'

/**
 * A path under this plugin's route prefix, resolved against the page's base.
 *
 * The page is served from the host's UI directory, and behind a reverse proxy
 * that mounts dsh under a prefix the origin-rooted path would miss the prefix
 * rule and 404. `document.baseURI` is that directory. The helper is kept here
 * rather than imported so this package stays a single self-contained bundle.
 *
 * @param path - a path beginning with `/`; the leading slash is optional.
 * @returns the path to fetch, absolute against the page.
 */
export function api(path: string): string {
  const relative = path.replace(/^\/+/, '')
  if (typeof document === 'undefined') return `/${relative}`
  const url = new URL(relative, document.baseURI)
  // `pathname` alone drops the query, and `/api/detail?id=…` carries its whole
  // argument there: the server then answers "id is required" and the sheet
  // shows a load error for a document that was never asked for.
  return `${url.pathname}${url.search}`
}

/**
 * This plugin's route prefix.
 *
 * The server owns the same string as `ROUTE_PREFIX` in `src/server/routes.ts`,
 * but that module cannot be imported here without dragging server code into the
 * page bundle, so this is a deliberate second copy — one constant instead of
 * thirteen literals, so a route change is a one-line edit here rather than a
 * silent 404 for every call.
 */
const API_BASE = '/dsh-suite-store/api'

/** The public repository behind this plugin. */
export const STORE_REPOSITORY_URL = 'https://github.com/dsh-suite-store/dsh-suite-store'

/** The linked plugin identity shown under the page title. */
export function pluginIdentity(locale: Locale): string {
  return t('pluginIdentity', locale)
}

/** The installed plugin version, or nothing until capabilities arrive. */
export function pluginVersionLabel(version: string | undefined): string | undefined {
  return version === undefined || version.trim() === ''
    ? undefined
    : fill('pluginVersion', 'en', { version: version.trim() })
}

/** A catalog card joined with what this profile holds of it. */
export type StoreCard = BundleCard & {
  installedMembers?: string[]
  /** True only when a run from this store installed it, not merely because members are present. */
  installedByUser?: boolean
  installedCount?: number
  installed?: boolean
}

/** A curated member returned by the submission picker APIs. */
export interface SubmissionMembersResponse {
  members: CuratedMember[]
}

/** The `/api/bundles` answer: the catalog as this profile sees it. */
export interface BundlesResponse {
  generatedAt: string
  /**
   * Where the catalog's bytes came from, as `descriptor()` on the server
   * serializes it. `label` is the display name the UI shows as the source.
   */
  source: { kind: 'url' | 'npm' | 'file'; label: string }
  categories: Record<string, string[]>
  /** Category id → its name in both languages, when the catalog carries one. */
  categoryLabels?: Record<string, LocalizedText>
  /**
   * The catalog cards, each already joined with this profile's inventory by
   * the server. `installedMembers` is what makes "已装" survive the wire: the
   * server has never sent the separate `installed` map, so reading only that
   * made every card claim nothing was installed.
   */
  bundles: StoreCard[]
  /**
   * Member keys each card reports as installed, keyed by bundle id.
   *
   * The catalog itself is machine-agnostic, so what this profile holds rides
   * beside it rather than inside each card: one answer, one place to look,
   * and a card can be rendered from the catalog alone when the profile is
   * unknown (a host with no plugin manager).
   */
  installed?: Record<string, string[]>
}

/** The `/api/preflight` answer (§7.2): what an install would touch. */
export interface PreflightResponse {
  summary: {
    steps: number
    alreadyInstalled: number
    estimateSeconds: number
    /** True when at least one member wants a build-script approval. */
    needsBuildApproval: boolean
    /** Exact package names the host will accept as approvedBuilds. */
    pendingBuilds: string[]
    members: { key: string; name: string; pinnedVersion: string | null }[]
  }
  plan: unknown
}

/** The `/api/capabilities` answer (§7.2). */
export interface CapabilitiesResponse {
  /** Running package version, when the host supplies it. */
  version?: string
  hostKind: 'cli' | 'desktop'
  installable: boolean
  canRestart: boolean
  canApproveBuilds: boolean
  /** Rough outer bound of one member, used only to say "about N minutes". */
  memberEstimateMs: [number, number]
}

/** One progress line as the server streams it (§7.5). */
export type ProgressLine =
  | { type: 'capabilities'; hostKind: 'cli' | 'desktop'; canRestart: boolean }
  | { type: 'snapshot'; op: OperationRecord | null }
  | { type: string; [key: string]: unknown }

/** The `/api/uninstall/preview` answer. */
export interface UninstallPreviewResponse {
  members: UninstallChoice[]
}

/** The `/api/members` answer: one row per member, as this profile sees it. */
export interface MemberStatesResponse {
  members: MemberStateView[]
}

/** A failed request, with the status so the page can tell 409 from 500. */
export class StoreRequestError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number
  /** The operation that made the server busy, when that is why it answered 409. */
  readonly operation: OperationRecord | undefined

  constructor(message: string, status: number, operation?: OperationRecord) {
    super(message)
    this.name = 'StoreRequestError'
    this.status = status
    this.operation = operation
  }
}

/**
 * The browser port the page talks to.
 *
 * Tests drive the components through a literal of this rather than a stubbed
 * `fetch`, because every interesting behaviour in the page (retry, resume,
 * the busy banner) is a response to an answer here, not to a network detail.
 */
export interface StoreClient {
  bundles(filters: FilterOptions): Promise<BundlesResponse>
  detail(id: string): Promise<BundleDetail>
  capabilities(): Promise<CapabilitiesResponse>
  /**
   * Start an install; resolves with the operation already running.
   *
   * Not the final report: a ten-member suite takes minutes, so the POST
   * answers as soon as work begins and `/api/progress` carries it to the end.
   */
  install(bundleId: string, approvedBuilds?: readonly string[]): Promise<OperationRecord>
  /** What an install would do, including who needs a build approval (§7.2). */
  preflight(bundleId: string): Promise<PreflightResponse>
  cancel(): Promise<{ stopped: boolean }>
  /**
   * Retry the failed and never-started members of a persisted operation (§7.5).
   *
   * Resolves with the running record, like `install`; the page folds it in so
   * the panel reappears immediately.
   */
  resume(opId: string, approvedBuilds?: readonly string[]): Promise<OperationRecord>
  uninstallPreview(bundleId: string): Promise<UninstallPreviewResponse>
  /**
   * Remove the checked plugins.
   *
   * The answer is a `UninstallReport`, not the `InstallReport` an install
   * returns: the fields the two share (`bundleId`) are a coincidence, and
   * typing this as an install made the caller's `removed`/`failed` reads look
   * like a superset of an `ok`/`skipped` report that the server never sends.
   */
  uninstall(bundleId: string, ids: readonly string[]): Promise<UninstallReport>
  /**
   * What this profile holds for each member, and whether it is switched on
   * (§8.3).
   *
   * Asked when the dialog opens rather than carried with the card: it is a
   * fact about this computer, so caching it with a bundle's catalog metadata
   * would let a toggle in one tab go stale in another.
   */
  memberStates(bundleId: string): Promise<MemberStatesResponse>
  /**
   * Switch one member on or off.
   *
   * @returns whether the host ended up in the asked-for state — the host is
   * the authority here, and a refusal is reported rather than assumed away.
   */
  setMemberEnabled(id: string, enabled: boolean): Promise<boolean>
  /**
   * Install one member on its own (§8.3).
   *
   * @param bundleId - the bundle the row belongs to.
   * @param key - the member key the catalog gave it.
   */
  installMember(bundleId: string, key: string): Promise<InstallReport>
  /** Installed plugins that are also present in the curated index. */
  submissionInstalled(): Promise<SubmissionMembersResponse>
  /** Search the curated plugin index for suite members. */
  submissionSearch(query: string): Promise<SubmissionMembersResponse>
  /**
   * Follow the progress stream.
   *
   * @param onLine - called for every event, and once with `snapshot` on connect.
   * @returns a function that closes the stream.
   */
  progress(onLine: (line: ProgressLine) => void): () => void
}

/** Turn filters into the query string `/api/bundles` reads (§8.6). */
export function filterQuery(filters: FilterOptions): string {
  const search = new URLSearchParams()
  if (filters.query !== undefined && filters.query.trim() !== '') search.set('q', filters.query.trim())
  if (filters.primary !== undefined) search.set('primary', filters.primary)
  if (filters.secondary !== undefined) search.set('secondary', filters.secondary)
  if (filters.sort !== undefined && filters.sort !== 'recommended') search.set('sort', filters.sort)
  if (filters.hideBroken === true) search.set('hideBroken', '1')
  // Omitted at 0 too: `updatedWithin=0` would arrive at the server as a filter
  // that keeps nothing, and "any time" is the absence of the option.
  if (filters.updatedWithinDays !== undefined && filters.updatedWithinDays > 0) {
    search.set('updatedWithin', String(filters.updatedWithinDays))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * The real client, over `fetch` and `EventSource`.
 *
 * Both are read from the global at call time rather than captured at module
 * load: the bundle is evaluated inside the host's module loader, where the
 * page's globals are certainly there, but a test harness (jsdom, a shim)
 * installs them later than the module graph would capture them.
 */
export function createStoreClient(): StoreClient {
  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    let response: Response
    try {
      response = await fetch(api(path), {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
    } catch (error) {
      // A network failure is not an HTTP answer: status 0 says so, and the
      // page's copy ("could not reach the host") keys off it.
      throw new StoreRequestError(error instanceof Error ? error.message : String(error), 0)
    }
    const body = (await response.json().catch(() => undefined)) as
      | { error?: string; operation?: OperationRecord }
      | undefined
    if (!response.ok) {
      throw new StoreRequestError(
        body?.error ?? `HTTP ${response.status}`,
        response.status,
        body?.operation,
      )
    }
    // An `ok` response with no JSON body (a 204, an empty body, a proxy that
    // ate it) is a broken answer, not `T`. Handing `undefined` back made the
    // first dereference throw a bare TypeError ("Cannot read properties of
    // undefined") instead of the `StoreRequestError` the page knows how to
    // render.
    if (body === undefined) {
      throw new StoreRequestError(`HTTP ${response.status}: empty response body`, response.status)
    }
    return body as T
  }

  return {
    bundles: (filters) => request<BundlesResponse>(`${API_BASE}/bundles${filterQuery(filters)}`),
    detail: (id) => request<BundleDetail>(`${API_BASE}/detail?id=${encodeURIComponent(id)}`),
    capabilities: () => request<CapabilitiesResponse>(`${API_BASE}/capabilities`),
    install: (bundleId, approvedBuilds) =>
      request<OperationRecord>(`${API_BASE}/install`, {
        method: 'POST',
        body: JSON.stringify({
          id: bundleId,
          ...(approvedBuilds === undefined || approvedBuilds.length === 0 ? {} : { approvedBuilds }),
        }),
      }),
    preflight: (bundleId) =>
      request<PreflightResponse>(`${API_BASE}/preflight?id=${encodeURIComponent(bundleId)}`),
    cancel: () =>
      request<{ stopped: boolean }>(`${API_BASE}/cancel`, { method: 'POST', body: '{}' }),
    resume: (opId, approvedBuilds) =>
      request<OperationRecord>(`${API_BASE}/resume`, {
        method: 'POST',
        body: JSON.stringify({
          opId,
          ...(approvedBuilds === undefined || approvedBuilds.length === 0 ? {} : { approvedBuilds }),
        }),
      }),
    uninstallPreview: (bundleId) =>
      request<UninstallPreviewResponse>(`${API_BASE}/uninstall/preview`, {
        method: 'POST',
        body: JSON.stringify({ id: bundleId }),
      }),
    uninstall: (bundleId, ids) =>
      request<UninstallReport>(`${API_BASE}/uninstall`, {
        method: 'POST',
        body: JSON.stringify({ id: bundleId, ids }),
      }),
    memberStates: (bundleId) =>
      request<MemberStatesResponse>(`${API_BASE}/members`, {
        method: 'POST',
        body: JSON.stringify({ id: bundleId }),
      }),
    setMemberEnabled: async (id, enabled) => {
      const answer = await request<{ id: string; enabled: boolean }>(`${API_BASE}/members/enabled`, {
        method: 'POST',
        body: JSON.stringify({ id, enabled }),
      })
      return answer.enabled
    },
    installMember: (bundleId, key) =>
      request<InstallReport>(`${API_BASE}/members/install`, {
        method: 'POST',
        body: JSON.stringify({ id: bundleId, key }),
      }),
    submissionInstalled: () => request<SubmissionMembersResponse>(`${API_BASE}/submission/installed`),
    submissionSearch: (query) => request<SubmissionMembersResponse>(`${API_BASE}/submission/search?q=${encodeURIComponent(query)}`),
    progress: (onLine) => {
      // SSE rather than polling (§11②): the server already speaks it, and a
      // 12-member install emits ~40 lines, which polling at 1 Hz would either
      // miss or render as jumpy.
      const stream = new EventSource(api(`${API_BASE}/progress`))
      const handle = (event: MessageEvent): void => {
        try {
          onLine(JSON.parse(event.data) as ProgressLine)
        } catch {
          // A malformed line is the server's bug, not the page's; dropping it
          // keeps a stream with one bad event usable for the rest of the run.
        }
      }
      // The server names every event (`capabilities`, `snapshot`,
      // `member-done`, …) and also sends a default `message`; subscribing to
      // both would deliver each event twice, so the named ones are listed
      // explicitly and the unnamed one is not listened to.
      for (const name of PROGRESS_EVENTS) stream.addEventListener(name, handle as EventListener)
      return () => { stream.close() }
    },
  }
}

/**
 * Event names the progress stream carries.
 *
 * Kept in one list because the browser side must name every one to receive
 * it: an `addEventListener('message')` fallback would double-deliver the ones
 * listed here.
 */
export const PROGRESS_EVENTS = [
  'capabilities',
  'snapshot',
  'op-start',
  'op-phase',
  'member-start',
  'member-phase',
  'member-done',
  'op-restarting',
  'op-verify',
  'op-end',
  'op-cancelled',
  // Rollback-failure notes ride the stream as `op-note`; leaving the name out
  // here made the executor's "could not undo X" lines vanish without a trace.
  'op-note',
] as const

/** Collapse localized catalog text to one string (§8.1: the card shows one). */
export function text(value: LocalizedText | string | undefined, locale: Locale): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  const preferred = value[locale]
  if (typeof preferred === 'string' && preferred !== '') return preferred
  // An empty translation is a gap, not a deliberate blank: fall through to
  // the other language rather than rendering a card with no title.
  return value[locale === 'zh' ? 'en' : 'zh'] ?? ''
}

/** The sort modes the page offers, in display order (§8.6). */
export const SORT_MODES: readonly { id: SortMode; zh: string; en: string }[] = [
  { id: 'recommended', zh: '推荐', en: 'Recommended' },
  { id: 'updated', zh: '最近更新', en: 'Recently updated' },
  { id: 'members', zh: '成员最多', en: 'Most members' },
  { id: 'hottest', zh: '最热', en: 'Hottest' },
]

/**
 * How a member's or a bundle's permission reads to someone who does not know
 * what a capability tag means (§8.6: 权限要说人话).
 *
 * The sentences live in `copy.ts` and are keyed here rather than duplicated,
 * so the one place a translator edits is the one place they are written.
 *
 * Every tag `rebuild-capabilities.mjs` can emit has a sentence here, and
 * `tests/client-data.spec.ts` holds the two lists against each other: a tag
 * with no sentence reaches a card as `fs-read`, which is the exact thing
 * §8.6 exists to stop.
 *
 * @param tag - the capability tag the catalog declared.
 * @param locale - which language the sentence should be written in.
 * @returns a sentence, or `undefined` for a tag this build has no copy for —
 *   in which case the caller shows the raw tag rather than inventing a meaning.
 */
export function capabilitySentence(tag: string, locale: Locale): string | undefined {
  switch (tag) {
    case 'shell': return t('capsShell', locale)
    case 'fs-write': return t('capsFsWrite', locale)
    case 'network': return t('capsNetwork', locale)
    case 'fs-read': return t('capsFsRead', locale)
    case 'env': return t('capsEnv', locale)
    case 'credentials': return t('capsCredentials', locale)
    case 'llm': return t('capsLlm', locale)
    case 'subagent': return t('capsSubagent', locale)
    case 'dynamic-code': return t('capsDynamicCode', locale)
    // `CAPABILITY_GROUPS` lists this tag under the `host` family, and shipped
    // catalog documents in the wild carry it, so without a sentence the chip
    // fell through to the raw string — the §8.6 failure this switch exists to
    // prevent.
    case 'host-runtime': return t('capsHost', locale)
    default: return undefined
  }
}

/**
 * The permission families the sheet groups chips into.
 *
 * A flat list of nine sentences is nine lines nobody scans; the same nine in
 * three labelled rows is "files, network, execution" at a glance. The order is
 * the order they are drawn in, sorted by how much they change a decision.
 */
export const CAPABILITY_GROUPS = [
  { key: 'fileEnv', tags: ['fs-read', 'fs-write', 'env'] },
  { key: 'network', tags: ['network'] },
  { key: 'exec', tags: ['shell', 'dynamic-code'] },
  { key: 'credentials', tags: ['credentials'] },
  { key: 'model', tags: ['llm', 'subagent'] },
  { key: 'host', tags: ['host-runtime'] },
] as const

/** One capability family. */
export type CapabilityGroupKey = (typeof CAPABILITY_GROUPS)[number]['key'] | 'other'

/**
 * Which family a tag belongs to.
 *
 * @param tag - a capability tag from the catalog.
 * @returns the family, or `other` for a tag this build does not know — the
 *   chip still renders, it just lands in the last group instead of vanishing.
 */
export function capabilityGroupOf(tag: string): CapabilityGroupKey {
  for (const group of CAPABILITY_GROUPS) {
    if ((group.tags as readonly string[]).includes(tag)) return group.key
  }
  return 'other'
}

/** Whether a card is worth a warning badge on its own face (§8.2). */
export function needsWarning(card: BundleCard): boolean {
  return card.health.status !== 'ok'
}

/** `updatedAt` as a short, locale-following date; `''` when unparseable. */
export function shortDate(iso: string, locale: Locale): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleDateString(localeTag(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** How many members of a bundle are installed right now, for the button copy. */
export function installedCount(card: BundleCard, keys: ReadonlySet<string>): number {
  let count = 0
  for (const member of card.members) if (keys.has(member.key)) count += 1
  return count
}

/** Which list the page is showing above the filters (§8.4). */
export type StoreView = 'discover' | 'installed' | 'enhance'

/**
 * Whether one card belongs to a view.
 *
 * 发现 is the whole catalog. 已安装 is provenance — what a run from this store
 * put here, full or partial, because that is the list a reader finishes from.
 * 可增强 is the presence answer instead: something of the suite is on disk and
 * something is not, i.e. the suites missing plugins the reader could add. The
 * two questions differ on purpose — a member installed by hand cannot make a
 * suite 已安装, but it does make the remaining members worth offering.
 *
 * @param card - the card to test.
 * @param view - which list is drawn.
 * @param installed - member keys this profile holds.
 * @returns true when the view keeps the card.
 */
export function inView(card: StoreCard, view: StoreView, installed: ReadonlySet<string>): boolean {
  if (view === 'discover') return true
  if (view === 'installed') return card.installedByUser === true
  const have = installedCount(card, installed)
  return have > 0 && have < card.memberCount
}

/** The keys listed for one bundle, as a set, or the empty set. */
export function keysOf(catalog: BundlesResponse | undefined, bundleId: string): ReadonlySet<string> {
  return new Set(catalog?.installed?.[bundleId] ?? [])
}

/** The card's install-button state, as one value the button switches on. */
export type InstallState =
  | { kind: 'install' }
  | { kind: 'installed'; have: number; of: number }
  | { kind: 'installing'; done: number; total: number }
  | { kind: 'removing'; done: number; total: number }
  /**
   * No button that could do anything.
   *
   * The two reasons are NOT the same fact and must not share a sentence: a
   * host without a plugin manager cannot install at all, while a host already
   * running this store's one operation can install perfectly well — later.
   * Saying the first when the second is true tells the user their store is
   * broken during a healthy install.
   */
  | { kind: 'blocked'; reason: 'pluginManager' | 'busy' }

/**
 * Decide what a bundle's action button should say and do.
 *
 * The order is the whole rule: an operation on this bundle wins over the
 * installed count, because while an install runs the count is a moving
 * number and the button must not invite a second click. `blocked` comes
 * before `install` so a host that cannot install never offers a button that
 * would fail.
 *
 * A removal gets its own state rather than borrowing `installing`: the count
 * means the opposite thing (it falls instead of rising), and telling someone
 * their files are being written while they are being deleted is the one
 * misreading this card must not allow.
 */
export function installState(input: {
  card: BundleCard
  installed: ReadonlySet<string>
  /**
   * The running operation, when it is this bundle's. The page already holds
   * the real record; never pass a hand-built object here — `progressOf`
   * iterates `members`, and a partial record used to crash the whole tree
   * with "operation.members is not iterable" during an uninstall.
   */
  operation: OperationRecord | undefined
  installable: boolean
  /**
   * Another bundle's operation owns the host right now (§7.1: one at a time).
   *
   * Distinct from `installable: false`: the store can install this bundle, it
   * just has to wait, and the card must say so rather than blame the host.
   */
  hostBusy?: boolean
  /** Derived counters, supplied by the page when it has no full record. */
  progress?: { done: number; total: number }
  /** Which way the operation moves plugins; absent means an install. */
  operationKind?: OperationKind
  /** The bundle id the derived counters belong to, when there is no record. */
  operationBundleId?: string
}): InstallState {
  const { card, installed, operation, installable, progress, operationKind, hostBusy } = input
  if (operation !== undefined && operation.bundleId === card.id && isLiveStatus(operation.status)) {
    const counts = Array.isArray(operation.members) ? progressOf(operation) : progress
    if (counts !== undefined) {
      const kind = operation.kind === 'uninstall' ? 'removing' : 'installing'
      return { kind, done: counts.done, total: counts.total }
    }
  }
  // No full record: the page can still say "installing 1/3" from the counters
  // it already derived, without inventing a half-valid OperationRecord.
  if (progress !== undefined && operationBundleOf(input) === card.id) {
    return operationKind === 'uninstall'
      ? { kind: 'removing', done: progress.done, total: progress.total }
      : { kind: 'installing', done: progress.done, total: progress.total }
  }
  const have = installedCount(card, installed)
  if (have >= card.memberCount && card.memberCount > 0) {
    return { kind: 'installed', have, of: card.memberCount }
  }
  if (!installable) return { kind: 'blocked', reason: 'pluginManager' }
  // Checked after `installable`: a host that cannot install at all is the
  // stronger answer, and it is the one that stays true when the run ends.
  if (hostBusy === true) return { kind: 'blocked', reason: 'busy' }
  return { kind: 'install' }
}

/** The bundle id a derived-progress input belongs to. */
function operationBundleOf(input: { operationBundleId?: string }): string | undefined {
  return input.operationBundleId
}

/** A status that means "still running" rather than "finished somehow". */
export function isLiveStatus(status: OperationRecord['status']): boolean {
  return status === 'queued' || status === 'preflight' || status === 'installing'
    || status === 'restarting' || status === 'verifying'
}

/**
 * The operation's counters, as fractions plus a member-by-member tally.
 *
 * Computed here rather than read from the record so the page and the server
 * cannot disagree: the record stores per-member state, and the numbers are
 * derived from it by one rule (§7.5).
 */
export function progressOf(operation: OperationRecord): {
  done: number
  total: number
  ok: number
  skipped: number
  failed: number
  running: string | undefined
} {
  let ok = 0
  let skipped = 0
  let failed = 0
  let running: string | undefined
  for (const member of operation.members) {
    // `needs-restart` is a finished removal whose effect waits for the next
    // start; counting it as neither done nor failed left the banner reading
    // 0/1 for work that was complete.
    if (member.state === 'ok' || member.state === 'needs-restart') ok += 1
    else if (member.state === 'skipped' || member.state === 'skipped-build-denied') skipped += 1
    else if (member.state === 'failed') failed += 1
    else if (member.state === 'running') running = member.key
  }
  return {
    done: ok + skipped + failed,
    total: operation.members.length,
    ok,
    skipped,
    failed,
    running,
  }
}

/**
 * A markdown document reduced to the nodes this page will render.
 *
 * Deliberately not a markdown library: the corpus is a package README, and
 * the surface that matters is a reading pane. Supported: headings, bullets,
 * quotes, fenced code, paragraphs, bold, inline code and https links. HTML in
 * the source is stripped rather than interpreted, and every link must be
 * https — a `javascript:` link in a README must not become a live control in
 * the host's own window.
 *
 * @param markdown - the raw document.
 * @returns blocks; each block is text or an inline run, never raw HTML.
 */
export function markdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let bullets: InlineRun[][] | null = null
  let fence: string[] | null = null

  const flushList = (): void => {
    if (bullets === null) return
    const items = bullets
    blocks.push({ kind: 'list', items })
    bullets = null
  }
  const flushFence = (): void => {
    if (fence === null) return
    blocks.push({ kind: 'code', text: fence.join('\n') })
    fence = null
  }

  // Line by line, with HTML stripping applied only OUTSIDE a fence. Running
  // `stripHtml` over the whole document first deleted legitimate markup out of
  // the code samples a README exists to show (`<div>`, `<br/>`, an `<img …>`),
  // and its blank-line collapse reflowed them — so a `code` block, which is
  // rendered verbatim, showed text the author never published.
  //
  // The whole document is still trimmed first, and its trailing newline is
  // dropped, which is what `stripHtml`'s own `trim()` did for the lines it
  // returned: an unclosed fence must not gain a trailing blank line that the
  // author did not write.
  const source = markdown.trimEnd()
  for (const raw of source.split('\n')) {
    const line = fence === null ? stripHtml(raw) : raw
    const trimmed = line.trim()
    if (fence !== null) {
      if (trimmed.startsWith('```')) flushFence()
      else fence.push(line.replace(/\s+$/, ''))
      continue
    }
    if (trimmed.startsWith('```')) {
      flushList()
      fence = []
      continue
    }
    if (trimmed === '') {
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flushList()
      blocks.push({ kind: 'heading', level: heading[1]!.length, inline: inlineRuns(heading[2]!) })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(trimmed)
    if (quote !== null) {
      flushList()
      blocks.push({ kind: 'quote', inline: inlineRuns(quote[1]!) })
      continue
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    if (bullet !== null) {
      // Through the same inline reducer as a paragraph: `**bold**`,
      // `` `code` `` and a link inside a bullet used to render literally,
      // which made a bullet look different from the sentence beside it.
      ;(bullets ??= []).push(inlineRuns(bullet[1]!))
      continue
    }
    flushList()
    blocks.push({ kind: 'paragraph', inline: inlineRuns(line) })
  }
  flushList()
  flushFence()
  return blocks
}

/** One block of a reduced markdown document. */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; inline: InlineRun[] }
  | { kind: 'paragraph'; inline: InlineRun[] }
  | { kind: 'quote'; inline: InlineRun[] }
  | { kind: 'list'; items: InlineRun[][] }
  | { kind: 'code'; text: string }

/** One styled span inside a block. */
export type InlineRun =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

/**
 * Split one line into text, bold, code and https-link runs.
 *
 * `[label](https://…)` is the only link form accepted; anything else stays
 * literal text, which is the safe direction for a hostile README.
 *
 * @param line - one line of markdown.
 * @returns the runs, in order.
 */
export function inlineRuns(line: string): InlineRun[] {
  const pattern = /(\[[^\]]+\]\(\s*https:\/\/[^)\s]+\s*\)|\*\*[^*]+\*\*|`[^`]+`)/g
  const runs: InlineRun[] = []
  for (const part of line.split(pattern)) {
    if (part === '') continue
    const link = /^\[([^\]]+)\]\(\s*(https:\/\/[^)\s]+)\s*\)$/.exec(part)
    if (link !== null) {
      runs.push({ kind: 'link', text: link[1]!, href: link[2]! })
      continue
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push({ kind: 'strong', text: part.slice(2, -2) })
      continue
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      runs.push({ kind: 'code', text: part.slice(1, -1) })
      continue
    }
    runs.push({ kind: 'text', text: part })
  }
  return runs
}

/**
 * Remove HTML from a document, keeping the text inside the tags.
 *
 * Comments go first: a `<!-- -->` block can hide an `<img>` or worse, and
 * dropping it before the tag pass means the pass sees a document without
 * holes in it. The tag pattern requires a real start (`<` then a letter or
 * `/`), so a bare `<` or a comparison like `a < b` survives as the text it
 * was.
 *
 * @param markdown - the raw document.
 * @returns the same document with markup removed.
 */
export function stripHtml(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z][\w:-]*(\s[^>]*)?\/?>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * How many bundles each category tab would show, given everything except the
 * category filter itself.
 *
 * The counts must follow the search: a reader who typed "记忆" and sees 记忆(4)
 * next to 记忆(0) would stop trusting the row. But they must NOT be computed
 * from the already-filtered list, or the selected tab would report only its own
 * matches (and every other tab 0), which is the same lie in the other
 * direction. So each count applies the search, the time window and the
 * hide-broken preference — the filters that are not categories — and nothing
 * else.
 *
 * @param bundles - the whole catalog, not a filtered slice.
 * @param filters - the current filters; only the non-category ones are used.
 * @param categories - primary id → secondary ids, from the catalog.
 * @returns primary counts and, per primary, its secondary counts.
 */
export function categoryCounts(
  bundles: readonly BundleCard[],
  filters: FilterOptions,
  categories: Record<string, string[]>,
): { primary: Map<string, number>; secondary: Map<string, Map<string, number>> } {
  // Everything except the two category dimensions.
  const base = selectBundles(bundles, {
    ...(filters.query === undefined ? {} : { query: filters.query }),
    ...(filters.hideBroken === undefined ? {} : { hideBroken: filters.hideBroken }),
    ...(filters.updatedWithinDays === undefined ? {} : { updatedWithinDays: filters.updatedWithinDays }),
  })
  const primary = new Map<string, number>()
  const secondary = new Map<string, Map<string, number>>()
  for (const card of base) {
    primary.set(card.category.primary, (primary.get(card.category.primary) ?? 0) + 1)
  }
  // Secondaries are per primary because the chip row only ever shows one tab's
  // children: a global map would count a slug under a category it cannot
  // appear in.
  for (const [id, slugs] of Object.entries(categories)) {
    const row = new Map<string, number>()
    for (const card of base) {
      if (card.category.primary !== id || card.category.secondary === '') continue
      if (!slugs.includes(card.category.secondary)) continue
      row.set(card.category.secondary, (row.get(card.category.secondary) ?? 0) + 1)
    }
    secondary.set(id, row)
  }
  return { primary, secondary }
}

/**
 * Tabs in display order: 全部 first, then the categories by count.
 *
 * A reader scans the row for "where is the content" — the numbers make the
 * ordering itself informative, and a category with one bundle no longer
 * outranks one with ten merely because the catalog listed it first. Ties keep
 * the catalog's own order (stable sort on the input sequence), so two empty
 * categories do not swap places between renders.
 *
 * The `全部` tab is the absence of a filter and must stay first regardless of
 * how many bundles any single category holds — it is the way back, not a peer.
 *
 * @param tabs - the catalog's order, `undefined` standing for 全部.
 * @param counts - count per primary, from {@link categoryCounts}.
 * @returns the same keys, 全部 first, the rest by descending count.
 */
export function orderTabsByCount(
  tabs: readonly (string | undefined)[],
  counts: ReadonlyMap<string, number>,
): (string | undefined)[] {
  const all = tabs.filter((tab) => tab === undefined)
  const rest = tabs.filter((tab): tab is string => tab !== undefined)
  const keyed = rest.map((tab, index) => ({ tab, index, count: counts.get(tab) ?? 0 }))
  keyed.sort((left, right) =>
    right.count - left.count || left.index - right.index)
  return [...all, ...keyed.map((entry) => entry.tab)]
}

/**
 * Chips in display order for one primary: descending count, then catalog order.
 *
 * Empty chips still render — the tree says the category HAS this secondary —
 * but the caller hides their zero, so the row stays readable while the choice
 * remains available for a hand-edited submission.
 */
export function orderChipsByCount(
  chips: readonly string[],
  counts: ReadonlyMap<string, number>,
): string[] {
  return chips
    .map((chip, index) => ({ chip, index, count: counts.get(chip) ?? 0 }))
    .sort((left, right) => right.count - left.count || left.index - right.index)
    .map((entry) => entry.chip)
}
