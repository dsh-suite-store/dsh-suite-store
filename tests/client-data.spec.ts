/**
 * The browser data module: query building, the wire-shape helpers the page
 * reads, and the two policies that must never regress — permission copy and
 * markdown reduced to safe nodes.
 *
 * These run in Node against no DOM: everything here is pure by design, which
 * is the reason the page's rules live in this file rather than in the
 * components that use them.
 */
import { describe, expect, it } from 'vitest'

import {isLiveStatus,
  api,
  capabilitySentence,
  filterQuery,
  categoryCounts,
  installState,
  inView,
  orderChipsByCount,
  orderTabsByCount,
  installedCount,
  inlineRuns,
  markdownBlocks,
  progressOf,
  shortDate,
  stripHtml,
  text,
  type InlineRun,
  type MarkdownBlock,
} from '../src/client/store-data.ts'
import { localeOfSnapshot } from '../src/client/copy.ts'
import { startOperation, startRemoval } from '../src/install/operation.ts'
import type { InstallPlan } from '../src/install/plan.ts'
import { fixtureCard } from './support/card.ts'

const LOCALE: 'zh' | 'en' = 'en'

/**
 * An install plan over the given member keys, which is what
 * `startOperation` takes: the record copies the plan, so a test that wants
 * five members builds a five-step plan.
 *
 * @param keys - member keys, in order.
 * @returns a plan with one pinned step per key and nothing skipped.
 */
function planOf(keys: readonly string[]): InstallPlan {
  return {
    steps: keys.map((key) => ({
      key,
      id: `npm:${key}`,
      spec: `${key}@1.0.0`,
      pinnedVersion: '1.0.0',
      name: key,
      approvedBuilds: [],
    })),
    skipped: [],
  }
}

describe('filterQuery', () => {
  it('omits every default so the URL is short and cacheable', () => {
    expect(filterQuery({})).toBe('')
    expect(filterQuery({ sort: 'recommended', hideBroken: false })).toBe('')
  })

  it('carries a search term and a sort mode', () => {
    expect(filterQuery({ query: 'finance', sort: 'updated' })).toBe('?q=finance&sort=updated')
  })

  it('trims a query that is only spaces down to nothing', () => {
    expect(filterQuery({ query: '   ' })).toBe('')
  })

  it('carries the category pair a secondary chip produces', () => {
    const query = filterQuery({ primary: 'research', secondary: 'finance' })
    expect(new URLSearchParams(query.slice(1)).get('primary')).toBe('research')
    expect(new URLSearchParams(query.slice(1)).get('secondary')).toBe('finance')
  })

  it('sends hideBroken as a flag rather than a truthy word', () => {
    expect(new URLSearchParams(filterQuery({ hideBroken: true }).slice(1)).get('hideBroken')).toBe('1')
  })

  it('carries an update window, and treats zero as "any time"', () => {
    expect(new URLSearchParams(filterQuery({ updatedWithinDays: 30 }).slice(1)).get('updatedWithin')).toBe('30')
    // 0 is the page's "any time" choice. Sending it would be a range that keeps
    // nothing, so it must serialize as the absence of the option.
    expect(filterQuery({ updatedWithinDays: 0 })).toBe('')
  })

  it('escapes a query with characters that would otherwise split the URL', () => {
    const search = new URLSearchParams(filterQuery({ query: 'a&b=c d' }).slice(1))
    expect(search.get('q')).toBe('a&b=c d')
  })
})

describe('api', () => {
  it('roots the path at the page when there is no document', () => {
    expect(api('/dsh-suite-store/api/bundles')).toBe('/dsh-suite-store/api/bundles')
  })

  it('accepts a path without a leading slash', () => {
    expect(api('dsh-suite-store/api/bundles')).toBe('/dsh-suite-store/api/bundles')
  })
})

describe('text', () => {
  it('prefers the active language', () => {
    expect(text({ zh: '整合包', en: 'Suite' }, 'zh')).toBe('整合包')
    expect(text({ zh: '整合包', en: 'Suite' }, 'en')).toBe('Suite')
  })

  it('falls back when the active language is empty rather than blanking the card', () => {
    expect(text({ zh: '', en: 'Suite' }, 'zh')).toBe('Suite')
  })

  it('accepts a plain string, which the catalog uses when one text serves both', () => {
    expect(text('Same both ways', 'zh')).toBe('Same both ways')
  })

  it('answers an empty string for missing text', () => {
    expect(text(undefined, 'en')).toBe('')
  })
})

describe('capabilitySentence', () => {
  it('says what a shell capability means in each language', () => {
    expect(capabilitySentence('shell', 'en')).toContain('commands')
    expect(capabilitySentence('shell', 'zh')).toContain('命令')
  })

  // The register is a scope statement, not a sentence about the reader:
  // "读取本地文件", not "可以读取你这台电脑上的文件". A second person or a
  // modal in a permission line reads as marketing copy next to a security fact.
  it('states scope without addressing the reader', () => {
    for (const tag of CATALOG_TAGS) {
      expect(capabilitySentence(tag, 'zh')).not.toMatch(/你|您/u)
      expect(capabilitySentence(tag, 'en')).not.toMatch(/\byou\b|\byour\b/u)
    }
  })

  it('answers undefined for a tag it has no copy for, so the caller shows the raw tag', () => {
    expect(capabilitySentence('gpu', 'en')).toBeUndefined()
  })

  // The catalog's tag list is derived, not hand-written: the next member swap
  // can introduce one. §8.6 asks for a sentence rather than a tag, so a tag
  // that reaches a card as `fs-read` is the bug this test is here to catch.
  const CATALOG_TAGS = [
    'credentials',
    'dynamic-code',
    'env',
    'fs-read',
    'fs-write',
    'llm',
    'network',
    'shell',
    'subagent',
  ]

  it('has a sentence, in both languages, for every tag the catalog can emit', () => {
    for (const tag of CATALOG_TAGS) {
      const en = capabilitySentence(tag, 'en')
      const zh = capabilitySentence(tag, 'zh')
      expect(en, `no English sentence for ${tag}`).toBeTruthy()
      expect(zh, `no Chinese sentence for ${tag}`).toBeTruthy()
      // A sentence, not the tag with a capital letter: the point of §8.6.
      expect(en).not.toBe(tag)
      expect(zh).not.toBe(tag)
    }
  })
})

describe('shortDate', () => {
  it('formats an ISO timestamp for the active locale', () => {
    expect(shortDate('2026-11-01T12:00:00.000Z', 'en')).toMatch(/2026/)
  })

  it('answers empty for a timestamp it cannot parse', () => {
    expect(shortDate('not a date', 'en')).toBe('')
  })
})

describe('installedCount', () => {
  it('counts the members this profile already has', () => {
    const card = fixtureCard({
      members: [
        { key: 'a', id: 'npm:alpha', name: 'alpha', version: '1.0.0', pinned: true, spec: 'alpha@1.0.0' },
        { key: 'b', id: 'npm:beta', name: 'beta', version: null, pinned: false, spec: 'beta' },
      ],
      memberCount: 2,
    })
    // Keys, not ids: the profile's answer names the bundle's own member keys
    // (§8.2), so the card can mark a member without knowing its identity spec.
    expect(installedCount(card, new Set(['a']))).toBe(1)
    expect(installedCount(card, new Set())).toBe(0)
  })

  it('ignores a key that belongs to some other bundle', () => {
    const card = fixtureCard({ members: [
      { key: 'a', id: 'npm:alpha', name: 'alpha', version: null, pinned: false, spec: 'alpha' },
    ], memberCount: 1 })
    expect(installedCount(card, new Set(['member:a', 'npm:alpha']))).toBe(0)
  })
})

describe('inView', () => {
  // Three-member suites, so "some but not all" has an answer.
  const three = (id: string, installedByUser?: boolean) => fixtureCard({
    id,
    installedByUser,
    memberCount: 3,
    members: [
      { key: 'a', id: 'npm:alpha', name: 'alpha', version: null, pinned: false, spec: 'alpha' },
      { key: 'b', id: 'npm:beta', name: 'beta', version: null, pinned: false, spec: 'beta' },
      { key: 'c', id: 'npm:gamma', name: 'gamma', version: null, pinned: false, spec: 'gamma' },
    ],
  })

  it('keeps every card in 发现, whatever is installed', () => {
    expect(inView(three('s'), 'discover', new Set())).toBe(true)
    expect(inView(three('s'), 'discover', new Set(['a', 'b', 'c']))).toBe(true)
  })

  it('keeps only provenance-installed cards in 已安装', () => {
    // Provenance, not presence: a plugin the reader installed themselves must
    // not put a suite in this list.
    expect(inView(three('s', true), 'installed', new Set())).toBe(true)
    expect(inView(three('s', false), 'installed', new Set(['a', 'b', 'c']))).toBe(false)
  })

  it('keeps a partly installed suite in 可增强 and drops the two ends', () => {
    const card = three('s')
    expect(inView(card, 'enhance', new Set(['a']))).toBe(true)
    // Nothing of it here: there is nothing to complete.
    expect(inView(card, 'enhance', new Set())).toBe(false)
    // Every member is here: the suite is whole, the list is for gaps.
    expect(inView(card, 'enhance', new Set(['a', 'b', 'c']))).toBe(false)
  })

  it('counts a hand-installed member towards 可增强, unlike 已安装', () => {
    // The two lists ask different questions on purpose: presence says what can
    // be completed, provenance says what this store put here.
    const card = three('s', false)
    expect(inView(card, 'enhance', new Set(['a']))).toBe(true)
    expect(inView(card, 'installed', new Set(['a']))).toBe(false)
  })

  it('ignores a key that belongs to no member of this card', () => {
    expect(inView(three('s'), 'enhance', new Set(['member:a', 'npm:alpha']))).toBe(false)
  })
})

describe('installState', () => {
  const card = fixtureCard({
    id: 'suite',
    members: [
      { key: 'a', id: 'npm:alpha', name: 'alpha', version: '1.0.0', pinned: true, spec: 'alpha@1.0.0' },
      { key: 'b', id: 'npm:beta', name: 'beta', version: null, pinned: false, spec: 'beta' },
    ],
    memberCount: 2,
  })

  it('offers install when nothing of the bundle is present', () => {
    expect(installState({ card, installed: new Set(), operation: undefined, installable: true }))
      .toEqual({ kind: 'install' })
  })

  it('reports the installed fraction when every member is present', () => {
    const state = installState({ card, installed: new Set(['a', 'b']), operation: undefined, installable: true })
    expect(state).toEqual({ kind: 'installed', have: 2, of: 2 })
  })

  it('still offers install when only some members are present', () => {
    expect(installState({ card, installed: new Set(['a']), operation: undefined, installable: true }))
      .toEqual({ kind: 'install' })
  })

  it('shows the live fraction while this bundle is installing', () => {
    const operation = startOperation({
      opId: 'op-1',
      bundleId: 'suite',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      plan: planOf(['a', 'b']),
      now: '2026-11-11T00:00:00.000Z',
    })
    operation.members[0]!.state = 'ok'
    expect(installState({ card: { ...card, id: 'suite' }, installed: new Set(), operation, installable: true }))
      .toEqual({ kind: 'installing', done: 1, total: 2 })
  })

  it('draws removal progress from derived counters without a full record', () => {
    // The card used to pass a hand-built object with no `members`; installState
    // iterated it and threw "operation.members is not iterable", blanking the
    // whole page the instant an uninstall started. Derived counters are the
    // supported path now.
    expect(installState({
      card,
      installed: new Set(),
      operation: undefined,
      operationBundleId: card.id,
      operationKind: 'uninstall',
      progress: { done: 1, total: 3 },
      installable: true,
    })).toEqual({ kind: 'removing', done: 1, total: 3 })
  })

  it('ignores derived counters belonging to a different bundle', () => {
    expect(installState({
      card,
      installed: new Set(),
      operation: undefined,
      operationBundleId: 'other-bundle',
      operationKind: 'uninstall',
      progress: { done: 1, total: 3 },
      installable: true,
    })).toEqual({ kind: 'install' })
  })

  it('survives a partial operation record whose members are missing', () => {
    const partial = {
      opId: 'op-1', bundleId: card.id, bundleVersion: '1.0.0', kind: 'uninstall',
      hostKind: 'cli', status: 'installing', startedAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
    }
    expect(() => installState({
      card, installed: new Set(), operation: partial as unknown as Parameters<typeof installState>[0]['operation'],
      progress: { done: 0, total: 1 }, operationBundleId: card.id, operationKind: 'uninstall',
      installable: true,
    })).not.toThrow()
  })

  it('lets another bundle’s operation leave this button alone', () => {
    const operation = startOperation({
      opId: 'op-1',
      bundleId: 'other',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      plan: planOf(['a']),
      now: '2026-11-11T00:00:00.000Z',
    })
    expect(installState({ card, installed: new Set(), operation, installable: true })).toEqual({ kind: 'install' })
  })

  it('says removing, not installing, while a removal runs on this bundle', () => {
    // A removal walks the same member list in the same direction as an install,
    // so the record alone is not enough to tell them apart. Saying "installing"
    // over a deletion would tell the user the opposite of what is happening.
    const operation = startRemoval({
      opId: 'op-2',
      bundleId: 'suite',
      bundleVersion: '1.0.0',
      hostKind: 'desktop',
      ids: ['npm:a', 'npm:b'],
      now: '2026-11-11T00:00:00.000Z',
    })
    operation.members[0]!.state = 'ok'
    expect(installState({ card: { ...card, id: 'suite' }, installed: new Set(['a', 'b']), operation, installable: true }))
      .toEqual({ kind: 'removing', done: 1, total: 2 })
  })

  it('stops offering the button on a finished operation, even one for this bundle', () => {
    const operation = startOperation({
      opId: 'op-1',
      bundleId: 'suite',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      plan: planOf(['a', 'b']),
      now: '2026-11-11T00:00:00.000Z',
    })
    operation.members[0]!.state = 'ok'
    operation.members[1]!.state = 'ok'
    operation.status = 'done'
    // The installed count is what speaks after the run: `have 0` because the
    // set was never refilled, which is exactly why the state must not claim
    // "installing" any more.
    expect(installState({ card, installed: new Set(), operation, installable: true })).toEqual({ kind: 'install' })
  })

  it('blocks the button on a host with no installer instead of failing on click', () => {
    expect(installState({ card, installed: new Set(), operation: undefined, installable: false }))
      .toEqual({ kind: 'blocked', reason: 'pluginManager' })
  })
})

describe('progressOf', () => {
  it('tallies every member state and names the one running', () => {
    const operation = startOperation({
      opId: 'op-1',
      bundleId: 'suite',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      plan: planOf(['a', 'b', 'c', 'd', 'e']),
      now: '2026-11-11T00:00:00.000Z',
    })
    operation.members[0]!.state = 'ok'
    operation.members[1]!.state = 'skipped'
    operation.members[2]!.state = 'skipped-build-denied'
    operation.members[3]!.state = 'failed'
    operation.members[4]!.state = 'running'
    expect(progressOf(operation)).toEqual({ done: 4, total: 5, ok: 1, skipped: 2, failed: 1, running: 'e' })
  })

  it('counts a disabled-until-restart removal as done', () => {
    // The removal happened; only its effect waits for the next start. Counting
    // it as neither done nor failed left the banner showing 0/1 for finished
    // work.
    const operation = startOperation({
      opId: 'op-1',
      bundleId: 'suite',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      plan: planOf(['a']),
      now: '2026-11-11T00:00:00.000Z',
    })
    operation.members[0]!.state = 'needs-restart'
    expect(progressOf(operation)).toMatchObject({ done: 1, total: 1, failed: 0 })
  })

  it('counts nothing done on a fresh operation', () => {
    const operation = startOperation({
      opId: 'op-1',
      bundleId: 'suite',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      plan: planOf(['a']),
      now: '2026-11-11T00:00:00.000Z',
    })
    expect(progressOf(operation).done).toBe(0)
    // A member is `pending` until the executor says otherwise, so an
    // operation that has only just started names no running member.
    expect(progressOf(operation).running).toBeUndefined()
  })
})

describe('stripHtml', () => {
  it('removes a comment and the tags inside it', () => {
    expect(stripHtml('before<!-- <img src=x> -->after')).toBe('beforeafter')
  })

  it('keeps the text of an anchor and drops the tag', () => {
    expect(stripHtml('<a href="https://example.com">label</a>')).toBe('label')
  })

  it('keeps a bare less-than that is not a tag', () => {
    expect(stripHtml('a < b and c > d')).toBe('a < b and c > d')
  })

  it('collapses the runs of blank lines that removed blocks leave behind', () => {
    expect(stripHtml('one\n\n\n\n\ntwo')).toBe('one\n\ntwo')
  })

  it('drops a script tag but keeps its body as text, never as markup', () => {
    // The reducer below renders text only, so a stripped script tag leaves
    // its body as an inert paragraph — visible, and unable to run.
    expect(stripHtml('<script>alert(1)</script>')).toBe('alert(1)')
  })
})

describe('inlineRuns', () => {
  it('splits bold, code and an https link out of a line', () => {
    const runs = inlineRuns('call `x` then **go** to [docs](https://example.com/a)')
    expect(runs).toEqual<InlineRun[]>([
      { kind: 'text', text: 'call ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' then ' },
      { kind: 'strong', text: 'go' },
      { kind: 'text', text: ' to ' },
      { kind: 'link', text: 'docs', href: 'https://example.com/a' },
    ])
  })

  it('leaves a non-https link as literal text rather than making it clickable', () => {
    const runs = inlineRuns('[click](javascript:alert(1))')
    expect(runs).toEqual<InlineRun[]>([{ kind: 'text', text: '[click](javascript:alert(1))' }])
  })

  it('leaves an http link literal too, because the window is the host’s', () => {
    expect(inlineRuns('[x](http://example.com)')).toEqual<InlineRun[]>([
      { kind: 'text', text: '[x](http://example.com)' },
    ])
  })
})

describe('markdownBlocks', () => {
  it('reduces a document to headings, paragraphs, lists, quotes and code', () => {
    const blocks = markdownBlocks([
      '# Title',
      '',
      'A paragraph.',
      '',
      '- one',
      '- two',
      '',
      '> quoted',
      '',
      '```',
      'pnpm add x',
      '```',
    ].join('\n'))
    expect(blocks.map((block) => block.kind)).toEqual<MarkdownBlock['kind'][]>([
      'heading', 'paragraph', 'list', 'quote', 'code',
    ])
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, inline: [{ kind: 'text', text: 'Title' }] })
    // A bullet goes through the same inline reducer as a paragraph, so its
    // items are runs rather than raw strings: `**bold**` and `` `code` `` in a
    // bullet used to render literally while the same text in a sentence did not.
    expect(blocks[2]).toEqual({
      kind: 'list',
      items: [
        [{ kind: 'text', text: 'one' }],
        [{ kind: 'text', text: 'two' }],
      ],
    })
    expect(blocks[4]).toEqual({ kind: 'code', text: 'pnpm add x' })
  })

  it('keeps markup inside a fenced sample instead of stripping it', () => {
    // `stripHtml` used to run over the whole document before fences were
    // parsed, so a README that *shows* HTML lost it — and the `code` block is
    // rendered verbatim, so the reader saw text the author never published.
    const blocks = markdownBlocks('```\n<div>x</div>\n```')
    expect(blocks).toEqual<MarkdownBlock[]>([{ kind: 'code', text: '<div>x</div>' }])
  })

  it('still strips markup outside a fence', () => {
    const blocks = markdownBlocks('<b>bold</b>\n\n```\n<b>kept</b>\n```')
    expect(blocks[0]).toEqual({ kind: 'paragraph', inline: [{ kind: 'text', text: 'bold' }] })
    expect(blocks[1]).toEqual({ kind: 'code', text: '<b>kept</b>' })
  })

  it('treats an unclosed fence as code to the end rather than as markup', () => {
    const blocks = markdownBlocks('```\n# not a heading\n')
    expect(blocks).toEqual<MarkdownBlock[]>([{ kind: 'code', text: '# not a heading' }])
  })

  it('never produces a raw-HTML block', () => {
    const blocks = markdownBlocks('<img src=x onerror=alert(1)>\n\ntext')
    expect(blocks.every((block) => block.kind !== ('html' as MarkdownBlock['kind']))).toBe(true)
    expect(blocks[0]).toEqual({ kind: 'paragraph', inline: [{ kind: 'text', text: 'text' }] })
  })

  it('keeps a numbered list as paragraphs, because the reducer only promises bullets', () => {
    const blocks = markdownBlocks('1. first')
    expect(blocks).toEqual<MarkdownBlock[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: '1. first' }] },
    ])
  })
})

describe('unknown catalog text', () => {
  it('survives a card whose summary is missing in both languages without throwing', () => {
    expect(text({ zh: '', en: '' }, LOCALE)).toBe('')
  })
})

describe('a finished operation leaves the card alone', () => {
  // The uninstall white-screen fix moved the card onto derived counters, which
  // carry no status. Without a live gate here, a card kept saying 卸载中 after
  // the run ended — visible until reload, because the panel and the card read
  // the same record two different ways.
  const operation = startOperation({
    opId: 'op-1',
    bundleId: 'suite',
    bundleVersion: '1.0.0',
    hostKind: 'cli',
    plan: planOf(['a', 'b']),
    now: '2026-11-11T00:00:00.000Z',
  })

  it('still shows progress while the run is live', () => {
    const local = fixtureCard({ id: 'suite', memberCount: 2 })
    expect(installState({
      card: local,
      installed: new Set(),
      operation: undefined,
      operationBundleId: 'suite',
      operationKind: 'install',
      progress: { done: 1, total: 2 },
      installable: true,
    })).toEqual({ kind: 'installing', done: 1, total: 2 })
  })

  it('shows no progress once the same record is done', () => {
    // The page gates on isLiveStatus before handing counters down; the card's
    // fallback branch must agree with that, so an empty counter set is what a
    // finished operation produces.
    expect(isLiveStatus('done')).toBe(false)
    expect(isLiveStatus('partial')).toBe(false)
    expect(isLiveStatus('installing')).toBe(true)
  })
})

describe('localeOfSnapshot', () => {
  // The live bug: the host publishes `{ active, locales, revision }`, this
  // page only looked at `locale`/`language`, found nothing, and fell back to
  // the browser — so switching the host to English left the page in Chinese.
  it('reads the shipped service shape', () => {
    expect(localeOfSnapshot({ active: 'en', locales: [], revision: 3 })).toBe('en')
    expect(localeOfSnapshot({ active: 'zh', locales: [], revision: 1 })).toBe('zh')
  })

  it('still reads the older shims', () => {
    expect(localeOfSnapshot('en')).toBe('en')
    expect(localeOfSnapshot({ locale: 'zh-CN' })).toBe('zh')
    expect(localeOfSnapshot({ language: 'en-US' })).toBe('en')
  })

  it('answers nothing when the host says nothing', () => {
    expect(localeOfSnapshot(undefined)).toBeUndefined()
    expect(localeOfSnapshot({})).toBeUndefined()
    expect(localeOfSnapshot({ active: '' })).toBeUndefined()
  })
})

describe('categoryCounts', () => {
  const categories = { vision: ['ocr', 'image-qa'], memory: ['cross-session'] }
  const cards = [
    fixtureCard({ id: 'v1', title: { zh: '视觉一', en: 'Vision one' }, category: { primary: 'vision', secondary: 'ocr' } }),
    fixtureCard({ id: 'v2', title: { zh: '视觉二', en: 'Vision two' }, category: { primary: 'vision', secondary: 'image-qa' } }),
    fixtureCard({ id: 'm1', title: { zh: '记忆一', en: 'Memory one' }, category: { primary: 'memory', secondary: 'cross-session' } }),
  ]

  it('counts every bundle under its primary', () => {
    const { primary } = categoryCounts(cards, {}, categories)
    expect(primary.get('vision')).toBe(2)
    expect(primary.get('memory')).toBe(1)
  })

  it('follows the search', () => {
    const { primary } = categoryCounts(cards, { query: '记忆' }, categories)
    expect(primary.get('memory')).toBe(1)
    expect(primary.get('vision')).toBeUndefined()
  })

  it('does not collapse to the selected tab', () => {
    // The bug this guards: computing counts from the filtered list would make
    // every tab except the current one read 0.
    const { primary } = categoryCounts(cards, { primary: 'vision' }, categories)
    expect(primary.get('vision')).toBe(2)
    expect(primary.get('memory')).toBe(1)
  })

  it('counts secondaries under their own primary', () => {
    const { secondary } = categoryCounts(cards, {}, categories)
    expect(secondary.get('vision')?.get('ocr')).toBe(1)
    expect(secondary.get('vision')?.get('image-qa')).toBe(1)
    expect(secondary.get('memory')?.get('cross-session')).toBe(1)
  })
})

describe('orderTabsByCount / orderChipsByCount', () => {
  it('keeps 全部 first and orders the rest by descending count', () => {
    const tabs = [undefined, 'a', 'b', 'c']
    const counts = new Map([['a', 1], ['b', 9], ['c', 4]])
    expect(orderTabsByCount(tabs, counts)).toEqual([undefined, 'b', 'c', 'a'])
  })

  it('keeps the catalog order for ties', () => {
    const tabs = [undefined, 'a', 'b', 'c']
    const counts = new Map([['a', 3], ['b', 3], ['c', 3]])
    expect(orderTabsByCount(tabs, counts)).toEqual([undefined, 'a', 'b', 'c'])
  })

  it('treats an unknown category as zero', () => {
    const tabs = [undefined, 'a', 'b']
    expect(orderTabsByCount(tabs, new Map())).toEqual([undefined, 'a', 'b'])
  })

  it('orders chips by count and keeps ties stable', () => {
    expect(orderChipsByCount(['x', 'y', 'z'], new Map([['y', 5], ['z', 2]]))).toEqual(['y', 'z', 'x'])
    expect(orderChipsByCount(['x', 'y'], new Map([['x', 1], ['y', 1]]))).toEqual(['x', 'y'])
  })
})

describe('installState during a run', () => {
  const card = fixtureCard({
    id: 'b',
    title: { zh: '包', en: 'Bundle' },
    memberCount: 3,
    members: [
      { key: 'a', id: 'npm:a', name: 'a', spec: 'npm:a@1', version: '1', pinned: true },
      { key: 'b', id: 'npm:b', name: 'b', spec: 'npm:b@1', version: '1', pinned: true },
      { key: 'c', id: 'npm:c', name: 'c', spec: 'npm:c@1', version: '1', pinned: true },
    ],
  })

  it('reports the live count that the card number reads from', () => {
    const state = installState({
      card,
      installed: new Set<string>(),
      operation: undefined,
      installable: true,
      progress: { done: 2, total: 3 },
      operationBundleId: 'b',
    })
    // The card renders done/total from this state; an installing state
    // without the numbers is what made the counter look frozen while the bar
    // moved.
    expect(state).toEqual({ kind: 'installing', done: 2, total: 3 })
  })

  it('counts a skipped member as done so the number can reach the total', () => {
    const state = installState({
      card,
      installed: new Set<string>(),
      operation: undefined,
      installable: true,
      progress: { done: 3, total: 3 },
      operationBundleId: 'b',
    })
    expect(state.kind).toBe('installing')
  })
})
