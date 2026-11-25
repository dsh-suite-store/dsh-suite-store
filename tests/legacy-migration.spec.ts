/**
 * Legacy provenance adoption must not race a queued writer.
 *
 * The old code wrote the adopted state from inside `readProvenance()` — outside
 * the serialized update queue — after awaiting the legacy file. An install
 * landing in that window wrote new claims, which the adoption then overwrote.
 *
 * The fix makes readers wait out an in-flight adoption and writers wait for it
 * before reading, so the migration and the first queued write are ordered.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFile as readFileCb, writeFile as writeFileCb, mkdir as mkdirCb, rename, rm } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFileInstallStore, STATE_DIRECTORY, type FileSystem } from '../src/install/store.ts'
import { recordBundleInstall } from '../src/install/state.ts'

function legacyState() {
  return JSON.stringify(recordBundleInstall(
    { format: 1, entries: {} },
    {
      id: 'npm:old@1.0.0', spec: 'npm:old@1.0.0', resolvedVersion: '1.0.0',
      bundleId: 'old-bundle', bundleVersion: '1.0.0', now: '2026-01-01T00:00:00.000Z',
    },
  ), null, 2)
}

/** Build a FileSystem that delays reads of the legacy file, passing everything
 * else through to real node fs. */
function delayedFileSystem(delayMs: number): FileSystem {
  const read = promisify(readFileCb)
  const write = promisify(writeFileCb)
  const mk = promisify(mkdirCb)
  const renameAsync = promisify(rename)
  const rmAsync = promisify(rm)
  return {
    async readText(path) {
      if (path.includes('.dsh-suites-store')) await new Promise((r) => setTimeout(r, delayMs))
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

describe('legacy migration is serialized with writes', () => {
  it('does not lose a claim written while the migration was in flight', async () => {
    const dir = join(tmpdir(), `legacy-race-${Date.now()}`)
    await mkdir(join(dir, '.dsh-suites-store'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    await writeFile(join(dir, '.dsh-suites-store', 'state.json'), legacyState(), 'utf8')

    const store = createFileInstallStore(dir, delayedFileSystem(40))
    // The reader and the writer overlap: the migration's legacy read is slow.
    const migrated = store.readProvenance()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.updateProvenance((current) => recordBundleInstall(current, {
      id: 'npm:new@1.0.0', spec: 'npm:new@1.0.0', resolvedVersion: '1.0.0',
      bundleId: 'new-bundle', bundleVersion: '1.0.0', now: '2026-01-01T00:00:00.000Z',
    }))
    await migrated

    const final = JSON.parse(await readFile(join(dir, STATE_DIRECTORY, 'state.json'), 'utf8'))
    expect(Object.keys(final.entries).sort()).toEqual(['npm:new@1.0.0', 'npm:old@1.0.0'])
  })
})
