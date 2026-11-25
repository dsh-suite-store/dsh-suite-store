/**
 * What the exported log says about an UNINSTALL.
 *
 * Install used to be the only half that logged, and that asymmetry is what this
 * file exists to catch: when a removal fails — the commonest complaint is "I
 * clicked uninstall and the plugin is still there" — the export could not say
 * what was removed, which member stuck, or why the host refused.
 *
 * Four things have to be present for a report to be answerable:
 *
 *  1. that a removal started, and for which members;
 *  2. one line per member with its verdict;
 *  3. for a FAILED member, the failure's type, phase and reason — the reason is
 *     the host's own sentence, and it is the whole value of the line;
 *  4. a summary, so the outcome is readable without counting bullets.
 *
 * The host here is deliberately minimal (a map plus a scriptable `removeBundle`)
 * rather than the elaborate fake `store.spec.ts` uses: this suite only needs
 * "the host removes, or refuses with a sentence", and a second copy of that big
 * fake would drift.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CatalogService } from '../src/catalog/service.ts'
import type { DetailLoader } from '../src/catalog/detail.ts'
import type { BundleDetail } from '../src/catalog/types.ts'
import type { HostAdapter, HostPluginManager } from '../src/install/host.ts'
import { emptyProvenance } from '../src/install/state.ts'
import { createMemoryInstallStore } from '../src/install/store.ts'
import { clearLog, exportLogs } from '../src/log/log.ts'
import { StoreService, type ServiceEvent } from '../src/store.ts'

const BUNDLE = 'fin'
const MEMBERS = ['npm:alpha', 'npm:beta'] as const

/** The bundle document both the planner and the removal check read. */
const detail: BundleDetail = {
  format: 1,
  id: BUNDLE,
  owner: 'someone',
  version: '1.0.0',
  readme: { zh: '说明', en: 'Readme' },
  capabilities: [],
  members: MEMBERS.map((id) => ({
    key: id.replace('npm:', ''),
    id,
    name: id.replace('npm:', ''),
    version: null,
    pinned: false,
    spec: id,
  })),
}

function catalog(): CatalogService {
  return { current: async () => ({ index: { bundles: [], format: 1, generatedAt: '', catalogRef: { updated: '', count: 0 }, categories: {} } }) } as unknown as CatalogService
}

function details(): DetailLoader {
  return { load: async () => detail, clear: () => undefined } as unknown as DetailLoader
}

interface Fake {
  adapter: HostAdapter
  manager: HostPluginManager
  removed: string[]
}

/**
 * A host that removes from a map, with per-id scriptable refusal.
 *
 * @param options.installed - ids the profile already holds.
 * @param options.remove - called before a removal; throwing refuses it.
 * @returns the adapter and the removals it performed.
 */
function host(options: { installed?: readonly string[]; remove?: (id: string) => Promise<void> } = {}): Fake {
  const state = new Set(options.installed ?? MEMBERS)
  const removed: string[] = []
  const manager: HostPluginManager = {
    async listPlugins() {
      return [...state].map((id) => ({ moduleName: id }))
    },
    async listBundles() {
      return []
    },
    async removeBundle(name: string) {
      if (options.remove !== undefined) await options.remove(name)
      removed.push(name)
      // The real manager removes by the BARE package name, so `npm:alpha` and
      // `alpha` both find `alpha`.
      const bare = name.replace(/^npm:/u, '')
      for (const id of [...state]) if (id === name || id.replace(/^npm:/u, '') === bare) state.delete(id)
    },
    async setPluginEnabled() {
      return { application: 'ok' }
    },
  }
  return {
    manager,
    removed,
    adapter: {
      manager,
      capabilities: () => ({
        installable: true,
        granularProgress: true,
        passOptions: true,
        canRestart: true,
        canApproveBuilds: true,
        cancelable: true,
      }),
      installed: async () => [...state].map((id) => ({ id })),
      has: (id: string) => state.has(id),
      enabledState: async () => undefined,
      setEnabled: async () => true,
    } as unknown as HostAdapter,
  }
}

function service(fake: Fake, emit?: (event: ServiceEvent) => void): StoreService {
  return new StoreService({
    catalog: catalog(),
    details: details(),
    host: fake.adapter,
    store: createMemoryInstallStore(emptyProvenance()),
    hostKind: 'desktop',
    memberTimeoutMs: 50,
    ...(emit === undefined ? {} : { emit }),
  })
}

/** The exported text, for substring assertions. */
function logged(): string {
  return exportLogs({})
}

/** Lines from the session section that belong to the uninstall subsystem. */
function linesFor(subsystem: string): string[] {
  return logged().split('\n').filter((line) => line.includes(`] ${subsystem}:`))
}

beforeEach(() => {
  clearLog()
})

afterEach(() => {
  clearLog()
})

describe('uninstall logging — the start and the verdicts', () => {
  it('records that a removal started, and which members it targets', async () => {
    const fake = host()
    await service(fake).uninstall({ bundleId: BUNDLE, ids: [...MEMBERS] })

    const start = linesFor('uninstall').find((line) => line.includes('starting'))
    expect(start).toBeDefined()
    expect(start).toContain(BUNDLE)
    // Both ids are named: "removed something" cannot be matched against the
    // plugin a user is complaining about.
    expect(start).toContain('npm:alpha')
    expect(start).toContain('npm:beta')
  })

  it('records one line per member with its verdict', async () => {
    const fake = host()
    await service(fake).uninstall({ bundleId: BUNDLE, ids: [...MEMBERS] })

    const members = linesFor('uninstall').filter((line) => /: (ok|failed|needs-restart|skipped)$/u.test(line))
    expect(members).toHaveLength(2)
    expect(members.some((line) => line.includes('npm:alpha: ok'))).toBe(true)
    expect(members.some((line) => line.includes('npm:beta: ok'))).toBe(true)
  })

  it('records a summary that names the outcome and the counts', async () => {
    const fake = host()
    await service(fake).uninstall({ bundleId: BUNDLE, ids: [...MEMBERS] })

    const summary = linesFor('uninstall').filter((line) => line.includes('removed') || line.includes('removal'))
    expect(summary.length).toBeGreaterThan(0)
    const line = summary[summary.length - 1]!
    expect(line).toContain(BUNDLE)
    expect(line).toMatch(/2 (removed|ok)/u)
  })
})

describe('uninstall logging — failures', () => {
  it("records the host's refusal with its reason when the removal cannot finish", async () => {
    // What a refused removal actually becomes: the store disables the plugin and
    // reports `needs-restart`, because the next start will not compose it. The
    // EXPORT still has to carry the host's sentence — "needs-restart" alone
    // tells a maintainer nothing about why.
    const fake = host({
      remove: async () => {
        throw new Error('bundle-in-use: another plugin composes it')
      },
    })
    const report = await service(fake).uninstall({ bundleId: BUNDLE, ids: ['npm:alpha'] })
    expect(report.failed).toHaveLength(0)

    const line = linesFor('uninstall').find((entry) => entry.includes('npm:alpha') && entry.includes('needs-restart'))
    expect(line).toBeDefined()
    expect(line).toContain('bundle-in-use')
    expect(line).toContain('another plugin composes it')
    // `warn`, not `error`: nothing is broken and the fix is a restart.
    expect(line).toContain('[warn]')
  })

  it('records a genuine failure at error level with the error\'s own type', async () => {
    // A host that cannot even disable the plugin has no restart to offer, so the
    // member really failed — and the error class is part of the evidence.
    class RefusedByHost extends Error {
      override name = 'RefusedByHost'
    }
    const fake = host({
      remove: async () => {
        throw new RefusedByHost('the host will not remove a composed plugin')
      },
    })
    // No `setEnabled` on this adapter, so the disable attempt fails and the
    // store has nothing left to try.
    const bare = {
      ...fake.adapter,
      setEnabled: async () => {
        throw new Error('the host will not disable a composed plugin')
      },
    } as unknown as HostAdapter
    const report = await new StoreService({
      catalog: catalog(),
      details: details(),
      host: bare,
      store: createMemoryInstallStore(emptyProvenance()),
      hostKind: 'desktop',
      memberTimeoutMs: 50,
    }).uninstall({ bundleId: BUNDLE, ids: ['npm:alpha'] })

    expect(report.failed).toHaveLength(1)
    const failure = linesFor('uninstall').find((line) => line.includes('npm:alpha') && line.includes('[error]'))
    expect(failure).toBeDefined()
    // Type and phase, so the line is actionable without the record on disk.
    expect(failure).toMatch(/remove-failed/u)
    expect(failure).toMatch(/composed plugin/u)
  })

  it('records a member that never started because the run was cancelled', async () => {
    let running: StoreService | undefined
    const fake = host()
    running = service(fake, (event) => {
      // Ask to stop while the FIRST member is being removed, so the second is
      // never started — the branch that used to leave no trace at all.
      if (event.type === 'member-done') void running?.cancel()
    })
    await running.uninstall({ bundleId: BUNDLE, ids: [...MEMBERS] })

    const skipped = linesFor('uninstall').find((line) => line.includes('npm:beta') && line.includes('skipped'))
    expect(skipped).toBeDefined()
  })

  it('records a timeout as its own reason rather than a generic failure', async () => {
    // `removeBundle` has no cancel channel, so an overdue removal is abandoned
    // with an explicit sentence. A report needs that sentence: it is the
    // difference between "the host is wedged" and "the plugin refused".
    const fake = host({
      remove: async () => new Promise<never>(() => {}),
    })
    const shortLived = new StoreService({
      catalog: catalog(),
      details: details(),
      host: fake.adapter,
      store: createMemoryInstallStore(emptyProvenance()),
      hostKind: 'desktop',
      memberTimeoutMs: 15,
    })
    await shortLived.uninstall({ bundleId: BUNDLE, ids: ['npm:alpha'] })
    expect(logged()).toMatch(/exceeded|timed out|timeout/iu)
  })

  it('records BOTH verdicts when one member of two is refused', async () => {
    const fake = host({
      remove: async (id) => {
        if (id.includes('beta')) throw new Error('EACCES: permission denied')
      },
    })
    const report = await service(fake).uninstall({ bundleId: BUNDLE, ids: [...MEMBERS] })
    expect(report.removed).toEqual(['npm:alpha'])

    const text = logged()
    expect(text).toMatch(/npm:alpha: ok/u)
    // The refused member's verdict and the package manager's own words both
    // survive into the export, so the two halves are readable together.
    expect(text).toMatch(/npm:beta.*needs-restart/u)
    expect(text).toMatch(/EACCES/u)
  })
})
