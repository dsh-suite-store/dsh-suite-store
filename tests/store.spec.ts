import { describe, expect, it } from 'vitest'

import type { DetailLoader } from '../src/catalog/detail.ts'
import type { CatalogService } from '../src/catalog/service.ts'
import type { CatalogSnapshot } from '../src/catalog/sources.ts'
import type { BundleCard, BundleDetail, BundleMember } from '../src/catalog/types.ts'
import type { HostAdapter, HostCapabilities, HostPluginManager, InstalledEntry } from '../src/install/host.ts'
import type { OperationRecord } from '../src/install/operation.ts'
import { emptyProvenance, recordBundleInstall, recordManualInstall } from '../src/install/state.ts'
import { createMemoryInstallStore } from '../src/install/store.ts'
import { BusyError } from '../src/server/routes.ts'
import { StoreService, type ServiceEvent } from '../src/store.ts'

// ------------------------------------------------------------------ fixtures

function member(overrides: Partial<BundleMember> & Pick<BundleMember, 'key'>): BundleMember {
  const id = overrides.id ?? `npm:${overrides.key}`
  return {
    key: overrides.key,
    id,
    name: overrides.name ?? overrides.key,
    version: overrides.version ?? null,
    pinned: overrides.pinned ?? false,
    spec: overrides.spec ?? id,
  }
}

function card(overrides: Partial<BundleCard> = {}): BundleCard {
  return {
    id: 'fin',
    owner: 'someone',
    version: '1.0.0',
    title: { zh: '金融分析', en: 'Finance' },
    summary: { zh: '摘要', en: 'Summary' },
    readme: { zh: '摘要', en: 'Summary' },
    category: { primary: 'research', secondary: 'finance' },
    tags: [],
    cover: null,

    icon: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    memberCount: 2,
    capabilitySummary: [],
    capabilities: [],
    needsBuildApproval: false,
    members: [member({ key: 'alpha', id: 'npm:alpha' }), member({ key: 'beta', id: 'npm:beta' })],
    health: { status: 'ok', checkedAt: '2026-01-02T00:00:00.000Z', missing: [], deprecated: [] },
    score: { hotness: 10, freshnessDays: 3, coverage: 0.9 },
    ...overrides,
  }
}

function detail(overrides: Partial<BundleDetail> = {}): BundleDetail {
  return {
    format: 1,
    id: 'fin',
    owner: 'someone',
    version: '1.0.0',
    readme: { zh: '说明', en: 'Readme' },
    capabilities: [],
    members: [
      member({ key: 'alpha', id: 'npm:alpha' }),
      member({ key: 'beta', id: 'npm:beta' }),
    ],
    ...overrides,
  }
}

function snapshot(bundles: BundleCard[] = [card()]): CatalogSnapshot {
  return {
    index: {
      format: 1,
      generatedAt: '2026-01-02T00:00:00.000Z',
      catalogRef: { updated: '2026-01-02T00:00:00.000Z', count: bundles.length },
      categories: { research: ['finance'] },
      bundles,
    },
    source: { kind: 'url', url: 'https://example.test/suites.json', label: 'cdn' },
    fetchedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    bytes: 128,
  }
}

/** A catalog service that hands back one fixed snapshot. */
function fakeCatalog(value: CatalogSnapshot = snapshot()): CatalogService {
  return { current: async () => value } as unknown as CatalogService
}

/** A detail loader that answers from a map and counts the calls. */
function fakeDetails(map: Record<string, BundleDetail> = { fin: detail() }) {
  const calls: string[] = []
  const loader: DetailLoader = {
    async load(_snapshot: CatalogSnapshot, id: string) {
      calls.push(id)
      return map[id]
    },
    clear() {},
  } as unknown as DetailLoader
  return { loader, calls }
}

interface FakeHost {
  adapter: HostAdapter
  manager: HostPluginManager
  installed: InstalledEntry[]
  removed: string[]
  installedCalls: number
}

/**
 * A host whose inventory and removals are scriptable.
 *
 * `install()` resolves immediately, so an install attempted twice in a row
 * completes both times; the concurrency rule under test is the *live* one, and
 * a hang is what makes an operation live (see `hangingHost`).
 */
function fakeHost(
  options: {
    installed?: InstalledEntry[]
    capabilities?: Partial<HostCapabilities>
    remove?: (id: string) => Promise<void>
  } = {},
): FakeHost {
  const state: InstalledEntry[] = options.installed === undefined ? [] : [...options.installed]
  const removed: string[] = []
  const switches = new Map<string, boolean>()
  const manager: HostPluginManager = {
    async listPlugins() {
      // The host reports `name`, not `id`; the adapter is what reconciles the
      // two spellings, so the fake must speak the host's.
      return state.map((entry) =>
        entry.version === undefined ? { name: entry.id } : { name: entry.id, version: entry.version },
      )
    },
    async installBundle(spec: string) {
      const id = spec.startsWith('git:') ? spec.slice(4).split('#')[0] ?? spec : spec
      state.push({ id })
    },
    async waitForInstall() {
      return {}
    },
    async cancelInstall() {
      return 'too-late' as const
    },
    async removeBundle(id: string) {
      if (options.remove !== undefined) await options.remove(id)
      removed.push(id)
      // The real manager removes by the package's bare name (`npm:beta` and
      // `beta` both find `beta`); matching the stored id verbatim would make
      // this fake reject every call the store gets right.
      const want = id.replace(/^(?:git|npm):/u, '').replace(/@[^@/]*$/u, '')
      const at = state.findIndex((entry) => entry.id === id || entry.id.replace(/^(?:git|npm):/u, '') === want)
      if (at >= 0) state.splice(at, 1)
    },
  }
  const capabilities: HostCapabilities = {
    installable: true,
    granularProgress: true,
    passOptions: true,
    canRestart: true,
    canApproveBuilds: true,
    cancelable: true,
    ...options.capabilities,
  }
  const counter = { installedCalls: 0 }
  const adapter = {
    manager,
    capabilities: () => capabilities,
    async installed() {
      counter.installedCalls += 1
      return [...state]
    },
    async install(input: { spec: string; approvedBuilds: readonly string[]; requestId: string }) {
      await manager.installBundle?.(input.spec, { requestId: input.requestId, approvedBuilds: [...input.approvedBuilds] })
      return { status: 'ok' as const }
    },
    async cancel() {
      return 'too-late' as const
    },
    has(id: string) {
      return state.some((entry) => entry.id === id)
    },
    /**
     * The switch, kept in the same array the inventory reads.
     *
     * `enabled` is not on {@link InstalledEntry} — the adapter reports it from a
     * second source — so the fake remembers flips in its own map and answers
     * `undefined` for anything it was never told about, which is what the real
     * host does for a package it cannot see.
     */
    async enabledState(id: string) {
      return switches.get(id.replace(/^(?:git|npm):/u, '').replace(/@[^@/]*$/u, ''))
    },
    async setEnabled(id: string, enabled: boolean) {
      switches.set(id.replace(/^(?:git|npm):/u, '').replace(/@[^@/]*$/u, ''), enabled)
      return true
    },
  } as unknown as HostAdapter
  return {
    adapter,
    manager,
    get installed() {
      return state
    },
    removed,
    get installedCalls() {
      return counter.installedCalls
    },
  }
}

/** A host whose install never settles, so the operation stays live. */
function hangingHost(): FakeHost {
  const host = fakeHost()
  host.adapter.install = () => new Promise<never>(() => {})
  return host
}

/**
 * Let a pending install reach the executor.
 *
 * `install()` now awaits the detail and the inventory before it starts the
 * executor, so a single microtask tick is no longer enough for `running()` to
 * be populated. The boundary is not a number of awaits to count — the
 * executor's `running` getter becomes defined once it has begun, so wait for
 * that condition rather than for a fixed delay.
 */
async function untilRunning(service: StoreService): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (service.running() !== undefined) return
    await Promise.resolve()
  }
  throw new Error('the install never reached the executor')
}

/**
 * Wait for the run to end.
 *
 * `install()` now resolves while the operation is still working, so a test
 * that asserts on the outcome has to wait for it the way the page does: by
 * watching `running()` fall back to undefined.
 */
async function untilIdle(service: StoreService): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (service.running() === undefined) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('the install never finished')
}

/** The operation record for the run that just ended, read back from the store. */
async function lastOperation(
  store: ReturnType<typeof createMemoryInstallStore>,
): Promise<OperationRecord | undefined> {
  const all = await store.listOperations()
  return all[0]
}

function build(
  options: {
    catalog?: CatalogService
    details?: DetailLoader
    host?: FakeHost
    store?: ReturnType<typeof createMemoryInstallStore>
    hostKind?: 'cli' | 'desktop'
    emit?: (event: ServiceEvent) => void
    memberTimeoutMs?: number
  } = {},
): {
  service: StoreService
  host: FakeHost
  store: ReturnType<typeof createMemoryInstallStore>
  events: ServiceEvent[]
} {
  const host = options.host ?? fakeHost()
  const store = options.store ?? createMemoryInstallStore(emptyProvenance())
  const events: ServiceEvent[] = []
  const service = new StoreService({
    catalog: options.catalog ?? fakeCatalog(),
    details: options.details ?? fakeDetails().loader,
    host: host.adapter,
    store,
    hostKind: options.hostKind ?? 'cli',
    now: () => new Date('2026-01-02T00:00:00.000Z'),
    memberTimeoutMs: options.memberTimeoutMs ?? 50,
    emit: (event) => {
      events.push(event)
      options.emit?.(event)
    },
  })
  return { service, host, store, events }
}

// --------------------------------------------------------------------- cards

describe('store service cards', () => {
  it('reports a fresh bundle as not installed', async () => {
    const { service } = build()
    const [view] = await service.cards()
    expect(view?.installedCount).toBe(0)
    expect(view?.installedMembers).toEqual([])
    expect(view?.installed).toBe(false)
  })

  it('counts the members the profile already has', async () => {
    const { service } = build({ host: fakeHost({ installed: [{ id: 'npm:alpha' }] }) })
    const [view] = await service.cards()
    expect(view).toMatchObject({ installedCount: 1, installedMembers: ['alpha'], installed: false })
  })

  it('matches a git member by repo pair against the host package name', async () => {
    // Seen with a bundle-shaped git plugin: the card says `0xsline/dsh-spotlight`
    // while the host reports the loaded bundle as `@0xsline/dsh-spotlight`.
    // Matching on the repo pair avoids calling it not installed and offering a
    // redundant reinstall on every visit.
    const gitCard = card({
      id: 'git-bundle',
      members: [
        member({ key: '0xsline/dsh-spotlight', id: 'git:0xsline/dsh-spotlight' }),
        member({ key: 'alpha', id: 'npm:alpha' }),
      ],
    })
    const { service } = build({
      catalog: fakeCatalog(snapshot([gitCard])),
      host: fakeHost({ installed: [{ id: '@0xsline/dsh-spotlight' }, { id: 'npm:alpha' }] }),
    })
    const [view] = await service.cards()
    expect(view).toMatchObject({
      installedCount: 2,
      installedMembers: ['0xsline/dsh-spotlight', 'alpha'],
      installed: true,
    })
  })

  it('calls a bundle installed only when every member is present', async () => {
    const { service } = build({ host: fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }] }) })
    const [view] = await service.cards()
    expect(view).toMatchObject({ installedCount: 2, installed: true })
  })

  it('matches a pinned member by the versioned spec it records', async () => {
    const pinned = card({
      members: [member({ key: 'alpha', id: 'npm:alpha', version: '1.0.0', pinned: true, spec: 'npm:alpha@1.0.0' })],
    })
    const { service } = build({
      catalog: fakeCatalog(snapshot([pinned])),
      host: fakeHost({ installed: [{ id: 'npm:alpha', version: '1.0.0' }] }),
    })
    const [view] = await service.cards()
    expect(view?.installed).toBe(true)
  })

  it('never calls a memberless bundle installed', async () => {
    const empty = card({ members: [], memberCount: 0 })
    const { service } = build({ catalog: fakeCatalog(snapshot([empty])) })
    const [view] = await service.cards()
    expect(view?.installed).toBe(false)
  })

  it('reads the inventory once for the whole page', async () => {
    const many = Array.from({ length: 12 }, (_unused, index) => card({ id: `b${index}` }))
    const host = fakeHost()
    const { service } = build({ catalog: fakeCatalog(snapshot(many)), host })
    await service.cards()
    expect(host.installedCalls).toBe(1)
  })

  it('reuses the inventory within the second but forgets it after an uninstall', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }] })
    const { service } = build({ host })
    await service.cards()
    await service.cards()
    expect(host.installedCalls).toBe(1)
    await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })
    await service.cards()
    expect(host.installedCalls).toBe(2)
  })

  it('browses without an installer', async () => {
    const store = createMemoryInstallStore(emptyProvenance())
    const service = new StoreService({
      catalog: fakeCatalog(),
      details: fakeDetails().loader,
      host: undefined,
      store,
      hostKind: 'cli',
    })
    const [view] = await service.cards()
    expect(view?.installedCount).toBe(0)
    expect(service.capabilities()).toEqual({
      canRestart: false,
      hostKind: 'cli',
      installable: false,
      canApproveBuilds: false,
      memberEstimateMs: [20_000, 40_000],
    })
    await expect(service.install('fin')).rejects.toThrow(/cannot install/)
    expect(await service.cancel()).toBe(false)
  })
})

// -------------------------------------------------------------------- detail

describe('store service detail', () => {
  it('resolves the card path through the loader', async () => {
    const details = fakeDetails()
    const { service } = build({ details: details.loader })
    const found = await service.detail('fin')
    expect(found?.id).toBe('fin')
    expect(details.calls).toEqual(['fin'])
  })

  it('answers undefined for an unknown bundle', async () => {
    const { service } = build()
    expect(await service.detail('nope')).toBeUndefined()
  })
})

// ------------------------------------------------------------------- install

describe('store service install', () => {
  it('installs the members the profile lacks', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const { service } = build({ host })
    // `install()` answers with the RUNNING record, not the report: a long run
    // must not hold an HTTP response open. Waiting for the executor to finish
    // is what the panel does through the progress stream.
    const started = await service.install('fin')
    expect(started.bundleId).toBe('fin')
    await untilIdle(service)
    // The member landed on disk. The per-member states are read from the
    // persisted record by the panel, not from this call's answer.
    expect(host.installed.map((entry) => entry.id)).toEqual(['npm:alpha', 'npm:beta'])
  })

  it('refuses to install a bundle the catalog does not describe', async () => {
    const { service } = build()
    await expect(service.install('nope')).rejects.toThrow(/no bundle named nope/)
  })

  it('refuses a second install while one is live', async () => {
    const { service } = build({ host: hangingHost() })
    const first = service.install('fin')
    await untilRunning(service)
    await expect(service.install('fin')).rejects.toBeInstanceOf(BusyError)
    await service.cancel()
    await first
  })

  it('reports the running operation with the 409 so the client can attach', async () => {
    const { service } = build({ host: hangingHost() })
    const first = service.install('fin')
    await untilRunning(service)
    const error = await service.install('fin').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(BusyError)
    expect((error as BusyError).operation?.bundleId).toBe('fin')
    await service.cancel()
    await first
  })

  it('stops a live operation on request', async () => {
    const { service, store } = build({ host: hangingHost() })
    const started = await service.install('fin')
    expect(started.bundleId).toBe('fin')
    expect(await service.cancel()).toBe(true)
    // The cancel is honoured between members; the record on disk is what says
    // the run stopped, and that is what the panel repaints from.
    await untilIdle(service)
    const record = await lastOperation(store)
    expect(record?.status).toBe('cancelled')
  })

  it('reports the operation in flight', async () => {
    const { service } = build({ host: hangingHost() })
    expect(service.running()).toBeUndefined()
    const first = service.install('fin')
    await untilRunning(service)
    expect(service.running()?.bundleId).toBe('fin')
    await service.cancel()
    await first
  })

  it('records provenance for what it installed', async () => {
    const { service, store } = build()
    await service.install('fin')
    await untilIdle(service)
    const state = await store.readProvenance()
    expect(state.entries['npm:beta']?.sources).toEqual([
      { kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-02T00:00:00.000Z' },
    ])
  })
})

// ------------------------------------------------------------------ uninstall

describe('store service identity across spellings', () => {
  // Regression set for one root cause seen five times on the live host: the
  // same plugin is named `npm:alpha`, `npm:alpha@1.0.0`, `alpha` and
  // `@scope/alpha` by the catalog, the plan, the provenance record and the
  // host, and every "is it installed / is it gone" question compared only one
  // spelling. Each test below encodes one of the failures that produced.
  it('counts a pinned member the host reports without its version', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:beta' }] })
    const { service } = build({ host })
    const cards = await service.cards()
    const fin = cards.find((card) => card.id === 'fin')
    expect(fin?.installedCount).toBe(1)
    expect(fin?.installedMembers).toEqual(['beta'])
  })

  it('offers a pinned member for removal even though the host names it bare', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:beta' }] })
    const { service } = build({ host })
    const choices = await service.uninstallPreview('fin')
    expect(choices).toEqual([{ id: 'npm:beta', checked: true, reason: 'only-source' }])
  })

  it('removes a pinned member by the name the host knows it by', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:beta' }] })
    const { service } = build({ host })
    await service.uninstall({ bundleId: 'fin', ids: ['npm:beta@1.0.0'] })
    expect(host.installed.map((entry) => entry.id)).toEqual([])
  })
})

describe('store service uninstall', () => {
  it('offers only installed members, defaulting to the bundle-exclusive ones', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const { service } = build({ host })
    const choices = await service.uninstallPreview('fin')
    expect(choices).toEqual([{ id: 'npm:alpha', checked: true, reason: 'only-source' }])
  })

  it('refuses to preview a bundle the catalog does not describe', async () => {
    const { service } = build()
    await expect(service.uninstallPreview('nope')).rejects.toThrow(/no bundle named nope/)
  })

  it('removes exactly what the user checked', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }] })
    const { service } = build({ host })
    const report = await service.uninstall({ bundleId: 'fin', ids: ['npm:beta'] })
    expect(report).toEqual({ bundleId: 'fin', removed: ['npm:beta'], failed: [] })
    expect(host.installed.map((entry) => entry.id)).toEqual(['npm:alpha'])
  })

  it('keeps going past a plugin that will not go away', async () => {
    const host = fakeHost({
      installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }],
      remove: async (id) => {
        if (id.replace(/^(?:git|npm):/u, '') === 'alpha') throw new Error('locked by another process')
      },
    })
    const { service } = build({ host })
    const report = await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha', 'npm:beta'] })
    // The point is that beta went ahead after alpha was refused.
    expect(report.removed).toEqual(['npm:beta'])
    // alpha could be disabled, so it is a finished removal that waits for the
    // next start rather than a failure the user has to repair.
    expect(report.failed).toEqual([])
  })

  it('never widens the checked list on its own', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }] })
    const { service } = build({ host })
    await service.uninstall({ bundleId: 'fin', ids: [] })
    expect(host.removed).toEqual([])
  })

  it('publishes a removal as an operation the progress panel can draw', async () => {
    // §7.7: a removal is serial, with per-member results and its own report.
    // The live host showed the failure mode of NOT doing this — the first
    // removal answered HTTP 200 with an empty `removed` array while three
    // packages stayed on disk, and the page showed two events (capabilities
    // and snapshot) for the whole run, so nothing on screen said otherwise.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }] })
    const { service, events } = build({ host })
    await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha', 'npm:beta'] })

    const types = events.map((event) => event.type)
    expect(types).toEqual([
      'op-start',
      'op-phase',
      // one per member, in the order the user checked them
      'member-start', 'member-done',
      'member-start', 'member-done',
      'op-end',
    ])

    // Every event the client folds into its record has to CARRY the record:
    // `applyProgress` drops any line whose `op` is not an operation, so an
    // event without one is invisible no matter how correct the server is.
    const started = events[0]
    expect(started?.type === 'op-start' && started.op.kind).toBe('uninstall')
    const ended = events.at(-1)
    expect(ended?.type === 'op-end' && ended.op.status).toBe('done')
    expect(ended?.type === 'op-end' && ended.op.members.map((member) => member.state)).toEqual(['ok', 'ok'])
  })

  it('marks a refused removal it could disable as needing a restart', async () => {
    const host = fakeHost({
      installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }],
      remove: async (id) => {
        if (id.replace(/^(?:git|npm):/u, '') === 'alpha') throw new Error('bundle-in-use')
      },
    })
    const { service, events } = build({ host })
    const report = await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha', 'npm:beta'] })
    expect(report.removed).toEqual(['npm:beta'])
    const ended = events.at(-1)
    // A refusal this session could answer by DISABLING is not a failure: the
    // plugin stops running now and the next start will not compose it, so the
    // run finished and the member reports `needs-restart`.
    expect(ended?.type === 'op-end' && ended.op.status).toBe('done')
    const member = ended?.type === 'op-end' ? ended.op.members[0] : undefined
    expect(member?.state).toBe('needs-restart')
    expect(member?.failure?.reason).toBe('bundle-in-use')
  })

  it('still fails the member when the host will not even disable it', async () => {
    const host = fakeHost({
      installed: [{ id: 'npm:alpha' }],
      remove: async () => { throw new Error('not-removable') },
    })
    host.adapter.setEnabled = async () => false
    const { service, events } = build({ host })
    const report = await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })
    expect(report.failed).toEqual([{ id: 'npm:alpha', reason: 'not-removable' }])
    const ended = events.at(-1)
    expect(ended?.type === 'op-end' && ended.op.status).toBe('partial')
  })

  it('reports the removal as running while it is in flight', async () => {
    // The SSE route answers a reconnect with `snapshot` from `running()`, so a
    // removal the page did not start (another tab) is only visible if this
    // returns the record. Without it the panel says "nothing is running" while
    // packages are being deleted.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    let seen: string | undefined
    const { service } = build({
      host,
      emit: (event) => {
        if (event.type === 'member-start' && seen === undefined) {
          seen = service.running()?.kind
        }
      },
    })
    await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })
    expect(seen).toBe('uninstall')
    expect(service.running()).toBeUndefined()
  })

  it('drops the bundle claim on a plugin it removed', async () => {
    // The package is gone but the record stayed, so the next preview offered a
    // checkbox for something that was not on disk — and a reinstall would have
    // inherited a source pointing at the bundle the user removed it from.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const store = createMemoryInstallStore({
      format: 1,
      entries: {
        'npm:alpha': {
          id: 'npm:alpha',
          spec: 'npm:alpha',
          resolvedVersion: null,
          sources: [{ kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-01T00:00:00.000Z' }],
        },
      },
    })
    const { service } = build({ host, store })
    await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })
    expect((await store.readProvenance()).entries).toEqual({})
  })

  it("keeps the user's own claim on a plugin the bundle also listed", async () => {
    // `forgetBundleSource` drops one bundle's claim, never the manual one: a
    // plugin the user installed by hand and a bundle later declared is still
    // theirs, and a removal must not turn that into "nothing knows this".
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const store = createMemoryInstallStore({
      format: 1,
      entries: {
        'npm:alpha': {
          id: 'npm:alpha',
          spec: 'npm:alpha',
          resolvedVersion: null,
          sources: [
            { kind: 'manual', at: '2026-01-01T00:00:00.000Z' },
            { kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-01T00:00:00.000Z' },
          ],
        },
      },
    })
    const { service } = build({ host, store })
    await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })
    expect((await store.readProvenance()).entries['npm:alpha']?.sources).toEqual([
      { kind: 'manual', at: '2026-01-01T00:00:00.000Z' },
    ])
  })
})

// ---------------------------------------------------------------- provenance

describe('store service reconcile', () => {
  it('claims a member the catalog lists even when its record was lost', async () => {
    // A profile whose provenance file was wiped (or copied from another
    // machine) still knows `npm:alpha` belongs to `fin`, because the catalog
    // says so. Recording it as manual would make the package permanently
    // unremovable from the uninstall sheet (§7.7).
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const { service, store } = build({ host })
    await service.reconcile()
    const state = await store.readProvenance()
    expect(state.entries['npm:alpha']?.sources).toEqual([
      { kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-02T00:00:00.000Z' },
    ])
  })

  it('marks a plugin no bundle lists as manual', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:stranger' }] })
    const { service, store } = build({ host })
    await service.reconcile()
    const state = await store.readProvenance()
    expect(state.entries['npm:stranger']?.sources).toEqual([{ kind: 'manual', at: '2026-01-02T00:00:00.000Z' }])
  })

  it('leaves a bundle claim alone', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const store = createMemoryInstallStore({
      format: 1,
      entries: {
        'npm:alpha': {
          id: 'npm:alpha',
          spec: 'npm:alpha',
          resolvedVersion: null,
          sources: [{ kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-01T00:00:00.000Z' }],
        },
      },
    })
    const { service } = build({ host, store })
    await service.reconcile()
    const state = await store.readProvenance()
    expect(state.entries['npm:alpha']?.sources).toHaveLength(1)
    expect(state.entries['npm:alpha']?.sources[0]?.kind).toBe('bundle')
  })

  it('writes nothing when the profile has no plugins', async () => {
    const { service, store } = build()
    let writes = 0
    const write = store.writeProvenance.bind(store)
    store.writeProvenance = async (state) => {
      writes += 1
      return write(state)
    }
    await service.reconcile()
    expect(writes).toBe(0)
  })

  it('does nothing at all without a host', async () => {
    const store = createMemoryInstallStore(emptyProvenance())
    const service = new StoreService({
      catalog: fakeCatalog(),
      details: fakeDetails().loader,
      host: undefined,
      store,
      hostKind: 'cli',
    })
    await expect(service.reconcile()).resolves.toBeUndefined()
  })

  it('leaves an existing record alone instead of re-deriving its bundle', async () => {
    // The live profile: `acceptance-run` installed `npm:billion-context`, and
    // the very next reconcile noticed that `daily-driver` also lists that
    // package and added its claim. The member then read as `shared`, so neither
    // bundle would offer to remove it even though one of them had just
    // installed it. Provenance is a history of what happened, not a re-run of
    // the catalog lookup.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const store = createMemoryInstallStore({
      format: 1,
      entries: {
        'npm:alpha@1.0.0': {
          id: 'npm:alpha@1.0.0',
          spec: 'npm:alpha@1.0.0',
          resolvedVersion: null,
          sources: [{ kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-01T00:00:00.000Z' }],
        },
      },
    })
    const other = card({ id: 'other', members: [member({ key: 'alpha', id: 'npm:alpha' })] })
    const { service } = build({ host, store, catalog: fakeCatalog(snapshot([card(), other])) })
    await service.reconcile()
    const state = await store.readProvenance()
    expect(state.entries['npm:alpha@1.0.0']?.sources).toEqual([
      { kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('writes nothing when two bundles list the same unrecorded plugin', async () => {
    // Crediting whichever bundle the index happens to list first would make the
    // package removable under that bundle and `shared` under the other, on the
    // strength of a coin flip. `unknown` is the honest answer.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const other = card({ id: 'other', members: [member({ key: 'alpha', id: 'npm:alpha' })] })
    const { service, store } = build({ host, catalog: fakeCatalog(snapshot([card(), other])) })
    await service.reconcile()
    expect((await store.readProvenance()).entries).toEqual({})
  })

  it('writes nothing when the catalog cannot be read', async () => {
    // `manual` is permanent (D15), so a cold start with no reachable catalog
    // must classify nothing rather than classify everything as foreign: the
    // live profile got 197 permanent manual stamps exactly this way, which
    // made the plugins those bundles had just installed unremovable.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:stranger' }] })
    const catalog = { current: async () => { throw new Error('offline') } } as unknown as CatalogService
    const { service, store } = build({ host, catalog })
    await service.reconcile()
    expect((await store.readProvenance()).entries).toEqual({})
  })

  it('finds a claim through the bare name the host reports', async () => {
    // The install writes `npm:alpha@1.0.0`; the host reports `npm:alpha`. The
    // catalog indexes the member under both, but only the spec carries the
    // version, so the lookup has to try the versioned spec too.
    const host = fakeHost({ installed: [{ id: 'npm:alpha', version: '1.0.0' }] })
    const { service, store } = build({ host })
    await service.reconcile()
    const state = await store.readProvenance()
    expect(state.entries['npm:alpha']?.sources).toEqual([
      { kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-02T00:00:00.000Z' },
    ])
  })

  it('keeps one record when the install key and the reported id differ', async () => {
    // Reconcile runs on every uninstall preview. Matching only exact keys would
    // append a fresh record per spelling on every start, and the pinned
    // record the install wrote must stay the one the plan reads.
    const host = fakeHost({ installed: [{ id: 'npm:alpha', version: '1.0.0' }] })
    const store = createMemoryInstallStore({
      format: 1,
      entries: {
        'npm:alpha@1.0.0': {
          id: 'npm:alpha@1.0.0',
          spec: 'npm:alpha@1.0.0',
          resolvedVersion: null,
          sources: [{ kind: 'bundle', bundleId: 'fin', version: '1.0.0', at: '2026-01-01T00:00:00.000Z' }],
        },
      },
    })
    const { service } = build({ host, store })
    await service.reconcile()
    const state = await store.readProvenance()
    expect(Object.keys(state.entries)).toEqual(['npm:alpha@1.0.0'])
    expect(state.entries['npm:alpha@1.0.0']?.sources).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ progress

describe('store service progress', () => {
  it('forwards executor events to subscribers', async () => {
    const { service, events } = build()
    const seen: ServiceEvent[] = []
    const stop = service.subscribe((event) => seen.push(event))
    await service.install('fin')
    // The run outlives the call, so the assertions wait for it: the point is
    // that every executor event reaches a subscriber, including the last one.
    await untilIdle(service)
    expect(events.length).toBeGreaterThan(0)
    expect(seen.length).toBe(events.length)
    stop()
    expect(events.some((event) => event.type === 'op-end')).toBe(true)
  })

  it('stops forwarding after the disposer runs', async () => {
    const { service } = build()
    const seen: ServiceEvent[] = []
    service.subscribe((event) => seen.push(event))()
    await service.install('fin')
    expect(seen).toEqual([])
  })
})

// -------------------------------------------------------------- capabilities

describe('store service capabilities', () => {
  it('only promises a restart on a CLI host that supports one', () => {
    expect(build({ hostKind: 'cli' }).service.capabilities()).toEqual({
      canRestart: true,
      hostKind: 'cli',
      installable: true,
      canApproveBuilds: true,
      memberEstimateMs: [20_000, 40_000],
    })
    expect(build({ hostKind: 'desktop' }).service.capabilities()).toEqual({
      canRestart: false,
      hostKind: 'desktop',
      installable: true,
      canApproveBuilds: true,
      // §7.2's own per-member budget: a desktop install asks for a build
      // approval more often and runs the restart, so the sheet's estimate has
      // to match `preflight()`'s 30–60 s rather than the CLI range.
      memberEstimateMs: [30_000, 60_000],
    })
    expect(build({ host: fakeHost({ capabilities: { canRestart: false } }) }).service.capabilities().canRestart)
      .toBe(false)
  })
})

// ---------------------------------------------------------------- member rows

describe('store service member rows', () => {
  it('reports a present member with the switch state the host gave', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const { service } = build({ host })
    const rows = await service.memberStates('fin')
    expect(rows).toEqual([
      { key: 'alpha', id: 'npm:alpha', present: true },
      { key: 'beta', id: 'npm:beta', present: false },
    ])
  })

  it('omits the switch rather than guessing when nothing knows the plugin', async () => {
    // `present: true` with no `enabled` is the third state: installed, but the
    // host would not say whether it runs. Collapsing it into either boolean
    // would draw a switch position the host never reported (§8.3).
    const host = fakeHost()
    host.adapter.installed = async () => [{ id: 'npm:alpha' }]
    host.adapter.enabledState = async () => undefined
    const { service } = build({ host })
    const rows = await service.memberStates('fin')
    expect(rows[0]).toEqual({ key: 'alpha', id: 'npm:alpha', present: true })
    expect(rows[0]?.enabled).toBeUndefined()
  })

  it('refuses member rows for a bundle the catalog does not describe', async () => {
    const { service } = build()
    await expect(service.memberStates('nope')).rejects.toThrow(/no bundle named nope/)
  })

  it('answers with the state the host settled on, not with success', async () => {
    // `setEnabled` resolves only after reading the profile back, so its `true`
    // means "reached the requested state" — not "the requested state was on".
    // Returning that boolean from here made a switch turned OFF report `true`,
    // which the sheet would draw as on.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const { service } = build({ host })
    expect(await service.setMemberEnabled('npm:alpha', false)).toBe(false)
    expect(await service.setMemberEnabled('npm:alpha', true)).toBe(true)
  })

  it('drops the cached inventory so the next card read sees the flip', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }] })
    const { service } = build({ host })
    await service.cards()
    const before = host.installedCalls
    await service.setMemberEnabled('npm:alpha', false)
    await service.cards()
    expect(host.installedCalls).toBeGreaterThan(before)
  })
})

// ------------------------------------------------- regressions (review fixes)

describe('operation lock across awaits (§7.1)', () => {
  it('refuses a second uninstall that raced the first through detail()', async () => {
    // The busy check used to run only BEFORE `detail()`; a second POST that
    // arrived inside that await set `removing` first and both removals ran.
    const { service } = build()
    await service.install('fin')
    await untilIdle(service)
    const first = service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })
    const second = service.uninstall({ bundleId: 'fin', ids: ['npm:beta'] })
    const [firstResult, secondResult] = await Promise.allSettled([first, second])
    expect(secondResult.status).toBe('rejected')
    expect((secondResult as PromiseRejectedResult).reason).toBeInstanceOf(BusyError)
    expect(firstResult.status).toBe('fulfilled')
    await untilIdle(service)
  })

  it('releases the lock when a removal run throws mid-flight', async () => {
    // `publish()` sat outside the per-member try: a throwing listener used to
    // leave `removing` live forever, 409-ing every later operation.
    let explode = true
    const { service } = build({
      emit: (event) => {
        if (explode && event.type === 'member-done') throw new Error('listener exploded')
      },
    })
    await service.install('fin')
    await untilIdle(service)
    await expect(service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })).rejects.toThrow(/listener exploded/u)
    await untilIdle(service)
    expect(service.running()).toBeUndefined()
    // The lock is back: the next run starts cleanly once the listener stops
    // throwing.
    explode = false
    await expect(service.uninstall({ bundleId: 'fin', ids: ['npm:beta'] })).resolves.toBeDefined()
  })

  it('budgets a hung removal at the member timeout instead of holding the lock', async () => {
    const host = fakeHost()
    // Removals go through `host.manager.removeBundle` (store.ts reduces the
    // checkbox identity itself), so the hang has to be there.
    host.manager.removeBundle = () => new Promise<never>(() => {})
    const { service } = build({ host, memberTimeoutMs: 30 })
    await service.install('fin')
    await untilIdle(service)
    const report = await service.uninstall({ bundleId: 'fin', ids: ['npm:alpha'] })
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.reason).toMatch(/removal exceeded/u)
    expect(service.running()).toBeUndefined()
  })

  it('skips the members a cancel reached before they started', async () => {
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:beta' }] })
    const { service } = build({ host })
    // The profile already holds both members, so there is nothing to install
    // first — go straight to the removal whose skip behaviour is under test.
    const run = service.uninstall({ bundleId: 'fin', ids: ['npm:alpha', 'npm:beta'] })
    await service.cancel()
    const report = await run
    expect(report.removed).toEqual([])
    expect(host.removed).toEqual([])
  })
})

describe('resume (§7.5 continue)', () => {
  it('retries the members a partial run left unfinished', async () => {
    // A hanging host leaves the record partial; the resume retries exactly
    // the unfinished members once the host answers again.
    const hanging = hangingHost()
    const { service, store } = build({ host: hanging })
    await service.install('fin')
    await untilRunning(service)
    await service.cancel()
    await untilIdle(service)
    const partial = await lastOperation(store)
    expect(partial?.status).toBe('cancelled')
    // Swap the host for one that answers, then continue the same record.
    const healthy = fakeHost()
    const second = build({ host: healthy, store })
    const started = await second.service.resume(partial!.opId)
    expect(started.opId).toBe(partial!.opId)
    await untilIdle(second.service)
    const after = await lastOperation(store)
    expect(after?.status).toBe('done')
  })

  it('refuses an unknown operation id', async () => {
    const { service } = build()
    await expect(service.resume('op-nothing')).rejects.toThrow(/no record named op-nothing/u)
  })

  it('refuses to resume while another operation is live', async () => {
    const { service } = build({ host: hangingHost() })
    await service.install('fin')
    await untilRunning(service)
    await expect(service.resume('op-x')).rejects.toBeInstanceOf(BusyError)
    await untilIdle(service)
  })

  it('refuses a terminal record with nothing left to do', async () => {
    const { service, store } = build()
    await service.install('fin')
    await untilIdle(service)
    const record = await lastOperation(store)
    expect(record?.status).toBe('done')
    await expect(service.resume(record!.opId)).rejects.toThrow(/has no unfinished members/u)
  })

  it('narrows an echoed plan to the members the catalog lists', async () => {
    // The route shape-checks the client's JSON; the service is the one that
    // can confirm the steps belong to this bundle. A plan naming an outside
    // spec used to run verbatim under this bundle's provenance.
    const { service, host } = build()
    await expect(service.install('fin', {
      bundleId: 'fin',
      bundleVersion: '1.0.0',
      plan: {
        steps: [{
          key: 'intruder',
          id: 'npm:intruder',
          spec: 'npm:intruder@9.9.9',
          name: 'intruder',
          pinnedVersion: null,
          approvedBuilds: [],
        }],
        skipped: [],
      },
    })).rejects.toThrow(/no installable members/u)
    expect(host.installed).toEqual([])
  })

  it('installs the catalog spec even when the echoed plan names a real key with a forged one', async () => {
    // The hole the `catalogKeys` check left open: a legitimate member key says
    // nothing about the SPEC, and the executor installs `step.spec` verbatim.
    // A caller could therefore install anything it liked under this bundle's
    // provenance — and, with `approvedBuilds`, run build scripts the user never
    // approved. The service now rebuilds each step from the catalog and keeps
    // only the caller's choice of WHICH members.
    const { service, host } = build()
    await service.install('fin', {
      bundleId: 'fin',
      bundleVersion: '1.0.0',
      plan: {
        steps: [{
          key: 'alpha',
          id: 'npm:not-alpha',
          spec: 'npm:not-alpha@9.9.9',
          name: 'not-alpha',
          pinnedVersion: null,
          approvedBuilds: ['not-alpha'],
        }],
        skipped: [],
      },
    })
    await untilIdle(service)
    // What was installed is what the CATALOG pins (`npm:alpha`, the member the
    // key names), not the spec the caller sent.
    const installed = host.installed.map((entry) => entry.id)
    expect(installed).toContain('npm:alpha')
    expect(installed).not.toContain('not-alpha')
    expect(installed).not.toContain('npm:not-alpha@9.9.9')
  })

  it('refuses to uninstall an id that is not a member of the bundle', async () => {
    // The route only shape-checks `ids`, so without this check a caller could
    // name any installed plugin and have it removed under a bundle that never
    // listed it.
    const host = fakeHost({ installed: [{ id: 'npm:alpha' }, { id: 'npm:outsider' }] })
    const { service } = build({ host })
    await expect(service.uninstall({ bundleId: 'fin', ids: ['npm:outsider'] }))
      .rejects.toThrow(/not a member of fin/u)
    expect(host.removed).toEqual([])
    // The lock is released, so the refusal cannot strand the service.
    expect(service.running()).toBeUndefined()
  })
})

describe('reconcile during a live run', () => {
  it('leaves provenance alone while an operation is running', async () => {
    // reconcile() used to read-modify-write provenance while the executor was
    // mid-run; the write raced and could stamp a member `manual` permanently.
    const host = hangingHost()
    const { service, store } = build({ host })
    await service.install('fin')
    await untilRunning(service)
    await service.reconcile()
    const state = await store.readProvenance()
    expect(Object.keys(state.entries)).toEqual([])
    await untilIdle(service)
  })

  it('keeps a claim written while it was awaiting the catalog', async () => {
    // The door check only covers a run that was ALREADY live. Everything
    // between it and the write is awaited — installed list, provenance file,
    // catalog — and an install that starts in that window writes its own
    // claim. The stale snapshot was then written back verbatim, so the member
    // came back as `manual`, which is permanent (D15) and bars it from ever
    // being uninstalled with its suite.
    //
    // Reproduced by delaying the CATALOG read: that is the last await before
    // the loop, so a claim written during it is exactly the one a blind write
    // would erase.
    const host = fakeHost()
    host.adapter.installed = async () => [{ id: 'npm:deck-alpha', version: '1.0.0' }]
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slowCatalog = {
      current: async () => {
        await gate
        return snapshot()
      },
    } as unknown as CatalogService

    const { service, store } = build({ host, catalog: slowCatalog })
    const inFlight = service.reconcile()
    // Land a bundle claim while reconcile is still awaiting the catalog.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const written = await store.readProvenance()
    await store.writeProvenance({
      ...written,
      entries: {
        ...written.entries,
        'npm:deck-alpha': {
          id: 'npm:deck-alpha',
          spec: 'npm:deck-alpha',
          resolvedVersion: '1.0.0',
          sources: [{ kind: 'bundle', bundleId: 'deck', version: '1.0.0', at: '2026-01-02T00:00:00.000Z' }],
        },
      },
    })
    release?.()
    await inFlight

    const state = await store.readProvenance()
    expect(state.entries['npm:deck-alpha']?.sources.map((source) => source.kind)).toEqual(['bundle'])
  })

  it('does not resurrect a claim removed while it was awaiting the catalog', async () => {
    // The other direction of the same race. Two installed plugins:
    //   alpha — already in provenance; a concurrent uninstall removes it
    //   beta  — NOT in provenance; reconcile adds it, which is what MAKES the
    //           updater run at all
    // The old updater merged the WHOLE old snapshot back, so alpha — absent
    // from the freshest state — came back on a plugin no longer on disk.
    const host = fakeHost()
    host.adapter.installed = async () => [
      { id: 'npm:deck-alpha', version: '1.0.0' },
      { id: 'npm:deck-beta', version: '1.0.0' },
    ]
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slowCatalog = {
      current: async () => {
        await gate
        return snapshot()
      },
    } as unknown as CatalogService

    const { service, store } = build({ host, catalog: slowCatalog })
    // alpha is already claimed; beta is not.
    await store.updateProvenance((current) => recordManualInstall(current, {
      id: 'npm:deck-alpha', spec: 'npm:deck-alpha', now: '2026-01-01T00:00:00.000Z',
    }))
    const inFlight = service.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // A concurrent uninstall removes alpha's claim.
    await store.updateProvenance((current) => ({
      ...current,
      entries: Object.fromEntries(Object.entries(current.entries).filter(([id]) => id !== 'npm:deck-alpha')),
    }))
    release?.()
    await inFlight

    const state = await store.readProvenance()
    // beta was legitimately added; alpha must stay deleted.
    expect(state.entries['npm:deck-beta']).toBeDefined()
    expect(state.entries['npm:deck-alpha']).toBeUndefined()
  })

  it('does not record a claim for a plugin uninstalled during the scan', async () => {
    // The third direction: reconcile's `installed` snapshot is taken up front.
    // A plugin that exists in that snapshot, is uninstalled before the write
    // (so it is absent from both provenance and the live host), and was NOT in
    // provenance at scan start, satisfies both earlier filters — it is not in
    // `initialIds`, and `latest.entries` has nothing for it. Only a live
    // inventory read at write time can tell it is gone.
    const host = fakeHost()
    let installed = [{ id: 'npm:deck-gone', version: '1.0.0' }]
    host.adapter.installed = async () => installed
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slowCatalog = {
      current: async () => {
        await gate
        return snapshot()
      },
    } as unknown as CatalogService

    const { service, store } = build({ host, catalog: slowCatalog })
    const inFlight = service.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // It is uninstalled while the pass is awaiting the catalog: gone from the
    // live inventory, and its claim (never written) is absent too.
    installed = []
    release?.()
    await inFlight

    const state = await store.readProvenance()
    expect(state.entries['npm:deck-gone']).toBeUndefined()
  })

  it('still records a plugin that really is installed at write time', async () => {
    // The control: the freshness check must not stop reconcile from doing its
    // job. Nothing is uninstalled, so the claim is recorded.
    const host = fakeHost()
    host.adapter.installed = async () => [{ id: 'npm:deck-here', version: '1.0.0' }]
    const { service, store } = build({ host })
    await service.reconcile()

    const state = await store.readProvenance()
    expect(state.entries['npm:deck-here']).toBeDefined()
  })

  it('withdraws a claim when the plugin disappears between the last read and the write', async () => {
    // The final window: `installedFresh()` saw the plugin, then the write landed,
    // then the host removed it. Provenance and the host inventory are not one
    // transaction, so the claim has to be withdrawn afterwards — scoped to the
    // ids THIS pass added, so an unrelated claim is never touched.
    //
    // Modelled with an inventory that answers "present" once and "gone" after:
    // the first read is the freshness check, the second is the withdrawal scan.
    const host = fakeHost()
    let reads = 0
    host.adapter.installed = async () => {
      reads += 1
      // Read 0 is reconcile's own inventory snapshot, read 1 the freshness
      // check — both must see the plugin, or there is no claim to withdraw.
      // Read 2 is the post-write scan: the plugin is gone by then.
      return reads <= 2 ? [{ id: 'npm:deck-race', version: '1.0.0' }] : []
    }
    const { service, store } = build({ host })
    await service.reconcile()

    const state = await store.readProvenance()
    expect(state.entries['npm:deck-race']).toBeUndefined()
  })

  it('leaves a claim alone that this pass did not add', async () => {
    // The withdrawal is scoped: a pre-existing claim for a plugin the host does
    // not list must survive. A blanket "delete whatever is not installed" would
    // erase the provenance of an unreadable host.
    const host = fakeHost()
    host.adapter.installed = async () => [{ id: 'npm:deck-new', version: '1.0.0' }]
    const { service, store } = build({ host })
    await store.updateProvenance((current) => recordManualInstall(current, {
      id: 'npm:pre-existing', spec: 'npm:pre-existing', now: '2026-01-01T00:00:00.000Z',
    }))
    await service.reconcile()

    const state = await store.readProvenance()
    expect(state.entries['npm:pre-existing']).toBeDefined()
  })

  it('does not delete a claim a concurrent install rewrote for the same id', async () => {
    // Compare-and-delete: the sweep may only remove the EXACT entry this pass
    // wrote. A concurrent install that rewrote the same id produced a different
    // value, and deleting it by id alone turned that bundle claim back into
    // nothing (or, worse, into a later `manual`).
    //
    // The concurrent write is injected from the THIRD inventory read — the
    // withdrawal scan — which is precisely the window between reconcile's own
    // write and the sweep.
    const host = fakeHost()
    let reads = 0
    let concurrentWrite: Promise<void> | undefined
    host.adapter.installed = async () => {
      reads += 1
      // snapshot + freshness see it; the withdrawal scan does not.
      if (reads <= 2) return [{ id: 'npm:deck-shared', version: '1.0.0' }]
      concurrentWrite = store.updateProvenance((current) => recordBundleInstall(current, {
        id: 'npm:deck-shared', spec: 'npm:deck-shared', resolvedVersion: '2.0.0',
        bundleId: 'concurrent-bundle', bundleVersion: '2.0.0', now: '2026-06-01T00:00:00.000Z',
      }))
      await concurrentWrite
      return []
    }
    const { service, store } = build({ host })
    await service.reconcile()
    await concurrentWrite

    const state = await store.readProvenance()
    // The concurrent claim survives: it is not the value this pass inserted.
    expect(state.entries['npm:deck-shared']?.sources.some(
      (source) => source.kind === 'bundle' && source.bundleId === 'concurrent-bundle',
    )).toBe(true)
  })

  it('does not withdraw on an inventory that could not be read', async () => {
    // A failing host call must not look like an empty profile. The real
    // adapter's `installed()` degrades to a shorter list (right for display),
    // while `installedStrict()` reports the failure. The store must use the
    // strict form for a destructive decision: with the degrading one, the
    // withdrawal saw "no plugins" and deleted the claim it had just written.
    const host = fakeHost()
    let reads = 0
    const failFrom = 3
    // Display-oriented reader: swallows the failure into an empty list.
    host.adapter.installed = async () => {
      reads += 1
      return reads < failFrom ? [{ id: 'npm:deck-keep', version: '1.0.0' }] : []
    }
    // Strict reader: the same failure is reported as "unknown".
    const strictInstalled = async (): Promise<{ id: string; version: string }[] | undefined> => {
      reads += 1
      return reads < failFrom ? [{ id: 'npm:deck-keep', version: '1.0.0' }] : undefined
    }
    ;(host.adapter as unknown as { installedStrict?: typeof strictInstalled }).installedStrict = strictInstalled

    const { service, store } = build({ host })
    await service.reconcile()

    const state = await store.readProvenance()
    expect(state.entries['npm:deck-keep']).toBeDefined()
  })
})
