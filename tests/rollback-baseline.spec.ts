import { describe, expect, it } from 'vitest'

import { InstallExecutor, type ExecutorHost, type InstallEvent } from '../src/install/executor.ts'
import { createMemoryInstallStore } from '../src/install/store.ts'
import { emptyProvenance } from '../src/install/state.ts'
import type { InstallPlan } from '../src/install/plan.ts'
import type { InstalledEntry } from '../src/install/host.ts'

/**
 * Regression tests for the rollback's data-loss defect.
 *
 * The shape the review found: a failed UPDATE plus one transient error reading
 * the installed list made the rollback remove the user's pre-existing copy.
 * `host.remove` folds a versioned spec onto its bare name, so removing
 * `npm:alpha@2.0.0` when only `alpha@1.0.0` is installed deletes the working
 * plugin.
 *
 * The rule being pinned: an unknown baseline means NO removal. Leaving files
 * behind is recoverable; deleting a working plugin is not.
 */
const alphaUpgrade = {
  key: 'alpha',
  id: 'npm:alpha@2.0.0',
  spec: 'npm:alpha@2.0.0',
  pinnedVersion: '2.0.0',
  name: 'alpha',
  approvedBuilds: [],
}

const betaFresh = {
  key: 'beta',
  id: 'npm:beta@1.0.0',
  spec: 'npm:beta@1.0.0',
  pinnedVersion: '1.0.0',
  name: 'beta',
  approvedBuilds: [],
}

const planOf = (step: typeof alphaUpgrade): InstallPlan => ({ steps: [step], skipped: [] })

/**
 * A host holding whatever the test seeds, whose `installed()` fails on chosen
 * calls and whose install always fails (optionally writing first).
 *
 * @param options.seed - ids present before anything runs.
 * @param options.installedFailsOn - 0-based indices of `installed()` calls that
 *   throw; every other call answers with the CURRENT contents.
 * @param options.writes - what the failed install leaves behind first.
 */
function host(options: {
  seed?: string[]
  installedFailsOn?: number[]
  writes?: string[]
} = {}): ExecutorHost & { removed: string[]; installedCalls: number } {
  const failsOn = new Set(options.installedFailsOn ?? [])
  const entries: InstalledEntry[] = (options.seed ?? []).map((id) => ({
    id,
    version: id.split('@').at(-1) ?? '0.0.0',
  }))
  const removed: string[] = []
  const self = {
    removed,
    installedCalls: 0,
    async installed(): Promise<InstalledEntry[]> {
      const call = self.installedCalls
      self.installedCalls += 1
      if (failsOn.has(call)) throw new Error('the profile could not be read')
      return entries.map((entry) => ({ ...entry }))
    },
    async install(): Promise<{ status: 'failed'; reason: string }> {
      for (const id of options.writes ?? []) {
        entries.push({ id, version: id.split('@').at(-1) ?? '0.0.0' })
      }
      return { status: 'failed', reason: 'peer dependency conflict' }
    },
    async cancel() {
      return 'not-running' as const
    },
    async remove(id: string): Promise<void> {
      removed.push(id)
      const at = entries.findIndex((entry) => entry.id === id)
      if (at !== -1) entries.splice(at, 1)
    },
  }
  return self as unknown as ExecutorHost & { removed: string[]; installedCalls: number }
}

function executor(hostImpl: ExecutorHost) {
  const events: InstallEvent[] = []
  const instance = new InstallExecutor({
    host: hostImpl,
    store: createMemoryInstallStore(emptyProvenance()),
    capabilities: { canRestart: false },
    emit: (event) => events.push(event),
    now: () => '2026-11-25T00:00:00.000Z',
    memberTimeoutMs: 5_000,
  })
  return { instance, events }
}

const run = (hostImpl: ExecutorHost, step: typeof alphaUpgrade = alphaUpgrade) =>
  executor(hostImpl).instance.start({ bundleId: 'b', bundleVersion: '2.0.0', plan: planOf(step) })

describe('a failed update never deletes the copy that was already installed', () => {
  it('removes nothing when the baseline could not be read', async () => {
    // Call 0 is the pre-install snapshot (fails: no baseline).
    // Call 1 is the rollback's re-read, which succeeds and shows the old copy.
    // Before the fix this called remove('npm:alpha@2.0.0'), which the host folds
    // onto the bare name and applies to the installed alpha@1.0.0.
    const hostImpl = host({ seed: ['npm:alpha@1.0.0'], installedFailsOn: [0] })
    await run(hostImpl)

    expect(hostImpl.removed).toEqual([])
  })

  it('says so, instead of reporting a clean undo', async () => {
    const hostImpl = host({ seed: ['npm:alpha@1.0.0'], installedFailsOn: [0] })
    const { instance, events } = executor(hostImpl)
    await instance.start({ bundleId: 'b', bundleVersion: '2.0.0', plan: planOf(alphaUpgrade) })

    const notes = events.filter((event) => event.type === 'op-note').map((event) => event.note)
    expect(notes.join('\n')).toMatch(/did not undo alpha/u)
  })

  it('still removes a leftover the baseline proves is new', async () => {
    // A fresh member (not an upgrade): the baseline has alpha only, so a beta
    // that was written before the failure is unambiguously this member's.
    const hostImpl = host({ seed: ['npm:alpha@1.0.0'], writes: ['npm:beta@1.0.0'] })
    await run(hostImpl, betaFresh)

    expect(hostImpl.removed).toEqual(['npm:beta@1.0.0'])
  })

  it('leaves an upgrade alone, because the new id folds onto the old copy', async () => {
    // Conservative by design: `findInstalled` matches on the base name, so a
    // baseline holding alpha@1.0.0 makes alpha@2.0.0 look pre-existing and the
    // rollback refuses to touch it. That keeps a half-written upgrade on disk,
    // which is recoverable; removing it would risk the user's working plugin.
    const hostImpl = host({ seed: ['npm:alpha@1.0.0'], writes: ['npm:alpha@2.0.0'] })
    await run(hostImpl)

    expect(hostImpl.removed).toEqual([])
  })

  it('never removes by bare name', async () => {
    const hostImpl = host({ seed: ['npm:alpha@1.0.0'], writes: ['npm:beta@1.0.0'] })
    await run(hostImpl, betaFresh)

    expect(hostImpl.removed.every((id) => id.includes('@'))).toBe(true)
  })
})
