/**
 * The plugin entry point: mounts the store into a running harness (§9, §15).
 *
 * Everything that can be tested is tested elsewhere; this file exists to do
 * the four things only a live composition can do, and to do nothing else:
 *
 * 1. Resolve the profile directory and the host's registry preference.
 * 2. Build the services and reconcile provenance once at startup (§7.7).
 * 3. Register the HTTP routes inside `ctx.effect`, so the disposer belongs to
 *    Cordis' lifecycle rather than to us. `webServer.register` throws on a
 *    duplicate (kind, path) — a route pattern is a composition-level contract.
 *    A reload that installs a second copy of this plugin into the same process
 *    therefore fails at the SECOND copy's mount unless the first copy's routes
 *    are gone, which only happens if the first copy disposed properly. Wiring
 *    the disposers into `ctx.effect` is what makes unload actually unload.
 *
 *    This is a real constraint on packaging, not just tidiness: the profile
 *    must install an immutable copy of the built plugin and REMOVE the old one,
 *    because two live copies cannot both own `/dsh-suite-store/api/*`.
 * 4. Answer honestly when the composition has no `pluginManager`: the store
 *    still browses, but it says so instead of failing on the first click.
 *
 * Two composition rules are load-bearing here:
 *
 * - **`inject` names `webServer` and `pluginManager`.** Both are structural:
 *   the page needs somewhere to live, and installing is the plugin's only
 *   verb. Cordis also throws on reading a service a plugin did not declare,
 *   so leaving `pluginManager` out would not degrade gracefully — it would
 *   throw at mount.
 * - **No top-level `await` on the network.** The first catalog fetch is
 *   kicked off but not awaited: a slow registry must not delay the boot of the
 *   host that is about to serve its own UI.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { CatalogService } from './catalog/service.ts'
import { DetailLoader } from './catalog/detail.ts'
import { FileSnapshotStore } from './catalog/snapshot-file.ts'
import { catalogPlan } from './catalog/sources.ts'
import { NodeTransport, type Transport } from './catalog/transport.ts'
import { connectHost } from './install/host.ts'
import { STATE_DIRECTORY, createFileInstallStore } from './install/store.ts'
import { configurePersistentLog, logEvent } from './log/log.ts'
import { storeRoutes, ROUTE_PREFIX, type StoreApi } from './server/routes.ts'
import { StoreService } from './store.ts'
import { CuratedIndex } from './submission/curated.ts'

/** The plugin's configuration, as written in `cordis.patch.yml`. */
export interface Config {
  /** npm registry named by the host, used as the first registry fallback. */
  registry?: string
  /**
   * Read the catalog from this file instead of the network.
   *
   * For a self-hosted mirror and for previewing an unpublished catalog build.
   * When set it is the ONLY source: silently falling back to the CDN after a
   * local read fails would install a different catalog than the one the
   * operator pointed at.
   */
  catalogFile?: string
  /**
   * Interface language for catalog text.
   *
   * Accepted for forward compatibility only: the SERVER does not collapse
   * bilingual fields today (the browser resolves them itself, see `copy.ts`),
   * so setting this changes nothing on screen. Kept rather than deleted because
   * a shipped profile patch file may already name it, and an unknown key is
   * silently ignored either way.
   */
  locale?: 'zh' | 'en'
  /** Per-member install budget in ms (§7.5: 300 s). */
  memberTimeoutMs?: number
  /**
   * Ceiling on one bundle's member list (§5.4).
   *
   * Defaults to 10. The reason it is configurable rather than a constant: the
   * limit comes from install cost (serial, 30–60 s per member, one operation
   * at a time, no bundle-level rollback), and those numbers will change before
   * the curation rules do. Raising it is a profile edit, not a release.
   */
  maxBundleMembers?: number
  /**
   * Print `[DBG]` lines for catalog, host and install receipts (§8.6).
   *
   * Off by default and never on in a published build, because the receipts it
   * prints carry the profile's plugin list. `DSH_SUITES_STORE_DEBUG=1` in the
   * environment also turns it on: a live host cannot be reconfigured without a
   * restart, and the receipt is the only place a host explains itself.
   */
  debug?: boolean
}

/**
 * Prefix every debug line carries (§8.6).
 *
 * The spec asks for `[DBG]` and nothing else, so the plugin's own name is not
 * folded in here — the harness already tags each line with its source, and two
 * prefixes on one line is one too many to scan.
 */
const DEBUG_PREFIX = '[DBG]'

/**
 * The plugin's name in the lines a person reads while it is misbehaving.
 *
 * These are not §8.6 debug output: a warning that the store mounted browse-only
 * is the only trace of a broken host, and it has to survive with debugging off.
 * Hence a separate prefix rather than `[DBG]` on both.
 */
const LOG_PREFIX = '[dsh-suite-store]'

/**
 * This package's version, for the log export's header.
 *
 * Read from the manifest at first use rather than imported: a JSON import needs
 * an import attribute under ESM and would be inlined into the bundle, while the
 * manifest is already on disk beside `lib/`. One read, cached, and a failure
 * says `unknown` — a missing version must never break a mount, and an export
 * that says `unknown` is still better than no export.
 *
 * @returns the version string, or `unknown`.
 */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

const PACKAGE_VERSION = packageVersion()

/**
 * Wire a {@link StoreService} to the route-level API.
 *
 * Extracted from `apply()` so the PRODUCTION adapter can be tested directly.
 * An earlier test built its own adapter that did forward the snapshot, so it
 * stayed green while this one silently dropped it — and `/api/bundles` went on
 * fetching the catalog twice in real use. The snapshot parameter on `cards()`
 * has to survive this boundary; nothing downstream can recover it.
 *
 * @param service - the live service the routes dispatch to.
 * @returns the API object handed to `storeRoutes`.
 */
export function bindApi(service: StoreService): StoreApi {
  return {
    catalog: () => service.catalog(),
    detail: (id) => service.detail(id),
    cards: (snapshot) => service.cards(snapshot),
    install: (id, request, approvedBuilds) => service.install(id, request, approvedBuilds),
    preflight: (id) => service.preflight(id),
    installMember: (bundleId, key) => service.installMember(bundleId, key),
    running: () => service.running(),
    uninstallPreview: (id) => service.uninstallPreview(id),
    uninstall: (input) => service.uninstall(input),
    memberStates: (bundleId) => service.memberStates(bundleId),
    setMemberEnabled: (id, enabled) => service.setMemberEnabled(id, enabled),
    cancel: () => service.cancel(),
    resume: (opId, approvedBuilds) => service.resume(opId, approvedBuilds),
    subscribe: (listener) => service.subscribe(listener),
    submissionInstalled: () => service.submissionInstalled(),
    submissionSearch: (query) => service.submissionSearch(query),
    capabilities: () => service.capabilities(),
  }
}

/**
 * Mount the store.
 *
 * @param ctx - the plugin's context, already guaranteed a `webServer`.
 * @param config - composition configuration (see {@link Config}).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Two different things, deliberately spelled out rather than derived:
  //
  // - `profileRootDirectory` is the DSH profile root. `createFileInstallStore`
  //   takes the ROOT and appends `.dsh-suite-store` itself, and `connectHost`
  //   needs the root to write bundle rows.
  // - `profile` is the store's own state directory, which `FileSnapshotStore`
  //   takes directly.
  //
  // These used to be computed from an overridable `stateDirectory`, and the
  // derivation could not honour the override anyway: `createFileInstallStore`
  // appends the directory name unconditionally, so the only value that
  // survived was one literally NAMED `.dsh-suite-store`, and a relative one
  // resolved against the process cwd. A setting that cannot do its job is
  // worse than no setting, so it is gone; the layout is fixed to the one value
  // the store can actually serve.
  const profileRootDirectory = profileRoot(ctx)
  const profile = join(profileRootDirectory, STATE_DIRECTORY)

  // One sink per profile, next to the install records. Configured before
  // anything else can log, so a failure during mount is itself recorded: the
  // events worth reporting most are the ones from a start that went wrong.
  const logFile = join(profile, 'log.ndjson')
  configurePersistentLog(logFile)
  logEvent('info', 'mount', `dsh-suite-store mounting (profile ${profileRootDirectory})`)
  const transport: Transport = new NodeTransport()
  const snapshotStore = new FileSnapshotStore(profile)
  const catalog = new CatalogService({
    store: snapshotStore,
    transport,
    plan: catalogPlan({
      ...(config.registry === undefined ? {} : { registry: config.registry }),
      ...(config.catalogFile === undefined ? {} : { file: config.catalogFile }),
    }),
    ...(config.maxBundleMembers === undefined ? {} : { maxMembers: config.maxBundleMembers }),
  })
  const details = new DetailLoader({ transport })
  const curated = new CuratedIndex({ transport })
  const host = connectHost(ctx, profileRootDirectory)
  const debug = config.debug === true || process.env['DSH_SUITES_STORE_DEBUG'] === '1'
  if (debug) host?.setDebug(true)
  const store = createFileInstallStore(profileRootDirectory)

  if (host === undefined) {
    // Unreachable while `pluginManager` is in `inject`, and kept as a floor:
    // a harness that renames the service would otherwise fail on the first
    // click rather than at mount, where the message can explain itself.
    ctx.logger?.warn?.(`${LOG_PREFIX} the host exposes no pluginManager; the store is browse-only`)
  }

  const service = new StoreService({
    catalog,
    details,
    host,
    store,
    curated,
    hostKind: detectHostKind(),
    ...(config.memberTimeoutMs === undefined ? {} : { memberTimeoutMs: config.memberTimeoutMs }),
  })

  // §8.6: debug output is off unless asked for, and the receipt it prints
  // carries this profile's plugin list.
  if (debug) ctx.logger?.debug?.(`${DEBUG_PREFIX} enabled; receipts will be printed`)

  // One catalog fetch, then one provenance reconcile, both unawaited: see the
  // header note on boot latency. They are chained rather than raced because
  // reconcile classifies every installed plugin against the catalog, and an
  // empty catalog answers "no bundle claims this" for all of them — which the
  // live profile turned into 197 permanent `manual` stamps on a cold start.
  // `current()` revalidates with the source; the disk copy is only a
  // conditional-request validator, not a substitute for a fresh answer.
  void catalog
    .current()
    .then(() => service.reconcile())
    .catch((error: unknown) => {
      // `warn`, not `debug`: a failed reconcile leaves on-disk plugins without
      // provenance (every uninstall sheet then reads them as `unknown`), and a
      // published build runs with `debug: false`.
      ctx.logger?.warn?.(`${LOG_PREFIX} catalog prefetch / reconcile failed: ${errorText(error)}`)
    })

  const api = bindApi(service)

  const webServer = (ctx as unknown as { webServer: WebServerLike }).webServer
  const routes = storeRoutes(api, { version: PACKAGE_VERSION, profile: profileRootDirectory, logFile })
  ctx.effect(() => {
    // One failure mode needs a loud log rather than a bare throw: a cordis
    // effect that throws leaves the routes unmounted and every
    // `/dsh-suite-store/*` request answering 404 with nothing anywhere saying
    // why. The line is written BEFORE the throw for exactly that reason.
    const disposers: (() => void)[] = []
    try {
      for (const route of routes) disposers.push(webServer.register(route))
    } catch (error) {
      // A failed mount must still release what it registered: the old handler
      // table would otherwise keep answering from a service being discarded.
      // `[...disposers].reverse()` rather than in place, so the array's order
      // is not a side effect of an error path.
      for (const dispose of [...disposers].reverse()) dispose()
      // `storeRoutes` SUBSCRIBED eagerly (before this effect ran), so the
      // subscription outlives the handlers on this path: without the dispose,
      // every failed mount — a reload racing the old copy — leaks one listener
      // forwarding every progress event into a stream set nothing owns.
      routes.dispose?.()
      logEvent('error', 'mount', `could not mount ${ROUTE_PREFIX}: ${errorText(error)}`)
      ctx.logger?.warn?.(`${LOG_PREFIX} could not mount ${ROUTE_PREFIX}: ${errorText(error)}`)
      throw error
    }
    // Reverse order on the way out, so routes that depend on others go first.
    // `routes.dispose` ends the service subscription and any open stream: the
    // route table is gone, so a surviving subscription would forward every
    // progress event to nobody, once per reload.
    return () => {
      for (const dispose of [...disposers].reverse()) dispose()
      routes.dispose?.()
      // Stop persisting on unload: a disposed plugin that keeps appending would
      // write into a profile whose owner is the next mount.
      configurePersistentLog(null)
    }
  }, `${LOG_PREFIX} routes under ${ROUTE_PREFIX}`)
  logEvent('info', 'mount', `mounted at ${ROUTE_PREFIX}`)
  ctx.logger?.debug?.(`${LOG_PREFIX} mounted at ${ROUTE_PREFIX} (state in ${profile})`)
}

/** The slice of `ctx.webServer` this plugin calls. */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (...args: never[]) => unknown }): () => void
}

/**
 * The directory DSH keeps this profile in.
 *
 * The host's own `profileContext` service is asked first, because it is the
 * only answer that cannot be wrong: it is the directory the loader composed
 * this very plugin from, and the harness passes it to the loader as a launch
 * argument. Everything else here is reconstruction, and reconstruction is what
 * put a live profile's records in the harness home instead of the profile: the
 * desktop host does not export `DSH_PROFILE_DIR` to the process that runs
 * plugins (it exports it to tool calls), so `DSH_HOME` was unset too and the
 * fallback silently chose `~/.dsh`. The store then wrote 237 `manual` records
 * to a directory the profile never reads, and every uninstall preview for a
 * plugin the store had just installed answered "unknown".
 *
 * The remaining branches stay for hosts that mount this plugin without the
 * service: `DSH_PROFILE_DIR` first (the contract for tool processes), then the
 * shorter `$DSH_HOME/profiles/$DSH_PROFILE` some launchers set, then the
 * harness home for a process started outside any profile.
 */
export function profileRoot(ctx?: Context): string {
  const fromService = serviceProfileDir(ctx)
  if (fromService !== undefined) return fromService
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && home !== '') {
    return typeof profile === 'string' && profile !== '' ? join(home, 'profiles', profile) : home
  }
  // Last resort, and loud on purpose: nothing named a profile, so this is a
  // reconstruction with no evidence behind it. Getting it wrong writes
  // provenance into a directory the profile never reads — the very bug that
  // stayed invisible for a release because this branch was silent.
  const fallback = join(homedir(), '.dsh')
  ctx?.logger?.warn?.(`${LOG_PREFIX} no profile directory found; falling back to ${fallback}`)
  return fallback
}

/**
 * The composed profile directory the host publishes as `profileContext.dir`.
 *
 * Read with `ctx.get(name, false)`: the strict form honours `inject`, and this
 * plugin must not depend on the service — a composition without it still
 * mounts, it just resolves the directory the older way.
 */
function serviceProfileDir(ctx?: Context): string | undefined {
  const reader = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown } | undefined)?.get
  if (typeof reader !== 'function') return undefined
  let service: unknown
  try {
    service = reader.call(ctx, 'profileContext', false)
  } catch {
    return undefined
  }
  const dir = (service as { dir?: unknown } | undefined)?.dir
  return typeof dir === 'string' && dir !== '' ? dir : undefined
}

/**
 * Whether this host can restart itself (§7.2).
 *
 * A desktop build has no CLI to restart, so the restart-and-verify phase is
 * skipped there and the copy must not promise it. The two cheap signals are
 * the desktop app's own env marker and Electron in `process.versions` — NOT
 * `ELECTRON_RUN_AS_NODE`, which marks a process deliberately running as plain
 * Node and would therefore misclassify a CLI host as desktop.
 */
function detectHostKind(): 'cli' | 'desktop' {
  const packaged = process.env.DSH_DESKTOP_APP === '1' || process.versions.electron !== undefined
  return packaged ? 'desktop' : 'cli'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Cordis' own plugin interface, re-exported so the patch file can name it. */
export const name = 'dsh-suite-store'

/**
 * Hard dependencies.
 *
 * `webServer` for the routes; `pluginManager` because reading a service the
 * plugin did not declare throws in Cordis, and because installing is what the
 * plugin is for. A composition without an installer therefore does not mount
 * the store at all — which is the honest outcome, since the page's only verb
 * would be a dead button.
 */
export const inject = ['webServer', 'pluginManager']
