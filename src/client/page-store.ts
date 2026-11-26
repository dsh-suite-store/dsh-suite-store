/**
 * The page's state, as one reducer plus a thin store around it.
 *
 * Why a reducer rather than component state: the install stream arrives
 * out of order relative to the clicks that cause it (a `member-done` can land
 * before the `install()` response resolves), and a page reload mid-install
 * must reconnect and repaint from the server's snapshot. Both are "fold an
 * event into what is already known", which is a reducer's shape, not React
 * state's. Keeping it here also means the rules are testable in Node with no
 * DOM — which is what the suite does.
 *
 * Two invariants the fold maintains:
 *
 * - **The operation record only ever moves forward.** A snapshot that
 *   arrives after a live event (the SSE reconnect case) must not roll a
 *   member back from `running` to `pending`; {@link applySnapshot} compares
 *   `updatedAt` and keeps the newer one.
 * - **Nothing here throws on a bad line.** A progress stream is a long-lived
 *   connection to a server that may restart; a malformed event is dropped and
 *   the rest of the run still renders.
 */

import type { BundleDetail, FilterOptions } from '../catalog/types.ts'
import type { InstallReport } from '../install/executor.ts'
import type { OperationRecord } from '../install/operation.ts'
import type {
  BundlesResponse,
  CapabilitiesResponse,
  MemberStatesResponse,
  PreflightResponse,
  ProgressLine,
  StoreClient,
  UninstallPreviewResponse,
} from './store-data.ts'
import type { UninstallReport } from '../server/routes.ts'
import type { CuratedMember } from '../submission/curated.ts'

/** What the page knows at any moment. */
export interface PageState {
  /** `loading` until the first catalog answer arrives. */
  status: 'loading' | 'ready' | 'error'
  /** The last catalog answer; kept on error so the page is not blank. */
  catalog: BundlesResponse | undefined
  /** Why the last catalog load failed, when it did. */
  error: string | undefined
  /** The host's capabilities, once the server has answered. */
  capabilities: CapabilitiesResponse | undefined
  /** The install running on this host, if any (§7.1: one at a time). */
  operation: OperationRecord | undefined
  /**
   * Member keys present in the profile, from each card's `installedMembers`.
   *
   * Keys, not ids: a card knows its own members by key, and the host's
   * inventory only reaches the browser as keys. Nothing outside a card needs
   * the global set, so the key space is the one that pays for itself.
   */
  installed: ReadonlySet<string>
  /** Row-level message for a failed install request, shown next to the button. */
  actionError: string | undefined
}

/** An empty page state. */
export function initialState(): PageState {
  return {
    status: 'loading',
    catalog: undefined,
    error: undefined,
    capabilities: undefined,
    operation: undefined,
    installed: new Set<string>(),
    actionError: undefined,
  }
}

/** Every way the state can change. */
export type PageAction =
  | { type: 'catalog-start' }
  | { type: 'catalog-ok'; catalog: BundlesResponse }
  | { type: 'catalog-failed'; message: string }
  | { type: 'capabilities'; capabilities: CapabilitiesResponse }
  | { type: 'operation'; operation: OperationRecord | undefined }
  | { type: 'installed'; installed: ReadonlySet<string> }
  | { type: 'action-failed'; message: string | undefined }

/**
 * Fold one action into the state.
 *
 * @param state - the previous state; never mutated.
 * @param action - what happened.
 * @returns the next state.
 */
export function reduce(state: PageState, action: PageAction): PageState {
  switch (action.type) {
    case 'catalog-start':
      // A refresh keeps the old list on screen: replacing it with a spinner
      // on every filter change makes the page flicker for no information.
      return { ...state, status: state.catalog === undefined ? 'loading' : state.status, error: undefined }
    case 'catalog-ok':
      return { ...state, status: 'ready', catalog: action.catalog, error: undefined }
    case 'catalog-failed':
      return { ...state, status: state.catalog === undefined ? 'error' : 'ready', error: action.message }
    case 'capabilities':
      return { ...state, capabilities: action.capabilities }
    case 'operation':
      // A new operation clears the last failure. Otherwise the "could not
      // start" banner from a previous attempt sits above a run that IS
      // working, and the page says two opposite things at once. A record for
      // the SAME opId goes through `newer()`: the stream can fold a live
      // event in before the POST resolves, and replacing it with the POST's
      // queued-era record rolled the panel backwards (1/12 → 0/12).
      return {
        ...state,
        operation: action.operation === undefined
          ? undefined
          : newer(state.operation, action.operation),
        actionError: undefined,
      }
    case 'installed':
      return { ...state, installed: action.installed }
    case 'action-failed':
      return { ...state, actionError: action.message }
    default:
      return state
  }
}

/**
 * Fold a live progress line into the state.
 *
 * @param state - the previous state.
 * @param line - one event from `/api/progress`.
 * @returns the next state; the same object when the line changes nothing.
 */
export function applyProgress(state: PageState, line: ProgressLine): PageState {
  switch (line.type) {
    case 'capabilities': {
      const hostKind = line.hostKind === 'desktop' ? 'desktop' : 'cli'
      const canRestart = line.canRestart === true
      const current = state.capabilities
      // The stream's announcement is authoritative for the two facts it
      // carries and says nothing about the others, so it merges rather than
      // replaces: `installable` must not be reset to `undefined` by a line
      // that never mentioned it.
      if (current !== undefined && current.hostKind === hostKind && current.canRestart === canRestart) return state
      return {
        ...state,
        capabilities: {
          hostKind,
          canRestart,
          installable: current?.installable ?? true,
          canApproveBuilds: current?.canApproveBuilds ?? hostKind === 'cli',
          memberEstimateMs: current?.memberEstimateMs ?? [20_000, 40_000],
        },
      }
    }
    case 'snapshot': {
      const incoming = isOperation(line.op) ? line.op : undefined
      return applySnapshot(state, incoming)
    }
    case 'op-start':
    case 'op-phase':
    case 'member-start':
    case 'member-phase':
    case 'member-done':
    case 'op-restarting':
    case 'op-verify':
    case 'op-end':
    case 'op-cancelled': {
      // Every live event carries the whole record, because the record is
      // small and a delta would have to be reconstructed anyway. A missing
      // record means the event was about something this page never knew
      // about (an operation started in another tab), so the snapshot is the
      // one to wait for rather than inventing a partial record here.
      const operation = isOperation(line.op) ? line.op : undefined
      if (operation === undefined) return state
      const next = { ...state, operation: newer(state.operation, operation) }
      // The run just ended: what it did to the profile is not on any card
      // yet. Folding the record's member keys in here is what stops every
      // card showing the pre-run state ("安装", "0/5") for the rest of the
      // session — installed state was previously only ever read from the
      // catalog fetched at mount. A successful install marks its members
      // present; a removal takes them out. The next catalog fetch reconciles
      // this against the server's own answer.
      if (isTerminal(operation.status) && (state.operation === undefined || isLiveStatus(state.operation.status))) {
        // `installed` here is the client's own guess, good only until the next
        // catalog fetch. A removal is keyed by plugin id while the cards test
        // by member key, so the guess cannot always be right — the page also
        // re-fetches the catalog when it sees this transition, and that
        // answer overwrites the guess.
        return { ...next, installed: adjustInstalled(state.installed, operation) }
      }
      return next
    }
    case 'op-note': {
      // Rollback-failure notes ("could not undo X; it is still installed")
      // are emitted by the executor but were never subscribed to, so §7.3's
      // traceability guarantee silently failed. They surface in the panel
      // through the same row the action errors use.
      const note = typeof (line as { note?: unknown } | undefined)?.note === 'string'
        ? (line as { note?: unknown }).note
        : undefined
      if (typeof note !== 'string') return state
      return { ...state, actionError: note }
    }
    default:
      return state
  }
}

/**
 * The statuses that mean the operation is over, however it ended.
 *
 * Enumerated rather than "anything not live": a status this build does not
 * know (a newer host's `paused`, or a malformed value that passed the loose
 * `isOperation` check) used to be read as finished, and `adjustInstalled` then
 * folded a still-running operation's partial `ok` members into `installed`.
 */
const TERMINAL_STATUSES: readonly OperationRecord['status'][] = ['done', 'partial', 'blocked', 'cancelled']

/** Whether the operation is over. */
function isTerminal(status: OperationRecord['status']): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/**
 * Apply one finished operation to the set of member keys the profile holds.
 *
 * Members the run reported `ok` are present afterwards; a REMOVAL takes its
 * `ok` members out instead. Anything else (skipped, failed) is left as it
 * was, because the server-side presence check is the authority and this fold
 * only has to be right between the run's end and the next catalog fetch.
 */
function adjustInstalled(installed: ReadonlySet<string>, operation: OperationRecord): ReadonlySet<string> {
  const next = new Set(installed)
  const touched = operation.members.filter((member) => member.state === 'ok').map((member) => member.key)
  if (operation.kind === 'uninstall') {
    // A removal is keyed by PLUGIN ID (`npm:name`), not by a member key: it can
    // name a plugin no bundle in the catalog lists. The id is deleted as-is;
    // `installedFrom` is what maps an id onto the card's key on the way out, so
    // the two sides do not need the catalog in the reducer.
    for (const id of touched) next.delete(id)
  } else {
    for (const key of touched) next.add(key)
  }
  return next
}

/**
 * Take a snapshot as the truth, unless a newer record is already on screen.
 *
 * @param state - the previous state.
 * @param incoming - the record the server sent, or `undefined` for "nothing
 *   is running".
 * @returns the next state.
 */
export function applySnapshot(state: PageState, incoming: OperationRecord | undefined): PageState {
  if (incoming === undefined) {
    // "Nothing running" is only true if what we hold is not still live: a
    // late snapshot can arrive while a fresh operation is already painting.
    if (state.operation !== undefined && isLiveStatus(state.operation.status)) return state
    return state.operation === undefined ? state : { ...state, operation: undefined }
  }
  const next = newer(state.operation, incoming)
  return next === state.operation ? state : { ...state, operation: next }
}

/**
 * The later of two records describing the same operation.
 *
 * @param current - the record on screen.
 * @param incoming - the record that just arrived.
 * @returns `incoming` unless `current` is the different operation or strictly
 *   newer.
 */
function newer(current: OperationRecord | undefined, incoming: OperationRecord): OperationRecord {
  if (current === undefined) return incoming
  if (current.opId !== incoming.opId) {
    // A different opId is not automatically newer. A snapshot for another
    // operation still has to be the later one, or a reconnected stream could
    // put an old run back over one that is on screen.
    const known = timestamp(current)
    const arrived = timestamp(incoming)
    return arrived > known ? incoming : current
  }
  const known = timestamp(current)
  const arrived = timestamp(incoming)
  if (arrived !== known) return arrived > known ? incoming : current
  // Equal (or both unparseable) stamps. `updatedAt` is whole-second ISO, so a
  // POST answer recorded in the same second as a live `member-done` ties — and
  // letting the incoming (queued-era) record win rolled the panel from 1/12
  // back to 0/12. Keep whichever got further instead.
  return progressed(incoming) >= progressed(current) ? incoming : current
}

/**
 * How many members have left `pending`.
 *
 * The only tie-break available on a shared second: it is monotone within one
 * operation, so "further along" is the right "newer" when the clock cannot say.
 */
function progressed(operation: OperationRecord): number {
  return operation.members.filter((member) => member.state !== 'pending').length
}

/** `updatedAt` as a comparable number; `-Infinity` when it cannot be parsed. */
function timestamp(operation: OperationRecord): number {
  const parsed = Date.parse(operation.updatedAt)
  // An unparseable stamp compares as "as old as unknown", not as "the epoch":
  // a record with no usable time is the one written by a host whose clock or
  // format we do not understand, and treating it as infinitely old keeps the
  // newer, well-formed record on screen.
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/** A status that means the operation is still running. */
function isLiveStatus(status: OperationRecord['status']): boolean {
  return status === 'queued' || status === 'preflight' || status === 'installing'
    || status === 'restarting' || status === 'verifying'
}

/**
 * Whether a value is enough of an operation record to render.
 *
 * A structural check rather than a schema: this is the boundary the progress
 * stream crosses, and everything past it re-reads the same fields.
 */
function isOperation(value: unknown): value is OperationRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<OperationRecord>
  return typeof record.opId === 'string'
    && typeof record.bundleId === 'string'
    && typeof record.status === 'string'
    && Array.isArray(record.members)
}

/**
 * The page's store: current state, a subscription, and the actions the
 * components dispatch.
 *
 * Deliberately hand-rolled instead of `useSyncExternalStore`'s usual context
 * plumbing: the page has exactly one consumer tree and one mounted instance,
 * so a module-level store with a subscribe function is the whole mechanism.
 */
export interface PageStore {
  getState(): PageState
  subscribe(listener: () => void): () => void
  dispatch(action: PageAction): void
  /** Load (or reload) the catalog for the given query string. */
  load(query: string): Promise<void>
  /** Load the host's capabilities once. */
  loadCapabilities(): Promise<void>
  /** Ask the server to install a bundle; resolves with whether it started. */
  install(bundleId: string, approvedBuilds?: readonly string[]): Promise<boolean>
  /** Retire a finished operation so its panel leaves the page. */
  dismissOperation(): void
  /** Ask the server to stop the running operation. */
  cancel(): Promise<void>
  /** Retry the failed and never-started members of a persisted run (§7.5). */
  resume(opId: string, approvedBuilds?: readonly string[]): Promise<boolean>
  /** Replace the set of member keys this profile holds. */
  setInstalled(keys: readonly string[]): void
  /** Follow the progress stream; returns the unsubscribe. */
  follow(): () => void
  /** This bundle's detail document, read on demand and kept for the session. */
  detail(bundleId: string): Promise<BundleDetail>
  /** What an install would touch, including who needs a build approval. */
  preflight(bundleId: string): Promise<PreflightResponse>
  /** What uninstalling this bundle would remove, and what it would leave. */
  uninstallPreview(bundleId: string): Promise<UninstallPreviewResponse>
  /** Remove the chosen members; resolves with the report the server wrote. */
  uninstall(bundleId: string, ids: readonly string[]): Promise<UninstallReport>
  /** Presence and switch state of every member, as this profile sees it. */
  memberStates(bundleId: string): Promise<MemberStatesResponse>
  /** Turn one member's host switch on or off; resolves with what it settled on. */
  setMemberEnabled(id: string, enabled: boolean): Promise<boolean>
  /** Install one member of a bundle without taking the rest (§8.3). */
  installMember(bundleId: string, key: string): Promise<InstallReport>
  /** Load installed plugins that are also curated index members. */
  submissionInstalled(): Promise<CuratedMember[]>
  /** Search curated index members for the submission picker. */
  submissionSearch(query: string): Promise<CuratedMember[]>
}

/**
 * Build a store over a client.
 *
 * @param client - the transport; a test passes a literal.
 * @returns the store.
 */
export function createPageStore(client: StoreClient): PageStore {
  let state = initialState()
  const listeners = new Set<() => void>()
  /**
   * Detail documents already fetched, by bundle id.
   *
   * Detail is a README-sized document that never changes for a published
   * version (§8.4), so re-fetching it every time a card is clicked would be a
   * round trip for bytes the page already has. A failed fetch is not stored,
   * which is what makes the dialog's retry cheap to write.
   */
  const details = new Map<string, BundleDetail>()

  const set = (next: PageState): void => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  /**
   * Fetch the catalog for a query and fold it in.
   *
   * One function for the first load, a filter change and the error-state
   * retry: the three differ only in what the failure means to the reader,
   * and that is carried by the state the fold leaves behind, not by the call.
   */
  const loadInto = async (query: string): Promise<void> => {
    set(reduce(state, { type: 'catalog-start' }))
    try {
      const catalog = await client.bundles(parseQuery(query))
      set({ ...reduce(state, { type: 'catalog-ok', catalog }), installed: installedFrom(catalog) })
    } catch (error) {
      set(reduce(state, { type: 'catalog-failed', message: messageOf(error) }))
    }
  }

  /**
   * Start an operation and fold its outcome in.
   *
   * Shared by `install` and `resume`, whose bodies were identical apart from
   * the client call — two copies of the 409-adoption rule is how the two paths
   * drift, and only one of them gets the next fix.
   *
   * @param request - the client call that starts the run.
   * @returns whether it started (or adopted the operation that was running).
   */
  const startOperation = async (request: () => Promise<OperationRecord>): Promise<boolean> => {
    set(reduce(state, { type: 'operation', operation: undefined }))
    try {
      // The answer IS the running record. Folding it in immediately means the
      // panel appears the moment the click lands, instead of on the first
      // stream event — and it is what makes the run survive a reload, because
      // the record is already the page's own state.
      const started = await request()
      if (isOperation(started)) set(reduce(state, { type: 'operation', operation: started }))
      return true
    } catch (error) {
      // A 409 means another operation owns the host. Its record rides on the
      // error, so adopting it turns the refusal into visibly running work
      // rather than a dead-end message.
      if (error instanceof Error && 'operation' in error) {
        const operation = (error as { operation?: unknown }).operation
        if (isOperation(operation)) set(reduce(state, { type: 'operation', operation }))
      }
      set(reduce(state, { type: 'action-failed', message: messageOf(error) }))
      return false
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispatch: (action) => { set(reduce(state, action)) },
    load: (query) => loadInto(query),
    loadCapabilities: async () => {
      try {
        set(reduce(state, { type: 'capabilities', capabilities: await client.capabilities() }))
      } catch (error) {
        // A host without the route is a host without the page's backend;
        // the catalog load reports the real failure.
        set(reduce(state, { type: 'capabilities', capabilities: fallbackCapabilities() }))
      }
    },
    install: (bundleId, approvedBuilds = []) => startOperation(() => client.install(bundleId, approvedBuilds)),
    cancel: async () => {
      try {
        await client.cancel()
      } catch (error) {
        set(reduce(state, { type: 'action-failed', message: messageOf(error) }))
      }
    },
    resume: (opId, approvedBuilds = []) => startOperation(() => client.resume(opId, approvedBuilds)),
    setInstalled: (keys) => { set(reduce(state, { type: 'installed', installed: installedFrom(undefined, keys) })) },
    dismissOperation: () => {
      // The interface says "a finished operation". A live record is the page's
      // only view of what the host is doing, and the snapshot that could
      // restore it is exactly the one `applySnapshot` ignores while it is live
      // — so clearing it here would hide a running install until the next event.
      if (state.operation !== undefined && isLiveStatus(state.operation.status)) return
      set(reduce(state, { type: 'operation', operation: undefined }))
    },
    follow: () => client.progress((line) => { set(applyProgress(state, line)) }),
    preflight: (bundleId) => client.preflight(bundleId),
    detail: async (bundleId) => {
      const cached = details.get(bundleId)
      if (cached !== undefined) return cached
      // A failed detail must not be cached: the dialog's retry is the same
      // call one click later, and a cached rejection would answer it instead.
      const detail = await client.detail(bundleId)
      details.set(bundleId, detail)
      return detail
    },
    uninstallPreview: (bundleId) => client.uninstallPreview(bundleId),
    uninstall: (bundleId, ids) => client.uninstall(bundleId, ids),
    memberStates: (bundleId) => client.memberStates(bundleId),
    setMemberEnabled: (id, enabled) => client.setMemberEnabled(id, enabled),
    installMember: (bundleId, key) => client.installMember(bundleId, key),
    submissionInstalled: async () => (await client.submissionInstalled()).members,
    submissionSearch: async (query) => (await client.submissionSearch(query)).members,
  }
}

/**
 * Read filters back out of the query string the URL carries.
 *
 * The page keeps its filters in the URL (`?q=…&primary=…`) so a reload, a
 * bookmark and the browser's back button all restore the same view. Parsing
 * lives here rather than in the component because it is the inverse of
 * `filterQuery`, and the two must agree about defaults.
 *
 * @param search - the query string, with or without its leading `?`.
 * @returns the filters, ready for `client.bundles`.
 */
export function parseQuery(search: string): FilterOptions {
  const bare = search.startsWith('#') || search.startsWith('?') ? search.slice(1) : search
  const params = new URLSearchParams(bare)
  const query = params.get('q')
  const primary = params.get('primary')
  const secondary = params.get('secondary')
  const sort = params.get('sort')
  const modes = ['recommended', 'updated', 'members', 'hottest'] as const
  const within = Number.parseInt(params.get('updatedWithin') ?? '', 10)
  // A secondary category only exists inside its primary. A URL that carries
  // one without the other would filter the grid by a chip row the page never
  // draws — the count drops and nothing on screen explains why or clears it.
  const scoped = primary === null || primary === ''
  return {
    ...(query === null || query.trim() === '' ? {} : { query }),
    ...(primary === null || primary === '' ? {} : { primary }),
    ...(scoped || secondary === null || secondary === '' ? {} : { secondary }),
    ...(sort === null || !(modes as readonly string[]).includes(sort) ? {} : { sort: sort as typeof modes[number] }),
    ...(params.get('hideBroken') === '1' ? { hideBroken: true } : {}),
    ...(Number.isFinite(within) && within > 0 ? { updatedWithinDays: within } : {}),
  }
}

/**
 * The filter set as a query string.
 *
 * The inverse of {@link parseQuery}, and it lives beside it so the format is
 * written once: the page's URL and the page's state cannot drift apart if both
 * directions are the same two functions. The default sort is omitted, which is
 * what keeps a freshly opened page at a bare URL.
 *
 * @param filters - what the page is showing.
 * @returns a query string with no leading `#` or `?`, possibly empty.
 */
export function queryOf(filters: FilterOptions): string {
  const parts: string[] = []
  const add = (key: string, value: string | undefined): void => {
    if (value === undefined || value === '') return
    parts.push(`${key}=${encodeURIComponent(value)}`)
  }
  add('q', filters.query)
  add('primary', filters.primary)
  add('secondary', filters.secondary)
  add('sort', filters.sort === undefined || filters.sort === 'recommended' ? undefined : filters.sort)
  if (filters.hideBroken === true) parts.push('hideBroken=1')
  if (filters.updatedWithinDays !== undefined && filters.updatedWithinDays > 0) {
    parts.push(`updatedWithin=${String(filters.updatedWithinDays)}`)
  }
  return parts.join('&')
}

/**
 * The member keys a profile holds, as a set the page can test.
 *
 * The card carries no `installed` flag: the catalog is a published document
 * and says nothing about this machine. What the profile holds arrives beside
 * the cards, per card, as `installedMembers` — keys, because a card knows its
 * own members by key (§8.2) and the host's inventory is matched to them by
 * identity server-side.
 *
 * @param catalog - the catalog answer, or `undefined` for a bare key list.
 * @param keys - the keys the profile holds right now. OMITTED means "ask the
 *   catalog"; an explicit list — even an empty one — is the caller's fresher
 *   answer and is used as-is. The distinction matters because a removal leaves
 *   an empty list while the catalog in hand still lists the removed member.
 * @returns the keys present in this profile.
 */
export function installedFrom(
  catalog: BundlesResponse | undefined,
  keys?: readonly string[],
): ReadonlySet<string> {
  const collected = new Set<string>()
  // A key is only accepted when this catalog has a card that lists it. The
  // server's set is derived from the profile's whole inventory, so it can
  // mention a member of a bundle that has since left the catalog; drawing
  // that would make some card look fully installed for no visible reason.
  //
  // Two spellings mean the same thing here: an install names its member by
  // `owner/name` (the card's key) while a removal names it by plugin id
  // (`npm:pkg@ver`), because a removal may target a plugin no bundle lists.
  // Both are mapped to the card's key so the rest of the page has one shape.
  const claimed = new Set<string>()
  const keyOfId = new Map<string, string>()
  for (const card of catalog?.bundles ?? []) {
    for (const member of card.members) {
      claimed.add(member.key)
      keyOfId.set(member.id, member.key)
    }
  }
  // `keys` is the caller's explicit answer (what a finished run left behind).
  // An entry may arrive as a card key (`owner/name`) or as a plugin id
  // (`npm:pkg@ver`) — an install records the first, a removal the second — so
  // both spellings are folded onto the card's key. An id the catalog does not
  // know is kept as it arrived: this set is a superset that the cards test by
  // member key, so an unmatched id is inert rather than wrong, and a removal
  // naming a plugin no card lists still stops being `installed` here.
  for (const key of keys ?? []) collected.add(keyOfId.get(key) ?? key)
  // Only when the caller gave no explicit answer. A run's own result is the
  // fresher truth between the run and the next catalog fetch, and the catalog
  // still in hand lists exactly what that run just removed. `undefined`, not
  // `length === 0`: an EMPTY explicit list is a real answer ("the removal took
  // the last member"), and re-adding from the stale catalog is the bug.
  if (keys === undefined) {
    for (const card of catalog?.bundles ?? []) {
      for (const key of card.installedMembers ?? []) if (claimed.has(key)) collected.add(key)
    }
    for (const list of Object.values(catalog?.installed ?? {})) {
      for (const key of list) if (claimed.has(key)) collected.add(key)
    }
  }
  return collected
}

/** A capabilities answer that keeps the page browseable when the route fails. */
function fallbackCapabilities(): CapabilitiesResponse {
  return {
    hostKind: 'cli',
    installable: false,
    canRestart: false,
    canApproveBuilds: false,
    memberEstimateMs: [20_000, 40_000],
  }
}

/** The message of anything thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
