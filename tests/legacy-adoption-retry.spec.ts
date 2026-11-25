/**
 * A failed legacy adoption must be retryable, not latched forever.
 *
 * The bug: `adoptLegacy()` swallowed a write error with `.catch(() => undefined)`
 * and kept the RESOLVED promise cached. Every later reader then saw an empty
 * state, the first `updateProvenance` wrote that empty state as canonical, and
 * the legacy claims were gone — the canonical file existed, so no restart could
 * find them again.
 *
 * The fix records the failure, retries on the next attempt, and REFUSES to write
 * while a legacy document is known to exist but has not been adopted.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  mkdir as mkdirCb,
  readFile as readFileCb,
  rename,
  rm,
  writeFile as writeFileCb,
} from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFileInstallStore, STATE_DIRECTORY, type FileSystem } from '../src/install/store.ts'
import { recordBundleInstall, type ProvenanceState } from '../src/install/state.ts'

const read = promisify(readFileCb)
const write = promisify(writeFileCb)
const mk = promisify(mkdirCb)
const renameAsync = promisify(rename)
const rmAsync = promisify(rm)

function withClaim(state: ProvenanceState, id: string): ProvenanceState {
  return recordBundleInstall(state, {
    id, spec: id, resolvedVersion: '1.0.0',
    bundleId: 'b', bundleVersion: '1.0.0', now: '2026-01-01T00:00:00.000Z',
  })
}

/** A profile whose legacy file holds `npm:old`. */
async function profileWithLegacy(): Promise<string> {
  const dir = join(tmpdir(), `legacy-latch-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(join(dir, '.dsh-suites-store'), { recursive: true })
  await writeFile(
    join(dir, '.dsh-suites-store', 'state.json'),
    JSON.stringify(withClaim({ format: 1, entries: {} }, 'npm:old@1.0.0'), null, 2),
    'utf8',
  )
  return dir
}

/**
 * A filesystem that fails the first `writeAtomic` to state.json, then works.
 *
 * Only the ADOPTION write is targeted (the first canonical write); later writes
 * succeed, so the test distinguishes "retry works" from "everything is broken".
 */
function failFirstAdoptionWrite(): FileSystem {
  let failures = 0
  return {
    async readText(path) {
      try {
        return (await read(path, 'utf8')) as string
      } catch {
        return undefined
      }
    },
    async writeAtomic(path, content) {
      if (failures === 0 && path.endsWith('state.json')) {
        failures += 1
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
      const temp = `${path}.tmp-test`
      await write(temp, content, 'utf8')
      await renameAsync(temp, path)
    },
    async mkdir(path) {
      await mk(path, { recursive: true })
    },
    async listDir() {
      return []
    },
    async remove(path) {
      await rmAsync(path, { force: true })
    },
  }
}

const entriesOf = (state: ProvenanceState) => Object.keys(state.entries).sort()

describe('a failed legacy adoption is retryable', () => {
  it('retries on the next read and eventually adopts the legacy claims', async () => {
    const dir = await profileWithLegacy()
    const store = createFileInstallStore(dir, failFirstAdoptionWrite())

    // First read: the adoption write fails. It must not take the process down,
    // and it must not report success either.
    const first = await store.readProvenance()
    expect(entriesOf(first)).toEqual([])

    // Second read: the retry succeeds, so the legacy claim IS there.
    const second = await store.readProvenance()
    expect(entriesOf(second)).toEqual(['npm:old@1.0.0'])

    // And it is on disk under the new name.
    const canonical = JSON.parse(await readFile(join(dir, STATE_DIRECTORY, 'state.json'), 'utf8')) as ProvenanceState
    expect(entriesOf(canonical)).toEqual(['npm:old@1.0.0'])
  })

  it('refuses to write while the legacy document is still unadopted', async () => {
    const dir = await profileWithLegacy()
    // Every canonical write fails, so adoption can never complete.
    const store = createFileInstallStore(dir, {
      ...failFirstAdoptionWrite(),
      async writeAtomic() {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      },
    })

    await store.readProvenance()
    // Writing now would persist a state that omits `npm:old`, and the canonical
    // file would then look authoritative forever. It must be refused.
    await expect(store.updateProvenance((current) => withClaim(current, 'npm:new@1.0.0')))
      .rejects.toThrow(/legacy provenance could not be adopted/u)

    // The legacy document is untouched, so a later successful run still finds it.
    const legacy = JSON.parse(await readFile(join(dir, '.dsh-suites-store', 'state.json'), 'utf8')) as ProvenanceState
    expect(entriesOf(legacy)).toEqual(['npm:old@1.0.0'])
  })

  it('keeps the legacy claims when an update follows a recovered adoption', async () => {
    const dir = await profileWithLegacy()
    const store = createFileInstallStore(dir, failFirstAdoptionWrite())

    await store.readProvenance() // fails once
    await store.readProvenance() // recovers
    await store.updateProvenance((current) => withClaim(current, 'npm:new@1.0.0'))

    const canonical = JSON.parse(await readFile(join(dir, STATE_DIRECTORY, 'state.json'), 'utf8')) as ProvenanceState
    expect(entriesOf(canonical)).toEqual(['npm:new@1.0.0', 'npm:old@1.0.0'])
  })

  it('rejects the FIRST operation when it is an update and adoption fails', async () => {
    // The worst ordering: canonical absent, legacy present, and the very first
    // thing the process does is an update. There is no reader to trigger the
    // migration first, so the update path itself has to enforce it — otherwise
    // it wrote a canonical file containing only the new claim, and the legacy
    // one was shadowed for good.
    const dir = await profileWithLegacy()
    const store = createFileInstallStore(dir, {
      ...failFirstAdoptionWrite(),
      async writeAtomic() {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      },
    })

    await expect(store.updateProvenance((current) => withClaim(current, 'npm:new@1.0.0')))
      .rejects.toThrow(/legacy provenance could not be adopted/u)

    // No canonical file was created, so a later successful run still migrates.
    const legacy = JSON.parse(await readFile(join(dir, '.dsh-suites-store', 'state.json'), 'utf8')) as ProvenanceState
    expect(entriesOf(legacy)).toEqual(['npm:old@1.0.0'])
  })

  it('an update retries a failed adoption instead of latching', async () => {
    // One transient write failure must not disable writes for the process's
    // whole lifetime: the update path retries the adoption itself, so a disk
    // that recovered lets the very next update succeed. Without the retry this
    // rejected with "could not be adopted" until an unrelated read happened.
    const dir = await profileWithLegacy()
    const store = createFileInstallStore(dir, failFirstAdoptionWrite())

    await store.readProvenance() // first adoption write fails
    // No further read: go straight to an update, which must retry and succeed.
    await store.updateProvenance((current) => withClaim(current, 'npm:new@1.0.0'))

    const canonical = JSON.parse(await readFile(join(dir, STATE_DIRECTORY, 'state.json'), 'utf8')) as ProvenanceState
    expect(entriesOf(canonical)).toEqual(['npm:new@1.0.0', 'npm:old@1.0.0'])
  })
})
