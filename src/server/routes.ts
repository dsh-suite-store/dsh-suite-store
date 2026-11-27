/**
 * The store's HTTP surface: everything the browser page talks to (§7.5, §8).
 *
 * This layer only parses requests, calls the services that already hold the
 * logic, and serializes the answer — it must not grow a second copy of any
 * rule. That is why it takes a `StoreApi` port rather than the concrete
 * catalog/executor: the route file can then be tested with a literal, and the
 * rules stay where their tests are.
 *
 * Two shape decisions worth stating:
 *
 * - **Mutations are POST + body**, never a query string, so a link someone
 *   pastes into a chat cannot install anything.
 * - **Progress is a stream with a snapshot first.** A client that connects
 *   mid-install gets the current record as its first event, not a silence
 *   waiting for the next phase change — the reconnect case is the common one
 *   (page reload during a long install).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  methodNotAllowed,
  openEventStream,
  readJsonBody,
  sameOrigin,
  sendError,
  sendJson,
  type EventStream,
} from './http.ts'
import { exportLogs, readPersistentLog } from '../log/log.ts'
import type { CatalogSnapshot } from '../catalog/sources.ts'
import type { CatalogFetchError } from '../catalog/errors.ts'
import type { BundleCard, BundleDetail, FilterOptions, SortMode } from '../catalog/types.ts'
import type { InstallReport } from '../install/executor.ts'
import type { InstallPlan } from '../install/plan.ts'
import type { PreflightSummary } from '../store.ts'
import type { OperationRecord } from '../install/operation.ts'
import type { UninstallChoice } from '../install/uninstall.ts'
import type { CuratedMember } from '../submission/curated.ts'

/**
 * The plan a confirmed install runs, as the preflight sheet hands it back.
 *
 * `plan` is echoed verbatim rather than rebuilt server-side, because the user
 * confirmed a specific member list: re-deriving it from the catalog at POST
 * time could silently install members the sheet never showed (§7.2). The
 * executor still re-checks every step against the profile (§7.3), so a stale
 * plan costs at most a redundant skip.
 */
export interface InstallRequest {
  bundleId: string
  bundleVersion: string
  plan: InstallPlan
  /** Package names the user approved a build script for (§7.2). */
  approvedBuilds?: readonly string[]
}

/**
 * Validate a client-supplied plan before handing it to the service.
 *
 * A plan is data from the browser, so the shape is checked rather than cast:
 * a malformed one must not reach `buildInstallPlan`'s consumers. The bundle id
 * must match the route's, or a plan for one bundle could be run under another's
 * provenance. Each STEP is shape-checked too, and the service cross-checks the
 * steps against the catalog document — accepting `steps: []` or a step whose
 * spec names an arbitrary package would turn this route into an installer for
 * anything a local caller names.
 */
function isInstallRequest(value: unknown): InstallRequest | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record['bundleId'] !== 'string' || typeof record['bundleVersion'] !== 'string') return undefined
  if (record['plan'] === null || typeof record['plan'] !== 'object') return undefined
  const plan = record['plan'] as Record<string, unknown>
  if (!Array.isArray(plan['steps']) || !Array.isArray(plan['skipped'])) return undefined
  if (plan['steps'].length === 0) return undefined
  for (const step of plan['steps']) {
    if (!isPlanStep(step)) return undefined
  }
  for (const skipped of plan['skipped']) {
    if (skipped === null || typeof skipped !== 'object') return undefined
    if (typeof (skipped as Record<string, unknown>)['key'] !== 'string') return undefined
  }
  return {
    bundleId: record['bundleId'],
    bundleVersion: record['bundleVersion'],
    plan: plan as unknown as InstallRequest['plan'],
  }
}

/** The fields one confirmed step must carry, checked before it is trusted. */
function isPlanStep(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const step = value as Record<string, unknown>
  return typeof step['key'] === 'string' && step['key'] !== ''
    && typeof step['id'] === 'string' && step['id'] !== ''
    && typeof step['spec'] === 'string' && step['spec'] !== ''
    && typeof step['name'] === 'string' && step['name'] !== ''
    && (step['pinnedVersion'] === null || typeof step['pinnedVersion'] === 'string')
    && (step['approvedBuilds'] === undefined || Array.isArray(step['approvedBuilds']))
}

/** Everything the routes need, narrow enough to fake in a test. */
export interface StoreApi {
  /**
   * The catalog, revalidated with its source on every call.
   *
   * Rejects when the source cannot be read; the route turns that into a 503.
   */
  catalog(): Promise<CatalogSnapshot>
  /** One bundle's detail document, or `undefined` when the catalog has no such bundle. */
  detail(id: string): Promise<BundleDetail | undefined>
  /**
   * The bundle's cards as the profile sees them right now.
   *
   * `snapshot` lets a handler that already fetched the catalog hand it over
   * instead of paying for a second revalidation.
   */
  cards(snapshot?: CatalogSnapshot): Promise<BundleCard[]>
  /**
   * Install one bundle from its card.
   *
   * `request` is the plan the preflight sheet confirmed; a one-click install
   * omits it and the service builds one from the catalog.
   *
   * Resolves when the operation is RUNNING, not when it is finished. A
   * ten-member suite takes minutes, and an HTTP response held open that long
   * is one the browser abandons first — which is how a healthy install came to
   * be reported as "Failed to fetch". The outcome reaches the page over
   * `/api/progress`, which is the channel built for it (§7.5).
   */
  install(id: string, request?: InstallRequest, approvedBuilds?: readonly string[]): Promise<OperationRecord>
  /**
   * What installing this bundle would do, including which members need a
   * build-script approval (§7.2).
   *
   * A separate GET because it is a question, not an action: the sheet asks it
   * when it opens so the approval prompt can be shown BEFORE the run rather
   * than interrupting one.
   */
  preflight(id: string): Promise<{ summary: PreflightSummary; plan: InstallPlan }>
  /** The operation in flight, if any. */
  running(): OperationRecord | undefined
  /** What removing this bundle would mean, before anything is removed. */
  uninstallPreview(id: string): Promise<UninstallChoice[]>
  /** Remove exactly the plugins the user checked. */
  uninstall(input: { bundleId: string; ids: readonly string[] }): Promise<UninstallReport>
  /**
   * Each member's presence and switch state, for the sheet's member table (§8.3).
   *
   * Separate from `detail()` because it is a question about THIS profile, not
   * about the catalog: the detail document is cached and identical for
   * everyone, while presence and the on/off switch change with every install.
   */
  memberStates(bundleId: string): Promise<MemberStateView[]>
  /** Turn one installed member on or off without removing it (§8.3). */
  setMemberEnabled(id: string, enabled: boolean): Promise<boolean>
  /**
   * Install one member on its own (§8.3).
   *
   * @param bundleId - the bundle the member belongs to, for the report.
   * @param key - the member key as the catalog names it.
   */
  installMember(bundleId: string, key: string): Promise<InstallReport>
  /** Stop the run in flight after its current member. */
  cancel(): Promise<boolean>
  /**
   * Retry the failed and never-started members of a persisted operation (§7.5).
   *
   * The record on disk is the truth about what already happened; a resume
   * cannot reinstall a member that succeeded before the interruption. Resolves
   * with the RUNNING record, like `install`.
   */
  resume(opId: string, approvedBuilds?: readonly string[]): Promise<OperationRecord>
  /** Follow progress events. */
  subscribe(listener: (event: ProgressEvent) => void): () => void
  /** Curated members already present in this profile, matched to owner/name. */
  submissionInstalled(): Promise<CuratedMember[]>
  /** Search the curated index; results are already limited for the picker. */
  submissionSearch(query: string): Promise<CuratedMember[]>
  /** Which host this is, for the capability-dependent copy. */
  capabilities(): { canRestart: boolean; hostKind: 'cli' | 'desktop' }
}

/**
 * What removing a subset of a bundle's members produced.
 *
 * Defined here rather than in the service because the route serializes it and
 * nothing else consumes it — the shape is the wire contract.
 */
export interface UninstallReport {
  bundleId: string
  removed: string[]
  failed: { id: string; reason: string }[]
}

/**
 * One row of the sheet's member table (§8.3).
 *
 * `state` is deliberately three-valued rather than a boolean: "the profile has
 * this plugin and it is off" and "the profile has never heard of it" are
 * different rows on screen — the first gets a switch, the second gets an
 * install button, and collapsing them would make a missing member look
 * switched off.
 */
export interface MemberStateView {
  /** Member key from the catalog, so the sheet can match its own rows. */
  key: string
  /** Normalized plugin id the removal and switch routes speak. */
  id: string
  present: boolean
  /** Only meaningful when `present`; undefined when the host cannot say. */
  enabled?: boolean
}

/** One progress line; the same union the executor emits, plus the snapshot. */
export type ProgressEvent =
  | { type: 'snapshot'; op: OperationRecord | undefined }
  | { type: 'op-start' | 'op-phase' | 'op-restarting' | 'op-verify' | 'op-end' | 'op-cancelled'
    ; [key: string]: unknown }
  | { type: 'op-note'; [key: string]: unknown }
  | { type: 'member-start'; [key: string]: unknown }
  | { type: 'member-phase'; [key: string]: unknown }
  | { type: 'member-done'; [key: string]: unknown }

/** One route registration, matching the host's `webServer.register`. */
export interface RouteDefinition {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

export const ROUTE_PREFIX = '/dsh-suite-store'

/**
 * The mounted routes, plus the one thing that must be undone with them.
 *
 * An array with a `dispose` method rather than a wrapper object: every caller
 * (and every test) treats the result as a list, and a shape change would have
 * rewritten all of them to reach one disposer. The disposer stops the service
 * subscription and ends any open stream, so a reloaded plugin leaves nothing
 * forwarding events.
 */
export type RouteList = RouteDefinition[] & { dispose?: () => void }

/** Query parameters the catalog listing understands (§8.6). */
export function filtersFrom(search: URLSearchParams): FilterOptions {
  const sort = search.get('sort')
  const sortModes: readonly SortMode[] = ['recommended', 'updated', 'members', 'hottest']
  const within = Number.parseInt(search.get('updatedWithin') ?? '', 10)
  return {
    ...(nonEmpty(search.get('q')) === undefined ? {} : { query: nonEmpty(search.get('q'))! }),
    ...(nonEmpty(search.get('primary')) === undefined ? {} : { primary: nonEmpty(search.get('primary'))! }),
    ...(nonEmpty(search.get('secondary')) === undefined ? {} : { secondary: nonEmpty(search.get('secondary'))! }),
    ...(sort !== null && sortModes.includes(sort as SortMode) ? { sort: sort as SortMode } : {}),
    ...(search.get('hideBroken') === '1' ? { hideBroken: true } : {}),
    ...(Number.isFinite(within) && within > 0 ? { updatedWithinDays: within } : {}),
  }
}

function nonEmpty(value: string | null): string | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * What the log export needs to know about the process it is running in.
 *
 * Injected rather than read here: the route layer must stay testable with a
 * literal (no `process.platform` guessing, no reading the package manifest from
 * disk), and the mount point is the only layer that knows the profile.
 */
export interface RouteEnvironment {
  /** This package's version, so a screenshot/export carries it. */
  version: string
  /** The profile directory, the state directory's parent. */
  profile: string
  /** The NDJSON sink, when persistence is on. */
  logFile?: string
}

/**
 * Build every route this plugin registers.
 *
 * @param api - the services behind the routes.
 * @param environmentInfo - process facts for the log export; omitted by tests
 *   that do not exercise it, which then export without a version header.
 * @returns the registrations, in the order the host should mount them.
 */
export function storeRoutes(api: StoreApi, environmentInfo?: RouteEnvironment): RouteList {
  const streams = new Set<EventStream>()
  const persistentLogFile = environmentInfo?.logFile
  // The disposer is kept, not dropped. `subscribe` hands one back so a
  // reloaded plugin stops listening; discarding it left one listener per hot
  // reload, each forwarding every progress event into a stream set no page
  // owns any more. Attached to the returned array rather than changing the
  // return type, so every existing caller keeps working.
  const disposeSubscription = api.subscribe((event) => {
    for (const stream of streams) {
      // `send` writes to a socket whose close event is asynchronous: a client
      // that disconnected in the same tick can still be marked open here, and
      // an unguarded write-after-end would propagate into `publish()` — which
      // the uninstall loop calls OUTSIDE its per-member try, aborting the run
      // with the lock still held. One dead stream must never cost a removal.
      try {
        stream.send(event.type, event)
      } catch {
        streams.delete(stream)
        try { stream.close() } catch { /* already gone */ }
      }
    }
  })
  /**
   * Did this page's client half ever reach `apply()`?
   *
   * A desktop host has no console a user can read, and a client plugin that
   * fails to mount is silent by design (a throw there would take the app
   * down). That left "the row is missing" with no evidence at all. The client
   * reports what it did here, and `/api/capabilities` hands the report back,
   * so `curl` answers the question the console would have.
   */
  let clientReport: string | undefined

  const guard = (response: ServerResponse, request: IncomingMessage): boolean => {
    // Every mutation goes through here: it is the one place a request from
    // another site can be refused, and a route added later inherits it.
    if (sameOrigin(request)) return true
    sendError(response, 403, 'cross-origin request refused')
    return false
  }

  const routes = [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/bundles`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        try {
          // Every filter is applied in the browser (§8.6); the catalog is
          // revalidated with its source on every call.
          const snapshot = await api.catalog()
          // The snapshot is handed over rather than fetched again inside:
          // `cards()` would otherwise revalidate a second time, and a failure
          // there 503'd a request whose document had already been read.
          const cards = await api.cards(snapshot)
          sendJson(response, 200, {
            generatedAt: snapshot.index.generatedAt,
            source: descriptor(snapshot.source),
            ...(snapshot.index.catalogRef.etag === undefined ? {} : { etag: snapshot.index.catalogRef.etag }),
            categories: snapshot.index.categories,
            // Present only when the catalog names its categories. An older
            // catalog omits it and the page title-cases the ids, which is the
            // pre-existing behaviour rather than a regression.
            ...(snapshot.index.categoryLabels === undefined
              ? {}
              : { categoryLabels: snapshot.index.categoryLabels }),
            bundles: cards,
          })
        } catch (error) {
          // A failed catalog is not a broken store: the client shows the error
          // next to the last good list rather than an empty page (§8.6).
          sendError(response, 503, describeCatalogFailure(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/detail`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id')
        if (id === null || id.trim() === '') return sendError(response, 400, 'id is required')
        try {
          const detail = await api.detail(id)
          if (detail === undefined) return sendError(response, 404, `no bundle named ${id}`)
          sendJson(response, 200, detail)
        } catch (error) {
          sendError(response, 503, describeCatalogFailure(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/preflight`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id')
        if (id === null || id.trim() === '') return sendError(response, 400, 'id is required')
        try {
          sendJson(response, 200, await api.preflight(id))
        } catch (error) {
          sendError(response, 500, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/logs`,
      handler: async (request, response) => {
        // GET only: this EXPORTS, it must never be something a mutation can
        // trigger. A link pasted into a chat cannot pull the log either, which
        // is why the same-origin guard is applied as well.
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        if (!guard(response, request)) return
        // A plain-text body with an attachment filename: the browser saves it
        // instead of rendering it, so the user has a file to attach.
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-suite-store-log.txt"',
        })
        // The live state of THIS profile, which does not depend on anything
        // having been recorded this session. The in-memory buffer starts empty
        // on every start, so a failure that only appears after a restart would
        // otherwise export nothing that matters.
        const state = await profileSnapshot(api)
        response.end(exportLogs(
          environment({ ...(environmentInfo === undefined ? {} : { info: environmentInfo }) }),
          state,
          persistentLogFile === undefined ? [] : readPersistentLog(persistentLogFile),
        ))
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/capabilities`,
      handler: (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        sendJson(response, 200, {
          ...api.capabilities(),
          ...(environmentInfo === undefined ? {} : { version: environmentInfo.version }),
          // Absent until the client half has mounted at least once. A browser
          // that never reports is the signal that `apply()` did not run.
          ...(clientReport === undefined ? {} : { clientReport }),
        })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/submission/installed`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        try {
          sendJson(response, 200, { members: await api.submissionInstalled() })
        } catch (error) {
          sendError(response, 503, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/submission/search`,
      handler: async (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        const query = new URL(request.url ?? '/', 'http://localhost').searchParams.get('q')?.trim() ?? ''
        if (query === '') return sendJson(response, 200, { members: [] })
        try {
          sendJson(response, 200, { members: await api.submissionSearch(query) })
        } catch (error) {
          sendError(response, 503, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/client-report`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const note = field(body, 'note')
        if (note === undefined) return sendError(response, 400, 'note is required')
        // Keep the whole sequence, not just the last line: "apply entered"
        // with no "panellist inject callback fired" is the evidence that the
        // declaration never reached this page's waiter.
        clientReport = clientReport === undefined
          ? note.slice(0, 200)
          : `${clientReport} | ${note}`.slice(-600)
        sendJson(response, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/install`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const id = field(body, 'id')
        if (id === undefined) return sendError(response, 400, 'id is required')
        // The approval list rides on the request body, not on a query string:
        // it is a decision, and a URL that can carry it is a URL that can be
        // pasted into a chat and run by someone else.
        const approved = body['approvedBuilds']
        const approvedBuilds = Array.isArray(approved)
          ? approved.filter((name): name is string => typeof name === 'string')
          : []
        // The sheet's confirmed plan is echoed verbatim when it is sent: the
        // service must install exactly what the user approved, not a plan
        // re-derived from a catalog generation that may have changed while the
        // sheet was open. Older clients omit it and get the old behaviour.
        const echoed = isInstallRequest(body['request'])
        const confirmed = echoed !== undefined && echoed.bundleId === id ? echoed : undefined
        try {
          sendJson(response, 200, await api.install(id, confirmed, approvedBuilds))
        } catch (error) {
          // A busy executor and a bad request are different answers: 409 tells
          // the client to attach to the operation already running instead of
          // offering a retry that will fail the same way.
          if (error instanceof BusyError) {
            sendJson(response, 409, { error: error.message, operation: error.operation })
            return
          }
          sendError(response, 500, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/progress`,
      handler: (request, response) => {
        if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
        const stream = openEventStream(request, response)
        streams.add(stream)
        const { hostKind, canRestart } = api.capabilities()
        // `type` must be in the PAYLOAD as well as the event name: the client
        // switches on `line.type`, so a named event without it fell through to
        // `default` and the whole capabilities handler was unreachable.
        stream.send('capabilities', { type: 'capabilities', hostKind, canRestart })
        stream.send('snapshot', { type: 'snapshot', op: api.running() ?? null })
        // The stream lives as long as the page does; a client that reloads
        // opens a new one, which is cheaper than trying to resume a closed one.
        request.on('close', () => streams.delete(stream))
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/cancel`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        sendJson(response, 202, { stopped: await api.cancel() })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/resume`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const opId = field(body, 'opId')
        if (opId === undefined) return sendError(response, 400, 'opId is required')
        const approved = body['approvedBuilds']
        const approvedBuilds = Array.isArray(approved)
          ? approved.filter((name): name is string => typeof name === 'string')
          : []
        try {
          sendJson(response, 200, await api.resume(opId, approvedBuilds))
        } catch (error) {
          if (error instanceof BusyError) {
            sendJson(response, 409, { error: error.message, operation: error.operation })
            return
          }
          // An unknown opId is a 404, not a 500: the record was deleted or the
          // page is resuming an operation from a previous profile generation.
          if (error instanceof Error && /no (record|unfinished members)/u.test(error.message)) {
            sendError(response, 404, error.message)
            return
          }
          sendError(response, 500, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/uninstall/preview`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const id = field(body, 'id')
        if (id === undefined) return sendError(response, 400, 'id is required')
        try {
          sendJson(response, 200, { members: await api.uninstallPreview(id) })
        } catch (error) {
          // The preview reads provenance AND reconciles against the host, so a
          // catalog fetch can fail here; without this handler the rejection is
          // unhandled and the request hangs until the browser gives up.
          sendError(response, 500, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/uninstall`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const bundleId = field(body, 'id')
        if (bundleId === undefined) return sendError(response, 400, 'id is required')
        const ids = idsField(body)
        if (ids === undefined) return sendError(response, 400, 'ids must be a list of plugin ids')
        try {
          sendJson(response, 200, await api.uninstall({ bundleId, ids }))
        } catch (error) {
          if (error instanceof BusyError) {
            sendJson(response, 409, { error: error.message, operation: error.operation })
            return
          }
          sendError(response, 500, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/members`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const id = field(body, 'id')
        if (id === undefined) return sendError(response, 400, 'id is required')
        try {
          sendJson(response, 200, { members: await api.memberStates(id) })
        } catch (error) {
          sendError(response, 500, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/members/enabled`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const id = field(body, 'id')
        if (id === undefined) return sendError(response, 400, 'id is required')
        const enabled = body['enabled']
        if (typeof enabled !== 'boolean') return sendError(response, 400, 'enabled must be a boolean')
        try {
          sendJson(response, 200, { id, enabled: await api.setMemberEnabled(id, enabled) })
        } catch (error) {
          if (error instanceof BusyError) {
            sendJson(response, 409, { error: error.message, operation: error.operation })
            return
          }
          sendError(response, 500, messageOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/members/install`,
      handler: async (request, response) => {
        if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
        if (!guard(response, request)) return
        const body = await readBody(response, request)
        if (body === undefined) return
        const bundleId = field(body, 'id')
        if (bundleId === undefined) return sendError(response, 400, 'id is required')
        const key = field(body, 'key')
        if (key === undefined) return sendError(response, 400, 'key is required')
        try {
          sendJson(response, 200, await api.installMember(bundleId, key))
        } catch (error) {
          if (error instanceof BusyError) {
            sendJson(response, 409, { error: error.message, operation: error.operation })
            return
          }
          sendError(response, 500, messageOf(error))
        }
      },
    },
  ] as RouteList
  routes.dispose = (): void => {
    disposeSubscription()
    for (const stream of streams) stream.close()
    streams.clear()
  }
  return routes
}

/**
 * The header block of the log export: the facts every report needs first.
 *
 * Deliberately no absolute paths of its own — `exportLogs` sanitises these
 * values, so the profile path is safe to include and lets a maintainer tell
 * which profile a report came from.
 *
 * @param options.info - the injected process facts, when the mount supplied them.
 * @returns key/value lines, in reading order.
 */
function environment(options: { info?: RouteEnvironment } = {}): Record<string, string> {
  const info = options.info
  return {
    'dsh-suite-store': info?.version ?? 'unknown',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    ...(info === undefined ? {} : { profile: info.profile }),
  }
}

/**
 * The store's live state, one line per fact, for the export's snapshot section.
 *
 * Ordered by how a maintainer reads a report: what is installed, what a bundle
 * would touch, then what is running. A read that fails is described in place
 * rather than aborting the export — a profile too broken to read is exactly the
 * case the log is needed for.
 *
 * @param api - the services behind the routes.
 * @returns the lines.
 */
async function profileSnapshot(api: StoreApi): Promise<string[]> {
  const lines: string[] = []
  try {
    const cards = await api.cards()
    lines.push(`catalog bundles (${String(cards.length)}):`)
    for (const card of cards) {
      // Reported from the CARD alone: member count, pinned version and the
      // catalog's own health verdict. Install state is deliberately not
      // guessed here — `cards()` returns catalog data, and inferring a profile
      // fact from it is how an export starts lying.
      lines.push(
        `  ${card.id} ${card.version}: ${String(card.memberCount)} members, health ${card.health.status}`
        + (card.health.missing.length === 0 ? '' : `, missing ${card.health.missing.join(', ')}`)
        + (card.needsBuildApproval ? ', needs build approval' : ''),
      )
    }
  } catch (error) {
    lines.push(`profile state unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return lines
  }
  try {
    const running = api.running()
    lines.push('operation:')
    if (running === undefined) {
      lines.push('  (none running)')
    } else {
      lines.push(`  ${running.opId} ${running.bundleId} ${running.status}`)
      for (const member of running.members) {
        const failure = member.failure === undefined ? '' : ` — ${member.failure.type}: ${member.failure.reason}`
        lines.push(`    ${member.key}: ${member.state}${failure}`)
      }
    }
  } catch (error) {
    lines.push(`running operation unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const capabilities = api.capabilities()
    lines.push(`host: ${capabilities.hostKind}, restart ${capabilities.canRestart ? 'available' : 'unavailable'}`)
  } catch (error) {
    lines.push(`capabilities unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return lines
}

/**
 * A busy-executor marker the route layer can recognize across module
 * boundaries without importing the executor itself.
 *
 * The executor's own error is a class; depending on its identity here would
 * couple serialization to an implementation file, so the route checks for the
 * property it needs and the service layer rethrows with it set.
 */
export class BusyError extends Error {
  constructor(
    message: string,
    readonly operation: OperationRecord,
  ) {
    super(message)
    this.name = 'BusyError'
  }
}

async function readBody(response: ServerResponse, request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await readJsonBody(request)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(response, 400, 'body must be a JSON object')
      return undefined
    }
    return body as Record<string, unknown>
  } catch (error) {
    sendError(response, 400, messageOf(error))
    return undefined
  }
}

function field(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function idsField(body: Record<string, unknown>): string[] | undefined {
  const value = body.ids
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return ids.length === value.length ? ids : undefined
}

function descriptor(source: CatalogSnapshot['source']): Record<string, string> {
  // Every variant names where its bytes came from, so the UI can say which
  // source answered instead of just "ok". `label` is included because the
  // UI shows it as the source — omitting it left a bare descriptor.
  switch (source.kind) {
    case 'url': return { kind: source.kind, label: source.label, url: source.url }
    case 'npm': return { kind: source.kind, label: source.label, registry: source.registry, pkg: source.pkg }
    case 'file': return { kind: source.kind, label: source.label, path: source.path }
  }
}

function describeCatalogFailure(error: unknown): string {
  const failure = error as Partial<CatalogFetchError> & { message?: string }
  if (typeof failure.message === 'string' && failure.message !== '') return failure.message
  return messageOf(error)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { BundleCard, BundleDetail }
