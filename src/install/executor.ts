/**
 * The install executor: runs a plan one member at a time and survives
 * anything a package manager does to it (§7.3, §7.5, §7.6).
 *
 * The governing rule is that a suite install is many installs, and the unit
 * that can be undone is ONE member. A member that fails is rolled back and
 * reported; the run then continues with the next member, because a suite in
 * which nine of twelve plugins work is worth having, and stopping at the
 * first failure makes a single broken plugin (usually an author's problem,
 * not the user's) cost the user the other eleven.
 *
 * Three details carry the weight and are easy to get wrong:
 *
 * - **A timeout is not a failure.** §7.5: when a member exceeds its budget the
 *   executor asks the host to cancel and believes the answer. `too-late` means
 *   the install may already have completed, so the run stops and records
 *   `timeout-too-late` — the profile is then reconciled rather than assumed
 *   untouched. Retrying a member that may have succeeded is how a user ends up
 *   with two copies of a plugin.
 * - **Progress is written before it happens, not after.** Every phase change
 *   is persisted so a host killed mid-install leaves a record that resumes
 *   from the right member.
 * - **Build approvals are per member.** They are passed to exactly the one
 *   install call whose member the user approved.
 *
 * The host-facing work is injected (`HostAdapter`-shaped port) so this whole
 * file is testable without a package manager.
 */

import {
  concludeStatus,
  isLive,
  patchMember,
  operationProgress,
  resumableSteps,
  startOperation,
  type MemberFailure,
  type MemberPhase,
  type MemberRecord,
  type OperationRecord,
} from './operation.ts'
import { baseName, sameIdentity, type InstallPlan, type InstallStep } from './plan.ts'
import type { InstallStore } from './store.ts'
import { logEvent } from '../log/log.ts'
import { recordBundleInstall, type ProvenanceState } from './state.ts'
import type { InstalledEntry } from './host.ts'

/**
 * Events the progress stream forwards (SSE, §7.5).
 *
 * A flat discriminated union rather than a set of callbacks: the route layer
 * serializes each event as-is, and the client switches on `type`, so adding a
 * field here is a client change and not a protocol change.
 */
export type InstallEvent =
  | { type: 'op-start'; op: OperationRecord }
  | { type: 'op-phase'; op: OperationRecord; phase: OperationRecord['status'] }
  /**
   * The member events carry `opId` and, optionally, the whole record.
   *
   * The executor leaves `op` out: its members are bracketed by `op-start` /
   * `op-phase` / `op-end` writes that already carry the record, so the page
   * redraws there. A removal has no member loop to bracket (each member is one
   * host call and there may be only two), so it attaches the record to its own
   * `member-done` and the row lights up when that member is done instead of
   * when the whole run ends.
   */
  | { type: 'member-start'; opId: string; key: string; index: number; total: number; op?: OperationRecord }
  | { type: 'member-phase'; opId: string; key: string; phase: MemberPhase; op?: OperationRecord }
  | { type: 'member-done'; opId: string; member: MemberRecord; op?: OperationRecord }
  // The record is optional on both phase events so existing emitters keep
  // compiling, but `run()` always attaches it now: the client's fold drops a
  // live event that carries no record, so an op-less one left the panel on the
  // previous status until op-end.
  | { type: 'op-restarting'; opId: string; op?: OperationRecord }
  | { type: 'op-verify'; opId: string; op?: OperationRecord }
  | { type: 'op-end'; op: OperationRecord }
  | { type: 'op-cancelled'; opId: string }
  /**
   * Something the user should know that is not a member result.
   *
   * §7.3 asks for a rollback, and a rollback can fail. The member is still
   * recorded as failed — that part is certain — but "I tried to undo this and
   * could not" has to reach the screen, or the profile quietly keeps files the
   * user believes were removed.
   */
  | { type: 'op-note'; opId: string; note: string }

/** The final report the UI shows once (§7.6). */
export interface InstallReport {
  opId: string
  bundleId: string
  status: OperationRecord['status']
  ok: string[]
  skipped: string[]
  skippedBuildDenied: string[]
  failed: MemberFailure[]
}

/** What the executor needs from the host, narrowed to what it calls. */
export interface ExecutorHost {
  /** Everything the profile currently has installed. */
  installed(): Promise<InstalledEntry[]>
  /** Install one member; throws when the host refuses to start at all. */
  install(input: { spec: string; approvedBuilds: readonly string[]; requestId: string }): Promise<
    | { status: 'ok' }
    | { status: 'failed'; reason: string; cause?: string; buildKey?: string }
    | { status: 'unknown'; reason: string; cause?: string; buildKey?: string }
  >
  /** Ask for cancellation and report the host's own verdict. */
  cancel(requestId: string): Promise<'cancelled' | 'too-late' | 'not-running'>
  /**
   * Remove a plugin the profile has. Used only by rollback, and only for
   * entries that appeared during the member being undone.
   *
   * Optional because a host may expose no removal at all; the rollback then
   * reports what it left behind instead of pretending to have cleaned up.
   */
  remove?(id: string): Promise<void>
}

export interface ExecutorHostCapabilities {
  canRestart: boolean
}

/** Injected clock, so the record's timestamps are assertable. */
export type Now = () => string

export interface InstallExecutorOptions {
  store: InstallStore
  host: ExecutorHost
  capabilities: ExecutorHostCapabilities
  /** Called for every event; the SSE route fans these out. */
  emit?: (event: InstallEvent) => void
  now?: Now
  /** Per-member budget in ms (§7.5: 300 s). */
  memberTimeoutMs?: number
}

/** Raised when the executor is asked to work while another operation is live. */
export class OperationBusyError extends Error {
  constructor(readonly operation: OperationRecord) {
    super(`install ${operation.opId} for ${operation.bundleId} is already running`)
    this.name = 'OperationBusyError'
  }
}

const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Owns the one install this plugin is allowed to run at a time (§7.1).
 *
 * The single-operation rule is not an optimisation: the host's installer
 * serializes anyway, and a second concurrent run would make the progress
 * screen lie about which bundle the member list belongs to.
 */
export class InstallExecutor {
  private readonly store: InstallStore
  private readonly host: ExecutorHost
  private readonly capabilities: ExecutorHostCapabilities
  private readonly emit: (event: InstallEvent) => void
  private readonly now: Now
  private readonly memberTimeoutMs: number
  private current: OperationRecord | undefined
  /** Set by `requestCancel()`; survives the run's own record snapshots. */
  private cancelRequested = false
  private seq = 0

  constructor(options: InstallExecutorOptions) {
    this.store = options.store
    this.host = options.host
    this.capabilities = options.capabilities
    this.emit = options.emit ?? (() => undefined)
    this.now = options.now ?? (() => new Date().toISOString())
    this.memberTimeoutMs = options.memberTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** The operation in flight, if any. */
  get running(): OperationRecord | undefined {
    return this.current
  }

  /**
   * Start installing a bundle.
   *
   * @param input.plan - the plan to execute.
   * @param input.bundleId / input.bundleVersion - what the report credits.
   * @param input.preferences - whether the run should stop early.
   * @returns the final report.
   * @throws {OperationBusyError} when another operation is live.
   */
  async start(input: {
    bundleId: string
    bundleVersion: string
    plan: InstallPlan
    hostKind?: 'cli' | 'desktop'
    /** Members whose build scripts the user already refused (§7.2). */
    deniedBuilds?: readonly string[]
  }): Promise<InstallReport> {
    if (this.current !== undefined && isLive(this.current)) throw new OperationBusyError(this.current)
    const startedAt = this.now()
    const operation = startOperation({
      opId: `op-${startedAt.replace(/[^0-9]/gu, '')}-${this.seq++}`,
      bundleId: input.bundleId,
      bundleVersion: input.bundleVersion,
      hostKind: input.hostKind ?? 'cli',
      plan: input.plan,
      now: startedAt,
    })
    return this.run(operation, input.plan, input.deniedBuilds ?? [])
  }

  /**
   * Continue an operation the host already recorded (page reload, restart).
   *
   * Only the members that did not finish are retried (§7.5). The record on
   * disk is the source of truth for what already happened, so a resume cannot
   * reinstall a member that succeeded before the interruption.
   */
  async resume(operation: OperationRecord, plan: InstallPlan, deniedBuilds: readonly string[] = []): Promise<InstallReport> {
    // ANY live current refuses a resume, including the same opId: two member
    // loops over one record would interleave phase writes and double-install
    // members. (Before, the same-opId arm passed, so two `resume()` calls in
    // one tick both ran.)
    if (this.current !== undefined && isLive(this.current)) {
      throw new OperationBusyError(this.current)
    }
    const remaining = resumableSteps(operation, plan)
    if (remaining.length === 0) {
      // Nothing to retry, but the record can still be LIVE: the host may have
      // died after the last member and before `concludeStatus` ran. Concluding
      // it here is what makes the operation terminate — otherwise the record
      // stays `installing` on disk forever, no `op-end` is ever emitted, and
      // the store keeps reporting a phantom run.
      const concluded: OperationRecord = {
        ...operation,
        status: concludeStatus(operation),
        updatedAt: this.now(),
      }
      this.current = concluded
      await this.persist(concluded)
      if (concluded.status === 'cancelled') this.emit({ type: 'op-cancelled', opId: concluded.opId })
      const settled = this.report(concluded)
      this.emit({ type: 'op-end', op: concluded })
      this.current = isLive(concluded) ? concluded : undefined
      return settled
    }
    // Members that already finished keep their state: the report must say what
    // this resume did AND what was already done, or the user sees a bundle
    // appear partially installed with no explanation.
    const retried = new Set(remaining.map((step) => step.key))
    let record = operation
    for (const step of remaining) record = patchMember(record, step.key, { state: 'pending', failure: undefined })
    // Hand `run` the narrowed plan but tell it which members it is retrying,
    // so the final report can name the ones this resume left alone.
    const narrowed: InstallPlan = { ...plan, steps: remaining }
    return this.run({ ...record, cancelRequested: false }, narrowed, deniedBuilds, retried)
  }

  /** Ask the run in flight to stop after the current member (§7.5). */
  async requestCancel(): Promise<boolean> {
    const operation = this.current
    if (operation === undefined || !isLive(operation)) return false
    // Record the intent where it cannot be clobbered. `requestCancel()` runs
    // while the run's own `await`s are in flight, and the run assigns fresh
    // record snapshots after each phase — a copy of the flag on the record
    // would simply be overwritten by the next one. Only the FLAG is set here:
    // persisting this method's older snapshot raced the run's own writes and
    // could revert member states the run had already recorded, leaving a
    // member `running` on disk that the resume rule then refused to retry.
    // The run persists at its next phase change anyway.
    this.cancelRequested = true
    this.current = { ...operation, cancelRequested: true }
    return true
  }

  private async run(
    operation: OperationRecord,
    plan: InstallPlan,
    deniedBuilds: readonly string[],
    retried?: ReadonlySet<string>,
  ): Promise<InstallReport> {
    this.cancelRequested = false
    this.current = { ...operation, status: 'preflight', updatedAt: this.now() }
    // The run's start, in the exportable log: a report that says "it failed"
    // without saying which bundle and how many members is the one a maintainer
    // has to ask about, and this line costs nothing.
    logEvent('info', 'install', `${operation.opId} ${operation.bundleId} starting (${String(plan.steps.length)} members)`)
    try {
      this.emit({ type: 'op-start', op: this.current })
      await this.persist(this.current)

      let record: OperationRecord = { ...this.current, status: 'installing', updatedAt: this.now() }
      this.emit({ type: 'op-phase', op: record, phase: 'installing' })
      this.current = record
      await this.persist(record)

      const denied = new Set(deniedBuilds)
      let stopped = false

      for (const [index, step] of plan.steps.entries()) {
      // Re-read the record: `requestCancel()` may have written to it while the
      // previous member was installing.
      if (this.cancelRequested) break
      record = this.current ?? record

      if (denied.has(step.name)) {
        record = patchMember(record, step.key, {
          state: 'skipped-build-denied',
          failure: { key: step.key, phase: 'add', type: 'build-denied', reason: 'build scripts not approved' },
        })
        this.current = record
        // Every member event carries the whole record. The page's reducer
        // deliberately ignores an event without one, so omitting it here froze
        // the panel at 0/N until op-end — a member turning green was never
        // drawn, even though the operation file on disk was up to date.
        this.emit({ type: 'member-done', opId: record.opId, member: this.member(record, step.key), op: record })
        await this.persist(record)
        continue
      }

      record = patchMember(record, step.key, { state: 'running', phase: 'add' })
      this.current = record
      this.emit({
        type: 'member-start', opId: record.opId, key: step.key,
        index, total: plan.steps.length, op: record,
      })
      await this.persist(record)

      const outcome = await this.installOne(record, step)
      record = outcome.record
      this.current = record
      // One line per member, at the single point every member passes through:
      // success, refusal, timeout and rollback all land here, so the export
      // names the member and its verdict without eight call sites to keep
      // aligned. Only the failures carry a reason.
      const settled = this.member(record, step.key)
      logEvent(
        settled.state === 'failed' || settled.state === 'skipped-build-denied' ? 'error' : 'info',
        'install',
        `${record.opId} ${step.key}: ${settled.state}`
        + (settled.failure === undefined ? '' : ` — ${settled.failure.type}: ${settled.failure.reason}`),
      )
      this.emit({ type: 'member-done', opId: record.opId, member: settled, op: record })
      // Fold in a cancellation that arrived while this member was installing:
      // the settings snapshots written above replaced whatever
      // `requestCancel()` put in `this.current`. §7.5 promises the flag is
      // honoured before the next member starts, so read it here or lose it.
      if (this.cancelRequested) record = { ...record, cancelRequested: true }
      this.current = record
      await this.persist(record)

      // §7.5: a `too-late` timeout leaves the member in an unknown state, so
      // the whole run stops and the profile is reconciled instead of guessed.
      if (outcome.fatal) {
        stopped = true
        break
      }
    }

    if (!stopped && !this.cancelRequested && this.capabilities.canRestart && this.installedAny(record)) {
      record = { ...record, status: 'restarting', updatedAt: this.now() }
      // The record rides on both phase events: the client's fold requires it
      // (a live event without one is dropped as "about an operation this page
      // never knew about"), and without it the panel sat on "installing"
      // through the whole restart/verify window until op-end.
      this.emit({ type: 'op-restarting', opId: record.opId, op: record })
      this.current = record
      await this.persist(record)
      record = { ...record, status: 'verifying', updatedAt: this.now() }
      this.emit({ type: 'op-verify', opId: record.opId, op: record })
      this.current = record
      await this.persist(record)
      record = await this.verify(record)
    }

    if (this.cancelRequested) record = { ...record, cancelRequested: true }
    record = { ...record, status: concludeStatus(record), updatedAt: this.now() }
    this.current = record
    await this.persist(record)
    if (record.status === 'cancelled') this.emit({ type: 'op-cancelled', opId: record.opId })
    const report = this.report(record, retried)
    // One line per run, naming what actually happened. The member-level lines
    // above say why; this says the shape of the outcome, which is the first
    // thing a maintainer reads.
    logEvent(
      report.failed.length > 0 ? 'error' : 'info',
      'install',
      `${record.opId} ${record.bundleId} ${record.status}: `
      + `${String(report.ok.length)} ok, ${String(report.skipped.length)} skipped, `
      + `${String(report.failed.length)} failed`
      + (report.failed.length === 0 ? '' : ` — ${report.failed.map((entry) => `${entry.key}: ${entry.reason}`).join('; ')}`),
    )
    this.emit({ type: 'op-end', op: record })
    this.current = isLive(record) ? record : undefined
    return report
    } catch (error) {
      // A throw from a provenance write or an SSE write to a socket the client
      // just closed must not leave the run marked live: one failed write would
      // otherwise lock out every later install, uninstall and switch until the
      // host restarted.
      //
      // Disk and memory have to agree. Clearing only `current` left the
      // persisted record in its last live status with the current member still
      // `running` — never pruned (it looks live) and never settled, so the
      // progress page showed a run that had already stopped. The terminal write
      // is best-effort: the write that just failed may be this one, and
      // reporting the original error matters more.
      const abandoned = this.current
      this.current = undefined
      if (abandoned !== undefined && isLive(abandoned)) {
        const concluded: OperationRecord = {
          ...abandoned,
          status: concludeStatus(abandoned),
          updatedAt: this.now(),
        }
        try {
          await this.persist(concluded)
          this.emit({ type: 'op-end', op: concluded })
        } catch {
          // Nothing more to do: the caller is about to see the first error.
        }
      }
      throw error
    }
  }

  /**
   * Run one member through resolve → add → record, with rollback on failure.
   *
   * @returns the updated record and whether the run must stop.
   */
  private async installOne(
    record: OperationRecord,
    step: InstallStep,
  ): Promise<{ record: OperationRecord; fatal: boolean }> {
    const requestId = `${record.opId}:${step.key}`
    // The snapshot phase is what a rollback would restore to. It is taken as
    // the list of what was installed BEFORE this member, so undoing means
    // "whatever the host now reports that was not here before".
    const before = await this.safeInstalled()
    this.emit({ type: 'member-phase', opId: record.opId, key: step.key, phase: 'resolve', op: record })

    let settled: Awaited<ReturnType<ExecutorHost['install']>> | 'timeout' | 'threw'
    let thrown: unknown
    try {
      settled = await this.withTimeout(this.host.install({ spec: step.spec, approvedBuilds: step.approvedBuilds, requestId }))
    } catch (error) {
      thrown = error
      settled = 'threw'
    }

    if (settled === 'timeout') {
      // §7.5: ask the host, believe it, and never assume on its behalf.
      //
      // A cancel that rejects or never answers is NOT a refusal: the install may
      // well have completed, so it is read as `too-late` (stop the run and
      // reconcile) instead of throwing out of the member loop and leaving the
      // member `running` with no report at all. The same member budget bounds
      // the wait, so a wedged host cannot hold the run open forever.
      let verdict: 'cancelled' | 'too-late' | 'not-running'
      try {
        const asked = await this.withTimeout(this.host.cancel(requestId))
        verdict = asked === 'timeout' ? 'too-late' : asked
      } catch {
        verdict = 'too-late'
      }
      if (verdict === 'cancelled') {
        // A cancelled install has written whatever it had written by then, so
        // it needs the same cleanup a refusal gets (§7.3).
        await this.rollback(before, record.opId, step)
        return {
          record: patchMember(record, step.key, {
            state: 'failed',
            failure: {
              key: step.key,
              phase: 'add',
              type: 'install-failed',
              reason: `install exceeded ${Math.round(this.memberTimeoutMs / 1000)}s and was cancelled`,
            },
          }),
          fatal: false,
        }
      }
      if (verdict === 'not-running') {
        // The install finished on its own between the timeout and the cancel;
        // ask the profile what actually happened instead of failing a member
        // that may well be installed.
        const now = await this.safeInstalled()
        if (this.appeared(before, now, step)) {
          return { record: await this.succeeded(record, step, now), fatal: false }
        }
        await this.rollback(before, record.opId, step)
        return {
          record: patchMember(record, step.key, {
            state: 'failed',
            failure: {
              key: step.key,
              phase: 'add',
              type: 'install-failed',
              reason: `install exceeded ${Math.round(this.memberTimeoutMs / 1000)}s`,
            },
          }),
          fatal: false,
        }
      }
      return {
        record: patchMember(record, step.key, {
          state: 'failed',
          failure: {
            key: step.key,
            phase: 'add',
            type: 'timeout-too-late',
            reason: `install did not report before ${Math.round(this.memberTimeoutMs / 1000)}s and may have completed; not retrying`,
          },
        }),
        fatal: true,
      }
    }

    if (settled === 'threw') {
      // The host refused to start: nothing was written, so there is nothing to
      // roll back, and the profile is exactly as it was.
      return {
        record: patchMember(record, step.key, {
          state: 'failed',
          failure: { key: step.key, phase: 'add', type: 'install-failed', reason: messageOf(thrown), cause: 'unknown' },
        }),
        fatal: false,
      }
    }

    if (settled.status === 'failed') {
      await this.rollback(before, record.opId, step)
      return {
        record: patchMember(record, step.key, {
          state: 'failed',
          failure: {
            key: step.key, phase: 'add', type: 'install-failed', reason: settled.reason,
            ...(settled.cause === undefined ? {} : { cause: settled.cause }),
            ...(settled.buildKey === undefined ? {} : { buildKey: settled.buildKey }),
          },
        }),
        fatal: false,
      }
    }

    if (settled.status === 'unknown') {
      // §7.3 is explicit that one member's uncertainty is not the run's, and
      // §7.5 sets the rule for resolving it: ask the profile, do not assume.
      // The host reported `ambiguous-install` — pnpm exited 0 but the host
      // could not name what it added — so the profile is the only witness
      // left. Finding the member here is a SUCCESS: rolling it back would
      // delete a plugin that is already on disk, and the next click would
      // download it again.
      const after = await this.safeInstalled()
      if (findInstalled(after, step) !== undefined) {
        return { record: await this.succeeded(record, step, after), fatal: false }
      }
      // It is genuinely not there, so there is nothing to keep — but there may
      // be half-written files the profile has not listed yet, which is exactly
      // what the rollback's step-identity arm exists for.
      await this.rollback(before, record.opId, step)
      this.emit({
        type: 'op-note',
        opId: record.opId,
        note: `${step.name}: the host could not confirm the install and the profile does not list it`,
      })
      return {
        record: patchMember(record, step.key, {
          state: 'failed',
          failure: {
            key: step.key, phase: 'add', type: 'install-failed', reason: settled.reason,
            ...(settled.cause === undefined ? {} : { cause: settled.cause }),
            ...(settled.buildKey === undefined ? {} : { buildKey: settled.buildKey }),
          },
        }),
        fatal: false,
      }
    }

    const after = await this.safeInstalled()
    return { record: await this.succeeded(record, step, after), fatal: false }
  }

  /**
   * Record a member that installed, including provenance.
   *
   * Verification of a single member is the presence check: §7.3 verifies after
   * the restart, but a member that is not even listed right now is a
   * `verify-failed` immediately, because that is information the user can act
   * on without waiting for the whole run.
   */
  private async succeeded(
    record: OperationRecord,
    step: InstallStep,
    installed: InstalledEntry[] | undefined,
  ): Promise<OperationRecord> {
    const match = findInstalled(installed, { name: step.name, id: step.id, spec: step.spec })
    const resolvedVersion = match?.version
    if (match === undefined && installed !== undefined) {
      return patchMember(record, step.key, {
        state: 'failed',
        failure: {
          key: step.key,
          phase: 'verify',
          type: 'verify-failed',
          // The package manager succeeded but the host does not list it. Seen
          // with a git-hosted plugin that pnpm installed to node_modules while
          // the Loader never picked it up, so the sentence names that state
          // instead of calling a present package missing.
          reason: 'the package manager installed it, but the host has not loaded it; restart the host to pick it up',
        },
      })
    }
    // `installed === undefined` means the inventory could not be read, which is
    // not evidence that the member failed — the host said it succeeded. It is
    // recorded as ok with no resolved version, and a later run reconciles the
    // version from the profile rather than calling a working install broken.
    this.emit({ type: 'member-phase', opId: record.opId, key: step.key, phase: 'record', op: record })
    // Atomic read-modify-write: a plain read then write let a concurrent
    // reconcile's claims be overwritten (and vice versa).
    await this.store.updateProvenance((previous) => recordBundleInstall(previous, {
      id: step.id,
      spec: step.spec,
      resolvedVersion: resolvedVersion ?? null,
      bundleId: record.bundleId,
      bundleVersion: record.bundleVersion,
      now: this.now(),
    }))
    const patched = patchMember(record, step.key, {
      state: 'ok',
      phase: 'record',
      ...(resolvedVersion === undefined ? {} : { resolvedVersion }),
    })
    // §7.4 drift is NOT synthesised here: the resolved version is recorded on
    // the member above, and that is where a reconciliation reads it. A member
    // that loaded as a different version than pinned still WORKED, so turning
    // the mismatch into a failure would fail something that is not broken.
    return patched
  }

  /**
   * After the restart, re-check every member that claimed success (§7.6).
   *
   * A plugin can install cleanly and still fail to load — a peer dependency
   * that is missing at runtime, a native module built for the wrong ABI. That
   * failure only appears once the host reloads, so this is the step that makes
   * "installed" mean "working".
   */
  private async verify(record: OperationRecord): Promise<OperationRecord> {
    const installed = await this.safeInstalled()
    // An unreadable inventory is the absence of a fact, not evidence of
    // failure: `succeeded()` already refuses to call a member failed on it,
    // and rewriting every success to `load-failed` here — the host's own
    // documented contract (see `safeInstalled`) — turned a healthy install
    // into a page of red rows. Skip the pass; a later run reconciles.
    if (installed === undefined) {
      this.emit({
        type: 'op-note',
        opId: record.opId,
        note: 'post-restart verification skipped: the host would not report its installed list',
      })
      return record
    }
    let next = record
    for (const member of record.members) {
      if (member.state !== 'ok') continue
      const present = findInstalled(installed, { name: member.name, id: member.id }) !== undefined
      if (present) continue
      next = patchMember(next, member.key, {
        state: 'failed',
        failure: {
          key: member.key,
          phase: 'verify',
          type: 'load-failed',
          reason: 'the plugin installed but did not load after the host restarted',
        },
      })
    }
    return next
  }

  /**
   * Remove whatever a failed member left behind (§7.3).
   *
   * §7.3 draws the line that matters: the BUNDLE is never rolled back, but a
   * single MEMBER is. A member's package manager can add half its tree and
   * then fail on a peer dependency, leaving files behind that the profile
   * believes are installed — the next attempt then answers `already-installed`
   * and the user cannot get past a failure they already saw.
   *
   * Only entries that appeared during THIS member are removed. Touching
   * anything else would delete plugins the user had before the install, which
   * is the one unrecoverable mistake this plugin could make. When nothing
   * appeared, the member's own identity is the only candidate — and it is
   * still dropped when the baseline shows the user already had it, because the
   * usual way to reach that branch is a failed update OF that very plugin.
   * Asking the host to remove a plugin it does not have is a no-op.
   *
   * A diff is only meaningful when BOTH ends of it are known. If either
   * inventory read failed, "everything present" is not evidence that this
   * member installed it — and it is equally not evidence that it did NOT.
   *
   * So an unknown baseline means NO removal at all. This used to fall back to
   * `[step.id]`, which read as "just this member" but is not: `host.remove`
   * folds a versioned spec onto its bare name, so `npm:alpha@2.0.0` removed a
   * user's pre-existing `alpha@1.0.0`. A failed update plus one transient
   * inventory error therefore deleted a working plugin, and that is
   * unrecoverable — the rollback exists to avoid exactly this. Leaving files
   * behind is the recoverable direction: the user still has their plugin, and
   * the note says what could not be confirmed.
   */
  private async rollback(before: readonly InstalledEntry[] | undefined, opId: string, step: InstallStep): Promise<void> {
    const now = await this.safeInstalled()
    if (before === undefined) {
      // No baseline: removing anything would be a guess about what this member
      // added, and a wrong guess deletes the user's plugin.
      this.emit({
        type: 'op-note',
        opId,
        note: `did not undo ${step.name}: the plugin list could not be read before the install, so leftovers cannot be told apart from what was already there`,
      })
      return
    }
    let targets: string[]
    if (now === undefined) {
      // Baseline known, current list not: the member's own identity is the only
      // thing we can name, and the baseline check below still protects a
      // pre-existing copy of it.
      targets = [step.id]
    } else {
      const previous = new Set(before.map((entry) => entry.id))
      const leftovers = now.filter((entry) => !previous.has(entry.id))
      // ONE entry is the normal case and is this member's — but "one diff
      // entry" is not proof of OWNERSHIP: another process's install can land
      // inside this member's 300 s window, and deleting it removes a plugin
      // the user asked something else for. The diff entry is taken only when
      // it names this step; otherwise the member's own identity is the
      // target, which is the conservative direction (§7.3).
      const owned = leftovers.length === 1
        && findInstalled(leftovers, { name: step.name, id: step.id, spec: step.spec }) !== undefined
        ? [leftovers[0]!.id]
        : [step.id]
      // Never remove an entry that was already in the baseline. A failed
      // UPDATE or reinstall is the normal way to reach here — the member was
      // installed at another version, `satisfies()` re-planned it, the install
      // failed and the host still lists the old copy — and `[step.id]` is the
      // new identity, which `findInstalled`/`bareNames` fold onto exactly that
      // pre-existing copy. Removing it would delete the working plugin the user
      // had, which is the one unrecoverable mistake this method exists to avoid.
      targets = (leftovers.length === 0 ? [step.id] : owned)
        .filter((target) => findInstalled(before, { name: target, id: target, spec: step.spec }) === undefined)
    }
    if (this.host.remove === undefined) {
      // Nothing to undo with. Saying so is better than reporting a clean
      // failure and leaving files the user cannot explain.
      this.emit({
        type: 'op-note',
        opId,
        note: `left ${step.name} behind: this host cannot remove plugins`,
      })
      return
    }
    for (const target of targets) {
      try {
        await this.host.remove(target)
      } catch {
        this.emit({ type: 'op-note', opId, note: `could not undo ${target}; it is still installed` })
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.memberTimeoutMs)
      // Never hold the process open just to time out an install.
      timer.unref?.()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * The host's installed list, or `undefined` when it could not be read.
   *
   * The distinction is load-bearing. An empty ARRAY is a fact ("nothing is
   * installed"), and a rollback may safely treat everything present afterwards
   * as this member's leftovers. `undefined` is the absence of a fact, and no
   * caller may infer anything from it: a failed read that returned `[]` once
   * made every plugin in the profile look like a leftover, and the rollback
   * deleted them all.
   */
  private async safeInstalled(): Promise<InstalledEntry[] | undefined> {
    try {
      return await this.host.installed()
    } catch {
      return undefined
    }
  }

  private appeared(
    before: readonly InstalledEntry[] | undefined,
    after: readonly InstalledEntry[] | undefined,
    step: InstallStep,
  ): boolean {
    // Without both ends of the comparison there is nothing to conclude: the
    // caller falls through to the rollback, which then narrows to the step's
    // own identity rather than guessing at leftovers.
    if (before === undefined || after === undefined) return false
    // The same three-spelling rule `findInstalled` applies: a host that
    // reports `npm:<name>` against a plan id of `<name>` (or vice versa) had a
    // member that installed perfectly read as absent, and the rollback then
    // deleted the plugin the user just watched install (§7.5 不做臆断).
    const landed = findInstalled(after, { name: step.name, id: step.id, spec: step.spec })
    if (landed === undefined) return false
    const previous = new Set(before.map((entry) => entry.id))
    return !previous.has(landed.id)
  }

  private installedAny(record: OperationRecord): boolean {
    return record.members.some((member) => member.state === 'ok')
  }

  private member(record: OperationRecord, key: string): MemberRecord {
    return record.members.find((member) => member.key === key) ?? { key, id: '', name: '', state: 'pending' }
  }

  private report(record: OperationRecord, retried?: ReadonlySet<string>): InstallReport {
    const ok: string[] = []
    const skipped: string[] = []
    const skippedBuildDenied: string[] = []
    const failed: MemberFailure[] = []
    for (const member of record.members) {
      // A resume reports only the members it worked on. The record keeps the
      // whole bundle for display, but attributing last run's successes to this
      // run would make "3 of 12 installed" look like a fresh, full install.
      if (retried !== undefined && !retried.has(member.key)) continue
      switch (member.state) {
        case 'ok':
          ok.push(member.key)
          break
        case 'skipped':
          skipped.push(member.key)
          break
        case 'skipped-build-denied':
          skippedBuildDenied.push(member.key)
          break
        case 'failed':
          if (member.failure !== undefined) failed.push(member.failure)
          break
        default:
          break
      }
    }
    return { opId: record.opId, bundleId: record.bundleId, status: record.status, ok, skipped, skippedBuildDenied, failed }
  }

  private async persist(record: OperationRecord): Promise<void> {
    try {
      await this.store.writeOperation(record)
    } catch {
      // Failing to persist must not fail an install that is going fine: the
      // only cost is that it cannot be resumed.
    }
  }
}

function baseOf(id: string): string {
  // `baseName` is the ONE normaliser: it strips every git prefix the host or
  // the catalog may use (`git:`, `github:`, `git+https://…`), the subdirectory
  // fragment and any `@version`. A local copy that only stripped `git:`/`npm:`
  // is what made a git member look uninstalled right after pnpm installed it.
  return baseName(id)
}

/**
 * Find the host's report of one installed member.
 *
 * Three spellings describe the same install and no host fills in all of them
 * consistently: the plan's `name` (the npm package, e.g. `dsh-api-relay-audit`),
 * the plan's `id` (`npm:dsh-api-relay-audit@2.5.0`), and whatever the host
 * echoes back (`npm:dsh-api-relay-audit`, or a bare `dsh-api-relay-audit`).
 * Comparing only exact strings made a member that installed perfectly look
 * absent, which the executor then reported as `verify-failed` — a success
 * turned into a failure by a missing colon.
 *
 * Exact matches win before normalised ones, so a host that distinguishes two
 * versions of the same package is still read correctly.
 */
function findInstalled(
  installed: readonly InstalledEntry[] | undefined,
  member: { name: string; id: string; spec?: string },
): InstalledEntry | undefined {
  // An unreadable inventory is not an empty one: reporting "not found" here
  // would let a member that IS installed be rolled back.
  if (installed === undefined) return undefined
  const exact = installed.find((entry) => entry.id === member.name || entry.id === member.id)
  if (exact !== undefined) return exact
  const wanted = new Set([baseOf(member.name), baseOf(member.id)])
  const byBase = installed.find((entry) => wanted.has(baseOf(entry.id)))
  if (byBase !== undefined) return byBase
  // A git member is `owner/repo` in the catalog but the host reports the
  // installed package by its own name (`dsh-perlica-ding`). `baseOf` cannot
  // close that gap — only `sameIdentity`'s git arm folds it — and a miss here
  // turned a successful git install into a `verify-failed` the user saw as
  // "the host has not loaded it".
  //
  // `spec` is required for this: the plan's `id` is already `memberSpecId()`'s
  // output, which strips the `git:` prefix, so neither it nor `name` still
  // looks like a git reference to fold.
  const identities = [member.spec, member.name, member.id]
    .filter((value): value is string => typeof value === 'string' && value !== '')
  return installed.find((entry) => identities.some((identity) => sameIdentity(entry.id, identity)))
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

// Re-exported so callers of this module do not need a second import just to
// read a progress counter.
export { operationProgress }
