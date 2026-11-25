import { describe, expect, it, vi } from 'vitest'

import {
  InstallExecutor,
  OperationBusyError,
  type ExecutorHost,
  type InstallEvent,
} from '../src/install/executor.ts'
import { createMemoryInstallStore, type InstallStore } from '../src/install/store.ts'
import { emptyProvenance } from '../src/install/state.ts'
import type { InstallPlan } from '../src/install/plan.ts'
import type { InstalledEntry } from '../src/install/host.ts'

function step(key: string, overrides: Partial<InstallPlan['steps'][number]> = {}) {
  return {
    key,
    id: `npm:${key}`,
    spec: `npm:${key}@1.0.0`,
    pinnedVersion: '1.0.0',
    name: key,
    approvedBuilds: [],
    ...overrides,
  }
}

function plan(...keys: string[]): InstallPlan {
  return { steps: keys.map((key) => step(key)), skipped: [] }
}

/** A host whose install queue decides what each member does. */
function fakeHost(
  outcomes: Record<string, 'ok' | 'failed' | 'failed-after-landing' | 'throw' | 'hang' | 'ambiguous' | 'ambiguous-unconfirmed'> = {},
): ExecutorHost & {
  installedIds: Set<string>
  cancelled: string[]
} {
  const installedIds = new Set<string>()
  const cancelled: string[] = []
  return {
    installedIds,
    cancelled,
    async installed(): Promise<InstalledEntry[]> {
      return [...installedIds].map((id) => ({ id, version: '1.0.0' }))
    },
    async install({ spec }) {
      const key = spec.replace(/^npm:/u, '').split('@')[0] ?? spec
      const outcome = outcomes[key] ?? 'ok'
      if (outcome === 'throw') throw new Error(`host refused ${key}`)
      if (outcome === 'hang') return new Promise(() => undefined)
      if (outcome === 'failed') return { status: 'failed', reason: `pnpm failed for ${key}` }
      if (outcome === 'failed-after-landing') {
        // The shape §7.3 is about: the package manager wrote the package and
        // THEN failed (a peer-dependency error after the files landed), so the
        // profile lists it and the rollback has a real leftover to remove.
        installedIds.add(key)
        return { status: 'failed', reason: `pnpm failed for ${key} after writing it` }
      }
      if (outcome === 'ambiguous') {
        // The real host's shape: pnpm exited 0, the plugin IS on disk, and
        // only the host's own dependency diff failed to name it.
        installedIds.add(key)
        return { status: 'unknown', reason: 'the host could not tell whether the install landed; check the plugin list before retrying' }
      }
      if (outcome === 'ambiguous-unconfirmed') {
        // Half-written files, no dependency entry: the profile cannot confirm it.
        return { status: 'unknown', reason: 'the host could not tell whether the install landed; check the plugin list before retrying' }
      }
      installedIds.add(key)
      return { status: 'ok' }
    },
    async cancel(requestId) {
      cancelled.push(requestId)
      return 'cancelled'
    },
  }
}

function executor(host: ExecutorHost, options: { store?: InstallStore; canRestart?: boolean } = {}) {
  const events: InstallEvent[] = []
  const store = options.store ?? createMemoryInstallStore(emptyProvenance())
  const instance = new InstallExecutor({
    store,
    host,
    capabilities: { canRestart: options.canRestart ?? false },
    emit: (event) => events.push(event),
    now: () => '2026-11-11T00:00:00.000Z',
    // The member budget is what actually drives the timeout tests; the old
    // `delay` option was never read by `withTimeout` and has been removed.
    memberTimeoutMs: 10,
  })
  return { instance, events, store }
}

describe('install executor', () => {
  it('installs every member in plan order and reports success', async () => {
    const host = fakeHost()
    const { instance, events } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(report.ok).toEqual(['alpha', 'beta'])
    expect(report.failed).toEqual([])
    expect(report.status).toBe('done')
    expect(events.map((event) => event.type)).toContain('op-end')
  })

  it('releases the operation lock when a write throws', async () => {
    // A read-only profile dir or an SSE write to a closed socket used to leave
    // `current` live forever: every later install/uninstall/toggle 409'd until
    // the host restarted.
    const { instance, store } = executor(fakeHost())
    vi.spyOn(store, 'writeProvenance').mockRejectedValueOnce(new Error('disk full'))
    await expect(instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') }))
      .rejects.toThrow('disk full')
    // A new run must be accepted: before the fix the first failure left the
    // in-memory lock live forever, so this second start threw "busy".
    const second = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('beta') })
    expect(second.status).toBe('done')
  })

  it('attaches the record to every member event', async () => {
    // The page's reducer ignores an event with no `op`, so omitting it froze
    // the progress panel at 0/N until the run ended. Uninstall events have
    // always carried one; install events now hold to the same contract.
    const { instance, events } = executor(fakeHost())
    await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    const memberEvents = events.filter((event) =>
      event.type === 'member-start' || event.type === 'member-done' || event.type === 'member-phase')
    expect(memberEvents.length).toBeGreaterThan(0)
    for (const event of memberEvents) {
      expect((event as { op?: unknown }).op).toBeDefined()
    }
  })

  it('continues after a failed member, which is the whole point', async () => {
    const host = fakeHost({ alpha: 'failed' })
    const { instance } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(report.status).toBe('partial')
    expect(report.ok).toEqual(['beta'])
    expect(report.failed).toEqual([
      { key: 'alpha', phase: 'add', type: 'install-failed', reason: 'pnpm failed for alpha' },
    ])
  })

  it('records a host refusal as a member failure without stopping the run', async () => {
    const host = fakeHost({ alpha: 'throw' })
    const { instance } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(report.failed[0]?.reason).toMatch(/host refused alpha/u)
    expect(report.ok).toEqual(['beta'])
  })

  // §7.3: the BUNDLE is never rolled back, but a single MEMBER is. A package
  // manager can add half a tree and then fail on a peer dependency; those
  // files are real, so the next attempt answers `already-installed` and the
  // user cannot get past a failure they already saw.
  it('removes what a failed member left behind', async () => {
    const host = fakeHost({ alpha: 'failed-after-landing' })
    const removed: string[] = []
    const { instance } = executor({
      ...host,
      async remove(id) {
        removed.push(id)
        host.installedIds.delete(id)
      },
    })
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    // The leftover APPEARED during this member (it is in the post-run
    // inventory but not in the baseline), which is what makes it this member's
    // to remove. The host reports it by its own id (`alpha`), so that is what
    // the rollback passes to `remove`.
    expect(removed).toEqual(['alpha'])
    expect(report.ok).toEqual(['beta'])
  })

  it('never removes a plugin the profile had before the install', async () => {
    const host = fakeHost({ alpha: 'failed' })
    const removed: string[] = []
    const { instance } = executor({
      ...host,
      async remove(id) {
        removed.push(id)
      },
    })
    // `old` and `alpha` were both installed before this run. The alpha install
    // fails without landing anything, so the diff is empty — and the member's
    // own identity must NOT be removed either, because that entry is the
    // user's pre-existing copy. This is the failed-UPDATE case: the usual way
    // to reach the empty-diff branch is a reinstall of something already here,
    // so removing `[step.id]` would delete the working plugin.
    host.installedIds.add('old')
    host.installedIds.add('alpha')
    await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(removed).toEqual([])
    expect(host.installedIds.has('old')).toBe(true)
    expect(host.installedIds.has('alpha')).toBe(true)
  })

  // §7.5 governs this case: the host says it could not tell, so ask the
  // profile instead of assuming. Observed live as `ambiguous-install`, where
  // pnpm exited 0 and the plugin WAS installed — treating it as a failure
  // rolled back a working plugin and made the next click download it again.
  it('believes the profile when the host cannot say whether the install landed', async () => {
    const host = fakeHost({ alpha: 'ambiguous' })
    const removed: string[] = []
    const { instance, events } = executor({
      ...host,
      async remove(id) {
        removed.push(id)
      },
    })
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(report.failed).toEqual([])
    expect(report.ok).toEqual(['alpha'])
    expect(removed).toEqual([])
    expect(events.some((event) => event.type === 'op-note')).toBe(false)
  })

  it('rolls an ambiguous member back when the profile does not list it', async () => {
    // The other half of the same rule: an `unknown` that the profile does not
    // confirm is a failure, and half-written files may still be on disk.
    const host = fakeHost({ alpha: 'ambiguous-unconfirmed' })
    const removed: string[] = []
    const { instance, events } = executor({
      ...host,
      async remove(id) {
        removed.push(id)
      },
    })
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(report.ok).toEqual([])
    expect(report.failed[0]?.key).toBe('alpha')
    expect(removed).toEqual(['npm:alpha'])
    expect(events.some((event) => event.type === 'op-note')).toBe(true)
  })

  it('says so when it cannot undo a failed member, instead of pretending', async () => {
    const host = fakeHost({ alpha: 'failed' })
    const { instance, events } = executor(host)
    host.installedIds.add('alpha')
    await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    const note = events.find((event) => event.type === 'op-note')
    expect(note).toBeDefined()
    expect((note as { note: string }).note).toMatch(/behind/u)
  })

  it('writes provenance for each installed member keyed by identity', async () => {
    const host = fakeHost()
    const { instance, store } = executor(host)
    await instance.start({ bundleId: 'fin', bundleVersion: '2.0.0', plan: plan('alpha') })
    const state = await store.readProvenance()
    expect(state.entries['npm:alpha']?.sources).toEqual([
      { kind: 'bundle', bundleId: 'fin', version: '2.0.0', at: '2026-11-11T00:00:00.000Z' },
    ])
    expect(state.entries['npm:alpha']?.resolvedVersion).toBe('1.0.0')
  })

  it('skips a member whose build scripts the user denied', async () => {
    const host = fakeHost()
    const { instance } = executor(host)
    const report = await instance.start({
      bundleId: 'b',
      bundleVersion: '1.0.0',
      plan: plan('alpha', 'beta'),
      deniedBuilds: ['alpha'],
    })
    expect(report.skippedBuildDenied).toEqual(['alpha'])
    expect(report.ok).toEqual(['beta'])
    expect(host.installedIds.has('alpha')).toBe(false)
  })

  it('passes only the approvals of the member being installed', async () => {
    const seen: { spec: string; approvedBuilds: readonly string[] }[] = []
    const host: ExecutorHost = {
      async installed() {
        return []
      },
      async install(input) {
        seen.push({ spec: input.spec, approvedBuilds: input.approvedBuilds })
        return { status: 'ok' }
      },
      async cancel() {
        return 'cancelled'
      },
    }
    // The fake above never reports the plugin as installed, so members fail
    // verification — but the approval plumbing is what this asserts.
    const custom = new InstallExecutor({
      store: createMemoryInstallStore(),
      host,
      capabilities: { canRestart: false },
      now: () => '2026-11-11T00:00:00.000Z',
    })
    await custom.start({
      bundleId: 'b',
      bundleVersion: '1.0.0',
      plan: { steps: [step('alpha', { approvedBuilds: ['alpha'] }), step('beta')], skipped: [] },
    })
    expect(seen).toEqual([
      { spec: 'npm:alpha@1.0.0', approvedBuilds: ['alpha'] },
      { spec: 'npm:beta@1.0.0', approvedBuilds: [] },
    ])
  })

  it('fails a member that installs but never shows up', async () => {
    const host: ExecutorHost = {
      async installed() {
        return []
      },
      async install() {
        return { status: 'ok' }
      },
      async cancel() {
        return 'cancelled'
      },
    }
    const { instance } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(report.failed[0]).toMatchObject({ key: 'alpha', type: 'verify-failed', phase: 'verify' })
  })

  it('does not fail a git member the host reports under its package name', async () => {
    // The catalog names this `git:117BS/dsh-perlica-ding`; pnpm installs it and
    // the host lists it as the package `dsh-perlica-ding`. Comparing only
    // prefix-stripped strings made this a phantom verify-failed, which the user
    // saw as "installed but the host has not loaded it".
    const host: ExecutorHost = {
      async installed() {
        return [{ id: 'dsh-perlica-ding', version: '0.2.1' }]
      },
      async install() {
        return { status: 'ok' }
      },
      async cancel() {
        return 'cancelled'
      },
    }
    const { instance } = executor(host)
    const report = await instance.start({
      bundleId: 'b',
      bundleVersion: '1.0.0',
      plan: {
        steps: [step('ding', {
          // `id` is `memberSpecId()`'s output: the `git:` prefix is already
          // stripped, so only `spec` still identifies this as a git install.
          id: '117BS/dsh-perlica-ding',
          spec: 'git:117BS/dsh-perlica-ding',
          name: '117BS/dsh-perlica-ding',
          pinnedVersion: null,
        })],
        skipped: [],
      },
    })
    expect(report.failed).toEqual([])
    expect(report.ok).toEqual(['ding'])
  })

  it('cancels a timed-out member and carries on', async () => {
    const host = fakeHost({ alpha: 'hang' })
    const { instance } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(host.cancelled).toEqual([expect.stringMatching(/:alpha$/u)])
    expect(report.failed[0]).toMatchObject({ key: 'alpha', type: 'install-failed' })
    expect(report.ok).toEqual(['beta'])
  })

  it('stops the whole run when a timeout cannot be cancelled', async () => {
    const host: ExecutorHost = {
      async installed() {
        return []
      },
      async install() {
        return new Promise(() => undefined)
      },
      async cancel() {
        return 'too-late'
      },
    }
    const { instance } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(report.failed).toEqual([
      expect.objectContaining({ key: 'alpha', type: 'timeout-too-late' }),
    ])
    // beta was never attempted: the profile is in an unknown state.
    expect(report.ok).toEqual([])
  })

  it('accepts a member that the host reports as not-running but actually landed', async () => {
    const state = { installed: [] as InstalledEntry[] }
    const host: ExecutorHost = {
      async installed() {
        return state.installed
      },
      async install({ spec }) {
        // Install completes on its own, after our timer fired but before the
        // cancellation reached the host.
        state.installed = [{ id: 'alpha', version: '1.0.0' }]
        void spec
        return new Promise(() => undefined)
      },
      async cancel() {
        return 'not-running'
      },
    }
    const { instance } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(report.ok).toEqual(['alpha'])
  })

  it('restarts and verifies only when the host can restart', async () => {
    const host = fakeHost()
    const withRestart = executor(host, { canRestart: true })
    await withRestart.instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(withRestart.events.map((event) => event.type)).toContain('op-restarting')

    const without = executor(fakeHost(), { canRestart: false })
    await without.instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(without.events.map((event) => event.type)).not.toContain('op-restarting')
  })

  it('demotes a member that vanished after the restart to load-failed', async () => {
    // A host that claims success and lists the plugin, then forgets it once
    // the verification listing happens — the native-module case.
    // before → after → verify: the third listing is the post-restart check.
    let listings = 0
    const host: ExecutorHost = {
      async installed() {
        listings += 1
        return listings >= 3 ? [] : [{ id: 'alpha', version: '1.0.0' }]
      },
      async install() {
        return { status: 'ok' }
      },
      async cancel() {
        return 'cancelled'
      },
    }
    const { instance } = executor(host, { canRestart: true })
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(report.failed[0]).toMatchObject({ type: 'load-failed' })
  })

  it('refuses a second concurrent operation', async () => {
    const host = fakeHost({ alpha: 'hang' })
    const { instance } = executor(host)
    const first = instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(instance.start({ bundleId: 'c', bundleVersion: '1.0.0', plan: plan('beta') })).rejects.toBeInstanceOf(
      OperationBusyError,
    )
    await first
  })

  it('stops after the current member when cancelled, keeping what landed', async () => {
    const host = fakeHost()
    // Cancel from inside the install call: the run is provably mid-member, and
    // the member it is in the middle of was never interrupted.
    const cancelling: ExecutorHost = {
      ...host,
      async install(input) {
        const outcome = await host.install(input)
        await instance.requestCancel()
        return outcome
      },
    }
    const { instance } = executor(cancelling)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(report.status).toBe('cancelled')
    expect(report.ok).toEqual(['alpha'])
    expect(host.installedIds.has('beta')).toBe(false)
  })

  it('resumes only the members that did not finish', async () => {
    const store = createMemoryInstallStore()
    const first = executor(fakeHost({ beta: 'failed' }), { store })
    const report = await first.instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(report.failed.map((failure) => failure.key)).toEqual(['beta'])

    const record = (await store.listOperations())[0]
    expect(record).toBeDefined()
    const host = fakeHost()
    const { instance } = executor(host, { store })
    const resumed = await instance.resume(record!, plan('alpha', 'beta'))
    expect(resumed.ok).toEqual(['beta'])
    // Members the record already has do not belong to this resume's report.
    expect(host.installedIds.has('alpha')).toBe(false)
  })

  it('reports a resume with nothing left to do as done', async () => {
    const store = createMemoryInstallStore()
    const { instance } = executor(fakeHost(), { store })
    await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    const record = (await store.listOperations())[0]!
    const resumed = await instance.resume(record, plan('alpha'))
    expect(resumed.status).toBe('done')
    expect(resumed.ok).toEqual(['alpha'])
  })

  it('persists every phase change so a reload can resume', async () => {
    const writes: string[] = []
    const inner = createMemoryInstallStore()
    const store: InstallStore = {
      ...inner,
      async writeOperation(record) {
        writes.push(`${record.status}:${record.members.map((member) => member.state).join(',')}`)
        await inner.writeOperation(record)
      },
    }
    const { instance } = executor(fakeHost(), { store })
    await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    expect(writes).toContain('preflight:pending')
    expect(writes).toContain('installing:running')
    expect(writes.at(-1)).toMatch(/^done:ok$/u)
  })

  it('does not fail the install when the record cannot be written', async () => {
    const store: InstallStore = {
      ...createMemoryInstallStore(),
      async writeOperation() {
        throw new Error('disk full')
      },
    }
    const { instance } = executor(fakeHost(), { store })
    expect((await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })).ok).toEqual(['alpha'])
  })

  it('emits member-phase during the run so the UI can show steps', async () => {
    const { instance, events } = executor(fakeHost())
    await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha') })
    const phases = events.filter((event) => event.type === 'member-phase').map((event) => event.phase)
    expect(phases).toEqual(['resolve', 'record'])
  })

  it('marks every progress counter consistently at the end', async () => {
    const host = fakeHost({ beta: 'failed' })
    const { instance } = executor(host)
    const report = await instance.start({ bundleId: 'b', bundleVersion: '1.0.0', plan: plan('alpha', 'beta') })
    expect(report.status).toBe('partial')
    expect(report.ok.length + report.failed.length + report.skipped.length + report.skippedBuildDenied.length).toBe(2)
  })
})

// Keep the unused import honest: `vi` is used by nothing here today.
void vi
