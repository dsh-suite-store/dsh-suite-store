/**
 * Where the catalog snapshot lives on disk.
 *
 * The snapshot is a cache, never a source of truth: losing it costs one
 * download, so it is written best-effort (a read-only profile directory must
 * not break the marketplace) and replaced atomically so a crash mid-write
 * cannot leave a half-JSON file that makes the next start look like a
 * corrupt catalog.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CatalogSnapshot, SnapshotStore } from './sources.ts'
import { parseCatalogIndex } from './types.ts'

/** File name inside the store directory; also what a user can delete to reset. */
const FILE_NAME = 'suites.json'

/** Version of the on-disk envelope, independent of the catalog's own format. */
const ENVELOPE_VERSION = 1

/**
 * A `SnapshotStore` backed by one JSON file.
 *
 * `directory` is injected rather than derived from `import.meta.url` so a test
 * can point it at a temp dir and so the host can put it under the profile's
 * cache folder on the next platform.
 */
export class FileSnapshotStore implements SnapshotStore {
  private readonly file: string

  constructor(directory: string) {
    this.file = join(directory, FILE_NAME)
  }

  /** The file a user would delete to force a refetch. */
  get path(): string {
    return this.file
  }

  async read(): Promise<CatalogSnapshot | undefined> {
    try {
      const text = await readFile(this.file, 'utf8')
      const envelope = JSON.parse(text) as Record<string, unknown>
      // The envelope version is separate from `format` so the cache layout can
      // change without the catalog document having to.
      if (envelope.envelope !== ENVELOPE_VERSION) return undefined
      const snapshot = envelope.snapshot as Partial<CatalogSnapshot> | null | undefined
      // `index` is not the only field a consumer reads directly: `descriptor()`
      // switches on `source.kind` and throws on `undefined`, and the page
      // prints `fetchedAt`. An invalid cache is no cache, so the whole file is
      // rejected rather than handed on with one field checked.
      if (snapshot === null || typeof snapshot !== 'object') return undefined
      if (snapshot.index === undefined || snapshot.source === undefined) return undefined
      if (typeof snapshot.fetchedAt !== 'number' || typeof snapshot.bytes !== 'number') return undefined
      // The disk cache is data this plugin once read off the network, and it
      // is the one copy no parser has ever seen: a hand-edited, half-written
      // or pre-parser `suites.json` previously loaded verbatim into memory.
      // Re-running the trust boundary here keeps "a whole-file reject" true
      // for the cached generation too — an invalid cache is no cache.
      const index = parseCatalogIndex(snapshot.index)
      return {
        ...snapshot,
        index,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
        bytes: snapshot.bytes,
      } as CatalogSnapshot
    } catch {
      // Missing, unreadable, half-written or out-of-spec: all four mean "no
      // cache", and the next fetch rebuilds it.
      return undefined
    }
  }

  async write(snapshot: CatalogSnapshot): Promise<void> {
    // Best-effort by contract: the catalog service treats a write failure as
    // "no cache updated", never as a failed refresh. Throwing here used to
    // make a read-only profile directory walk every mirror and end up
    // presenting the OLD catalog with an offline banner on a working network.
    try {
      const text = JSON.stringify({ envelope: ENVELOPE_VERSION, snapshot })
      // A per-write suffix, not just the pid: two stores over one directory (or
      // two overlapping writes in one process) shared a temp path, so their
      // `writeFile`s interleaved and one `rename` could publish the other's
      // half-written bytes — defeating the atomic replace.
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temporary, text, 'utf8')
      try {
        await rename(temporary, this.file)
      } catch {
        // Windows refuses `rename` over an open file; falling back to a direct
        // write keeps the marketplace working, at the cost of atomicity. The
        // temp file is removed FIRST so the direct write is the only thing that
        // can fail, and a stray `.tmp` next to `suites.json` — the one artefact
        // a user would find and be unable to explain — cannot be left behind.
        await rm(temporary, { force: true }).catch(() => undefined)
        await writeFile(this.file, text, 'utf8')
      }
    } catch {
      // Nothing to do: the in-memory snapshot is already serving the page.
    }
  }
}

/** In-memory store; used by tests and by a read-only profile. */
export class MemorySnapshotStore implements SnapshotStore {
  private snapshot: CatalogSnapshot | undefined

  constructor(initial?: CatalogSnapshot) {
    this.snapshot = initial
  }

  async read(): Promise<CatalogSnapshot | undefined> {
    // Returned by reference, deliberately: the service treats a snapshot as
    // immutable — it builds a new object to change `fetchedAt` — so a copy here
    // would only create the illusion that the two stores behave differently.
    // (`structuredClone` would be worse than useless: it restores the default
    // prototype, and `categories` is built with `Object.create(null)` on
    // purpose so a category named `__proto__` cannot hijack the map.)
    return this.snapshot
  }

  async write(snapshot: CatalogSnapshot): Promise<void> {
    this.snapshot = snapshot
  }
}
