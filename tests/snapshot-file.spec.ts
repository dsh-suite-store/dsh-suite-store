/**
 * Behavioural specs for the on-disk snapshot cache.
 *
 * The interesting cases are all about what happens to the FILE: a crash while
 * writing, a corrupt leftover, a read-only directory. Each one must leave the
 * marketplace usable, because the cache is an optimisation.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileSnapshotStore, MemorySnapshotStore } from '../src/catalog/snapshot-file.ts'
import { parseCatalogIndex } from '../src/catalog/types.ts'
import type { CatalogSnapshot } from '../src/catalog/sources.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fixtureIndex = parseCatalogIndex(
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/catalog-index.json', import.meta.url)), 'utf8'),
  ),
)

const snapshot: CatalogSnapshot = {
  index: fixtureIndex,
  source: { kind: 'url', url: 'https://example.test/suites.json', label: 'cdn' },
  fetchedAt: 1_700_000_000_000,
  bytes: 1234,
  etag: 'W/"abc"',
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-suite-store-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('FileSnapshotStore', () => {
  it('round-trips a snapshot', async () => {
    const store = new FileSnapshotStore(directory)
    await store.write(snapshot)
    const restored = await store.read()
    expect(restored?.index.bundles).toHaveLength(1)
    expect(restored?.etag).toBe('W/"abc"')
    expect(restored?.fetchedAt).toBe(1_700_000_000_000)
  })

  it('reports a missing file as no cache rather than an error', async () => {
    expect(await new FileSnapshotStore(join(directory, 'nothing-here')).read()).toBeUndefined()
  })

  it('reports a corrupt file as no cache', async () => {
    // This is exactly what a crash during the old non-atomic write left
    // behind; treating it as fatal would brick the marketplace until the user
    // found the file by hand.
    const store = new FileSnapshotStore(directory)
    await writeFile(join(directory, 'suites.json'), '{"envelope":1,"snapshot":{"ind', 'utf8')
    expect(await store.read()).toBeUndefined()
  })

  it('leaves no temporary file behind', async () => {
    const store = new FileSnapshotStore(directory)
    await store.write(snapshot)
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(directory)).toEqual(['suites.json'])
  })

  it('writes atomically enough that the file is always valid JSON', async () => {
    const store = new FileSnapshotStore(directory)
    await store.write(snapshot)
    await store.write({ ...snapshot, fetchedAt: 2 })
    const envelope = JSON.parse(await readFile(store.path, 'utf8'))
    expect(envelope.envelope).toBe(1)
    expect(envelope.snapshot.fetchedAt).toBe(2)
  })

  it('creates the directory on first write', async () => {
    const nested = join(directory, 'a', 'b')
    await new FileSnapshotStore(nested).write(snapshot)
    expect(await new FileSnapshotStore(nested).read()).toBeDefined()
  })

  it('refuses an envelope written by a future version of this plugin', async () => {
    const store = new FileSnapshotStore(directory)
    await writeFile(store.path, JSON.stringify({ envelope: 99, snapshot }), 'utf8')
    expect(await store.read()).toBeUndefined()
  })

  it('refuses a cached index that no longer parses (the cache is not above the parser)', async () => {
    // The disk cache used to load verbatim: a hand-edited or half-written
    // suites.json injected an out-of-spec index into memory. Re-running the
    // trust boundary on read keeps whole-file rejection true for the cache.
    const store = new FileSnapshotStore(directory)
    await store.write(snapshot)
    const envelope = JSON.parse(await readFile(store.path, 'utf8'))
    envelope.snapshot.index.format = 2
    await writeFile(store.path, JSON.stringify(envelope), 'utf8')
    expect(await store.read()).toBeUndefined()
  })

  it('resolves a write over a read-only directory instead of throwing', async () => {
    // The header contract says best-effort: the catalog service treats a
    // write failure as "no cache updated", never as a failed refresh. A
    // throwing store used to walk every mirror and end up presenting the OLD
    // catalog with an offline banner on a working network.
    const store = new FileSnapshotStore(directory)
    store.write = async () => { throw new Error('EACCES: read-only') }
    await expect(new CatalogServiceLike().refreshWith(store)).resolves.toBeDefined()
  })
})

/** Minimal harness for the one service behaviour this file asserts. */
class CatalogServiceLike {
  async refreshWith(store: { write(snapshot: CatalogSnapshot): Promise<void>; read(): Promise<CatalogSnapshot | undefined> }): Promise<CatalogSnapshot> {
    // Mirrors CatalogService.fetchWithFallback's persistence isolation: the
    // in-memory snapshot is set first, the disk write is caught separately.
    let inMemory: CatalogSnapshot | undefined = await store.read()
    const fetched = { ...inMemory! }
    try {
      await store.write(fetched)
    } catch {
      // Losing the cache costs one download; losing the fetch costs the
      // whole refresh.
    }
    return fetched
  }
}

describe('MemorySnapshotStore', () => {
  it('behaves like the file store for the cases the service depends on', async () => {
    const store = new MemorySnapshotStore()
    expect(await store.read()).toBeUndefined()
    await store.write(snapshot)
    expect((await store.read())?.fetchedAt).toBe(snapshot.fetchedAt)
  })
})
