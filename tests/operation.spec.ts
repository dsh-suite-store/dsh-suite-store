import { describe, expect, it } from 'vitest'

import type { InstallPlan } from '../src/install/plan.ts'
import {
  concludeStatus,
  isLive,
  operationProgress,
  parseOperation,
  patchMember,
  resumableSteps,
  startOperation,
  startRemoval,
} from '../src/install/operation.ts'

const AT = '2026-11-11T00:00:00.000Z'

function plan(): InstallPlan {
  return {
    steps: [
      {
        key: 'memory',
        id: 'npm:@scope/dsh-memory@0.6.11',
        spec: 'npm:@scope/dsh-memory@0.6.11',
        pinnedVersion: '0.6.11',
        name: '@scope/dsh-memory',
        approvedBuilds: [],
      },
      {
        key: 'log',
        id: 'someone/dsh-log',
        spec: 'git:someone/dsh-log#packages/log',
        pinnedVersion: null,
        name: 'someone/dsh-log',
        approvedBuilds: [],
      },
    ],
    skipped: [{ key: 'canvas', reason: 'already-installed' }],
  }
}

function operation() {
  return startOperation({
    opId: 'op-1',
    bundleId: 'fin-analyst-workstation',
    bundleVersion: '1.2.0',
    hostKind: 'cli',
    plan: plan(),
    now: AT,
  })
}

describe('startOperation', () => {
  it('mirrors the plan: skipped members marked, the rest pending', () => {
    const record = operation()
    expect(record.members.map((member) => [member.key, member.state])).toEqual([
      ['canvas', 'skipped'],
      ['memory', 'pending'],
      ['log', 'pending'],
    ])
    expect(record.status).toBe('queued')
  })

  it('counts live, done, skipped and pending members', () => {
    expect(operationProgress(operation())).toEqual({ total: 3, done: 0, failed: 0, skipped: 1, pending: 2 })
  })
})

describe('isLive', () => {
  it('treats in-flight statuses as live and finished ones as history', () => {
    expect(isLive(operation())).toBe(true)
    for (const status of ['done', 'partial', 'blocked', 'cancelled'] as const) {
      expect(isLive({ ...operation(), status })).toBe(false)
    }
  })
})

describe('patchMember', () => {
  it('replaces one member without touching the others', () => {
    const patched = patchMember(operation(), 'memory', { state: 'ok', resolvedVersion: '0.6.11' })
    expect(patched.members.find((member) => member.key === 'memory')).toMatchObject({
      state: 'ok',
      resolvedVersion: '0.6.11',
    })
    expect(patched.members[0]).toEqual(operation().members[0])
  })

  it('returns the same record for an unknown key', () => {
    const record = operation()
    expect(patchMember(record, 'nope', { state: 'ok' })).toBe(record)
  })
})

describe('concludeStatus', () => {
  it('is done when nothing failed and nothing is pending', () => {
    let record = patchMember(operation(), 'memory', { state: 'ok' })
    record = patchMember(record, 'log', { state: 'skipped-build-denied' })
    expect(concludeStatus(record)).toBe('done')
  })

  it('is partial when any member failed', () => {
    let record = patchMember(operation(), 'memory', { state: 'ok' })
    record = patchMember(record, 'log', {
      state: 'failed',
      failure: { key: 'log', phase: 'add', type: 'install-failed', reason: 'boom' },
    })
    expect(concludeStatus(record)).toBe('partial')
  })

  it('is partial while a member is still pending', () => {
    expect(concludeStatus(patchMember(operation(), 'memory', { state: 'ok' }))).toBe('partial')
  })

  it('reports cancelled even when every member happened to succeed', () => {
    let record = patchMember(operation(), 'memory', { state: 'ok' })
    record = patchMember(record, 'log', { state: 'ok' })
    expect(concludeStatus({ ...record, cancelRequested: true })).toBe('cancelled')
  })
})

describe('resumableSteps', () => {
  it('returns pending and failed steps in plan order', () => {
    let record = patchMember(operation(), 'memory', {
      state: 'failed',
      failure: { key: 'memory', phase: 'add', type: 'install-failed', reason: 'boom' },
    })
    record = patchMember(record, 'log', { state: 'pending' })
    expect(resumableSteps(record, plan()).map((step) => step.key)).toEqual(['memory', 'log'])
  })

  it('never retries a member whose build scripts the user denied', () => {
    let record = patchMember(operation(), 'memory', { state: 'skipped-build-denied' })
    record = patchMember(record, 'log', { state: 'failed' })
    expect(resumableSteps(record, plan()).map((step) => step.key)).toEqual(['log'])
  })
})

describe('parseOperation', () => {
  it('round-trips a record through JSON', () => {
    const record = patchMember(operation(), 'memory', { state: 'ok', phase: 'record', resolvedVersion: '0.6.11' })
    expect(parseOperation(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('rejects something that is not a record', () => {
    expect(parseOperation(null)).toBeUndefined()
    expect(parseOperation({ opId: 'x', bundleId: 'y', status: 'nonsense', members: [] })).toBeUndefined()
  })

  it('drops members it cannot read and keeps the rest', () => {
    const parsed = parseOperation({
      opId: 'op-1',
      bundleId: 'b',
      status: 'partial',
      members: [{ key: 'a' }, { key: 'b', state: 'ok' }],
    })
    expect(parsed?.members).toEqual([{ key: 'b', id: '', name: '', state: 'ok' }])
  })

  it('keeps a removal marked as one, and never invents the mark for an install', () => {
    // A record written before removals existed has no `kind`. Reading it as
    // anything but an install would rewrite history, and writing the field back
    // would claim its author made a choice they never made.
    const install = parseOperation(JSON.parse(JSON.stringify(operation())))
    expect(install?.kind).toBeUndefined()
    const bad = parseOperation({ ...JSON.parse(JSON.stringify(operation())), kind: 'delete' })
    expect(bad?.kind).toBeUndefined()

    const removal = startRemoval({
      opId: 'op-2', bundleId: 'fin', bundleVersion: '1.0.0', hostKind: 'desktop',
      ids: ['npm:alpha@1.0.0'], now: AT,
    })
    expect(parseOperation(JSON.parse(JSON.stringify(removal)))?.kind).toBe('uninstall')
  })

  it('keeps a removal failure through the parse', () => {
    const record = patchMember(startRemoval({
      opId: 'op-2', bundleId: 'fin', bundleVersion: '1.0.0', hostKind: 'desktop',
      ids: ['npm:alpha'], now: AT,
    }), 'npm:alpha', {
      state: 'failed',
      failure: { key: 'npm:alpha', phase: 'remove', type: 'remove-failed', reason: 'bundle-in-use' },
    })
    const parsed = parseOperation(JSON.parse(JSON.stringify(record)))
    expect(parsed?.members[0]).toEqual(record.members[0])
    expect(parsed?.members[0]?.failure?.type).toBe('remove-failed')
  })
})

describe('startRemoval', () => {
  it('builds a record the progress panel can draw without an install plan', () => {
    // A removal has no plan: nothing to resolve, no build approval, no member
    // that can be already installed. What it does share with an install is the
    // SHAPE the panel reads, so the record is built straight from the ids.
    const record = startRemoval({
      opId: 'op-9', bundleId: 'fin', bundleVersion: '1.0.0', hostKind: 'desktop',
      ids: ['npm:alpha@1.0.0', 'git:someone/dsh-log#packages/log'], now: AT,
    })
    expect(record.kind).toBe('uninstall')
    expect(record.status).toBe('queued')
    expect(record.members.map((member) => member.key)).toEqual([
      'npm:alpha@1.0.0',
      'git:someone/dsh-log#packages/log',
    ])
    // The row shows a readable name, not the spec: a removal targets the plugin
    // and there is no catalog member to borrow a friendlier one from.
    expect(record.members[0]?.name).toBe('alpha')
    expect(record.members.every((member) => member.state === 'pending')).toBe(true)
    expect(operationProgress(record)).toEqual({ total: 2, done: 0, failed: 0, skipped: 0, pending: 2 })
    expect(isLive(record)).toBe(true)
  })

  it('concludes as done once every removal succeeded', () => {
    let record = startRemoval({
      opId: 'op-9', bundleId: 'fin', bundleVersion: '1.0.0', hostKind: 'desktop',
      ids: ['npm:alpha', 'npm:beta'], now: AT,
    })
    record = patchMember(record, 'npm:alpha', { state: 'ok', phase: 'remove' })
    record = patchMember(record, 'npm:beta', { state: 'ok', phase: 'remove' })
    expect(concludeStatus(record)).toBe('done')
  })
})
