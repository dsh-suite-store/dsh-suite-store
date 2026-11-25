import { describe, expect, it } from 'vitest'

import {
  emptyProvenance,
  forgetBundleSource,
  installedBundles,
  hasManualSource,
  parseProvenance,
  recordBundleInstall,
  recordManualInstall,
} from '../src/install/state.ts'

const AT = '2026-11-11T00:00:00.000Z'

function bundleInstall(state = emptyProvenance(), bundleId = 'fin-analyst-workstation', bundleVersion = '1.2.0') {
  return recordBundleInstall(state, {
    id: 'npm:@scope/dsh-memory@0.6.11',
    spec: 'npm:@scope/dsh-memory@0.6.11',
    resolvedVersion: '0.6.11',
    bundleId,
    bundleVersion,
    now: AT,
  })
}

describe('parseProvenance', () => {
  it('returns an empty state for anything that is not a document', () => {
    expect(parseProvenance(null).entries).toEqual({})
    expect(parseProvenance({ format: 2 }).entries).toEqual({})
    expect(parseProvenance('nonsense').entries).toEqual({})
  })

  it('reads a well-formed document back', () => {
    const state = parseProvenance(JSON.parse(JSON.stringify(bundleInstall())))
    expect(state.entries['npm:@scope/dsh-memory@0.6.11']).toEqual({
      id: 'npm:@scope/dsh-memory@0.6.11',
      spec: 'npm:@scope/dsh-memory@0.6.11',
      resolvedVersion: '0.6.11',
      sources: [{ kind: 'bundle', bundleId: 'fin-analyst-workstation', version: '1.2.0', at: AT }],
    })
  })

  it('drops only the malformed source, not the whole document', () => {
    const state = parseProvenance({
      format: 1,
      entries: {
        'npm:pkg': {
          spec: 'npm:pkg',
          resolvedVersion: null,
          sources: [{ kind: 'bundle' }, { kind: 'manual', at: AT }],
        },
      },
    })
    expect(state.entries['npm:pkg']?.sources).toEqual([{ kind: 'manual', at: AT }])
  })

  it('drops an entry whose spec is missing', () => {
    const state = parseProvenance({
      format: 1,
      entries: { 'npm:pkg': { sources: [{ kind: 'manual', at: AT }] } },
    })
    expect(state.entries).toEqual({})
  })
})

describe('recordBundleInstall', () => {
  it('creates an entry keyed by the normalized identity', () => {
    const state = bundleInstall()
    expect(Object.keys(state.entries)).toEqual(['npm:@scope/dsh-memory@0.6.11'])
  })

  it('does not mutate the input state', () => {
    const before = emptyProvenance()
    bundleInstall(before)
    expect(before.entries).toEqual({})
  })

  it('rewrites the same bundle instead of duplicating it', () => {
    const twice = bundleInstall(bundleInstall())
    expect(twice.entries['npm:@scope/dsh-memory@0.6.11']?.sources).toHaveLength(1)
  })

  it('keeps a second bundle as a separate source', () => {
    const first = bundleInstall(emptyProvenance(), 'other-suite', '2.0.0')
    const state = bundleInstall(first)
    const sources = state.entries['npm:@scope/dsh-memory@0.6.11']?.sources ?? []
    expect(sources.map((source) => source.kind === 'bundle' && source.bundleId)).toEqual([
      'other-suite',
      'fin-analyst-workstation',
    ])
  })

  it('keeps an earlier resolved version when the host reports none', () => {
    const first = bundleInstall()
    const second = recordBundleInstall(first, {
      id: 'npm:@scope/dsh-memory@0.6.11',
      spec: 'npm:@scope/dsh-memory@0.6.11',
      resolvedVersion: null,
      bundleId: 'fin-analyst-workstation',
      bundleVersion: '1.2.1',
      now: AT,
    })
    expect(second.entries['npm:@scope/dsh-memory@0.6.11']?.resolvedVersion).toBe('0.6.11')
    expect(second.entries['npm:@scope/dsh-memory@0.6.11']?.sources).toEqual([
      { kind: 'bundle', bundleId: 'fin-analyst-workstation', version: '1.2.1', at: AT },
    ])
  })

  it('never discards an existing manual source', () => {
    const manual = recordManualInstall(emptyProvenance(), { id: 'npm:@scope/dsh-memory@0.6.11', spec: 'npm:pkg', now: AT })
    const state = bundleInstall(manual)
    expect(hasManualSource(state.entries['npm:@scope/dsh-memory@0.6.11'])).toBe(true)
  })
})

describe('recordManualInstall', () => {
  it('adds the manual source once', () => {
    const once = recordManualInstall(emptyProvenance(), { id: 'npm:pkg', spec: 'npm:pkg', now: AT })
    const twice = recordManualInstall(once, { id: 'npm:pkg', spec: 'npm:pkg', now: AT })
    expect(twice.entries['npm:pkg']?.sources).toHaveLength(1)
    // Same object back: the caller uses identity to skip a pointless write.
    expect(twice).toBe(once)
  })

  it('keeps the spec the bundle recorded', () => {
    const state = recordManualInstall(bundleInstall(), {
      id: 'npm:@scope/dsh-memory@0.6.11',
      spec: 'npm:something-else',
      now: AT,
    })
    expect(state.entries['npm:@scope/dsh-memory@0.6.11']?.spec).toBe('npm:@scope/dsh-memory@0.6.11')
  })
})

describe('installedBundles', () => {
  const withSources = (sources: Record<string, string[]>) => {
    let state = emptyProvenance()
    for (const [id, bundleIds] of Object.entries(sources)) {
      for (const bundleId of bundleIds) {
        state = recordBundleInstall(state, {
          id, spec: id, resolvedVersion: null, bundleId, bundleVersion: '1.0.0', now: '2026-11-01T00:00:00.000Z',
        })
      }
    }
    return state
  }

  it('lists a bundle the user installed', () => {
    expect([...installedBundles(withSources({ 'npm:a': ['fin'] })).keys()]).toEqual(['fin'])
  })

  it('keeps a PARTLY installed bundle, which is the point of the view', () => {
    const state = withSources({ 'npm:a': ['fin'], 'npm:b': ['other'] })
    expect([...installedBundles(state).keys()].sort()).toEqual(['fin', 'other'])
  })

  it('drops a bundle once its last member is forgotten', () => {
    let state = withSources({ 'npm:a': ['fin'] })
    state = forgetBundleSource(state, { id: 'npm:a', bundleId: 'fin' })
    expect(installedBundles(state).size).toBe(0)
  })

  it('ignores a hand-installed plugin', () => {
    // A plugin present by hand says nothing about which suite was installed.
    let state = recordManualInstall(emptyProvenance(), { id: 'npm:x', spec: 'npm:x', now: '2026-11-01T00:00:00.000Z' })
    expect(installedBundles(state).size).toBe(0)
  })
})

describe('forgetBundleSource', () => {
  it('drops the entry when its last source goes away', () => {
    const state = forgetBundleSource(bundleInstall(), {
      id: 'npm:@scope/dsh-memory@0.6.11',
      bundleId: 'fin-analyst-workstation',
    })
    expect(state.entries).toEqual({})
  })

  it('keeps a manual entry that loses its bundle source', () => {
    const manual = recordManualInstall(bundleInstall(), {
      id: 'npm:@scope/dsh-memory@0.6.11',
      spec: 'npm:@scope/dsh-memory@0.6.11',
      now: AT,
    })
    const state = forgetBundleSource(manual, {
      id: 'npm:@scope/dsh-memory@0.6.11',
      bundleId: 'fin-analyst-workstation',
    })
    expect(state.entries['npm:@scope/dsh-memory@0.6.11']?.sources).toEqual([{ kind: 'manual', at: AT }])
  })

  it('returns the same state when nothing matches', () => {
    const state = emptyProvenance()
    expect(forgetBundleSource(state, { id: 'npm:pkg', bundleId: 'x' })).toBe(state)
  })
})
