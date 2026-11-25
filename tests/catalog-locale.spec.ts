/**
 * The catalog's language rule, at the trust boundary.
 *
 * The submission schema requires `en` and makes `zh` optional; the builder fills
 * a missing `zh` from `en` before publishing. This parser used to require both
 * keys, which made the client stricter than the contract it reads — a document
 * the schema calls valid would have been rejected on the user's machine.
 */

import { describe, expect, it } from 'vitest'

import { CatalogFormatError, parseCatalogIndex } from '../src/catalog/types.ts'

/** A minimal index whose one card's text fields can be overridden. */
function indexWith(title: unknown, summary: unknown = title): unknown {
  return {
    format: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    catalogRef: { updated: '2026-01-01', count: 1 },
    categories: { productivity: [] },
    bundles: [{
      id: 'demo',
      owner: 'someone',
      version: '1.0.0',
      title,
      summary,
      category: { primary: 'productivity' },
      tags: [],
      cover: null,
      icon: null,
      publishedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      memberCount: 2,
      capabilitySummary: [],
      needsBuildApproval: false,
      members: [
        { key: 'a/one', id: 'npm:one', name: 'one', spec: 'npm:one', pinned: false },
        { key: 'a/two', id: 'npm:two', name: 'two', spec: 'npm:two', pinned: false },
      ],
      readme: { en: 'Body' },
      capabilities: [],
      health: { status: 'ok', checkedAt: '2026-01-01T00:00:00.000Z', missing: [], deprecated: [] },
      score: { hotness: null, freshnessDays: 0, coverage: 0 },
    }],
  }
}

describe('an en-only catalog', () => {
  it('parses, and fills the missing zh from en', () => {
    // This is the shape the submission schema produces: `zh` absent entirely.
    const parsed = parseCatalogIndex(indexWith({ en: 'Only English' }))
    expect(parsed.bundles[0].title).toEqual({ en: 'Only English', zh: 'Only English' })
  })

  it('keeps an explicit empty zh as empty rather than filling it', () => {
    // A deliberate `zh: ''` is a different statement from an absent key — the
    // submission validator rejects it as a mistake — and `text()` falls back at
    // render time, so nothing prints a blank line either way.
    const parsed = parseCatalogIndex(indexWith({ en: 'Only English', zh: '' }))
    expect(parsed.bundles[0].title).toEqual({ en: 'Only English', zh: '' })
  })

  it('still refuses a document with no en', () => {
    // The one language the contract requires.
    expect(() => parseCatalogIndex(indexWith({ zh: '只有中文' }))).toThrow(CatalogFormatError)
    expect(() => parseCatalogIndex(indexWith({}))).toThrow(/expected localized text/u)
  })

  it('still accepts a plain string, as an older document may carry', () => {
    const parsed = parseCatalogIndex(indexWith('Plain'))
    expect(parsed.bundles[0].title).toEqual({ zh: 'Plain', en: 'Plain' })
  })
})
