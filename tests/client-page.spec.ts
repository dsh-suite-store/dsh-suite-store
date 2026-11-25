/**
 * The page store, and the two functions that turn its state into a URL.
 *
 * There is no DOM here on purpose. Everything below is the part of the page
 * where a mistake is silent — an event folded in the wrong order, a reload
 * that loses its filter, a category that reads like a variable name — and all
 * of it is answerable from plain objects. The drawing is verified by hand in
 * a real host, where the theme tokens and the primitive components exist.
 */

import { describe, expect, it } from 'vitest'

import type { FilterOptions } from '../src/catalog/types.ts'
import { selectBundles } from '../src/catalog/types.ts'
import type {
  BundlesResponse,
  CapabilitiesResponse,
  MemberStatesResponse,
  PreflightResponse,
  StoreClient,
} from '../src/client/store-data.ts'
import type { InstallReport } from '../src/install/executor.ts'
import {
  applyProgress,
  applySnapshot,
  createPageStore,
  initialState,
  installedFrom,
  parseQuery,
  queryOf,
} from '../src/client/page-store.ts'
import { categoryTabs } from '../src/client/StorePage.tsx'
import { primaryLabel, secondaryLabel } from '../src/client/Card.tsx'
import { startOperation, patchMember } from '../src/install/operation.ts'
import type { InstallPlan } from '../src/install/plan.ts'
import type { OperationRecord } from '../src/install/operation.ts'
import { fixtureCard } from './support/card.ts'

/** A three-member plan, so member order is observable. */
const plan: InstallPlan = {
  steps: [
    { key: 'a', id: 'npm:a', spec: 'npm:a', pinnedVersion: null, name: 'Alpha', approvedBuilds: [] },
    { key: 'b', id: 'npm:b', spec: 'npm:b', pinnedVersion: null, name: 'Beta', approvedBuilds: [] },
    { key: 'c', id: 'npm:c', spec: 'npm:c', pinnedVersion: null, name: 'Gamma', approvedBuilds: [] },
  ],
  skipped: [],
}

describe('the URL and the page agree', () => {
  it('round-trips every filter through the hash', () => {
    const filters: FilterOptions = {
      query: '窗口 管理',
      primary: 'research',
      secondary: 'finance',
      sort: 'hottest',
      hideBroken: true,
      updatedWithinDays: 30,
    }
    expect(parseQuery(queryOf(filters))).toEqual(filters)
  })

  it('writes nothing for the default view', () => {
    expect(queryOf({ sort: 'recommended' })).toBe('')
  })

  it('leaves the default sort out of the URL but reads it back as recommended', () => {
    expect(queryOf({ primary: 'research', sort: 'recommended' })).toBe('primary=research')
    expect(parseQuery('primary=research').sort ?? 'recommended').toBe('recommended')
  })

  it('accepts a leading hash and a leading question mark alike', () => {
    expect(parseQuery('#primary=research').primary).toBe('research')
    expect(parseQuery('?primary=research').primary).toBe('research')
  })

  it('drops a secondary category that arrives without its primary', () => {
    // The chip row only exists under a primary tab. A stray `secondary=` in a
    // hand-edited URL would filter the grid by a control the page never draws.
    expect(parseQuery('secondary=finance')).toEqual({})
    expect(parseQuery('primary=research&secondary=finance').secondary).toBe('finance')
  })
})

describe('category headings', () => {
  // The catalog names its categories in both languages; the page must not
  // derive a name from the slug when a name exists. Deriving was the bug: a
  // Chinese reader saw `Academic research` because the slug is English.
  const labels = {
    'academic-research': { zh: '学术研究与文献', en: 'Academic Research' },
    'paper-search': { zh: '论文检索', en: 'Paper Search' },
    empty: { zh: '', en: 'Fallback' },
  }

  it('uses the catalog name for the reader language', () => {
    expect(primaryLabel('academic-research', 'zh', labels)).toBe('学术研究与文献')
    expect(primaryLabel('academic-research', 'en', labels)).toBe('Academic Research')
  })

  it('uses the same table for a secondary slug', () => {
    expect(secondaryLabel('paper-search', 'zh', labels)).toBe('论文检索')
  })

  it('falls back to the other language when one side is blank', () => {
    expect(primaryLabel('empty', 'zh', labels)).toBe('Fallback')
  })

  it('title-cases the id when the catalog names nothing', () => {
    expect(primaryLabel('breaking-news', 'en')).toBe('Breaking news')
    expect(primaryLabel('research', 'zh', {})).toBe('Research')
  })

  it('draws nothing for the empty key', () => {
    expect(primaryLabel('', 'zh')).toBe('')
  })
})

describe('the category tabs', () => {
  // The 全部 tab is the absence of the `primary` filter, not a category the
  // catalog publishes. Modelling it as `undefined` keeps the tab row, the URL
  // and `selectBundles` reading the same value.
  const categories = { research: ['finance'], finance: [] }

  it('puts 全部 first, then the catalog order', () => {
    expect(categoryTabs(categories)).toEqual([undefined, 'research', 'finance'])
  })

  it('is just 全部 for a catalog that publishes no categories', () => {
    expect(categoryTabs({})).toEqual([undefined])
  })

  it('round-trips 全部 through the URL as the absence of primary', () => {
    expect(queryOf({ primary: undefined })).toBe('')
    expect(parseQuery('').primary).toBeUndefined()
  })

  it('keeps the whole catalog visible under 全部', () => {
    const all: FilterOptions = { primary: undefined }
    // The regression: before this, the page defaulted `primary` to the first
    // category key, so a fresh visitor only ever saw that one category.
    expect(selectBundles([fixtureCard({ id: 'x' })], all)).toHaveLength(1)
    expect(selectBundles([fixtureCard({ id: 'x' })], { primary: 'finance' })).toHaveLength(0)
  })
})

describe('follow order', () => {
  // `patchMember` is pure: it returns a new record, as a reducer must. A test
  // that forgets the return value silently asserts against the old record.
  const live = (): OperationRecord =>
    startOperation({ opId: 'op1', bundleId: 'fin', bundleVersion: '1.0.0', hostKind: 'cli', now: '2026-01-02T00:00:00.000Z', plan })

  it('keeps a member running when a stale snapshot arrives afterwards', () => {
    const operation = patchMember(live(), 'a', { state: 'running', phase: 'add' })
    const state = { ...initialState(), status: 'ready' as const, operation }
    const stale: OperationRecord = {
      ...operation,
      updatedAt: '2000-01-01T00:00:00.000Z',
      members: operation.members.map((member) => ({ ...member, state: 'pending' as const })),
    }
    expect(applySnapshot(state, stale).operation?.members[0]?.state).toBe('running')
  })

  it('takes a newer snapshot even when it says less', () => {
    // The reconnect case: the server's record is authoritative for what it
    // knows, and only a STRICTLY newer record is allowed to roll a member
    // back. This is the rule the test above protects from both sides.
    const operation = patchMember(live(), 'a', { state: 'running', phase: 'add' })
    const state = { ...initialState(), status: 'ready' as const, operation }
    const later: OperationRecord = { ...operation, updatedAt: '2099-01-01T00:00:00.000Z' }
    expect(applySnapshot(state, later).operation?.updatedAt).toBe('2099-01-01T00:00:00.000Z')
  })

  it('does not reopen a member the record already finished', () => {
    const operation = patchMember(live(), 'a', { state: 'ok', phase: 'record' })
    const state = { ...initialState(), status: 'ready' as const, operation }
    const next = applyProgress(state, { type: 'member-phase', opId: 'op1', key: 'a', phase: 'add' })
    expect(next.operation?.members[0]?.state).toBe('ok')
  })

  it('breaks a same-second tie on progress, not on arrival', () => {
    // `updatedAt` is whole-second ISO, so a POST answer recorded in the same
    // second as a live `member-done` compares EQUAL. Letting the incoming
    // record win on `>=` rolled the panel from "1 of 3 done" back to "0 of 3".
    const operation = patchMember(live(), 'a', { state: 'ok', phase: 'record' })
    const state = { ...initialState(), status: 'ready' as const, operation }
    const queuedEra: OperationRecord = {
      ...operation,
      status: 'queued',
      members: operation.members.map((member) => ({ ...member, state: 'pending' as const })),
    }
    expect(applySnapshot(state, queuedEra).operation?.members[0]?.state).toBe('ok')
  })

  it('does not treat an unknown status as finished', () => {
    // "Not one of the five live statuses" used to mean terminal, so a status
    // this build does not know folded a still-running operation's partial `ok`
    // members into `installed`. The list is enumerated now.
    const record: OperationRecord = {
      ...startOperation({ opId: 'opX', bundleId: 'fin', bundleVersion: '1.0.0', hostKind: 'cli', now: '2026-01-02T00:00:00.000Z', plan }),
      status: 'paused' as OperationRecord['status'],
    }
    const state = { ...initialState(), status: 'ready' as const, operation: record, installed: new Set<string>() }
    const next = applyProgress(state, { type: 'op-end', op: record })
    expect(next.installed).toEqual(new Set<string>())
  })

  it('ignores an event for an operation it is not following', () => {
    const operation = patchMember(live(), 'a', { state: 'running' })
    const state = { ...initialState(), status: 'ready' as const, operation }
    const next = applyProgress(state, { type: 'member-start', opId: 'other', key: 'b' })
    expect(next.operation?.members[1]?.state).toBe('pending')
    expect(next.operation?.members[0]?.state).toBe('running')
  })
})

describe('installedFrom', () => {
  it('collects the keys of every bundle', () => {
    expect([...installedFrom(catalogWith({ fin: members('a', 'b'), ops: members('c') }, { fin: ['a'], ops: ['c'] }))].sort())
      .toEqual(['a', 'c'])
  })

  it('drops a key no card claims', () => {
    expect([...installedFrom(catalogWith({ fin: members('a') }, { fin: ['a'], gone: ['zzz'] }))]).toEqual(['a'])
  })

  it('adds the keys the profile reported outside the catalog', () => {
    expect([...installedFrom(catalogWith({ fin: members('a') }), ['a', 'b'])].sort()).toEqual(['a', 'b'])
  })

  it('trusts an explicit key list over the catalog in hand', () => {
    // The catalog the page still holds is PRE-run, so its `installedMembers`
    // lists what a removal just deleted. Only when the caller gave no explicit
    // answer may the catalog fill the set in.
    const stale = catalogWith({ fin: members('a') }, { fin: ['a'] })
    // No explicit answer: the catalog is all there is, so it fills the set.
    expect([...installedFrom(stale)]).toEqual(['a'])
    // An explicit answer — here the post-removal `state.installed`, which no
    // longer holds `a` — is the fresher truth and must not be re-added from
    // the stale catalog.
    expect([...installedFrom(stale, [])]).toEqual([])
  })

  it('answers with nothing before the catalog has loaded', () => {
    expect(installedFrom(undefined).size).toBe(0)
  })
})

describe('createPageStore', () => {
  it('loads the catalog into a ready state', async () => {
    const store = createPageStore(fakeClient())
    await store.load('')
    expect(store.getState().status).toBe('ready')
    expect(store.getState().catalog?.bundles).toHaveLength(1)
  })

  it('falls back to the last good catalog when a reload fails', async () => {
    // Not an error state: the page still has 24 usable cards, and blanking
    // them because the CDN hiccuped is worse than one quiet banner.
    const store = createPageStore(fakeClient({ failAfterFirst: true }))
    await store.load('')
    await store.load('')
    expect(store.getState().catalog?.bundles).toHaveLength(1)
  })

  it('reports an error when the first load fails and nothing was ever cached', async () => {
    const store = createPageStore(fakeClient({ failAlways: true }))
    await store.load('')
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toBe('offline')
  })

  it('tells its subscribers that something changed', async () => {
    const store = createPageStore(fakeClient())
    let calls = 0
    const off = store.subscribe(() => { calls += 1 })
    await store.load('')
    off()
    expect(calls).toBeGreaterThan(0)
  })

  it('reads a detail document once and remembers it', async () => {
    const client = fakeClient()
    const store = createPageStore(client)
    await store.detail('fin')
    await store.detail('fin')
    expect(client.detailCalls).toBe(1)
  })

  it('does not remember a failed detail read', async () => {
    const client = fakeClient({ detailFails: true })
    const store = createPageStore(client)
    await expect(store.detail('fin')).rejects.toThrow('no detail')
    await expect(store.detail('fin')).rejects.toThrow('no detail')
    expect(client.detailCalls).toBe(2)
  })
})

/** A catalog answer whose cards carry the given members. */
function catalogWith(byId: Record<string, ReturnType<typeof members>>, installed?: Record<string, string[]>): BundlesResponse {
  const answer: BundlesResponse = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { kind: 'url', label: 'CDN' },
    categories: { research: ['finance'] },
    bundles: Object.entries(byId).map(([id, list]) => fixtureCard({ id, members: list })),
  }
  return installed === undefined ? answer : { ...answer, installed }
}

/** Members with the given keys. */
function members(...keys: string[]) {
  return keys.map((key) => ({
    key,
    id: `npm:${key}`,
    name: key,
    version: null,
    pinned: false,
    spec: `npm:${key}`,
  }))
}

/** The catalog answer the fake client serves. */
const CATALOG = catalogWith({ fin: members('a') })

/** The capabilities the fake client reports. */
const CAPABILITIES: CapabilitiesResponse = {
  hostKind: 'cli',
  installable: true,
  canRestart: true,
  canApproveBuilds: true,
  memberEstimateMs: [20_000, 40_000],
}

/** A client that answers with one card and counts what was asked of it. */
function fakeClient(
  options: { failAfterFirst?: boolean; failAlways?: boolean; detailFails?: boolean } = {},
): StoreClient & { detailCalls: number } {
  let bundles = 0
  const client = {
    detailCalls: 0,
    bundles: async (): Promise<BundlesResponse> => {
      bundles += 1
      if (options.failAlways === true) throw new Error('offline')
      if (options.failAfterFirst === true && bundles > 1) throw new Error('offline')
      return CATALOG
    },
    detail: async () => {
      client.detailCalls += 1
      if (options.detailFails === true) throw new Error('no detail')
      return {
        format: 1 as const,
        id: 'fin',
        owner: 'someone',
        version: '1.0.0',
        // `readme` is localized text on the model, not a bare string.
        readme: { zh: '说明', en: 'Readme' },
        capabilities: [],
        members: [],
      }
    },
    capabilities: async (): Promise<CapabilitiesResponse> => CAPABILITIES,
    // The five members below are never exercised by this suite, but `StoreClient`
    // requires them: leaving them out meant the fake passed only because the
    // tests project silently skipped type-checking every spec file.
    preflight: async (): Promise<PreflightResponse> => ({
      summary: {
        steps: 0,
        alreadyInstalled: 0,
        estimateSeconds: 0,
        needsBuildApproval: false,
        pendingBuilds: [],
        members: [],
      },
      plan: {},
    }),
    // `resume` also answers with the running record (see `install` below).
    resume: async (): Promise<OperationRecord> => ({
      opId: 'op',
      bundleId: 'fin',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      status: 'installing',
      startedAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
      members: [],
    }),
    memberStates: async (): Promise<MemberStatesResponse> => ({ members: [] }),
    setMemberEnabled: async (): Promise<boolean> => true,
    installMember: async (): Promise<InstallReport> => ({
      opId: 'op',
      bundleId: 'fin',
      status: 'done' as const,
      ok: [],
      skipped: [],
      skippedBuildDenied: [],
      failed: [],
    }),
    // `install` answers with the RUNNING record, not the final report — a
    // ten-member suite takes minutes, so the POST returns as soon as work
    // begins. `OperationRecord` therefore needs its live fields here even
    // though this suite never drives an install.
    install: async (): Promise<OperationRecord> => ({
      opId: 'op',
      bundleId: 'fin',
      bundleVersion: '1.0.0',
      hostKind: 'cli',
      status: 'installing',
      startedAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
      members: [],
    }),
    cancel: async () => ({ stopped: true }),
    uninstallPreview: async () => ({ members: [] }),
    // `UninstallReport` has `removed` where an install report has `ok`.
    uninstall: async () => ({
      opId: 'op',
      bundleId: 'fin',
      status: 'done' as const,
      ok: [],
      skipped: [],
      skippedBuildDenied: [],
      failed: [],
      removed: [],
    }),
    progress: () => () => undefined,
  }
  return client
}

describe('whether a finished panel retires itself', () => {
  // The page keeps a finished banner readable; only a CLEAN run auto-closes.
  // A failed member is a result the reader has to be able to act on, and the
  // panel is the only place that names it.
  const record = (states: readonly string[]): OperationRecord => ({
    opId: 'op-1',
    bundleId: 'fin',
    bundleVersion: '1.0.0',
    kind: 'uninstall',
    hostKind: 'desktop',
    status: 'partial',
    startedAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:01:00.000Z',
    members: states.map((state, index) => ({
      key: `m${String(index)}`,
      id: `npm:m${String(index)}`,
      name: `m${String(index)}`,
      state: state as OperationRecord['members'][number]['state'],
    })),
  })

  const retires = (states: readonly string[]): boolean => {
    const op = record(states)
    return op.members.every((member) => member.state !== 'failed')
  }

  it('retires a run where every member landed', () => {
    expect(retires(['ok', 'ok'])).toBe(true)
  })

  it('retires a run whose members were skipped, which is not a failure', () => {
    expect(retires(['ok', 'skipped'])).toBe(true)
  })

  it('keeps the panel when a member failed', () => {
    expect(retires(['ok', 'failed'])).toBe(false)
  })
})
