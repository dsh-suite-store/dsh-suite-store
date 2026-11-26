/**
 * The `StoreApi` every route test drives.
 *
 * Shared rather than copied: two suites (`routes.spec.ts`, `routes-logs.spec.ts`)
 * drive the same handlers, and a copy in each would drift on the shapes the
 * handlers actually read. Two of those shapes are load-bearing and easy to get
 * wrong:
 *
 *  - `install()` answers the RUNNING record, not the final report — a long run
 *    must not hold an HTTP response open, and a test that returned a report
 *    would pass while every response had the wrong shape.
 *  - `uninstall()` reports `removed` (an `UninstallReport`), not `ok` (an
 *    `InstallReport`); the two share `bundleId` and nothing else.
 */

import type { StoreApi } from '../../src/server/routes.ts'
import type { CatalogSnapshot } from '../../src/catalog/sources.ts'
import type { BundleCard } from '../../src/catalog/types.ts'

export function card(overrides: Partial<BundleCard> = {}): BundleCard {
  return {
    id: 'fin',
    owner: 'someone',
    version: '1.0.0',
    title: { zh: '金融分析', en: 'Finance' },
    summary: { zh: '摘要', en: 'Summary' },
    readme: { zh: '摘要', en: 'Summary' },
    // `secondary` is `''` on the model when the primary tab has no
    // subcategory; `null` is never one of the two values the parser produces.
    category: { primary: 'research', secondary: '' },
    tags: [],
    cover: null,
    icon: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    memberCount: 2,
    capabilitySummary: [],
    capabilities: [],
    needsBuildApproval: false,
    members: [],
    health: { status: 'ok', checkedAt: '2026-01-02T00:00:00.000Z', missing: [], deprecated: [] },
    score: { hotness: 10, freshnessDays: 3, coverage: 0.9 },
    ...overrides,
  }
}

export function snapshot(): CatalogSnapshot {
  return {
    index: {
      format: 1,
      generatedAt: '2026-01-02T00:00:00.000Z',
      catalogRef: { updated: '2026-01-02T00:00:00.000Z', count: 1 },
      categories: { research: ['finance'] },
      bundles: [],
    },
    source: { kind: 'url', url: 'https://example.test/suites.json', label: 'cdn' },
    // A timestamp on the model, not the ISO string the JSON document carries.
    fetchedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    bytes: 10,
  }
}

/**
 * A store API that answers the happy path, with per-test overrides.
 *
 * @param overrides - the members this test is about.
 * @returns the API.
 */
export function fakeApi(overrides: Partial<StoreApi> = {}): StoreApi {
  return {
    async catalog() {
      return snapshot()
    },
    async detail(id) {
      return id === 'fin'
        ? {
            format: 1,
            id: 'fin',
            owner: 'someone',
            version: '1.0.0',
            readme: { zh: '', en: '' },
            capabilities: [],
            members: [],
          }
        : undefined
    },
    async cards() {
      return [card()]
    },
    async install() {
      return {
        opId: 'op-1',
        bundleId: 'fin',
        bundleVersion: '1.0.0',
        hostKind: 'cli',
        status: 'preflight',
        startedAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        members: [],
      }
    },
    async preflight() {
      return {
        summary: {
          steps: 1,
          alreadyInstalled: 0,
          estimateSeconds: 20,
          needsBuildApproval: false,
          pendingBuilds: [],
          members: [{ key: 'a', name: 'pkg-a', pinnedVersion: '1.0.0' }],
        },
        plan: { steps: [], skipped: [] },
      }
    },
    running() {
      return undefined
    },
    async uninstallPreview() {
      return [{ id: 'npm:a', checked: true, reason: 'only-source' }]
    },
    async uninstall() {
      return {
        opId: 'op-2',
        bundleId: 'fin',
        status: 'done',
        ok: ['a'],
        skipped: [],
        skippedBuildDenied: [],
        failed: [],
        removed: ['npm:a'],
      }
    },
    async memberStates() {
      return [
        { key: 'a', id: 'npm:a', present: true, enabled: true },
        { key: 'b', id: 'npm:b', present: false },
      ]
    },
    async setMemberEnabled(_id, enabled) {
      return enabled
    },
    async installMember(bundleId, key) {
      return { opId: 'op-3', bundleId, status: 'done', ok: [key], skipped: [], skippedBuildDenied: [], failed: [] }
    },
    async resume(opId) {
      // The route's 404 arm reads `no record …` / `no unfinished members …`.
      return {
        opId,
        bundleId: 'fin',
        bundleVersion: '1.0.0',
        hostKind: 'cli',
        status: 'preflight',
        startedAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        members: [],
      }
    },
    async submissionInstalled() {
      return [{
        key: 'alice/alpha',
        owner: 'alice',
        name: 'alpha',
        npm: '@alice/alpha',
        version: '2.0.0',
        url: 'https://github.com/alice/alpha',
      }]
    },
    async submissionSearch(query) {
      return query === 'alpha'
        ? [{
            key: 'alice/alpha',
            owner: 'alice',
            name: 'alpha',
            npm: '@alice/alpha',
            version: '2.0.0',
            url: 'https://github.com/alice/alpha',
          }]
        : []
    },    async cancel() {
      return true
    },
    subscribe() {
      return () => undefined
    },
    capabilities() {
      return {
        canRestart: true,
        hostKind: 'cli' as const,
        installable: true,
        canApproveBuilds: true,
        memberEstimateMs: [20_000, 40_000] as [number, number],
      }
    },
    ...overrides,
  }
}
