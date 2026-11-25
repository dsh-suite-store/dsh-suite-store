/**
 * Behavioral specs for the catalog model (src/catalog/types.ts).
 *
 * Fixtures come from `tests/fixtures/`, which is generated to match the wire
 * format in docs/specs §5.3 — the specs assert the PARSER accepts what the
 * spec says the builder emits, so the two documents cannot drift apart
 * silently.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CatalogFormatError,
  localized,
  parseCatalogIndex,
  recommendationScore,
  selectBundles,
  warningCapabilities,
  type BundleCard,
} from '../src/catalog/types.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

/** The fixture document, parsed once; every spec starts from a known-good shape. */
const rawIndex: unknown = JSON.parse(fixture('catalog-index.json'))
const index = parseCatalogIndex(rawIndex)

/** A minimal valid card for the tests that only vary one field. */
function card(overrides: Partial<BundleCard> = {}): BundleCard {
  return {
    id: 'bundle-a',
    owner: 'someone',
    version: '1.0.0',
    title: { zh: '甲', en: 'A' },
    summary: { zh: '甲', en: 'A' },

    readme: { zh: '甲', en: 'A' },
    category: { primary: 'personal', secondary: 'workspace' },
    tags: [],
    cover: null,

    icon: null,
    publishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    memberCount: 2,
    capabilitySummary: [],

    capabilities: [],
    needsBuildApproval: false,
    members: [],
    detail: 'bundles/someone__bundle-a.json',
    health: { status: 'ok', checkedAt: '2026-01-01T00:00:00Z', missing: [], deprecated: [] },
    score: { hotness: 50, freshnessDays: 10, coverage: 1 },
    ...overrides,
  }
}

describe('parseCatalogIndex', () => {
  it('accepts the catalog the data repository emits', () => {
    expect(index.format).toBe(1)
    expect(index.bundles).toHaveLength(1)
    expect(index.catalogRef.count).toBe(9714)
  })

  it('keeps member identity and install spec as separate fields', () => {
    const [memory, worklog] = index.bundles[0].members
    // §5.5: `id` is stable across sources, `spec` is what runs. The GitHub-only
    // member has NO version, so its `id` has no `@version` but its spec still
    // names the subdirectory.
    expect(memory.id).toBe('npm:@yolk_vat-y/dsh-project-memory')
    expect(memory.spec).toBe('npm:@yolk_vat-y/dsh-project-memory@0.6.11')
    expect(memory.pinned).toBe(true)
    expect(worklog.id).toBe('git:0x7A7A6572/dsh-forge-studio#packages/plugin-daily-log')
    expect(worklog.version).toBeNull()
    expect(worklog.pinned).toBe(false)
  })

  it('reads a category table whose secondaries carry display order', () => {
    expect(index.categories.research).toEqual(['finance', 'academic'])
  })

  it('refuses a format it does not understand instead of guessing', () => {
    const future = { ...(rawIndex as Record<string, unknown>), format: 2 }
    expect(() => parseCatalogIndex(future)).toThrow(CatalogFormatError)
    expect(() => parseCatalogIndex(future)).toThrow(/unsupported catalog format, expected 1 \(at \$\.format\)/u)
  })

  it('names the offending bundle in the error, not just the field', () => {
    const broken = structuredClone(rawIndex) as { bundles: Record<string, unknown>[] }
    broken.bundles[0].title = { zh: '只有中文' }
    expect(() => parseCatalogIndex(broken)).toThrow(/at \$\.bundles\[0\]\.title/u)
  })

  describe('icon', () => {
    it('reads an https icon', () => {
      const withIcon = structuredClone(rawIndex) as { bundles: Record<string, unknown>[] }
      withIcon.bundles[0].icon = 'https://raw.githubusercontent.com/a/b/main/icon.png'
      expect(parseCatalogIndex(withIcon).bundles[0].icon)
        .toBe('https://raw.githubusercontent.com/a/b/main/icon.png')
    })

    it('degrades anything that is not https to null', () => {
      // The catalog is remote data. A `javascript:` or `data:` URL reaching an
      // `<img src>` is not a broken image, it is an execution surface — so the
      // parser refuses it here rather than trusting the renderer to.
      for (const bad of [
        'http://example.com/icon.png',
        'javascript:alert(1)',
        'data:image/svg+xml,<svg onload=alert(1)>',
        '//example.com/icon.png',
        '/relative/icon.png',
        'not a url',
        42,
        null,
      ]) {
        const broken = structuredClone(rawIndex) as { bundles: Record<string, unknown>[] }
        broken.bundles[0].icon = bad
        expect(parseCatalogIndex(broken).bundles[0].icon, String(bad)).toBeNull()
      }
    })

    it('defaults to null when the field is absent', () => {
      // A catalog built before this field existed must parse: `null` means "draw
      // the bundled default", which is exactly right for an old document.
      const legacy = structuredClone(rawIndex) as { bundles: Record<string, unknown>[] }
      delete legacy.bundles[0].icon
      expect(parseCatalogIndex(legacy).bundles[0].icon).toBeNull()
    })
  })

  it('rejects a member without an install spec', () => {
    const broken = structuredClone(rawIndex) as { bundles: { members: Record<string, unknown>[] }[] }
    delete broken.bundles[0].members[0].spec
    expect(() => parseCatalogIndex(broken)).toThrow(/at \$\.bundles\[0\]\.members\[0\]\.spec/u)
  })

  it('rejects an unknown health status rather than treating it as ok', () => {
    const broken = structuredClone(rawIndex) as { bundles: { health: Record<string, unknown> }[] }
    broken.bundles[0].health.status = 'maybe'
    expect(() => parseCatalogIndex(broken)).toThrow(/at \$\.bundles\[0\]\.health\.status/u)
  })

  it('defaults optional arrays so downstream code never sees undefined', () => {
    const sparse = structuredClone(rawIndex) as { bundles: Record<string, unknown>[] }
    delete sparse.bundles[0].tags
    delete sparse.bundles[0].capabilitySummary
    const parsed = parseCatalogIndex(sparse)
    expect(parsed.bundles[0].tags).toEqual([])
    expect(parsed.bundles[0].capabilitySummary).toEqual([])
  })

  it('accepts a plain string where both languages agree', () => {
    const simple = structuredClone(rawIndex) as { bundles: Record<string, unknown>[] }
    simple.bundles[0].title = 'Simple Suite'
    const parsed = parseCatalogIndex(simple)
    expect(parsed.bundles[0].title).toEqual({ zh: 'Simple Suite', en: 'Simple Suite' })
  })

  it('refuses a duplicate bundle id (per-id routes would be ambiguous)', () => {
    const doubled = structuredClone(rawIndex) as { bundles: Record<string, unknown>[] }
    doubled.bundles.push(structuredClone(doubled.bundles[0]!))
    expect(() => parseCatalogIndex(doubled)).toThrow(/fin-analyst-workstation appears more than once/u)
  })

  it('refuses a repeated member key (per-key operations match the first hit)', () => {
    const doubled = structuredClone(rawIndex) as { bundles: { members: Record<string, unknown>[] }[] }
    doubled.bundles[0]!.members[1]!.key = doubled.bundles[0]!.members[0]!.key
    expect(() => parseCatalogIndex(doubled)).toThrow(/appears twice in fin-analyst-workstation/u)
  })

  it('refuses score numbers that do not exist on the number line (§5.6)', () => {
    // `1e999` parses as Infinity and passed the old NaN-only check; it would
    // have topped every ranking forever.
    const infinite = structuredClone(rawIndex) as { bundles: { score: Record<string, unknown> }[] }
    infinite.bundles[0]!.score.hotness = Number.parseFloat('1e999')
    expect(() => parseCatalogIndex(infinite)).toThrow(/finite number/u)
    const negative = structuredClone(rawIndex) as { bundles: { score: Record<string, unknown> }[] }
    negative.bundles[0]!.score.freshnessDays = -3
    expect(() => parseCatalogIndex(negative)).toThrow(/non-negative/u)
    const inflated = structuredClone(rawIndex) as { bundles: { score: Record<string, unknown> }[] }
    inflated.bundles[0]!.score.coverage = 1.5
    expect(() => parseCatalogIndex(inflated)).toThrow(/between 0 and 1/u)
  })

  it('keeps a wire category literally named __proto__ instead of losing it', () => {
    // JSON.parse creates an own `__proto__` property; bracket assignment on a
    // plain object triggered the prototype setter and the category vanished.
    // Built through JSON.parse because an object literal's `__proto__:`
    // would set the prototype instead — exactly the distinction under test.
    const sneaky = JSON.parse(JSON.stringify(rawIndex)) as Record<string, unknown>
    sneaky.categories = JSON.parse('{"__proto__": ["a", "b"], "research": ["finance"]}')
    const parsed = parseCatalogIndex(sneaky)
    expect(Object.getOwnPropertyDescriptor(parsed.categories, '__proto__')?.value).toEqual(['a', 'b'])
    expect(parsed.categories.research).toEqual(['finance'])
  })
})

describe('the member-count window (§5.4)', () => {
  /** The fixture with its first bundle's member list replaced by `count` members. */
  function withMembers(count: number): unknown {
    const document = structuredClone(rawIndex) as { bundles: { members: Record<string, unknown>[] }[] }
    const template = document.bundles[0]!.members[0]!
    document.bundles[0]!.members = Array.from({ length: count }, (_, index) => ({
      ...template,
      key: `m${String(index)}`,
      id: `npm:pkg-${String(index)}`,
      spec: `npm:pkg-${String(index)}@1.0.0`,
    }))
    // Keep the document self-consistent: a count that disagrees with the list
    // is rejected before the member window is even considered.
    const bundle = document.bundles[0] as Record<string, unknown>
    bundle['memberCount'] = count
    return document
  }

  it('refuses a suite of one, which the reader could have found themselves', () => {
    expect(() => parseCatalogIndex(withMembers(1))).toThrow(/expected 2–10 members, got 1/u)
    expect(() => parseCatalogIndex(withMembers(1))).toThrow(/at \$\.bundles\[0\]\.members/u)
  })

  it('refuses a suite past the ceiling', () => {
    expect(() => parseCatalogIndex(withMembers(11))).toThrow(/expected 2–10 members, got 11/u)
  })

  it('accepts both ends of the window', () => {
    expect(parseCatalogIndex(withMembers(2)).bundles[0]!.members).toHaveLength(2)
    expect(parseCatalogIndex(withMembers(10)).bundles[0]!.members).toHaveLength(10)
  })

  it('takes a raised ceiling without a rebuild, and the floor still holds', () => {
    const raised = { maxMembers: 20 }
    expect(parseCatalogIndex(withMembers(20), raised).bundles[0]!.members).toHaveLength(20)
    expect(() => parseCatalogIndex(withMembers(21), raised)).toThrow(/expected 2–20 members, got 21/u)
    // The floor is not configurable: a one-member suite is never valid.
    expect(() => parseCatalogIndex(withMembers(1), raised)).toThrow(/expected 2–20 members, got 1/u)
  })
})

describe('localized', () => {
  it('uses the requested language when it is present', () => {
    expect(localized({ zh: '中文', en: 'English' }, 'en')).toBe('English')
  })

  it('falls back silently to the other language (§8.5)', () => {
    expect(localized({ zh: '中文', en: '' }, 'en')).toBe('中文')
    expect(localized({ zh: '', en: 'English' }, 'zh')).toBe('English')
  })
})

describe('recommendationScore', () => {
  it('decays with age and damps by coverage', () => {
    const fresh = card({ score: { hotness: 100, freshnessDays: 0, coverage: 1 } })
    const old = card({ score: { hotness: 100, freshnessDays: 90, coverage: 1 } })
    expect(recommendationScore(fresh)).toBeCloseTo(100, 5)
    expect(recommendationScore(old)).toBeCloseTo(100 * Math.exp(-1), 5)
    expect(recommendationScore(card({ score: { hotness: 100, freshnessDays: 0, coverage: 0.5 } })))
      .toBeCloseTo(50, 5)
  })

  it('treats unknown hotness as zero rather than dropping the card', () => {
    expect(recommendationScore(card({ score: { hotness: null, freshnessDays: 0, coverage: 0 } }))).toBe(0)
  })
})

describe('selectBundles', () => {
  const bundles = [
    card({ id: 'alpha', memberCount: 3, updatedAt: '2026-10-01T00:00:00Z' }),
    card({
      id: 'beta',
      memberCount: 9,
      updatedAt: '2026-11-05T00:00:00Z',
      members: [{ key: 'm', id: 'npm:@scope/dsh-log-hero', name: '@scope/dsh-log-hero', version: '1.0.0', pinned: true, spec: 'npm:@scope/dsh-log-hero@1.0.0' }],
    }),
    card({ id: 'gamma', memberCount: 1, health: { status: 'broken', checkedAt: '', missing: ['m'], deprecated: [] } }),
  ]

  it('matches a bundle by the name of a plugin inside it (§8.4)', () => {
    expect(selectBundles(bundles, { query: 'log-hero' }).map((item) => item.id)).toEqual(['beta'])
  })

  it('treats the query as case-insensitive and trims it', () => {
    expect(selectBundles(bundles, { query: '  LOG-HERO  ' }).map((item) => item.id)).toEqual(['beta'])
  })

  it('hides broken bundles from the default list but keeps them findable by id or owner', () => {
    expect(selectBundles(bundles, { hideBroken: true }).map((item) => item.id)).toEqual(['alpha', 'beta'])
    // §6.5: a broken bundle still answers an explicit search — silently
    // dropping it would look like "this suite never existed".
    expect(selectBundles(bundles, { hideBroken: true, query: 'gamma' }).map((item) => item.id)).toEqual(['gamma'])
    // The default list is the only place that hides them: `hideBroken` is off
    // by default so the details payload can still resolve a broken bundle.
    expect(selectBundles(bundles, { query: 'someone' }).map((item) => item.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('keeps only bundles updated within the asked-for window (§8.4)', () => {
    const aged = [
      card({ id: 'fresh', score: { hotness: null, freshnessDays: 3, coverage: 0 } }),
      card({ id: 'month', score: { hotness: null, freshnessDays: 20, coverage: 0 } }),
      card({ id: 'old', score: { hotness: null, freshnessDays: 120, coverage: 0 } }),
    ]
    expect(selectBundles(aged, { updatedWithinDays: 7 }).map((item) => item.id)).toEqual(['fresh'])
    expect(selectBundles(aged, { updatedWithinDays: 30 }).map((item) => item.id)).toEqual(['fresh', 'month'])
    // Absent and zero both mean "any time": the page sends neither, and a
    // range of 0 would be a filter that keeps nothing at all.
    expect(selectBundles(aged, {}).map((item) => item.id)).toEqual(['fresh', 'month', 'old'])
    expect(selectBundles(aged, { updatedWithinDays: 0 }).map((item) => item.id)).toEqual(['fresh', 'month', 'old'])
  })

  it('measures the window against the catalog build, not this request', () => {
    // `freshnessDays` is stamped by the builder, so the same document always
    // answers the same way. Re-running a query an hour later cannot silently
    // drop a bundle that was inside the window when the page loaded.
    const built = [card({ id: 'edge', score: { hotness: null, freshnessDays: 30, coverage: 0 } })]
    expect(selectBundles(built, { updatedWithinDays: 30 }).map((item) => item.id)).toEqual(['edge'])
    expect(selectBundles(built, { updatedWithinDays: 29 }).map((item) => item.id)).toEqual([])
  })

  it('sorts by member count and breaks ties by id', () => {
    expect(selectBundles(bundles, { sort: 'members' }).map((item) => item.id))
      .toEqual(['beta', 'alpha', 'gamma'])
  })

  it('sorts by update time', () => {
    expect(selectBundles(bundles, { sort: 'updated' }).map((item) => item.id)[0]).toBe('beta')
  })

  // The catalog is hand-written JSON and nothing requires zero-padded days.
  // Lexical comparison put 2026-11-9 AFTER 2026-11-10, because '9' > '1'.
  it('orders update time by date, not by string', () => {
    const older = card({ id: 'older', updatedAt: '2026-11-9' })
    const newer = card({ id: 'newer', updatedAt: '2026-11-10' })
    expect(selectBundles([older, newer], { sort: 'updated' }).map((item) => item.id))
      .toEqual(['newer', 'older'])
  })

  it('ranks by hotness, and keeps unmeasured bundles at the bottom', () => {
    const hot = card({ id: 'hot', score: { hotness: 90, freshnessDays: 0, coverage: 1 } })
    const warm = card({ id: 'warm', score: { hotness: 10, freshnessDays: 0, coverage: 1 } })
    const noData = card({ id: 'nodata', score: { hotness: null, freshnessDays: 0, coverage: 0 } })
    expect(selectBundles([warm, noData, hot], { sort: 'hottest' }).map((item) => item.id))
      .toEqual(['hot', 'warm', 'nodata'])
  })

  // §5.6: `coverage < 0.5` does not take part in "hottest". Without this, one
  // measured member out of six could outrank a bundle measured across all.
  it('excludes thin-coverage bundles from the hotness ranking', () => {
    const thin = card({ id: 'thin', score: { hotness: 999, freshnessDays: 0, coverage: 0.3 } })
    const solid = card({ id: 'solid', score: { hotness: 8, freshnessDays: 0, coverage: 1 } })
    expect(selectBundles([thin, solid], { sort: 'hottest' }).map((item) => item.id))
      .toEqual(['solid', 'thin'])
  })

  it('filters on the secondary category, which only exists under its primary', () => {
    const other = card({ id: 'delta', category: { primary: 'research', secondary: 'finance' } })
    expect(selectBundles([...bundles, other], { primary: 'research' }).map((item) => item.id)).toEqual(['delta'])
    expect(selectBundles([...bundles, other], { secondary: 'workspace' })).toHaveLength(3)
  })

  it('does not mutate the array it was given', () => {
    const input = [...bundles]
    selectBundles(input, { sort: 'members' })
    expect(input.map((item) => item.id)).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('warningCapabilities', () => {
  it('reports the capabilities that deserve a badge, in a stable order', () => {
    expect(warningCapabilities(card({ capabilitySummary: ['network', 'shell', 'llm'] })))
      .toEqual(['shell', 'network'])
  })

  it('reports nothing when the scan found nothing risky', () => {
    expect(warningCapabilities(card({ capabilitySummary: ['llm'] }))).toEqual([])
  })
})

