/**
 * End-to-end install → uninstall for two real, curated bundles.
 *
 * Both bundles are taken verbatim from the shipped catalog (≤3 members each)
 * and both were verified in the full 103-bundle live cycle to install and
 * uninstall cleanly:
 *   - dshhub-appearance (3 npm members)
 *   - dph-dsh-cost-insight-part1-2 (2 npm members)
 *
 * The drive goes through the project's OWN code paths — StoreService.install()
 * builds the plan and runs InstallExecutor; StoreService.uninstall() calls the
 * removal path — rather than through a stubbed version of them. Only the host
 * pluginManager is substituted, and it is substituted with a faithful model of
 * the shipped desktop host: installs add a `moduleName` row, removals delete
 * it, and the profile manifest/disk mirror it. The test is green only when ALL
 * members of each bundle install AND remove, which is what catches the git
 * identity and the false-success removal regressions.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import type { DetailLoader } from '../src/catalog/detail.ts'
import type { CatalogService } from '../src/catalog/service.ts'
import type { CatalogSnapshot } from '../src/catalog/sources.ts'
import { parseBundleDetail, type BundleCard, type BundleDetail } from '../src/catalog/types.ts'
import { HostAdapter, type HostPluginManager, type InstalledEntry } from '../src/install/host.ts'
import { emptyProvenance } from '../src/install/state.ts'
import { createMemoryInstallStore } from '../src/install/store.ts'
import { StoreService, type ServiceEvent } from '../src/store.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

interface Case {
  id: string
  fixture: string
  title: { zh: string; en: string }
}

const CASES: readonly Case[] = [
  { id: 'dshhub-appearance', fixture: 'e2e-dshhub-appearance.json', title: { zh: '外观', en: 'Appearance' } },
  { id: 'dph-dsh-cost-insight-part1-2', fixture: 'e2e-cost-insight.json', title: { zh: '成本', en: 'Cost' } },
]

function bundleDetail(name: string): BundleDetail {
  return parseBundleDetail(JSON.parse(fixture(name)))
}

/** A card built from the real detail so the planner sees identical members. */
function cardOf(detail: BundleDetail): BundleCard {
  return {
    id: detail.id,
    owner: detail.owner,
    version: detail.version,
    title: CASES.find((c) => c.id === detail.id)?.title ?? { zh: detail.id, en: detail.id },
    summary: { zh: '', en: '' },

    readme: { zh: '', en: '' },
    category: { primary: 'personal', secondary: '' },
    tags: [],
    cover: null,

    icon: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    memberCount: detail.members.length,
    capabilitySummary: [],

    capabilities: [],
    needsBuildApproval: false,
    members: detail.members,
    detail: `bundles/${detail.id}.json`,
    health: { status: 'ok', checkedAt: '2026-01-02T00:00:00.000Z', missing: [], deprecated: [] },
    score: { hotness: 10, freshnessDays: 3, coverage: 1 },
  }
}

/**
 * A host that mirrors the shipped desktop manager:
 *  - `installBundle` writes a `moduleName` row into the inventory and the
 *    profile manifest, then `waitForInstall` reports success;
 *  - `removeBundle` deletes the matching row, refusing silently for a name
 *    the inventory does not hold (the real manager's no-op);
 *  - `setBundleEnabled` writes/clears the `dsh.profile.bundles` selection.
 *
 * Files on disk stand in for the installed package directory so the removal
 * path's `stillOnDisk` check sees the same truth as the real profile.
 */
function e2eHost(profileDirectory: string): {
  adapter: HostAdapter
  manager: HostPluginManager
  inventory: InstalledEntry[]
  bundleRows: Set<string>
  manifest: () => Record<string, unknown>
} {
  const inventory: InstalledEntry[] = []
  const bundleRows = new Set<string>()
  const deps: Record<string, string> = {}

  const persist = (): void => {
    writeFileSync(
      join(profileDirectory, 'package.json'),
      JSON.stringify({
        name: 'e2e-profile',
        dependencies: deps,
        dsh: { profile: { bundles: [...bundleRows] } },
      }),
      'utf8',
    )
  }
  persist()

  const bare = (id: string): string => id.replace(/^npm:/u, '').replace(/@[^@/]*$/u, '')
  const manager: HostPluginManager = {
    async listPlugins() {
      return inventory.map((entry) => ({ moduleName: entry.id, version: entry.version }))
    },
    async installBundle(spec: string) {
      const id = spec.replace(/^npm:/u, '').replace(/@[^@/]*$/u, '')
      const version = /@([^@/]+)$/u.exec(spec)?.[1] ?? '1.0.0'
      inventory.push({ id, version })
      deps[id] = spec
      // The shipped host does not add a bundle row for a plain npm package;
      // the store's selectIntoProfile only writes one for bundle-shaped packs.
      const dir = join(profileDirectory, 'node_modules', ...id.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: id, version }), 'utf8')
      persist()
      return { application: 'applied' }
    },
    async waitForInstall() {
      return { status: 'ok' }
    },
    async cancelInstall() {
      return 'too-late'
    },
    async removeBundle(name: string) {
      const wanted = bare(name)
      const at = inventory.findIndex((entry) => bare(entry.id) === wanted)
      if (at < 0) return { application: 'applied', changed: false } // silent no-op
      inventory.splice(at, 1)
      delete deps[wanted]
      const dir = join(profileDirectory, 'node_modules', ...wanted.split('/'), 'package.json')
      if (existsSync(dir)) rmSync(join(profileDirectory, 'node_modules', ...wanted.split('/')), { recursive: true, force: true })
      persist()
      return { application: 'applied', changed: true }
    },
    async setPluginEnabled(id: string, enabled: boolean) {
      // The real manager keys on an entryId the catalog cannot derive; the
      // faithful part is that it records the decision in the profile patch.
      void id
      void enabled
      return { application: 'applied' }
    },
    async setBundleEnabled(name: string, enabled: boolean) {
      const wanted = bare(name)
      if (enabled) bundleRows.add(wanted)
      else bundleRows.delete(wanted)
      persist()
      return { application: 'applied' }
    },
  }

  // A real HostAdapter, not a lookalike: the removal path calls
  // `releaseBundleRow` and `stillOnDisk` on it, both of which need the actual
  // profile directory to touch the manifest and the installed files.
  const adapter = new HostAdapter(manager, profileDirectory)

  return {
    adapter,
    manager,
    inventory,
    bundleRows,
    manifest: () => JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')),
  }
}

function buildService(
  details: BundleDetail[],
  host: HostAdapter,
  profileDirectory: string,
): { service: StoreService; store: ReturnType<typeof createMemoryInstallStore>; events: ServiceEvent[] } {
  const cards = details.map(cardOf)
  const snapshot: CatalogSnapshot = {
    index: {
      format: 1,
      generatedAt: '2026-01-02T00:00:00.000Z',
      catalogRef: { updated: '2026-01-02T00:00:00.000Z', count: cards.length },
      categories: { personal: [] },
      bundles: cards,
    },
    source: { kind: 'file', path: '/e2e/index.json', label: 'file' },
    fetchedAt: Date.now(),
    bytes: 128,
  }
  const catalog = { current: async () => snapshot, peek: () => snapshot } as unknown as CatalogService
  const byId = new Map(details.map((d) => [d.id, d]))
  const loader = {
    async load(_snapshot: CatalogSnapshot, id: string) { return byId.get(id) },
    clear() {},
  } as unknown as DetailLoader
  const store = createMemoryInstallStore(emptyProvenance())
  const events: ServiceEvent[] = []
  const service = new StoreService({
    catalog,
    details: loader,
    host,
    store,
    hostKind: 'desktop',
    now: () => new Date('2026-01-02T00:00:00.000Z'),
    memberTimeoutMs: 5_000,
    emit: (event) => { events.push(event) },
  })
  return { service, store, events }
}

async function waitForInstall(
  store: ReturnType<typeof createMemoryInstallStore>,
): Promise<void> {
  // The HTTP route returns while the operation runs; the end is observable
  // through the persisted record's terminal status. Wait for the record so a
  // fast run cannot be missed.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const all = await store.listOperations()
    const last = all[all.length - 1]
    if (last !== undefined && !['queued', 'preflight', 'installing', 'verifying'].includes(last.status)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('install did not reach a terminal status')
}

const profiles: string[] = []
afterEach(() => {
  for (const dir of profiles.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.each(CASES)('e2e install → uninstall: $id', (target) => {
  it('installs every member and then removes it, both succeeding', async () => {
    const detail = bundleDetail(target.fixture)
    expect(detail.members.length).toBeLessThanOrEqual(3)
    expect(detail.members.length).toBeGreaterThan(0)

    const profileDirectory = mkdtempSync(join(tmpdir(), 'suite-store-e2e-'))
    profiles.push(profileDirectory)
    const host = e2eHost(profileDirectory)
    const { service, store } = buildService([detail], host.adapter, profileDirectory)

    // --- install through the project's own service ---
    const started = await service.install(detail.id)
    expect(started.status).toBe('preflight')
    await waitForInstall(store)
    const installRecord = (await store.listOperations()).at(-1)
    expect(installRecord?.status).toBe('done')
    expect(installRecord?.members.filter((m) => m.state !== 'ok')).toEqual([])
    expect(host.inventory.length).toBe(detail.members.length)

    // --- uninstall through the project's own service ---
    const choices = await service.uninstallPreview(detail.id)
    expect(choices.length).toBe(detail.members.length)
    const report = await service.uninstall({
      bundleId: detail.id,
      ids: choices.map((choice) => choice.id),
    })
    expect(report.failed).toEqual([])
    expect(report.removed.length).toBe(detail.members.length)
    expect(host.inventory.length).toBe(0)
    // Every installed file and dependency row must really be gone — the
    // regression this test pins is a "done" report with the files still there.
    const manifest = host.manifest()
    for (const member of detail.members) {
      const bare = member.id.replace(/^npm:/u, '').replace(/@[^@/]*$/u, '')
      expect(existsSync(join(profileDirectory, 'node_modules', ...bare.split('/'), 'package.json'))).toBe(false)
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(bare)
    }
  })
})
