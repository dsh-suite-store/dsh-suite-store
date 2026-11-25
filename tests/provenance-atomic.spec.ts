/**
 * `updateProvenance()` must be a single critical section.
 *
 * The report's remaining race: reconcile re-READ provenance, then merged and
 * wrote it. An install that completed between those two calls had its claim
 * erased by the stale merge — the member came back as permanent `manual` and
 * could no longer be uninstalled with its suite.
 *
 * The fix moves the read INSIDE the store's queue, so a queued updater always
 * sees what the previous writer committed. The test uses the real interleaving:
 * writer A pauses mid-update, writer B is queued behind it, then A resumes.
 * A's derived state must include only what existed when A read; B's must see
 * A's committed claim. A plain read/write pair loses it; the queue keeps it.
 */
import { describe, expect, it } from 'vitest'

import {
  createFileInstallStore,
  createMemoryInstallStore,
  type InstallStore,
} from '../src/install/store.ts'
import { recordBundleInstall, emptyProvenance } from '../src/install/state.ts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const claim = (state: Parameters<typeof recordBundleInstall>[0], id: string) =>
  recordBundleInstall(state, {
    id,
    spec: id,
    resolvedVersion: '1.0.0',
    bundleId: 'deck',
    bundleVersion: '1.0.0',
    now: '2026-01-01T00:00:00.000Z',
  })

async function interleavedWrites(store: InstallStore) {
  let releaseA: (() => void) | undefined
  const gateA = new Promise<void>((resolve) => { releaseA = resolve })
  let aEntered: (() => void) | undefined
  const sawA = new Promise<void>((resolve) => { aEntered = resolve })

  // Writer A enters the critical section, reads, then pauses BEFORE writing.
  const a = store.updateProvenance(async (current) => {
    aEntered?.()
    await gateA
    return claim(current, 'npm:from-a')
  })
  await sawA

  // B is QUEUED behind A — it cannot read until A commits. Calling without
  // awaiting is deliberate: awaiting here would deadlock, since A is waiting
  // for the release that comes after this line.
  const b = store.updateProvenance((current) => {
    // The assertion lives inside the updater: B must see A's committed claim.
    expect(Object.keys(current.entries)).toContain('npm:from-a')
    return claim(current, 'npm:from-b')
  })

  releaseA?.()
  await Promise.all([a, b])
  return store.readProvenance()
}

describe('updateProvenance serializes read-modify-write', () => {
  it('keeps both claims in the memory store', async () => {
    const state = await interleavedWrites(createMemoryInstallStore(emptyProvenance()))
    expect(Object.keys(state.entries).sort()).toEqual(['npm:from-a', 'npm:from-b'])
  })

  it('keeps both claims in the file store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prov-atomic-'))
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    const state = await interleavedWrites(createFileInstallStore(dir))
    expect(Object.keys(state.entries).sort()).toEqual(['npm:from-a', 'npm:from-b'])
  })

  it('does not wedge the queue when one updater throws', async () => {
    const store = createMemoryInstallStore(emptyProvenance())
    await expect(store.updateProvenance(() => { throw new Error('disk full') })).rejects.toThrow('disk full')
    // A rejected updater must not poison `tail`: the next write still runs.
    await store.updateProvenance((current) => claim(current, 'npm:after-failure'))
    expect(Object.keys((await store.readProvenance()).entries)).toEqual(['npm:after-failure'])
  })

  it('skips the write when the updater returns the same object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prov-noop-'))
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    const store = createFileInstallStore(dir)
    const before = await store.readProvenance()
    await store.updateProvenance((current) => current)
    expect(await store.readProvenance()).toStrictEqual(before)
  })
})
