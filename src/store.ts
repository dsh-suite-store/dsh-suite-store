/**
 * The service layer: the one object the routes and the plugin entry point
 * talk to (§7, §8).
 *
 * Everything below this file is already testable in isolation, which shapes
 * what belongs here: this is the *composition* layer, and composition is where
 * the interesting rules actually live, because they are rules about ordering
 * and about what happens when two independently-correct pieces meet.
 *
 * Four of those rules are worth stating up front, because each one is a bug
 * the obvious implementation has:
 *
 * 1. **Provenance is reconciled against the host before it is trusted.** A
 *    plugin the user installed themselves — or one a *previous* profile left
 *    behind — must not become removable just because a bundle lists the same
 *    package (§7.7). So every unknown installed plugin is marked `manual`
 *    before any bundle claim can be written.
 * 2. **The installed view is fetched once per answer, not once per card.**
 *    `listPlugins` walks the whole profile; a twelve-card page that called it
 *    twelve times would make the settings screen cost a package-manager scan.
 * 3. **A busy executor is translated into the route layer's own error.** The
 *    executor is allowed to know nothing about HTTP, so the mapping lives
 *    here: the 409 the client needs in order to "attach to the running
 *    operation" (§7.1) is built from the record the executor already holds.
 * 4. **"Installed" is decided by member identity, not by name.** §7.3's whole
 *    idempotency story rests on recognising the same member twice, and the
 *    catalog spells one install several ways (`npm:name`, `npm:name@1.2.3`,
 *    `git:owner/repo#sub`). `memberSpecId()` is the only place that knows the
 *    rule, and both the planner and this view call it.
 */

import type { DetailLoader } from './catalog/detail.ts'
import type { CatalogService } from './catalog/service.ts'
import type { CatalogSnapshot } from './catalog/sources.ts'
import type { BundleCard, BundleDetail, BundleMember } from './catalog/types.ts'
import { InstallExecutor, OperationBusyError, type InstallEvent, type InstallReport } from './install/executor.ts'
import { removalRefusal } from './install/host.ts'
import type { HostAdapter, InstalledEntry } from './install/host.ts'
import { concludeStatus, patchMember, startRemoval, type OperationRecord } from './install/operation.ts'
import {
  InstallPlanError,
  baseName,
  buildInstallPlan,
  memberSpecId,
  sameIdentity,
  type InstallPlan,
  type InstalledMember,
} from './install/plan.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installedBundles } from './install/state.ts'
import { packageGoneFromDisk, runPnpm } from './install/pnpm-runner.ts'
import { logEvent } from './log/log.ts'
import { dropProfileRows } from './install/profile-bundle.ts'
import { forgetBundleSource, recordBundleInstall, recordManualInstall, type ProvenanceEntry, type ProvenanceState } from './install/state.ts'
import type { InstallStore } from './install/store.ts'
import { planUninstall, type UninstallChoice } from './install/uninstall.ts'
import { BusyError } from './server/routes.ts'
import type { MemberStateView, UninstallReport } from './server/routes.ts'

/**
 * Everything the service needs, injected rather than imported.
 *
 * The collaborators are ports (`CatalogService`, `DetailLoader`,
 * `HostAdapter`, `InstallStore`) and the clock is a function, so the whole
 * service can be exercised against a catalog literal and a fake host without a
 * network or a package manager.
 */
export interface StoreServiceOptions {
  catalog: CatalogService
  /** Resolves a card's detail path against the source the index came from. */
  details: DetailLoader
  /** The host adapter; `undefined` when the composition has no pluginManager. */
  host: HostAdapter | undefined
  store: InstallStore
  /** The running host's kind, which decides restart behaviour (§7.2). */
  hostKind: 'cli' | 'desktop'
  /** Clock injection point; every timestamp the service writes goes through it. */
  now?: () => Date
  /** Per-member install budget in ms, forwarded to the executor (§7.5). */
  memberTimeoutMs?: number
  /** Fan-out point for install events; the SSE route subscribes here. */
  emit?: (event: ServiceEvent) => void
}

/** The service's own progress vocabulary: the executor's events plus the snapshot. */
export type ServiceEvent = InstallEvent | { type: 'snapshot'; op: OperationRecord | undefined }

/**
 * A card plus the profile's answer about it.
 *
 * The catalog and the profile are separate facts — the catalog says a bundle
 * exists, the profile says three of its twelve members are installed — and the
 * card is where they meet. Keeping them separate in the wire payload too means
 * a page that reloads mid-install can re-derive the card without refetching
 * the catalog.
 */
export interface BundleCardView extends BundleCard {
  /** How many members the host already reports as installed. */
  installedCount: number
  /** Member keys the host already has, so the detail table can mark them. */
  installedMembers: string[]
  /** True only when a run from this store installed it (provenance), not merely because members are present. */
  installedByUser: boolean
  /** True when every member is present; the button becomes 已装. */
  installed: boolean
}

export interface InstallRequest {
  bundleId: string
  /** Bundle version, from the catalog; recorded on the operation. */
  bundleVersion: string
  /** The plan to run; the caller builds it so the preflight can inspect it. */
  plan: InstallPlan
}

/** How long an inventory read is reused, in ms (three routes ask within one second). */
const INVENTORY_TTL_MS = 1_000

/** The per-member budget the spec fixes at 300 s (§7.5), unless configured. */
const DEFAULT_MEMBER_TIMEOUT_MS = 300_000

/** What the preflight sheet asks for before it can show a plan (§7.2). */
export interface PreflightSummary {
  /** Members that still need installing, in plan order. */
  steps: number
  /** Members the profile already has. */
  alreadyInstalled: number
  /** Rough estimate in seconds, from §7.2's per-member ranges. */
  estimateSeconds: number
  /** Members that will ask for a build-script approval. */
  needsBuildApproval: boolean
  /** Exact package names the host will accept as approvedBuilds. */
  pendingBuilds: string[]
  /** Each member the install will touch, for the sheet's list. */
  members: { key: string; name: string; pinnedVersion: string | null }[]
}

export class StoreService {
  private readonly catalogService: CatalogService
  private readonly details: DetailLoader
  private readonly host: HostAdapter | undefined
  private readonly store: InstallStore
  private readonly hostKind: 'cli' | 'desktop'
  private readonly now: () => Date
  private readonly listeners = new Set<(event: ServiceEvent) => void>()
  private readonly executor: InstallExecutor | undefined
  /**
   * The removal in flight, if any.
   *
   * Removals do not go through `InstallExecutor` — it installs, and its whole
   * member loop (timeouts, rollback, restart) is about adding packages. They
   * still have to be VISIBLE as an operation, because §7.7 asks for the same
   * progress stream and the same report, so the record lives here and
   * `running()` reads it before the executor's.
   */
  private removing: OperationRecord | undefined
  /** Counter behind `opId`, so two runs started in the same millisecond differ. */
  private opSeq = 0
  /**
   * Set by the cancel route while a removal runs.
   *
   * `removeBundle` has no cancellation channel, so "cancel a removal" can only
   * mean "skip the members that have not started". The uninstall loop reads
   * this between members; the finally in `uninstall()` clears it so one run's
   * flag cannot leak into the next.
   */
  private cancelRequested = false
  /** Per-member removal budget in ms (§7.5). */
  private readonly memberTimeoutMs: number
  /** Cached host inventory, invalidated by any mutation and by expiry. */
  private inventory: { at: number; entries: InstalledEntry[] } | undefined

  constructor(options: StoreServiceOptions) {
    this.catalogService = options.catalog
    this.details = options.details
    this.host = options.host
    this.store = options.store
    this.hostKind = options.hostKind
    this.now = options.now ?? (() => new Date())
    this.memberTimeoutMs = options.memberTimeoutMs ?? DEFAULT_MEMBER_TIMEOUT_MS
    if (options.emit !== undefined) this.listeners.add(options.emit)

    if (this.host !== undefined) {
      this.executor = new InstallExecutor({
        store: this.store,
        host: this.host,
        // Desktop has no CLI to restart, so the restart-and-verify phase is
        // skipped there rather than faked (§7.2, §7.6).
        capabilities: { canRestart: this.hostKind === 'cli' && this.host.capabilities().canRestart },
        // The executor stamps operation records with a second, coarser clock
        // than the service's: it needs timestamps that move between phase
        // writes so a resumed run can be told apart from the run it continues.
        // Provenance, however, must agree with the rest of this file — a test
        // that freezes the service clock would otherwise see install times from
        // the wall clock and could never assert on them.
        now: () => this.now().toISOString(),
        ...(options.memberTimeoutMs === undefined ? {} : { memberTimeoutMs: options.memberTimeoutMs }),
        emit: (event) => this.publish(event),
      })
    }
  }

  // ---------------------------------------------------------------- catalog

  /**
   * The catalog, revalidated with its source on every read.
   *
   * A failed validation rejects; the route reports it and the page offers a
   * retry. Old bytes are never served as a current answer.
   */
  async catalog(): Promise<CatalogSnapshot> {
    return this.catalogService.current()
  }

  /**
   * The bundle listing, joined with what the profile already has.
   *
   * Returned unfiltered: §8.6 puts filtering and sorting in the browser,
   * because every control on that screen would otherwise cost a round-trip
   * and a catalog refresh.
   *
   * `snapshot` is for a caller that already holds one. `/api/bundles` awaits
   * `catalog()` for the document metadata (categories, etag, source) and then
   * called this, which fetched the catalog AGAIN: `refresh()` dedupes
   * CONCURRENT callers, but these two are sequential — the first has cleared
   * its in-flight promise before the second starts — so every page load paid
   * for two round trips, and a failure in the second turned a 200 into a 503
   * even though the document had just been read successfully.
   *
   * @param snapshot - a catalog the caller already fetched; omitted, this
   *   fetches one as before.
   */
  async cards(snapshot?: CatalogSnapshot): Promise<BundleCardView[]> {
    const current = snapshot ?? await this.catalogService.current()
    const installed = await this.installedIndex()
    // Which bundles the USER installed, from this store's own provenance. A
    // bundle whose members merely happen to be present is not the same thing:
    // a hand-installed plugin, or one another suite pulled in, would otherwise
    // make this suite look installed without the user ever running it.
    const byUser = installedBundles(await this.store.readProvenance())
    return current.index.bundles.map((card) => this.view(card, installed, byUser.has(card.id)))
  }

  /**
   * One bundle's detail document.
   *
   * The card carries only the repository-relative path, because the list
   * document must stay small (§5.3). The loader resolves that path against the
   * same source the index came from and caches by catalog generation.
   */
  async detail(id: string): Promise<BundleDetail | undefined> {
    const snapshot = await this.catalogService.current()
    return this.details.load(snapshot, id)
  }

  // ---------------------------------------------------------------- install

  /**
   * What installing this bundle right now would do (§7.2 preflight).
   *
   * Building the plan is a pure function of the catalog entry and the profile,
   * so asking what would happen costs one inventory read and no side effect.
   * The sheet needs that answer BEFORE the user commits — how many members,
   * which are already there, how long it will take (§7.2 point 4).
   *
   * The estimate is a range in §7.2 (20–40 s per member on a CLI host, 30–60 s
   * on desktop); this reports the LOW end and the sheet shows it as "至少",
   * because an estimate that overshoots makes users retry a healthy install.
   */
  async preflight(id: string): Promise<{ summary: PreflightSummary; plan: InstallPlan }> {
    const plan = await this.prepare(id)
    const perMember = this.hostKind === 'cli' ? 20 : 30
    // The names the HOST will accept, not the catalog's member labels: the
    // host validates each one against its own pending list and rejects a
    // label it does not know as `stale-approval`. Reading the same two
    // sources keeps the sheet and the host agreeing on what is approved.
    const fromFile = await this.store.pendingBuilds()
    const fromRefusals = this.refusedBuildKeys(await this.store.listOperations())
    const pending = [...new Set([...fromFile, ...fromRefusals])]
    return {
      summary: {
        steps: plan.steps.length,
        alreadyInstalled: plan.skipped.length,
        estimateSeconds: plan.steps.length * perMember,
        // A pending key IS the question. The catalog's flag can only say
        // "this member declares capabilities that imply a build script", and a
        // git-hosted member that pnpm refused to prepare carries no such flag
        // while its key sits in the list — requiring both hid the approval
        // button for exactly the case it was added for.
        needsBuildApproval: pending.length > 0,
        pendingBuilds: pending,
        members: plan.steps.map((step) => ({ key: step.key, name: step.name, pinnedVersion: step.pinnedVersion })),
      },
      plan,
    }
  }

  /**
   * The plan for one bundle, or the reason there is nothing to do.
   *
   * Shared by the preflight and by a one-click install, so the sheet and the
   * run can never disagree about what will happen.
   */
  /**
   * Build keys recorded by a member that pnpm refused to prepare.
   *
   * Read from the newest failure per key: an older record still names the
   * commit that was current when it failed, and approving a stale key makes the
   * retry fail identically — so keep the key pnpm printed rather than deriving
   * one.
   */
  private refusedBuildKeys(records: readonly OperationRecord[]): string[] {
    // Keyed by PACKAGE NAME, not by the key string: pnpm prints the same
    // dependency as `…@https://codeload…/tar.gz/<sha>` on one run and as
    // `…@git+https://…#<sha>` on another, and offering both asked the reader to
    // approve one package twice. The newest record wins because it names the
    // commit the next attempt will fetch.
    const newest = new Map<string, string>()
    for (const record of records) {
      for (const member of record.members) {
        const key = member.failure?.buildKey
        if (key === undefined) continue
        // `lastIndexOf('@')` is -1 for a key with no version separator, and
        // `slice(0, -1)` then silently drops the last character; at 0 it yields
        // `''` for a bare scoped key. Both mis-group every such key into one
        // map entry (and offer a bogus empty approval). `baseName` and
        // `allowBuildKeyFromDepPath` already guard the same index.
        const at = key.lastIndexOf('@')
        const name = at > 0 ? key.slice(0, at) : key
        if (!newest.has(name)) newest.set(name, key)
      }
    }
    return [...newest.values()]
  }

  private async prepare(id: string, approvedBuilds: readonly string[] = []): Promise<InstallPlan> {
    const detail = await this.detail(id)
    if (detail === undefined) throw new Error(`no bundle named ${id}`)
    const installed = await this.installed()
    return buildInstallPlan({
      detail,
      installed: installed.map((entry): InstalledMember => toMember(entry)),
      // §7.2 asks once, before the run. A member whose build script was not
      // approved stays `skipped-build-denied` rather than being run silently:
      // pnpm would refuse it anyway, and asking after the fact is a dialog in
      // the middle of a long operation.
      approvedBuilds,
    })
  }

  /**
   * Start installing one bundle from its catalog entry.
   *
   * Returns once the operation is RUNNING, not once it is finished.
   *
   * That is the whole point of the shape: a ten-member suite takes 5–10
   * minutes, and an HTTP response held open that long is one the browser
   * abandons first — the page then showed "Failed to fetch" for an install
   * that was still writing to disk, which is the worst of the two lies
   * available. The final report is not lost: every phase is emitted on the
   * progress stream, and the record is persisted per member, so the panel and
   * a reload both see the real outcome (§7.5).
   *
   * @param id - the bundle the user clicked.
   * @param request - the plan the preflight confirmed; omitted when the click
   *   itself is the confirmation (one-click install from a card).
   */
  async install(
    id: string,
    request: InstallRequest | undefined = undefined,
    approvedBuilds: readonly string[] = [],
  ): Promise<OperationRecord> {
    // The busy check comes FIRST, before any await. Two POSTs in the same tick
    // both pass a check that runs after theirs, and the second would only find
    // out from the executor — by which time the first has already started the
    // package manager, and the 409 the client uses to attach (§7.1) arrives as
    // an opaque rejection.
    this.requireIdle()
    const executor = this.requireExecutor()
    const detail = await this.detail(id)
    if (detail === undefined) throw new Error(`no bundle named ${id}`)
    // A client-confirmed plan is honoured as a LIST OF MEMBERS, not as a list of
    // installs: the route layer can only shape-check the browser's JSON, and
    // `step.spec` plus `step.approvedBuilds` are what the executor actually
    // runs. Echoing them verbatim let a caller send a real catalog key with a
    // forged spec — or with build approvals the user never gave — and have it
    // installed under this bundle's provenance. So the caller decides WHICH
    // members, and the catalog decides WHAT each one is.
    if (request !== undefined) {
      const authoritative = await this.prepare(id, approvedBuilds).catch((error: unknown) => {
        // A sheet left open while another run finished everything is not a
        // server error: it is the same "nothing to install" answer the fresh
        // path gives.
        if (error instanceof InstallPlanError && error.reason === 'nothing-to-do') return undefined
        throw error
      })
      const allowed = new Map((authoritative?.steps ?? []).map((step) => [step.key, step]))
      const narrowed = request.plan.steps.flatMap((step) => {
        const trusted = allowed.get(step.key)
        return trusted === undefined ? [] : [trusted]
      })
      if (narrowed.length === 0) throw new Error(`no installable members for ${id}`)
      // ALWAYS the rebuilt steps, never the caller's objects. Guarding this
      // with "only when the list got shorter" let a forged spec through
      // whenever the caller kept a matching number of legitimate keys — which
      // is exactly the attack the check exists to stop.
      request = { ...request, plan: { ...request.plan, steps: narrowed } }
    }
    const plan = request?.plan ?? (await this.prepare(id, approvedBuilds))
    this.requireIdle()
    // Deliberately not awaited: `start()` resolves with the report at the END
    // of the run. The rejection is still handled, because an unhandled one
    // would take the host down; the panel learns the outcome from the stream.
    void executor.start({
      bundleId: detail.id,
      bundleVersion: request?.bundleVersion ?? detail.version,
      plan,
      hostKind: this.hostKind,
    }).then(
      () => { this.inventory = undefined },
      (error: unknown) => {
        // A start that threw AFTER emitting op-start left the record on disk
        // with no terminal event: the panel would freeze on the stale record
        // and the client would show a run that never ends. Concluding it here
        // keeps the record as honest as the persisted file can be.
        const record = executor.running
        if (record !== undefined && isLive(record)) {
          this.publish({ type: 'op-end', op: { ...record, status: 'partial', reason: errorText(error) } })
        }
        this.inventory = undefined
      },
    )
    // The record exists synchronously inside `start()` before its first await
    // (it is what the busy check reads), so this is the operation just begun.
    const started = executor.running
    if (started === undefined) throw new Error(`install of ${id} did not start`)
    return started
  }

  /**
   * Install exactly one member of a bundle (§8.3).
   *
   * The member table's per-row install button exists because a suite is a
   * list of independent plugins: a user who only wants the search plugin
   * should not have to take the whole bundle, and a member that failed on the
   * last run should be retryable on its own.
   *
   * The run is still an ordinary install operation with one step, so it gets
   * the same serial execution, the same per-member rollback and the same
   * report — there is no second code path.
   */
  async installMember(bundleId: string, key: string): Promise<InstallReport> {
    this.requireIdle()
    const executor = this.requireExecutor()
    const detail = await this.detail(bundleId)
    if (detail === undefined) throw new Error(`no bundle named ${bundleId}`)
    const plan = await this.prepare(bundleId)
    const step = plan.steps.find((candidate) => candidate.key === key)
    if (step === undefined) {
      // Either the key is not in the catalog document or the member is already
      // installed (the planner skips those). Both mean "nothing to install",
      // and starting an empty operation would show the panel finishing nothing.
      throw new Error(`${key} is already installed or not a member of ${bundleId}`)
    }
    this.requireIdle()
    try {
      const report = await executor.start({
        bundleId: detail.id,
        bundleVersion: detail.version,
        plan: { steps: [step], skipped: [] },
        hostKind: this.hostKind,
      })
      this.inventory = undefined
      return report
    } catch (error) {
      if (error instanceof OperationBusyError) throw new BusyError(error.message, error.operation)
      throw error
    }
  }

  /**
   * The operation in flight, if any.
   *
   * A removal is reported before the executor's record: only one operation may
   * run at a time (§7.1), so two would mean a bug, and the removal is the one
   * the user just started.
   */
  running(): OperationRecord | undefined {
    if (this.removing !== undefined) return this.removing
    return this.executor?.running
  }

  /** Ask the running install to stop after its current member (§7.5). */
  async cancel(): Promise<boolean> {
    // A removal cannot be stopped mid-member, but its unstarted members are
    // skipped: the flag is recorded rather than refused, and the finally in
    // `uninstall()` clears it. Pretending a removal is untouchable made the
    // stop button lie about a run the page can see.
    if (this.removing !== undefined) {
      this.cancelRequested = true
      return true
    }
    if (this.executor === undefined) return false
    return this.executor.requestCancel()
  }

  // -------------------------------------------------------------- uninstall

  /** What removing this bundle would mean, before anything is removed (§7.7). */
  async uninstallPreview(id: string): Promise<UninstallChoice[]> {
    const detail = await this.detail(id)
    if (detail === undefined) throw new Error(`no bundle named ${id}`)
    // Reconcile first, exactly as an install does: a member that arrived with
    // the bundle but was never recorded (an interrupted run, a profile copied
    // from another machine) would otherwise be reported as `unknown` and left
    // unchecked — telling the user "this is not ours to remove" about the very
    // plugin they are looking at on the card.
    await this.reconcile()
    const state = await this.store.readProvenance()
    const present = await this.installedIndex()
    // Only members that are actually on disk become checkboxes: a member that
    // is not installed has nothing to remove, and offering it would suggest
    // the uninstall could also fix that.
    //
    // Presence goes through `isPresent` rather than a direct `Map` lookup for
    // the same reason the card does: a pinned member's identity carries its
    // version (`npm:cc-safety-net@2.7.8`) while the host reports the package
    // (`npm:cc-safety-net`), so an exact lookup found nothing and the preview
    // offered an empty dialog for a bundle the user had just installed.
    const removable = detail.members
      .filter((member) => this.isPresent(member, present))
      .map((member) => ({
        id: memberSpecId(member),
        ...(member.version === null ? {} : { version: member.version }),
      }))
    return planUninstall({ bundleId: id, installed: removable, provenance: state })
  }

  /**
   * Every member's presence and switch state for the sheet's member table (§8.3).
   *
   * Reads the profile once and answers for all members, rather than one call per
   * row: the table draws every row at the same instant and a per-row round trip
   * would let members disagree about which profile state they describe.
   *
   * A member that is not present gets no `enabled` value at all. Reporting
   * `enabled: false` there would render as "switched off", which is the one
   * reading the member table must not produce — the plugin is not there.
   */
  async memberStates(bundleId: string): Promise<MemberStateView[]> {
    const detail = await this.detail(bundleId)
    if (detail === undefined) throw new Error(`no bundle named ${bundleId}`)
    await this.reconcile()
    const present = await this.installedIndex()
    // Concurrently, not one member after another: each `enabledState` is an
    // independent host read, and a ten-member bundle paid ten serial round
    // trips before the table could render. `Promise.all` preserves the plan
    // order the caller renders in.
    return Promise.all(detail.members.map(async (member): Promise<MemberStateView> => {
      const id = memberSpecId(member)
      if (!this.isPresent(member, present)) return { key: member.key, id, present: false }
      // The adapter asks the host, which is the only place that knows: the
      // profile patch can carry a `disabled:` line added by another tool.
      const enabled = await this.host?.enabledState(id)
      return { key: member.key, id, present: true, ...(enabled === undefined ? {} : { enabled }) }
    }))
  }

  /**
   * Turn one installed member on or off without removing it (§8.3).
   *
   * Deliberately narrow: it changes the switch and nothing else. §7.7's
   * asymmetry applies here too — a control that also touched provenance or the
   * install record would make "off" a state the uninstall preview had to know
   * about, and it does not.
   */
  async setMemberEnabled(id: string, enabled: boolean): Promise<boolean> {
    const host = this.host
    if (host === undefined) throw new Error('this host cannot enable or disable plugins')
    this.requireIdle()
    await host.setEnabled(id, enabled)
    // The cached inventory carries `enabled` for the card badges; a switch the
    // user just flipped would otherwise be undone by the next cards() call.
    this.inventory = undefined
    // `setEnabled` resolves only once the profile reports the requested state,
    // so the settled state IS the requested one. Returning its `true` here would
    // have the route answer `enabled: true` for a switch that was just turned
    // off — the one sentence the sheet must not get wrong (§8.3).
    return enabled
  }

  /**
   * Remove exactly the plugins the user checked.
   *
   * The checkboxes are the contract: this method never widens the list on its
   * own — "the user said remove these three" is not a hint to remove eleven.
   * A failure part-way through keeps what already succeeded, because an
   * uninstall that stops on the first error would leave the profile in a state
   * the user did not ask for and cannot see.
   *
   * §7.7 asks for a removal to be "serial, with per-member rollback and its own
   * report" the way an install is, and the live host showed why that matters:
   * the first run answered HTTP 200 with an empty `removed` array while three
   * packages stayed on disk, because `removeBundle` RESOLVES for a refusal and
   * only the inventory can tell. So the run is published as an operation from
   * the first member to the last, and each member's outcome is both streamed
   * and reported.
   */
  async uninstall(input: { bundleId: string; ids: readonly string[] }): Promise<UninstallReport> {
    const host = this.host
    const remove = host?.manager.removeBundle
    if (host === undefined || remove === undefined) throw new Error('this host cannot remove plugins')
    // Same rule as `install()`: refuse before any await, or two clicks in one
    // tick both get past a check that runs after theirs.
    this.requireIdle()
    // The lock is taken BEFORE the first await, not after: `detail()` yields
    // to the event loop, and a cancel (or a second uninstall) that arrived
    // inside that gap used to see "nothing running". The placeholder record
    // is filled in with the real bundle version once the document loads; the
    // opId comparison below tells our own reservation from a rival's.
    const startedAt = this.now().toISOString()
    const opId = `op-${startedAt.replace(/[^0-9]/gu, '')}-${this.opSeq++}`
    this.removing = {
      ...startRemoval({
        opId,
        bundleId: input.bundleId,
        bundleVersion: '0.0.0',
        hostKind: this.hostKind,
        ids: input.ids,
        now: startedAt,
      }),
      status: 'preflight',
    }
    // The bundle document is read BEFORE the run, while the reservation is
    // still ours. Two things depend on it: the recorded bundle version, and
    // the membership check below — without that check a caller can POST this
    // bundle's id plus the id of any unrelated installed plugin and have it
    // removed under this bundle's provenance, which `install()` and
    // `uninstallPreview()` both refuse to allow.
    let detail: BundleDetail | undefined
    try {
      detail = await this.detail(input.bundleId)
      if (detail === undefined) throw new Error(`no bundle named ${input.bundleId}`)
    } catch (error) {
      // This path is outside the run's own `finally`, so the reservation has to
      // be released here: a failed catalog read used to leave `removing` live
      // forever, and every later install/uninstall/switch answered 409.
      if (this.removing?.opId === opId) {
        this.removing = undefined
        this.cancelRequested = false
      }
      throw error
    }
    if (this.removing === undefined || this.removing.opId !== opId) {
      // Someone else holds the lock now (our finally below will not run on
      // this path, and the rival's own cleanup owns `removing`).
      throw new Error('another operation took the removal lock')
    }
    // Every requested id must be a member of THIS bundle. `sameIdentity`, not
    // string equality: the host reports `npm:beta@1.0.0` where the catalog says
    // `npm:beta`, and both name the same install.
    const identities = detail.members.flatMap((member) => [member.id, memberSpecId(member)])
    const strangers = input.ids.filter((id) => !identities.some((identity) => sameIdentity(identity, id)))
    if (strangers.length > 0) {
      this.removing = undefined
      this.cancelRequested = false
      throw new Error(`${strangers.join(', ')} is not a member of ${input.bundleId}`)
    }
    const startedRecord = startRemoval({
      opId,
      bundleId: input.bundleId,
      bundleVersion: detail.version,
      hostKind: this.hostKind,
      ids: input.ids,
      now: startedAt,
    })
    // `try` wraps the WHOLE run, not one member: `publish()` and the
    // provenance write sit outside the per-member catch, and either of them
    // throwing left `this.removing` live forever — every later install,
    // uninstall and switch answered 409 until the host restarted. The finally
    // below is what guarantees the lock comes back.
    try {
      this.removing = { ...startedRecord, status: 'preflight' }
      this.publish({ type: 'op-start', op: this.removing })
      await this.store.writeOperation(this.removing)
      // The start, in the exportable log. A report that says "I clicked
      // uninstall" without naming the bundle and the members cannot be matched
      // against the plugin the reader is complaining about.
      logEvent('info', 'uninstall', `${opId} ${input.bundleId} starting (${input.ids.join(', ')})`)

      let current: OperationRecord = { ...this.removing, status: 'installing' }
      this.removing = current
      this.publish({ type: 'op-phase', op: current, phase: 'installing' })

      for (const [index, id] of input.ids.entries()) {
        // A removal cannot be interrupted mid-member, but a stop asked before
        // an untouched member starts is honoured the way an install's is.
        if (this.cancelRequested) {
          // Same three things the normal path below does, plus the flag: the
          // live event is what repaints the row (without it the panel sat on
          // the old state until `op-end`), the write is what makes a reload
          // agree, and `cancelRequested` is what lets `concludeStatus()` say
          // `cancelled` instead of reporting an all-skipped run as `done`.
          current = { ...patchMember(current, id, { state: 'skipped' }), cancelRequested: true }
          this.removing = current
          const skipped = current.members.find((member) => member.key === id)
          if (skipped !== undefined) {
            this.publish({ type: 'member-done', opId: current.opId, member: skipped, op: current })
          }
          // A member that never started is still a fact a report needs: "it
          // said 2 members and only removed 1" has no other explanation.
          logEvent('info', 'uninstall', `${opId} ${id}: skipped (run stopped before it started)`)
          await this.store.writeOperation(current)
          continue
        }
        current = patchMember(current, id, { state: 'running', phase: 'remove' })
        this.removing = current
        this.publish({ type: 'member-start', opId: current.opId, key: id, index, total: input.ids.length, op: current })
        try {
          // §7.5 budgets removals at the same 300 s as installs, and
          // `removeBundle` has no cancellation channel — so the budget is
          // enforced here rather than by asking the host to stop. Without it
          // one hung removal held the global lock forever (§7.1).
          await this.withRemovalTimeout(this.removeBy(host, id))
          current = patchMember(current, id, { state: 'ok', phase: 'remove' })
          // The claim goes with the plugin. Leaving it would make the next
          // preview offer a checkbox for something that is not on disk, and a
          // reinstall would inherit a source pointing at a bundle the user just
          // removed it from. `forgetBundleSource` drops only OUR claim, so a
          // plugin the user also installed by hand keeps its `manual` source.
          // Serialized with install and reconcile: a claim added while this
          // removal was running must not be overwritten.
          await this.store.updateProvenance((state) =>
            forgetBundleSource(state, { id, bundleId: input.bundleId }))
        } catch (error) {
          const reason = errorText(error)
          // A removal the running session cannot finish is not a failure: the
          // plugin is disabled and the next start will not compose it. Saying
          // `failed` there sent the reader looking for a problem to repair.
          if (error instanceof NeedsRestartError) {
            current = patchMember(current, id, {
              state: 'needs-restart',
              failure: { key: id, phase: 'remove', type: 'remove-failed', reason, cause: 'needs-restart' },
            })
            // `warn`: nothing is broken and there is no repair to make, but the
            // reader still has to know a restart is what finishes it.
            logEvent('warn', 'uninstall', `${opId} ${id}: needs-restart — ${reason}`)
          } else {
            current = patchMember(current, id, {
              state: 'failed',
              failure: { key: id, phase: 'remove', type: 'remove-failed', reason },
            })
            // The line that makes a failure report actionable: the phase, the
            // error's own type when it has one, and the host's sentence. A bare
            // "failed" sends a maintainer hunting for a cause they cannot see.
            logEvent(
              'error',
              'uninstall',
              `${opId} ${id}: failed (remove-failed`
              + `${error instanceof Error && error.name !== 'Error' ? `, ${error.name}` : ''}`
              + `) — ${reason}`,
            )
          }
        }
        this.removing = current
        // The record rides along: the panel redraws a member row from `op`, and
        // a `member-done` without one is dropped as "about an operation this page
        // never knew about" (§7.5's client rule).
        const done = current.members.find((member) => member.key === id)
        if (done !== undefined) this.publish({ type: 'member-done', opId: current.opId, member: done, op: current })
        // The success line. Written here rather than in the `try` because the
        // verdict is what matters, and a member that threw has already logged.
        if (done?.state === 'ok') logEvent('info', 'uninstall', `${opId} ${id}: ok`)
        await this.store.writeOperation(current)
      }

      if (input.ids.some((id) => {
        const member = current.members.find((entry) => entry.key === id)
        return member?.state === 'ok'
      })) this.inventory = undefined
      current = { ...current, status: concludeStatus(current), updatedAt: this.now().toISOString() }
      this.removing = current
      this.publish({ type: 'op-end', op: current })
      await this.store.writeOperation(current)
      const removed = current.members.filter((member) => member.state === 'ok').map((member) => member.key)
      const failed = current.members
        .filter((member) => member.state === 'failed' && member.failure !== undefined)
        .map((member) => ({ id: member.key, reason: member.failure!.reason }))
      // The outcome in one line, so a report is readable without counting
      // bullets. `needs-restart` is counted separately because it is neither a
      // removal nor a failure — the plugin is still on disk until the restart.
      const restarting = current.members.filter((member) => member.state === 'needs-restart').length
      const skippedCount = current.members.filter((member) => member.state === 'skipped').length
      logEvent(
        failed.length > 0 ? 'error' : 'info',
        'uninstall',
        `${opId} ${input.bundleId} ${current.status}: ${String(removed.length)} removed`
        + `, ${String(failed.length)} failed`
        + (restarting === 0 ? '' : `, ${String(restarting)} needing a restart`)
        + (skippedCount === 0 ? '' : `, ${String(skippedCount)} skipped`)
        + (failed.length === 0 ? '' : ` — ${failed.map((entry) => `${entry.id}: ${entry.reason}`).join('; ')}`),
      )
      return { bundleId: input.bundleId, removed, failed }
    } finally {
      // Keep a finished removal as history for one snapshot read, then drop it:
      // `running()` is what the progress stream's reconnect path asks, and a
      // completed record would otherwise be re-announced as live forever. The
      // finally is the point: a throw from a publish or a provenance write must
      // not leave a live record behind as the lock.
      this.removing = undefined
      this.cancelRequested = false
    }
  }

  /**
   * Budget one removal at the member timeout (§7.5: 安装/卸载各 300 s).
   *
   * `removeBundle` has no cancel channel, so an overdue removal is ABANDONED,
   * not cancelled: the member is recorded failed with the timeout reason and
   * the run continues. The underlying promise is left running — its eventual
   * answer has nowhere to land — which is the honest reading of "the host did
   * not answer within its budget".
   */
  private async withRemovalTimeout(promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`removal exceeded ${Math.round(this.memberTimeoutMs / 1000)}s`)), this.memberTimeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Retry the failed and never-started members of a persisted operation (§7.5).
   *
   * The record on disk is the truth about what already happened: members that
   * finished keep their state, and only `failed` / `pending` / `running`
   * (interrupted mid-install) steps are retried. The plan is REBUILT from the
   * catalog, not echoed from the client, so a resume cannot be aimed at specs
   * the bundle never listed.
   */
  async resume(opId: string, approvedBuilds: readonly string[] = []): Promise<OperationRecord> {
    this.requireIdle()
    const executor = this.requireExecutor()
    const stored = await this.store.readOperation(opId)
    if (stored === undefined) throw new Error(`no record named ${opId}`)
    if (stored.kind === 'uninstall') throw new Error(`operation ${opId} is a removal and cannot be resumed`)
    // A cancelled run whose members never started is exactly what §7.5's
    // continue is for: the record is terminal, but its pending rows are
    // unfinished work. Refusing it would make the flag in the UI dead.
    const unfinished = stored.members.some((member) => (
      member.state === 'pending' || member.state === 'failed' || member.state === 'running'
    ))
    if (!isLive(stored) && stored.status !== 'partial' && !unfinished) {
      throw new Error(`operation ${opId} is ${stored.status} and has no unfinished members`)
    }
    const detail = await this.detail(stored.bundleId)
    if (detail === undefined) throw new Error(`no bundle named ${stored.bundleId}`)
    const plan = await this.prepare(stored.bundleId, approvedBuilds)
    this.requireIdle()
    void executor.resume(stored, plan, []).then(
      () => { this.inventory = undefined },
      (error: unknown) => {
        const record = executor.running
        if (record !== undefined && isLive(record)) {
          this.publish({ type: 'op-end', op: { ...record, status: 'partial', reason: errorText(error) } })
        }
        this.inventory = undefined
      },
    )
    const started = executor.running
    if (started === undefined) throw new Error(`resume of ${opId} did not start`)
    return started
  }

  /**
   * Ask the host to remove one plugin, trying the names it might know it by.
   *
   * The host's `removeBundle(name)` reports success for a name it did not
   * actually have (the live manager answers without complaint for unknown
   * plugins), so a single attempt cannot tell "removed" from "never existed".
   * The inventory is the only honest source: after each attempt, ask whether
   * the plugin is still there and try the next spelling only if it is.
   *
   * @throws when the plugin is still present after every spelling was tried,
   *   so the caller records a real failure instead of a phantom success.
   */
  private async removeBy(host: HostAdapter, id: string): Promise<void> {
    const remove = host.manager.removeBundle
    if (remove === undefined) throw new Error('this host cannot remove plugins')
    // The member identity the catalog declares, `git:` intact. `id` reaching
    // here is usually `memberSpecId()`'s output, which has already shed the
    // prefix — and without it `sameIdentity` cannot tell that the manifest's
    // `dsh-perlica-ding` and this `117BS/dsh-perlica-ding` are the same
    // package. The uninstall plan carries the authoritative spelling.
    const spec = this.catalogMemberSpec(id)
    // A package listed in `dsh.profile.bundles` is a REQUIRED layer, and
    // `removeBundle` answers `not-removable` for it — silently. Dropping the
    // row first is what lets the host actually retire the package; without it
    // the receipt reads as success while the dependency, the files and the row
    // all survive (§16.5, measured on a git-hosted member).
    host.releaseBundleRow?.(id)
    // The spellings to try, best first. `baseName` handles `npm:`/`@version`,
    // but a git member's package name (`dsh-perlica-ding`) is neither its
    // catalog id (`git:117BS/dsh-perlica-ding`) nor `baseName`'s answer
    // (`117BS/dsh-perlica-ding`), so the inventory's own report and the
    // profile manifest are asked as well — `removeBundle` only takes a name
    // the manager recognises.
    const candidates = [...new Set([
      ...(await this.hostNamesFor(id, spec)),
      baseName(id),
      id,
      ...(host.profileDirectory === undefined ? [] : [this.installedPackageName(host.profileDirectory, id, spec)]),
    ].filter((name): name is string => name !== undefined && name !== ''))]
    let lastReason = `the host did not remove ${id}`
    for (const candidate of candidates) {
      try {
        // The receipt is the host's own account of the removal. `removeBundle`
        // RESOLVES for a no-op — it answers `{changed, application, error}`
        // rather than rejecting (see `change()` in the host's plugin manager),
        // so a "did nothing" removal looks like success from the call site and
        // the inventory check below is what catches it. Keeping the receipt's
        // reason is what makes the failure readable instead of the generic
        // "did not remove" the user would otherwise see.
        const receipt = await remove.call(host.manager, candidate)
        const refusal = removalRefusal(receipt)
        if (refusal !== undefined) lastReason = refusal
      } catch (error) {
        lastReason = errorText(error)
        continue
      }
      this.inventory = undefined
      let stillThere = false
      try {
        stillThere = await host.has(id) || this.stillOnDisk(host, id, spec)
      } catch {
        // A host that cannot answer is assumed to still hold the plugin: an
        // unverified removal must not be reported as a removal.
        stillThere = true
      }
      if (!stillThere) return
    }
    // Every spelling was refused and the plugin is still present. A host will
    // not take a plugin out of the process that already loaded it — but the
    // package manager is under no such restriction, and this store knows the
    // profile directory. Disabling first stops the running session from
    // composing it; `pnpm remove` then edits the manifest and deletes the
    // files, which the host itself will not do.
    const disabled = await host.setEnabled(id, false).catch(() => false)
    if (host.profileDirectory === undefined) {
      if (disabled) throw new NeedsRestartError(lastReason)
      throw new Error(lastReason)
    }
    const name = this.installedPackageName(host.profileDirectory, id, spec)
    if (name === undefined) {
      if (disabled) throw new NeedsRestartError(lastReason)
      throw new Error(lastReason)
    }
    const result = await runPnpm(['remove', name], host.profileDirectory)
    this.inventory = undefined
    // The pnpm fallback is the path that quietly disagrees with the host most
    // often (a no-op `already up to date`, a lock, a shim that never started),
    // so both verdicts are recorded with the package manager's own words.
    logEvent(
      packageGoneFromDisk(host.profileDirectory, name) ? 'info' : 'error',
      'uninstall',
      `${id} via pnpm remove ${name}: exit ${String(result.exitCode)}`
      + (result.timedOut ? ' (timed out)' : '')
      + (result.stderr === '' ? '' : ` — ${result.stderr.slice(-300)}`),
    )
    if (packageGoneFromDisk(host.profileDirectory, name)) {
      // Gone from disk: drop the dependency row the manifest may still carry
      // (a half-finished pnpm run leaves it behind) and report success.
      dropProfileRows(host.profileDirectory, name)
      return
    }
    // Still there: report the removal as needing a restart, with the reason
    // pnpm gave if it said anything.
    const why = result.exitCode !== 0
      ? `${lastReason}; pnpm remove exited ${String(result.exitCode)}`
      : lastReason
    throw new NeedsRestartError(why)
  }

  /**
   * The catalog's own spelling of a member, `git:`/`npm:` prefix intact.
   *
   * The uninstall plan hands over `memberSpecId()`'s output for a git member
   * (`117BS/dsh-perlica-ding`), and every identity question downstream needs
   * the prefix to know that the manifest's `dsh-perlica-ding` is the same
   * package. Asking the catalog is exact; guessing from the stripped form is
   * not.
   *
   * @param id - the member identity the caller holds.
   * @returns the catalog's spec, or `id` when no bundle still declares it.
   */
  private catalogMemberSpec(id: string): string {
    try {
      const snapshot = this.catalogService.peek?.()
      for (const bundle of snapshot?.index.bundles ?? []) {
        for (const member of bundle.members) {
          if (member.id === id || memberSpecId(member) === id) return member.spec
        }
      }
    } catch {
      // A catalog that cannot be read is no evidence; the caller's own
      // spelling still gets its turn.
    }
    return id
  }

  /**
   * Whether the profile still holds this member's files or dependency row.
   *
   * `host.has()` reads `listPlugins()`, which stops naming a plugin once the
   * host has retired its loader entry — measured on a git member whose
   * directory and `github:` dependency row survived a "successful" removal.
   * Disk is the authority the host's own answer is not (§16.5).
   */
  private stillOnDisk(host: HostAdapter, id: string, spec = id): boolean {
    const dir = host.profileDirectory
    if (dir === undefined) return false
    const name = this.installedPackageName(dir, id, spec)
    if (name === undefined) return false
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, unknown>
      }
      return Object.hasOwn(manifest.dependencies ?? {}, name)
    } catch {
      // An unreadable manifest is not evidence of removal.
      return true
    }
  }

  /**
   * The names the host itself reports for one member identity.
   *
   * `removeBundle` only acts on a name the manager recognises, and a git
   * install is listed under its package name (`dsh-perlica-ding`) while the
   * catalog names it `git:117BS/dsh-perlica-ding`. Passing only the catalog
   * spelling made the removal a silent no-op, which the store then reported as
   * a failed uninstall even though the host could have removed it.
   *
   * Reads the service's own cached inventory rather than the host's, so the
   * list route's short-lived cache is not bypassed by a removal.
   *
   * @param id - the identity the caller holds.
   * @returns every reported spelling that names this member, best first.
   */
  private async hostNamesFor(id: string, spec = id): Promise<string[]> {
    try {
      const installed = await this.installed()
      return installed
        .map((entry) => entry.id)
        .filter((name) => sameIdentity(name, spec) || sameIdentity(name, id))
    } catch {
      // An unreadable inventory is no evidence; the caller's other spellings
      // still get their turn.
      return []
    }
  }

  /**
   * The package name this identity refers to, as the profile manifest spells it.
   *
   * A git member arrives as owner/repo while the dependency is @owner/repo
   * (scoped, lowercased), so the manifest's own dependency list is the only
   * place that knows the right spelling — `pnpm remove` of a name it does not
   * recognise would be a no-op.
   */
  private installedPackageName(profileDir: string, id: string, spec = id): string | undefined {
    try {
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, unknown>
      }
      const names = Object.keys(manifest.dependencies ?? {})
      // Compare against BOTH spellings: `spec` still carries the `git:`
      // prefix the manifest match needs, and `id` covers a caller that
      // already had the full form.
      return names.find((name) => sameIdentity(name, spec) || sameIdentity(name, id)) ?? baseName(spec)
    } catch {
      return baseName(spec)
    }
  }

  // --------------------------------------------------------------- observed

  /** Follow progress events; the disposer is what the SSE route returns. */
  subscribe(listener: (event: ServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Which host this is, for the capability-dependent copy (§7.2). */
  capabilities(): {
    canRestart: boolean
    hostKind: 'cli' | 'desktop'
    installable: boolean
    canApproveBuilds: boolean
    memberEstimateMs: [number, number]
  } {
    const host = this.host?.capabilities()
    return {
      canRestart: this.hostKind === 'cli' && (host?.canRestart ?? false),
      hostKind: this.hostKind,
      // A host with no plugin manager is browse-only, and the page needs to
      // hear that as a yes/no rather than infer it from a missing field: the
      // banner reads `installable`, and an absent value used to render as a
      // false "this host cannot install" warning on a working desktop host.
      installable: host?.installable ?? false,
      canApproveBuilds: host?.canApproveBuilds ?? false,
      // Matches `preflight()`'s own per-member budget (§7.2: 20–40 s on a CLI
      // host, 30–60 s on desktop). A single hardcoded CLI range contradicted
      // the estimate the sheet had already shown for the same run.
      memberEstimateMs: this.hostKind === 'cli' ? [20_000, 40_000] : [30_000, 60_000],
    }
  }

  /**
   * Claim every plugin the profile has that this store did not install itself
   * (§7.7 point 3).
   *
   * Runs once at startup; deliberately not on every request. A plugin that
   * appears while the page is open was installed by something else just now,
   * and blessing it `manual` mid-session would make a bundle's own member look
   * foreign. The single write at the end keeps startup to one disk touch.
   *
   * The check at the door is not enough on its own. Everything between it and
   * the write is awaited — the installed list, the provenance file, the
   * catalog — and an install started in that window writes its own provenance.
   * This then wrote its stale snapshot back over it, so a member that had just
   * been recorded as `bundle:xyz` became `manual`, which is permanent (D15) and
   * bars the plugin from ever being uninstalled as part of its suite.
   *
   * `pruneOperations()` already swallowed its own failures for the same reason:
   * housekeeping must not fail a startup.
   */
  async reconcile(): Promise<void> {
    const host = this.host
    if (host === undefined) return
    // A reconcile that runs while the executor is writing provenance would
    // read the pre-write file, add `manual` entries the run is about to
    // supersede, and write them back over the run's claims — `manual` is
    // permanent (D15), so the race had to be closed at the door rather than
    // merged after the fact. `memberStates()` and `uninstallPreview()` call
    // this on every open of the sheet, which is exactly while a run is live.
    if (this.running() !== undefined && isLive(this.running()!)) return
    const installed = await this.installed()
    let state: ProvenanceState = await this.store.readProvenance()
    // Keep the ids that existed when this pass STARTED. The final write must
    // contribute ONLY the entries this scan ADDS — never the whole old
    // snapshot. Merging the old snapshot back resurrects a claim that a
    // concurrent uninstall removed while this pass was awaiting the catalog.
    const initialIds = new Set(Object.keys(state.entries))
    let changed = false
    const at = this.now().toISOString()
    // The catalog is how we learn which bundle a package belongs to: a profile
    // whose provenance file was lost can still recognise its own members,
    // because §7.7's rule is "read the installed manifest, then find the bundle
    // that lists that id". Without this every such member becomes `manual`,
    // which is the one classification the user cannot override.
    const owner = await this.bundleOwners()
    // No catalog means no way to tell "installed outside a bundle" from
    // "installed by the bundle we cannot read right now". Stamping everything
    // `manual` in that state is not a conservative fallback: `manual` is
    // permanent (D15), so a cold start with a slow or offline catalog would
    // permanently bar every future uninstall. Skipping the pass leaves the file
    // untouched and the next start tries again.
    if (owner === undefined) return
    for (const entry of installed) {
      // An existing record is the only evidence of WHY a plugin is here, and it
      // is what the uninstall sheet's default reads. Re-deriving it from the
      // catalog would *add* a claim from whichever bundle happens to be listed
      // first, which turns the plugin into `shared` for the bundle that really
      // installed it — the live profile did exactly this to every member of
      // `acceptance-run` right after they were installed.
      if (this.knownRecord(state, entry.id) !== undefined) continue
      // The catalog indexes members under both their id and their spec, and a
      // pinned member's spec carries the version. A bare-name report therefore
      // has to be tried as the bare name AND as `npm:<name>@<reported version>`.
      const claim = owner.get(entry.id)
        ?? (entry.version === undefined ? undefined : owner.get(`npm:${baseName(entry.id)}@${entry.version}`))
      // Two bundles listing the same package is not a tie to break by picking
      // one: crediting bundle A would hide the member from bundle B's sheet as
      // `shared` and would offer it for deletion under A. We do not know which
      // one put it here, so we write nothing and let it read as `unknown` —
      // the timid answer, and the only one that is not a guess.
      const sole = claim?.length === 1 ? claim[0] : undefined
      if (claim !== undefined && sole === undefined) continue
      state = sole === undefined
        ? recordManualInstall(state, { id: entry.id, spec: entry.id, now: at })
        : recordBundleInstall(state, {
            id: entry.id,
            spec: entry.id,
            // The profile's own version is the honest "resolved" answer here;
            // the catalog's bundle version is not a package version and must
            // not be recorded as one.
            resolvedVersion: entry.version ?? null,
            bundleId: sole.bundleId,
            bundleVersion: sole.version,
            now: at,
          })
      changed = true
    }
    if (changed) {
      // The scan above decided against a snapshot taken before several awaits,
      // so the write must be a SINGLE serialized read-modify-write. A separate
      // re-read then write still had a window: an install completing between
      // those two calls had its claim erased by the stale merge — a member
      // recorded as `bundle:xyz` came back as permanent `manual` (D15) and
      // could no longer be uninstalled with its suite.
      //
      // The updater receives the freshest state INSIDE the critical section.
      // Existing claims win; this pass only contributes ids the file does not
      // already know, which is all reconcile is entitled to add.
      if (this.running() !== undefined && isLive(this.running()!)) return
      // Add only entries that (a) did not exist when this pass started and
      // (b) are STILL INSTALLED right now.
      //
      // Condition (b) is not redundant. The scan iterates an `installed`
      // snapshot taken before several awaits. A plugin created during that
      // window and uninstalled again before this write would still be in the
      // snapshot, so (a) alone recorded a claim for something no longer on
      // disk — a resurrected source record on a plugin the user removed.
      //
      // The freshness check runs INSIDE the critical section and bypasses the
      // inventory cache: the cache is up to a second old, which is exactly the
      // window this guards.
      const added = new Map<string, ProvenanceEntry>()
      await this.store.updateProvenance(async (latest) => {
        const candidates = Object.entries(state.entries)
          .filter(([id]) => !initialIds.has(id))
          .filter(([id]) => latest.entries[id] === undefined)
        if (candidates.length === 0) return latest
        const present = await this.installedFresh()
        const stillThere = new Set((present ?? []).map((entry) => entry.id))
        const additions = candidates.filter(([id]) => stillThere.has(id))
        if (additions.length === 0) return latest
        for (const [id, entry] of additions) added.set(id, entry)
        return { ...latest, entries: { ...latest.entries, ...Object.fromEntries(additions) } }
      })

      // The inventory read above and the file write are NOT one transaction: an
      // uninstall can complete between them, leaving a claim for a plugin that
      // is already gone. Re-read the live inventory and WITHDRAW exactly the
      // claims this pass added that no longer exist.
      //
      // COMPARE-AND-DELETE. Keying only on the id deleted a legitimate claim a
      // concurrent install had just written for the same plugin: the sweep saw
      // "id present, not installed" and removed whatever was there. The value
      // has to be the exact entry this pass inserted; anything else is someone
      // else's claim and is left alone.
      //
      // Scoped to `added` for the same reason: a blanket "delete anything not
      // installed" would remove the claims of plugins the host merely fails to
      // list, and a claim this process never wrote may belong to a run still in
      // progress.
      if (added.size > 0) {
        const after = await this.installedFresh()
        // An unreadable inventory is not an empty one: skipping the sweep
        // leaves a possibly-stale claim, which is recoverable; sweeping on a
        // failed read would delete real provenance.
        if (after !== undefined) {
          const live = new Set(after.map((entry) => entry.id))
          const vanished = [...added.keys()].filter((id) => !live.has(id))
          if (vanished.length > 0) {
            await this.store.updateProvenance((latest) => {
              const entries = { ...latest.entries }
              let removed = false
              for (const id of vanished) {
                // Keep it if the current value is no longer the one this pass
                // wrote — that is a concurrent install's claim.
                if (!sameProvenanceEntry(entries[id], added.get(id))) continue
                delete entries[id]
                removed = true
              }
              return removed ? { ...latest, entries } : latest
            })
          }
        }
      }
    }
    await this.pruneOperations()
  }

  /**
   * Delete terminal operation records past the newest few.
   *
   * Every phase write creates a file under `operations/`, and nothing removed
   * them: a profile that installs daily grew the directory without bound. The
   * newest records are kept so a page reconnecting after a restart can still
   * find what it was painting; everything older than that is history the file
   * system does not need to remember.
   */
  private async pruneOperations(): Promise<void> {
    const KEEP = 5
    try {
      const records = await this.store.listOperations()
      const stale = records
        .filter((record) => !isLive(record))
        .slice(KEEP)
      for (const record of stale) await this.store.deleteOperation(record.opId)
    } catch {
      // Housekeeping must never fail a reconcile.
    }
  }

  /**
   * The existing record describing one reported plugin, under any spelling.
   *
   * A reported id can be a row-level module (`pkg/subpath`) or a bare package
   * name, while the install recorded `npm:pkg@version`. `baseName` reduces all
   * of them to the package name, which is the only common form.
   */
  private knownRecord(state: ProvenanceState, id: string): string | undefined {
    if (state.entries[id] !== undefined) return id
    // A row-level module names a sub-entry of the package; the package is the
    // record that owns it.
    const family = baseName(id)
    return Object.keys(state.entries).find(
      (key) => baseName(key) === family || baseName(state.entries[key]?.spec ?? '') === family,
    )
  }

  /**
   * Installed id → every bundle in the catalog that lists it.
   *
   * A list rather than the first hit: two bundles really can list the same
   * package, and `reconcile()` has to be able to tell "one bundle claims this"
   * (safe to record) from "several do" (a coin flip it must not make).
   *
   * Best-effort by design, but see `reconcile()`: an unreadable catalog
   * answers `undefined` rather than an empty map, because "I found no claims"
   * and "I could not look" have opposite consequences once `manual` is
   * permanent.
   */
  private async bundleOwners(): Promise<Map<string, { bundleId: string; version: string }[]> | undefined> {
    const owners = new Map<string, { bundleId: string; version: string }[]>()
    let bundles
    try {
      bundles = (await this.catalogService.current()).index.bundles
    } catch {
      // Undefined, not empty: the caller must be able to tell "the catalog
      // lists no bundles" (empty map is a real answer) from "there is no
      // catalog" (nothing may be classified at all).
      return undefined
    }
    for (const bundle of bundles) {
      for (const member of bundle.members) {
        for (const key of [member.id, memberSpecId(member)]) {
          const claims = owners.get(key)
          const claim = { bundleId: bundle.id, version: bundle.version }
          if (claims === undefined) owners.set(key, [claim])
          // The same bundle can list a key twice through its two spellings;
          // one claim per bundle is what the count means.
          else if (!claims.some((existing) => existing.bundleId === bundle.id)) claims.push(claim)
        }
      }
    }
    return owners
  }

  // ---------------------------------------------------------------- private

  private requireExecutor(): InstallExecutor {
    if (this.executor === undefined) throw new Error('this host cannot install plugins')
    return this.executor
  }

  /**
   * Refuse to start a second operation while one is live (§7.1, one lock).
   *
   * `partial` counts as idle on purpose: its remaining members are retried
   * through a *resume*, and treating it as live would make the retry look like
   * a second concurrent install.
   */
  private requireIdle(): void {
    const busy = this.removing ?? this.executor?.running
    if (busy !== undefined && isLive(busy)) throw new BusyError('another install is running', busy)
  }
  /**
   * Fan one event out to the SSE route.
   *
   * Typed as `ServiceEvent` rather than `InstallEvent` so a removal can publish
   * the member events it does not share with the executor: the union already
   * carries `member-start` / `member-done`, and the sink (`routes.ts`'s
   * `ProgressEvent`) is the looser form, so nothing here needs a new type.
   */
  private publish(event: ServiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /**
   * The installed inventory, with a short-lived cache.
   *
   * The TTL exists because the list route, the detail route and the SSE
   * reconnect path all ask within the same second. Any install or uninstall
   * clears it outright, so a mutation is never hidden by the cache.
   */
  private async installed(): Promise<InstalledEntry[]> {
    const host = this.host
    if (host === undefined) return []
    const at = this.now().getTime()
    if (this.inventory !== undefined && at - this.inventory.at < INVENTORY_TTL_MS) return this.inventory.entries
    const entries = await host.installed()
    this.inventory = { at, entries }
    return entries
  }

  /**
   * The installed inventory, read from the host even if the cache is warm.
   *
   * reconcile needs this at write time: it decides whether a plugin it saw in a
   * snapshot is STILL installed, and the 1-second cache is precisely the window
   * in which it is not. `undefined` means the host could not answer, which is
   * not the same as "nothing is installed" — the caller then records nothing.
   */
  private async installedFresh(): Promise<InstalledEntry[] | undefined> {
    const host = this.host
    if (host === undefined) return []
    try {
      // STRICT where available. `installed()` swallows a failing host call and
      // returns a shorter list, which a withdrawal would read as "the user
      // uninstalled everything" — deleting claims for plugins that are still
      // there. Only a complete answer may drive a destructive decision.
      const entries = await (host.installedStrict?.() ?? host.installed())
      // An undefined answer is "I could not find out" — never cache it as an
      // authoritative empty inventory.
      if (entries === undefined) return undefined
      this.inventory = { at: this.now().getTime(), entries }
      return entries
    } catch {
      return undefined
    }
  }

  /** The inventory keyed by identity, which is how cards look members up. */
  private async installedIndex(): Promise<Map<string, InstalledEntry>> {
    const entries = await this.installed()
    return new Map(entries.map((entry) => [entry.id, entry]))
  }

  /** One card joined with the profile's answer about its members. */
  private view(card: BundleCard, installed: Map<string, InstalledEntry>, installedByUser: boolean): BundleCardView {
    const members = card.members
    const present: string[] = []
    for (const member of members) {
      if (this.isPresent(member, installed)) present.push(member.key)
    }
    return {
      ...card,
      installedCount: present.length,
      installedMembers: present,
      // Both halves have to agree: a run from this store AND something still on
      // disk. Provenance alone keeps a suite listed after its members were
      // removed by hand (that path skips `forgetBundleSource`), and presence
      // alone credits a suite for a plugin the user installed themselves.
      installedByUser: installedByUser && present.length > 0,
      // A bundle with no members cannot be "installed"; the button stays an
      // install so a broken catalog entry is visible rather than silently 已装.
      installed: members.length > 0 && present.length === members.length,
    }
  }

  /**
   * Whether one member is already in the profile.
   *
   * Three spellings of the same install have to agree here: the catalog's
   * `id` (`npm:cc-safety-net`), the plan's identity for a pinned member
   * (`npm:cc-safety-net@2.7.8`, version included), and the host's report
   * (`npm:cc-safety-net`). An exact-versus-exact comparison misses at least
   * one of them, and a miss is not cosmetic: the card showed "0 of 5
   * installed" for a bundle that had just installed, and the next click
   * reinstalled all of it.
   *
   * `baseName` normalises all three to the bare package (`npm:` prefix and
   * `@version` suffix removed), which is the only form they share.
   */
  private isPresent(member: BundleMember, installed: Map<string, InstalledEntry>): boolean {
    const identities = [member.id, memberSpecId(member)]
    for (const [id] of installed) {
      if (identities.some((identity) => sameIdentity(identity, id))) return true
    }
    return false
  }
}

/**
 * A removal the running session cannot finish, but the next start can.
 *
 * Thrown instead of a plain Error so the caller marks the member
 * `needs-restart` rather than `failed`: the plugin is disabled and will not be
 * composed again, so there is nothing for the user to repair — only a restart
 * to perform.
 */
class NeedsRestartError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'NeedsRestartError'
  }
}

/**
 * Narrow an installed entry to what the planner compares. */
function toMember(entry: InstalledEntry): InstalledMember {
  return entry.version === undefined ? { id: entry.id } : { id: entry.id, version: entry.version }
}

/**
 * Whether an operation may still grow.
 *
 * `partial` is terminal on purpose: its remaining members are retried through
 * a *resume* (§7.5), and treating it as live would make the retry look like a
 * second concurrent install.
 */
function isLive(record: OperationRecord): boolean {
  return record.status !== 'done'
    && record.status !== 'partial'
    && record.status !== 'cancelled'
    && record.status !== 'blocked'
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Whether two provenance entries are the SAME value.
 *
 * Used as the compare half of compare-and-delete: the withdrawal may only
 * remove an entry if it is still exactly the one this reconcile pass wrote. A
 * concurrent install that rewrote the claim for the same id produces a
 * different value, and its claim must survive.
 *
 * Compared structurally rather than by reference: the value has been through
 * the store's read-modify-write, so the object identity a caller held is gone.
 * Sources are ordered (they record history), so the comparison is ordered too.
 *
 * @param left - the value currently in the file.
 * @param right - the value this pass wrote, or undefined when it wrote none.
 * @returns true only when both are defined and identical in content.
 */
function sameProvenanceEntry(left: ProvenanceEntry | undefined, right: ProvenanceEntry | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return JSON.stringify(left) === JSON.stringify(right)
}
