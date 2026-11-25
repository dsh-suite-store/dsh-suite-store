/**
 * The operation record: what an install is doing, saved often enough that a
 * page reload — or a wiped host — does not lose the answer (§7.5).
 *
 * An install is measured in dozens of package-manager runs and can take
 * minutes; a browser tab is not that durable. The record is written before
 * every phase change so that whoever opens the store next finds a truthful
 * account of what happened, including the members that were mid-flight. The
 * UI then offers "continue" (re-run failed and unstarted members) instead of
 * "install", which would redo everything already done.
 *
 * This module is pure: it decides what a record MEANS and how it evolves.
 * Reading and writing the file is `operation-file.ts`, and running the
 * members is `runner.ts`.
 */

import { baseName, type InstallPlan, type InstallStep } from './plan.ts'

/**
 * Lifecycle of one install operation (§7.1).
 *
 * The order is the order of the transitions, but the type is a flat union on
 * purpose: an operation can jump to `blocked` or `failed` from most phases,
 * and encoding that as a chain of narrower states would force the UI to build
 * the same information back out of it.
 */
export type OperationStatus =
  /** Accepted, nothing has touched the profile yet. */
  | 'queued'
  /** Checking host availability, capabilities and build approvals. */
  | 'preflight'
  /** Installing members one at a time. */
  | 'installing'
  /** Every member is in place; the host is restarting to load them (CLI only). */
  | 'restarting'
  /** Re-checking each member after the restart. */
  | 'verifying'
  /** Every member is installed and verified. */
  | 'done'
  /** Some members are installed, some are not. The profile is usable. */
  | 'partial'
  /** Refused before any side effect; retrying later may help. */
  | 'blocked'
  /** Stopped by the user. Already-installed members stay. */
  | 'cancelled'

/**
 * Which way the operation moves plugins.
 *
 * Removal shares this record with install because it shares everything the
 * progress panel draws — an ordered member list, per-member outcomes and a
 * final report — and differs only in the verb. Two record shapes would let the
 * executor, the SSE route and the client drift apart the moment the second
 * kind was added; one field cannot drift.
 *
 * Absent means `install`: records written before removals existed carry no
 * `kind`, and reading them as anything else would relabel history. That is why
 * this field is optional and why `parseOperation` only ever writes
 * `'uninstall'` back, never a default.
 */
export type OperationKind = 'install' | 'uninstall'

/** Per-member progress, as the UI shows it (§7.3). */
export type MemberState =
  /** Planned, not started. */
  | 'pending'
  /** The host is installing it right now. */
  | 'running'
  /** Installed and, when verification ran, verified. */
  | 'ok'
  | 'skipped'
  /** The user refused to let it run build scripts; it was never installed. */
  | 'skipped-build-denied'
  /**
   * The host would not remove it while the process holds it, so it was
   * disabled instead: it stops running now and goes away on the next start.
   *
   * Distinct from `failed` because nothing is broken and the user has no
   * reparation to make — the removal is done, the process just cannot finish
   * it. A host that refuses outright without letting the plugin be disabled
   * still reports `failed`, since there the restart alone would not help.
   */
  | 'needs-restart'
  | 'failed'

/**
 * The six steps of §7.3, in order.
 *
 * `snapshot` and `resolve` are tracked separately from `add` because they are
 * where the cheap failures happen (a member whose version no longer exists),
 * and a report that says "install failed" for those sends the user looking at
 * the wrong thing.
 */
export type MemberPhase = 'snapshot' | 'resolve' | 'add' | 'verify' | 'record' | 'remove'

/** Why a member failed, in the terms §7.4 defines. */
export type FailureType =
  | 'install-failed'
  | 'load-failed'
  | 'verify-failed'
  | 'build-denied'
  | 'timeout-too-late'
  /** A removal the host refused; the plugin is still there (§7.7). */
  | 'remove-failed'

export interface MemberFailure {
  key: string
  phase: MemberPhase
  type: FailureType
  /**
   * A tag the UI can translate, when the failure has a recognizable cause.
   *
   * `reason` stays the English sentence because it carries detail no tag can
   * (which package wanted which range from which runtime), and it is what the
   * sheet shows when the tag is absent or the client has no wording for it.
   */
  cause?: string
  /**
   * The `allowBuilds` key that would authorise this member's build script.
   *
   * Only pnpm knows it for a git dependency (it names the commit that install
   * fetches), and it prints the line once, at the refusal. Recorded here so the
   * next preflight can offer it as an approval instead of showing the same
   * refusal with nothing actionable behind it.
   */
  buildKey?: string
  /** Human-readable reason, already the most specific text we had. */
  reason: string
  /**
   * What the bundle asked for versus what the registry gave (§7.4).
   *
   * Attached to the failure rather than made a failure type of its own: the
   * member still failed to load, and collapsing the two into one type would
   * lose the reason. `pinned` is carried because "we pinned 0.6.11 and got
   * 0.6.9" is a broken catalog, while an unpinned member drifting is normal.
   */
  versionDrift?: { requested: string; resolved: string; pinned: boolean }
}

export interface MemberRecord {
  key: string
  id: string
  name: string
  state: MemberState
  /** Last phase reached; the UI shows which step a running member is on. */
  phase?: MemberPhase
  /** What was actually installed, when the host told us. */
  resolvedVersion?: string
  failure?: MemberFailure
}

/** Everything one install operation knows about itself. */
export interface OperationRecord {
  /** Monotonic id, also the file name under `<profile>/.dsh-suite-store/operations/`. */
  opId: string
  bundleId: string
  bundleVersion: string
  /** Which way this run moves plugins; absent means `install` (§7.7). */
  kind?: OperationKind
  /** `cli` restarts the host once at the end; `desktop` cannot (§7.2). */
  hostKind: 'cli' | 'desktop'
  status: OperationStatus
  startedAt: string
  updatedAt: string
  /** Members in plan order; the UI renders them in this order. */
  members: MemberRecord[]
  /** Why the operation is blocked or failed as a whole, when it is. */
  reason?: string
  /** Set once the user asked to stop; the runner stops after the current member. */
  cancelRequested?: boolean
}

/**
 * Start a record from a plan.
 *
 * @param input.plan - the ordered plan the executor will follow.
 * @param input.opId - id chosen by the orchestrator.
 * @param input.now - ISO timestamp.
 * @returns a `queued` record whose members mirror the plan exactly.
 *
 * The record copies the plan's members instead of referencing them so that a
 * catalog refresh mid-install cannot change what the progress screen claims
 * is happening.
 */
export function startOperation(input: {
  opId: string
  bundleId: string
  bundleVersion: string
  hostKind: 'cli' | 'desktop'
  plan: InstallPlan
  now: string
}): OperationRecord {
  const members: MemberRecord[] = []
  for (const member of input.plan.skipped) {
    members.push({ key: member.key, id: '', name: '', state: 'skipped' })
  }
  for (const step of input.plan.steps) {
    members.push({ key: step.key, id: step.id, name: step.name, state: 'pending' })
  }
  return {
    opId: input.opId,
    bundleId: input.bundleId,
    bundleVersion: input.bundleVersion,
    hostKind: input.hostKind,
    status: 'queued',
    startedAt: input.now,
    updatedAt: input.now,
    members,
  }
}

/**
 * Start a removal record from the ids the user checked.
 *
 * A removal has no `InstallPlan`: there is nothing to resolve, no build
 * approval to ask for, and no member that can be "already installed". The only
 * thing it shares with an install is the SHAPE the progress panel reads — an
 * ordered list of members with one state each — so the record is built here
 * from the ids rather than from a plan that would have to be invented first.
 *
 * `key` and `name` are the id itself: a removal is identified by the plugin it
 * targets, and there is no catalog member to borrow a friendly name from (the
 * plugin may have come from anywhere).
 *
 * @param input.ids - the checked plugin identities, in the order shown.
 * @returns a `queued` record whose members are all `pending`.
 */
export function startRemoval(input: {
  opId: string
  bundleId: string
  bundleVersion: string
  hostKind: 'cli' | 'desktop'
  ids: readonly string[]
  now: string
}): OperationRecord {
  const members: MemberRecord[] = input.ids.map((id) => ({
    key: id,
    id,
    name: baseName(id),
    state: 'pending',
  }))
  return {
    opId: input.opId,
    bundleId: input.bundleId,
    bundleVersion: input.bundleVersion,
    kind: 'uninstall',
    hostKind: input.hostKind,
    status: 'queued',
    startedAt: input.now,
    updatedAt: input.now,
    members,
  }
}

/**
 * Whether the record still describes work in flight.
 *
 * A record that is not live is history: the UI must not offer "cancel" for it
 * and the orchestrator must not refuse a new install because of it. This is
 * what makes a host killed mid-install recoverable — nothing has to clean up
 * the file, it simply stops being live.
 */
export function isLive(operation: OperationRecord): boolean {
  return operation.status === 'queued'
    || operation.status === 'preflight'
    || operation.status === 'installing'
    || operation.status === 'restarting'
    || operation.status === 'verifying'
}

/** Counts the progress bar needs, in one place so UI and report agree. */
export function operationProgress(operation: OperationRecord): {
  total: number
  done: number
  failed: number
  skipped: number
  pending: number
} {
  let done = 0
  let failed = 0
  let skipped = 0
  let pending = 0
  for (const member of operation.members) {
    switch (member.state) {
      case 'ok':
      case 'needs-restart':
        // Counted as done: the removal was carried out, only its effect waits
        // for the next start. Leaving it out made a finished uninstall read as
        // an unfinished run with a number that could never reach the total.
        done += 1
        break
      case 'failed':
        failed += 1
        break
      case 'skipped':
      case 'skipped-build-denied':
        skipped += 1
        break
      case 'pending':
      case 'running':
        pending += 1
        break
    }
  }
  return { total: operation.members.length, done, failed, skipped, pending }
}

/**
 * The aggregate status after the member loop ends (§7.1, D15).
 *
 * There is no stored "partial" state to keep in sync: it is derived from the
 * members, so a record cannot claim to be complete while a member is still
 * pending. "Cancelled" is the one status the loop cannot derive, because the
 * user's intent is not visible in the member list.
 */
export function concludeStatus(operation: OperationRecord): OperationStatus {
  const { failed, pending } = operationProgress(operation)
  if (operation.cancelRequested === true) return 'cancelled'
  if (failed === 0 && pending === 0) return 'done'
  return 'partial'
}

/** Replace one member immutably, returning the same record when it is absent. */
export function patchMember(
  operation: OperationRecord,
  key: string,
  patch: Partial<MemberRecord>,
): OperationRecord {
  let found = false
  const members = operation.members.map((member) => {
    if (member.key !== key) return member
    found = true
    return { ...member, ...patch }
  })
  return found ? { ...operation, members } : operation
}

/**
 * The members a "continue" run still has to deal with (§7.5).
 *
 * `pending` and `failed` are the obvious retries. `running` is included too:
 * the host dying mid-install persists the member in exactly that state, and
 * excluding it left the record partial forever — the member had been started,
 * so it was neither pending nor failed, and no later run ever touched it
 * again. A member that actually landed is short-circuited by the planner's
 * skip rule, so retrying a `running` row cannot double-install anything.
 *
 * A member skipped because the user denied its build scripts is deliberately
 * NOT retried: the denial is a decision, and silently re-asking on every
 * resume would be a dialog nobody can get rid of. The user can re-run the
 * install to be asked again.
 */
export function resumableSteps(operation: OperationRecord, plan: InstallPlan): InstallStep[] {
  const wanted = new Set(
    operation.members
      .filter((member) => member.state === 'pending' || member.state === 'failed' || member.state === 'running')
      .map((member) => member.key),
  )
  return plan.steps.filter((step) => wanted.has(step.key))
}

/** Narrow whatever was on disk into a record, or reject it. */
export function parseOperation(raw: unknown): OperationRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.opId !== 'string' || typeof record.bundleId !== 'string') return undefined
  if (typeof record.status !== 'string' || !isStatus(record.status)) return undefined
  if (!Array.isArray(record.members)) return undefined
  const members: MemberRecord[] = []
  for (const value of record.members) {
    if (typeof value !== 'object' || value === null) continue
    const member = value as Record<string, unknown>
    if (typeof member.key !== 'string' || typeof member.state !== 'string' || !isMemberState(member.state)) continue
    const parsed: MemberRecord = {
      key: member.key,
      id: typeof member.id === 'string' ? member.id : '',
      name: typeof member.name === 'string' ? member.name : '',
      state: member.state,
    }
    if (typeof member.resolvedVersion === 'string') parsed.resolvedVersion = member.resolvedVersion
    if (isMemberPhase(member.phase)) parsed.phase = member.phase
    if (isFailure(member.failure)) parsed.failure = member.failure
    members.push(parsed)
  }
  const parsed: OperationRecord = {
    opId: record.opId,
    bundleId: record.bundleId,
    bundleVersion: typeof record.bundleVersion === 'string' ? record.bundleVersion : '0.0.0',
    hostKind: record.hostKind === 'desktop' ? 'desktop' : 'cli',
    status: record.status,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    members,
  }
  if (typeof record.reason === 'string') parsed.reason = record.reason
  if (record.cancelRequested === true) parsed.cancelRequested = true
  // Only written back when it says `uninstall`: a record from before removals
  // existed must keep reading as an install rather than gain a field that
  // claims its author made a choice they never made.
  if (record.kind === 'uninstall') parsed.kind = 'uninstall'
  return parsed
}

function isStatus(value: string): value is OperationStatus {
  return value === 'queued' || value === 'preflight' || value === 'installing'
    || value === 'restarting' || value === 'verifying' || value === 'done'
    || value === 'partial' || value === 'blocked' || value === 'cancelled'
}

function isMemberState(value: string): value is MemberState {
  // `needs-restart` belongs here. It was omitted, so a member disabled-and-
  // pending-removal was dropped by `parseOperation` entirely: the user was told
  // "restart to finish", restarted, and the record was gone — no row, no
  // reason, nothing to confirm the removal completed. The state is written by
  // the uninstall path (store.ts), so a rejection here loses real data.
  return value === 'pending' || value === 'running' || value === 'ok'
    || value === 'skipped' || value === 'skipped-build-denied' || value === 'needs-restart'
    || value === 'failed'
}

function isMemberPhase(value: unknown): value is MemberPhase {
  return value === 'snapshot' || value === 'resolve' || value === 'add' || value === 'verify'
    || value === 'record' || value === 'remove'
}

function isFailure(value: unknown): value is MemberFailure {
  if (typeof value !== 'object' || value === null) return false
  const failure = value as Record<string, unknown>
  return typeof failure.key === 'string'
    && isMemberPhase(failure.phase)
    && typeof failure.type === 'string'
    && typeof failure.reason === 'string'
    && (failure.type === 'install-failed' || failure.type === 'load-failed'
      || failure.type === 'verify-failed' || failure.type === 'build-denied'
      || failure.type === 'timeout-too-late' || failure.type === 'remove-failed')
}
