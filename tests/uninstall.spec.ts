import { describe, expect, it } from 'vitest'

import { planUninstall, type RemovableEntry } from '../src/install/uninstall.ts'
import { recordBundleInstall, recordManualInstall, emptyProvenance, type ProvenanceState } from '../src/install/state.ts'

const AT = '2026-11-11T00:00:00.000Z'

function bundleSource(bundleId: string, version = '1.0.0') {
  return { kind: 'bundle' as const, bundleId, version, at: AT }
}

function stateWith(entries: Array<{ id: string; sources: Parameters<typeof recordBundleInstall>[1]['id'] extends never ? never : Array<'manual' | string> }>) {
  let state: ProvenanceState = emptyProvenance()
  for (const entry of entries) {
    for (const source of entry.sources) {
      state = source === 'manual'
        ? recordManualInstall(state, { id: entry.id, spec: `npm:${entry.id}`, now: AT })
        : recordBundleInstall(state, {
            id: entry.id,
            spec: `npm:${entry.id}@1.0.0`,
            resolvedVersion: '1.0.0',
            bundleId: source,
            bundleVersion: '1.0.0',
            now: AT,
          })
    }
  }
  return state
}

function installed(...ids: string[]): RemovableEntry[] {
  return ids.map((id) => ({ id, version: '1.0.0' }))
}

describe('uninstall planning', () => {
  it('pre-checks a member that only this bundle brought in', () => {
    const state = stateWith([{ id: 'npm:alpha', sources: ['fin'] }])
    const plan = planUninstall({ bundleId: 'fin', installed: installed('npm:alpha'), provenance: state })
    expect(plan).toEqual([
      { id: 'npm:alpha', checked: true, reason: 'only-source' },
    ])
  })

  it('pre-checks a hand-installed member but keeps the manual label', () => {
    const state = stateWith([{ id: 'npm:alpha', sources: ['fin', 'manual'] }])
    const plan = planUninstall({ bundleId: 'fin', installed: installed('npm:alpha'), provenance: state })
    expect(plan).toEqual([
      { id: 'npm:alpha', checked: true, reason: 'manual' },
    ])
  })

  it('pre-checks a shared member but names the other bundle', () => {
    const state = stateWith([{ id: 'npm:alpha', sources: ['fin', 'other'] }])
    const plan = planUninstall({ bundleId: 'fin', installed: installed('npm:alpha'), provenance: state })
    expect(plan).toEqual([
      { id: 'npm:alpha', checked: true, reason: 'shared', sharedWith: ['other'] },
    ])
  })

  it('pre-checks a plugin the bundle uses but did not install', () => {
    const state = stateWith([{ id: 'npm:alpha', sources: ['manual'] }])
    const plan = planUninstall({ bundleId: 'fin', installed: installed('npm:alpha'), provenance: state })
    expect(plan).toEqual([
      { id: 'npm:alpha', checked: true, reason: 'manual' },
    ])
  })

  it('pre-checks a member whose provenance record refers to a gone plugin', () => {
    const state = stateWith([{ id: 'npm:gone', sources: ['fin'] }])
    const plan = planUninstall({ bundleId: 'fin', installed: installed('npm:alpha'), provenance: state })
    expect(plan).toEqual([{ id: 'npm:alpha', checked: true, reason: 'unknown' }])
  })

  it('pre-checks an installed plugin with no provenance at all', () => {
    const plan = planUninstall({
      bundleId: 'fin',
      installed: installed('npm:alpha'),
      provenance: emptyProvenance(),
    })
    expect(plan).toEqual([{ id: 'npm:alpha', checked: true, reason: 'unknown' }])
  })

  it('keeps the caller order so the dialog matches the member table', () => {
    const state = stateWith([
      { id: 'npm:beta', sources: ['fin'] },
      { id: 'npm:alpha', sources: ['fin'] },
    ])
    const plan = planUninstall({
      bundleId: 'fin',
      installed: installed('npm:alpha', 'npm:beta'),
      provenance: state,
    })
    expect(plan.map((entry) => entry.id)).toEqual(['npm:alpha', 'npm:beta'])
  })

  it('never checks an entry twice for the same bundle source', () => {
    const state = stateWith([{ id: 'npm:alpha', sources: ['fin', 'fin'] }])
    const plan = planUninstall({ bundleId: 'fin', installed: installed('npm:alpha'), provenance: state })
    expect(plan[0]?.checked).toBe(true)
    expect(plan[0]?.reason).toBe('only-source')
  })

  // Reproduced from the live profile: one plugin held TWO records, one keyed
  // by the spec the install wrote and one by the bare name `reconcile()`
  // wrote from the host's report. An exact-key lookup found neither, so a
  // member the suite had just installed was offered as `unknown` — the one
  // answer that tells the user it is not the bundle's to remove.
  it('finds a member recorded under a different spelling of its identity', () => {
    let state = recordBundleInstall(emptyProvenance(), {
      id: 'npm:billion-context@0.1.213',
      spec: 'npm:billion-context@0.1.213',
      resolvedVersion: null,
      bundleId: 'acceptance-run',
      bundleVersion: '0.1.0',
      now: AT,
    })
    state = recordManualInstall(state, { id: 'billion-context', spec: 'billion-context', now: AT })
    const plan = planUninstall({
      bundleId: 'acceptance-run',
      installed: installed('npm:billion-context@0.1.213'),
      provenance: state,
    })
    // The manual source is still reported as an advisory label, but it no
    // longer silently excludes the member from the one-click removal.
    expect(plan[0]).toEqual({ id: 'npm:billion-context@0.1.213', checked: true, reason: 'manual' })
  })

  it('merges a bundle claim with a bare-name record of the same plugin', () => {
    let state = recordBundleInstall(emptyProvenance(), {
      id: 'npm:alpha@1.0.0',
      spec: 'npm:alpha@1.0.0',
      resolvedVersion: '1.0.0',
      bundleId: 'fin',
      bundleVersion: '1.0.0',
      now: AT,
    })
    state = recordBundleInstall(state, {
      id: 'alpha',
      spec: 'alpha',
      resolvedVersion: '1.0.0',
      bundleId: 'fin',
      bundleVersion: '1.0.0',
      now: AT,
    })
    const plan = planUninstall({ bundleId: 'fin', installed: installed('npm:alpha@1.0.0'), provenance: state })
    // Two spellings of ONE bundle source is still exactly one source: counting
    // it twice would have been the only way to reach "shared with itself".
    expect(plan[0]?.checked).toBe(true)
    expect(plan[0]?.reason).toBe('only-source')
  })
})
