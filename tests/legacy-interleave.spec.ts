/**
 * Legacy provenance adoption: two interleavings that silently lost claims.
 *
 * Both come from the same mistake — the adoption promise was created only AFTER
 * awaiting the legacy file, and the waiting branch returned an empty state
 * instead of re-reading what had since been written.
 *
 *   1. Two readers both see `adopting === undefined`, both read the legacy
 *      file, and the slower one writes LAST — after an update has committed.
 *      The update's claim is erased.
 *   2. A reader that sees `adopting` waits for it, then falls through to
 *      `return emptyProvenance()` without re-reading the canonical file. A
 *      claim committed during the migration is invisible to it.
 *
 * The fix creates the promise synchronously and always re-reads the canonical
 * file after waiting.
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

/** One claim, for seeding. */
function withClaim(state: ProvenanceState, id: string): ProvenanceState {
  return recordBundleInstall(state, {
    id, spec: id, resolvedVersion: '1.0.0',
    bundleId: 'b', bundleVersion: '1.0.0', now: '2026-01-01T00:00:00.000Z',
  })
}

/**
 * A FileSystem over the real one, with a controllable delay on the legacy read.
 *
 * `onLegacyRead` runs at the START of the delayed read, which is how a test
 * forces two readers to overlap in the window that used to be unprotected.
 */
function fsWithLegacyDelay(delayMs: number, onLegacyRead?: () => void): FileSystem {
  return {
    async readText(path) {
      if (path.includes('.dsh-suites-store')) {
        onLegacyRead?.()
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      try {
        return (await read(path, 'utf8')) as string
      } catch {
        return undefined
      }
    },
    async writeAtomic(path, content) {
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

/** A temp profile containing a legacy state.json with `npm:old`. */
async function profileWithLegacy(): Promise<string> {
  const dir = join(tmpdir(), `legacy-interleave-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(join(dir, '.dsh-suites-store'), { recursive: true })
  const legacy = withClaim({ format: 1, entries: {} }, 'npm:old@1.0.0')
  await writeFile(join(dir, '.dsh-suites-store', 'state.json'), JSON.stringify(legacy, null, 2), 'utf8')
  return dir
}

const entriesOf = (state: ProvenanceState) => Object.keys(state.entries).sort()

describe('legacy adoption interleavings', () => {
  it('does not let a slow second reader overwrite a committed claim', async () => {
    // TWO readers start before either can set the adoption promise. The second
    // one is slow, so its adoption write lands last.
    const dir = await profileWithLegacy()
    let legacyReads = 0
    const store = createFileInstallStore(dir, fsWithLegacyDelay(30, () => { legacyReads += 1 }))

    const first = store.readProvenance()
    const second = store.readProvenance()
    // A queued write commits while both readers are still reading.
    await store.updateProvenance((current) => withClaim(current, 'npm:new@1.0.0'))
    await Promise.all([first, second])

    const final = JSON.parse(await readFile(join(dir, STATE_DIRECTORY, 'state.json'), 'utf8')) as ProvenanceState
    expect(entriesOf(final)).toEqual(['npm:new@1.0.0', 'npm:old@1.0.0'])
    // And the migration really was shared: one legacy read, not two.
    expect(legacyReads).toBe(1)
  })

  it('a reader that waits for an in-flight adoption returns real state, not empty', async () => {
    // The waiting branch used to fall through to `return emptyProvenance()`
    // instead of re-reading the canonical file, so a caller that joined an
    // in-flight migration saw "no provenance at all" — every plugin then read
    // as unowned. The assertion is deliberately about the WAITING reader: the
    // first reader triggered the adoption, so only the second exercises it.
    const dir = await profileWithLegacy()
    let legacyReads = 0
    const store = createFileInstallStore(dir, fsWithLegacyDelay(40, () => { legacyReads += 1 }))

    const trigger = store.readProvenance()
    // Give the trigger a head start so `adopting` is already set.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const joiner = store.readProvenance()

    const [first, second] = await Promise.all([trigger, joiner])
    expect(entriesOf(first)).toEqual(['npm:old@1.0.0'])
    // This is the regression: not empty.
    expect(entriesOf(second)).toEqual(['npm:old@1.0.0'])
    expect(legacyReads).toBe(1)
  })

  it('adoption persists so a later read is not empty', async () => {
    // The one-time-write contract the earlier state-directory test pins.
    const dir = await profileWithLegacy()
    const store = createFileInstallStore(dir)
    expect(entriesOf(await store.readProvenance())).toEqual(['npm:old@1.0.0'])
    expect(entriesOf(await store.readProvenance())).toEqual(['npm:old@1.0.0'])
  })
})
