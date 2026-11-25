/**
 * Behavioural specs for the detail document (§5.3 second level).
 *
 * The detail payload is what the install confirmation renders, so it is the
 * one document whose mistakes a user sees as "the marketplace lied about what
 * would be installed". Every spec here is about keeping that promise: the
 * rendered plan must equal what the installer will actually run.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CatalogFormatError,
  parseBundleDetail,
} from '../src/catalog/types.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

/** The fixture document as JSON, for building broken variants. */
const rawDetail: unknown = JSON.parse(fixture('bundle-detail.json'))

describe('parseBundleDetail', () => {
  it('parses the detail document the builder emits', () => {
    const parsed = parseBundleDetail(rawDetail)
    expect(parsed.id).toBe('fin-analyst-workstation')
    expect(parsed.owner).toBe('someuser')
    expect(parsed.members).toHaveLength(2)
  })

  it('keeps the author note bilingual and separate from the install plan', () => {
    const parsed = parseBundleDetail(rawDetail)
    expect(parsed.readme.zh).toContain('财务分析')
    expect(parsed.readme.en).toContain('financial')
  })

  it('carries the capability source so the warning can name the member', () => {
    const parsed = parseBundleDetail(rawDetail)
    const shell = parsed.capabilities.find((capability) => capability.tag === 'shell')
    expect(shell?.sources).toEqual(['@yolk_vat-y/dsh-project-memory'])
  })

  it('defaults an absent member list to empty rather than failing', () => {
    // A bundle with every member removed is a legitimate intermediate state
    // for the data repo; it should render as a broken bundle, not a 500.
    const broken = structuredClone(rawDetail) as Record<string, unknown>
    delete broken.members
    expect(parseBundleDetail(broken).members).toEqual([])
  })

  it('names the offending field when the document is malformed', () => {
    const broken = structuredClone(rawDetail) as Record<string, unknown>
    broken.owner = 42
    expect(() => parseBundleDetail(broken)).toThrow(/at \$\.owner/u)
  })

  it('rejects a detail document whose id disagrees with the card', () => {
    // The two documents are fetched separately and cached separately; a
    // mismatch means the CDN served a document from another generation, and
    // rendering it would show one bundle's members under another's title.
    expect(() => parseBundleDetail(rawDetail, { expect: 'other-bundle' }))
      .toThrow(CatalogFormatError)
    expect(() => parseBundleDetail(rawDetail, { expect: 'other-bundle' }))
      .toThrow(/bundle id fin-analyst-workstation does not match requested other-bundle/u)
  })

  it('accepts a matching expectation', () => {
    expect(parseBundleDetail(rawDetail, { expect: 'fin-analyst-workstation' }).id)
      .toBe('fin-analyst-workstation')
  })

  it('counts install steps without inventing them', () => {
    // The confirmation renders "将安装 2 个插件"; that number must come from
    // the document, never from a guess at what a spec implies.
    expect(parseBundleDetail(rawDetail).members.filter((member) => member.spec !== '')).toHaveLength(2)
  })

  it('preserves the order the author declared', () => {
    // Dependencies are resolved at build time, so the order in the file IS the
    // install order; re-sorting it would break intra-bundle `requires`.
    expect(parseBundleDetail(rawDetail).members.map((member) => member.key)).toEqual(['memory', 'daily-log'])
  })

  it('exposes the bundle-level postinstall note verbatim', () => {
    // The fixture has an English-only note: the sheet shows it, and `zh` stays
    // empty so `localized()` falls back rather than printing a blank line.
    const parsed = parseBundleDetail(rawDetail)
    expect(parsed.postInstall?.zh).toBe('')
    expect(parsed.postInstall?.en).toContain('Restart the harness')
  })

  it('carries the red lines apart from the disclosure (§5.5, §8.3)', () => {
    // `capabilities` says what a member touches; `capabilityRedLines` says which
    // combinations to look at. §8.3 renders them in red and separately, so a
    // parser that folded them into `capabilities` would delete the distinction
    // the field exists for.
    const withLines = structuredClone(rawDetail) as Record<string, unknown>
    withLines.capabilityRedLines = ['reads files and sends them over the network']
    const parsed = parseBundleDetail(withLines)
    // A plain upstream string is normalised to a bilingual line with no named
    // member, so a mixed catalog is safe to read without special-casing it.
    expect(parsed.capabilityRedLines).toEqual([
      { text: { zh: 'reads files and sends them over the network', en: 'reads files and sends them over the network' }, members: [] },
    ])
    expect(parsed.capabilities.map((capability) => capability.tag)).not.toContain('reads files and sends them over the network')
  })

  it('keeps the structured red line and the members behind it (§8.3)', () => {
    // §8.3 asks the red line to name the member it came from. The structured
    // wire form carries a bilingual sentence and those names; the parser must
    // keep both rather than flattening the object back to a bare string.
    //
    // The name has to be one THIS document lists: `capabilityRedLines[].members`
    // goes through the same attribution check as `capabilities[].sources`, so a
    // red line naming a stranger is now a format error rather than an
    // untraceable warning on the sheet.
    const structured = structuredClone(rawDetail) as Record<string, unknown>
    structured.capabilityRedLines = [
      {
        text: { zh: '改写了宿主的压缩预设', en: 'Overrides the host compaction presets' },
        members: ['@yolk_vat-y/dsh-project-memory'],
      },
    ]
    const parsed = parseBundleDetail(structured)
    expect(parsed.capabilityRedLines).toEqual([
      {
        text: { zh: '改写了宿主的压缩预设', en: 'Overrides the host compaction presets' },
        members: ['@yolk_vat-y/dsh-project-memory'],
      },
    ])
  })

  it('refuses a red line that names a member the document does not list', () => {
    // The mirror of the capability check: an unattributable warning is exactly
    // what §8.3 exists to prevent, so it must not reach the sheet.
    const stranger = structuredClone(rawDetail) as Record<string, unknown>
    stranger.capabilityRedLines = [
      { text: { zh: '未知来源', en: 'Unknown source' }, members: ['billion-context'] },
    ]
    expect(() => parseBundleDetail(stranger)).toThrow(/names members absent from the document/u)
  })

  it('leaves an empty red-line list absent, not empty', () => {
    // "Nothing flagged" and "never scanned" are different sentences on screen,
    // and only one of them is a statement about the plugin. The detail sheet
    // draws the section only when there is something to draw.
    const empty = structuredClone(rawDetail) as Record<string, unknown>
    empty.capabilityRedLines = []
    expect(parseBundleDetail(empty).capabilityRedLines).toBeUndefined()
    expect(parseBundleDetail(rawDetail).capabilityRedLines).toBeUndefined()
  })

  it('keeps the host versions the author tested against', () => {
    const tested = structuredClone(rawDetail) as Record<string, unknown>
    tested.testedWith = 'dsh 0.2.1-rc.3'
    expect(parseBundleDetail(tested).testedWith).toBe('dsh 0.2.1-rc.3')
    // Absent or blank both mean "the author did not say", which §8.3 renders as
    // no row at all rather than an empty one.
    const blank = structuredClone(rawDetail) as Record<string, unknown>
    blank.testedWith = '   '
    expect(parseBundleDetail(blank).testedWith).toBeUndefined()
  })

  it('refuses a capability whose sources list is empty (G15 at the boundary)', () => {
    // The sheet names the members behind every permission row; a row with no
    // named member is a warning nobody can trace, so the parser rejects the
    // document instead of rendering it.
    const anonymous = structuredClone(rawDetail) as Record<string, unknown>
    ;(anonymous.capabilities as Record<string, unknown>[])[0]!.sources = []
    expect(() => parseBundleDetail(anonymous)).toThrow(/must name at least one member/u)
    const missing = structuredClone(rawDetail) as Record<string, unknown>
    delete (missing.capabilities as Record<string, unknown>[])[0]!.sources
    expect(() => parseBundleDetail(missing)).toThrow(/expected an array of strings/u)
  })

  it('refuses a source that names no member of the document', () => {
    const stranger = structuredClone(rawDetail) as Record<string, unknown>
    ;(stranger.capabilities as Record<string, unknown>[])[0]!.sources = ['totally-unrelated-plugin']
    expect(() => parseBundleDetail(stranger)).toThrow(/names members absent from the document/u)
  })
})
