/**
 * Fixtures shared by the browser tests.
 *
 * Kept in `tests/support/` rather than in a spec file because three suites
 * build cards and records by hand, and three hand-rolled builders would drift
 * apart in exactly the fields nobody asserts on — which is where a card
 * renders blank.
 */
import type { BundleCard } from '../../src/catalog/types.ts'
import type { StoreCard } from '../../src/client/store-data.ts'
import type { OperationRecord } from '../../src/install/operation.ts'

/**
 * A minimal valid bundle card, with every field a test does not care about
 * filled in.
 *
 * Typed as `StoreCard` (the wire model plus the profile fields the server
 * joins on), because the browser suites assert on `installedByUser` and
 * `installedMembers` too, and a `BundleCard`-only fixture rejected them.
 *
 * @param overrides - the fields this test is about.
 * @returns the card.
 */
export function fixtureCard(overrides: Partial<StoreCard> = {}): StoreCard {
  return {
    id: 'demo-suite',
    owner: 'someone',
    version: '1.0.0',
    title: { zh: '演示整合包', en: 'Demo suite' },
    summary: { zh: '一句话说明', en: 'One sentence' },

    readme: { zh: '一句话说明', en: 'One sentence' },
    category: { primary: 'research', secondary: 'finance' },
    tags: ['finance'],
    // `cover` is `string | null` on the wire model: `null` is "no cover", and
    // `undefined` is not one of the two values the parser can produce.
    cover: null,

    icon: null,
    publishedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    memberCount: 1,
    capabilitySummary: ['network'],

    capabilities: [],
    needsBuildApproval: false,
    members: [
      { key: 'member:a', id: 'npm:alpha', name: 'alpha', version: '1.0.0', pinned: true, spec: 'alpha@1.0.0' },
    ],
    detail: 'details/demo-suite.json',
    health: { status: 'ok', checkedAt: '2026-11-01T00:00:00.000Z', missing: [], deprecated: [] },
    score: { hotness: 50, freshnessDays: 10, coverage: 0.9 },
    ...overrides,
  }
}

/**
 * An operation record with the given members, all `pending`.
 *
 * @param keys - the member keys, in order.
 * @param overrides - the fields this test is about.
 * @returns the record, in `installing` status, which is the state the page
 *   renders progress for.
 */
export function fixtureOperation(keys: readonly string[], overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    opId: 'op-1',
    bundleId: 'demo-suite',
    bundleVersion: '1.0.0',
    hostKind: 'cli',
    status: 'installing',
    startedAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    members: keys.map((key) => ({ key, id: `npm:${key}`, name: key, state: 'pending' })),
    ...overrides,
  }
}
