/**
 * The files the store keeps in `<profile>/.dsh-suite-store/` (§7.5, §7.7).
 *
 * Two documents live here: `state.json` (provenance, who installed what) and
 * `operations/<opId>.json` (one per install attempt, so a reload can resume).
 * They are small, written rarely and read at startup, so plain JSON files are
 * the whole storage engine: a database would add a dependency and a migration
 * story for two objects.
 *
 * Writes are atomic in the only way that matters here: a temporary file plus
 * a rename, so a host killed mid-write leaves the previous good document
 * rather than half of a new one. On Windows the rename can fail while another
 * process holds the target open, and losing the new record would be worse
 * than a stale one, so that specific failure falls back to overwriting in
 * place. The same trade-off is made in `snapshot-file.ts` for the catalog
 * snapshot, and for the same reason.
 *
 * A store that cannot read or write its directory never fails startup: the
 * worst case is that installs cannot be resumed, which is a smaller problem
 * than a plugin that refuses to load.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  emptyProvenance,
  parseProvenance,
  type ProvenanceState,
} from './state.ts'
import { parseOperation, type OperationRecord } from './operation.ts'

/** Directory name inside the profile; §7.8 keeps it disjoint from other plugins'. */
export const STATE_DIRECTORY = '.dsh-suite-store'

/**
 * The directory this package used before it was renamed from
 * `dsh-suites-store`. Read once, then never again.
 *
 * A rename must not cost the user their provenance: without it, plugins this
 * store installed would look hand-installed, and the next uninstall would
 * stop offering to clean up their source records.
 */
const LEGACY_STATE_DIRECTORY = '.dsh-suites-store'

/** Persists provenance and operation records. */
export interface InstallStore {
  /** @returns the last written provenance, or an empty state when none exists. */
  readProvenance(): Promise<ProvenanceState>
  /**
   * Apply an update as ONE serialized read-modify-write.
   *
   * Callers must use this — NOT `readProvenance()` followed by
   * `writeProvenance()` — when their updater depends on the current state.
   * Install, uninstall and startup reconcile all add or remove claims; a
   * separate read then write let a concurrent one's claim be overwritten, so
   * a freshly installed member came back as permanent `manual` and could no
   * longer be uninstalled with its suite. The store owns the queue, so every
   * caller in every module shares the same critical section.
   *
   * @param updater - receives the current state; its result is written. Return
   *   the SAME object to signal "no change" and skip the write.
   */
  updateProvenance(updater: (current: ProvenanceState) => ProvenanceState | Promise<ProvenanceState>): Promise<void>
  /** Overwrite provenance atomically. */
  writeProvenance(state: ProvenanceState): Promise<void>
  /** @returns the record, or undefined when the file is gone or unreadable. */
  readOperation(opId: string): Promise<OperationRecord | undefined>
  writeOperation(record: OperationRecord): Promise<void>
  /**
   * Every operation record on disk, newest first.
   *
   * Used at startup to find an install that was in flight when the host went
   * away. A record that cannot be parsed is skipped rather than repaired: the
   * only thing in it that matters is the progress it no longer describes.
   */
  listOperations(): Promise<OperationRecord[]>
  /** Remove one record; a missing file is not an error. */
  deleteOperation(opId: string): Promise<void>
  /**
   * Package names whose build scripts pnpm left undecided in the profile's
   * `pnpm-workspace.yaml`.
   *
   * The host's `approveBuilds` accepts EXACTLY these names — passing a catalog
   * member name instead is what produced `stale-approval`. The store owns the
   * profile directory, so it is the one place that can read the same file the
   * host wrote without threading a path through the whole service.
   */
  pendingBuilds(): Promise<string[]>
}

/** The value pnpm writes for a build script that still needs a decision. */
const UNDECIDED_BUILD = 'set this to true or false'

/**
 * Read the undecided build scripts from a profile's workspace file.
 *
 * A tiny line reader rather than a YAML library: pnpm and the host write this
 * one mapping with plain scalar values, and a dependency that parses all of
 * YAML is not worth its weight for four lines. A malformed file answers [] —
 * the host will report its own parse error if it cannot read the policy.
 */
export function pendingBuildsFrom(text: string): string[] {
  const names: string[] = []
  const lines = text.split('\n')
  let inBuilds = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === 'allowBuilds:') { inBuilds = true; continue }
    // A line with no leading whitespace ends the mapping.
    if (inBuilds && line.trim() !== '' && !/^\s/u.test(line)) break
    if (!inBuilds) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().replace(/^['"]|['"]$/gu, '')
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/gu, '')
    if (name !== '' && value === UNDECIDED_BUILD && !/[*?]/u.test(name)) names.push(name)
  }
  return names
}

/**
 * A store rooted at the profile directory.
 *
 * @param profileDirectory - the DSH profile root (`<profile>` in the spec).
 * @param options - overrides for the filesystem slice below. The tests use
 *   them to make a write fail without needing a real Windows file lock.
 */
export function createFileInstallStore(
  profileDirectory: string,
  options: Partial<FileSystem> = {},
): InstallStore {
  const fs: FileSystem = { ...nodeFileSystem, ...options }
  const directory = join(profileDirectory, STATE_DIRECTORY)
  const operations = join(directory, 'operations')
  const statePath = join(directory, 'state.json')

  /** Where the previous name kept its documents, for the one-time migration. */
  const legacyStatePath = join(profileDirectory, LEGACY_STATE_DIRECTORY, 'state.json')

  // The critical section is per store instance, which in production is one per
  // profile. `tail` is always resolved, so a rejected updater never leaves the
  // queue wedged for every later write.
  let tail: Promise<void> = Promise.resolve()
  // A one-time legacy migration is in flight; queued writers wait for it before
  // reading, so a migration cannot overwrite a claim committed concurrently.
  let adopting: Promise<void> | undefined
  // Set while the legacy document still exists but has NOT been adopted. A
  // transient write failure used to be swallowed by `.catch(() => undefined)`
  // and the resolved promise stayed cached, so every later reader got an EMPTY
  // state: one update then wrote that empty state over the canonical file and
  // the legacy claims were gone for good, with no restart able to find them
  // again (the file had been created).
  let adoptionPending = false

  /**
   * Adopt a legacy `state.json`, retrying after a failed write.
   *
   * The promise is created SYNCHRONOUSLY, before the first await. An earlier
   * version assigned `adopting` only after `await fs.readText(legacyStatePath)`,
   * so two concurrent readers both saw `undefined`, both read the legacy file,
   * and both wrote it — the second write landing after an update had committed
   * and erasing that update's claims.
   *
   * On failure the latch is CLEARED and the migration is retried by the next
   * caller: a disk that was momentarily full must not permanently orphan every
   * legacy claim.
   *
   * @returns the shared adoption promise.
   */
  function adoptLegacy(): Promise<void> {
    if (adopting !== undefined) return adopting
    adoptionPending = true
    adopting = (async () => {
      const inherited = await fs.readText(legacyStatePath)
      if (inherited === undefined) {
        adoptionPending = false
        return
      }
      try {
        // Validate before copying: an unparseable legacy document must not
        // become the canonical one. This is NOT retryable — the bytes are bad.
        parseProvenance(JSON.parse(inherited))
      } catch {
        adoptionPending = false
        return
      }
      await fs.mkdir(directory)
      await fs.writeAtomic(statePath, inherited)
      adoptionPending = false
      // A retry that SUCCEEDS has to clear the earlier failure, or the process
      // would refuse every write for the rest of its life after one transient
      // disk error.
      adoptLegacyFailed = false
    })().catch(() => {
      // Retryable: clear the latch so the next reader/migration attempt runs.
      adoptLegacyFailed = true
      adopting = undefined
    })
    return adopting
  }

  /** True when a legacy document is known to exist but its adoption failed. */
  let adoptLegacyFailed = false

  /**
   * Make sure a pending legacy migration is complete, or throw.
   *
   * EVERY read/write path that could persist a snapshot goes through this. A
   * plain `await adoptLegacy()` is not enough: the promise RESOLVES even when
   * the adoption write failed (the failure is recorded in `adoptLegacyFailed`),
   * so a caller that only awaited it would then read an empty state and write
   * it as canonical — permanently shadowing the legacy claims.
   *
   * A retry is attempted when a failure is on record: the disk may have
   * recovered, and an update-only workload has no reader to retry for it.
   */
  async function ensureMigration(): Promise<void> {
    if (adopting !== undefined) await adopting
    // Retry an earlier failure rather than latching this process for good.
    if (adoptLegacyFailed) await adoptLegacy()
    if (adoptLegacyFailed) {
      throw new Error('legacy provenance could not be adopted; refusing to write an incomplete state')
    }
    // A canonical file that does not exist means the migration has not run yet.
    // Checking `adoptLegacyFailed` alone was the hole: on the FIRST operation
    // nothing has failed (nothing has been attempted), so an update went
    // straight through, the migration ran inside the read and failed silently,
    // and the updater wrote a canonical file containing only its own claim.
    if (await fs.readText(statePath) === undefined) {
      await adoptLegacy()
      if (adoptLegacyFailed) {
        throw new Error('legacy provenance could not be adopted; refusing to write an incomplete state')
      }
    }
  }

  return {
    updateProvenance(updater) {
      const run = tail.then(async () => {
        // Strict: a failed migration must reject the update, not let it write a
        // canonical file that omits the legacy claims. This is the only gate
        // that can stop the FIRST operation when it happens to be an update.
        await ensureMigration()
        const current = await this.readProvenance()
        const next = await updater(current)
        if (next !== current) await this.writeProvenance(next)
      })
      // Keep the queue alive even after a rejection; the caller still sees the
      // rejection, but the NEXT update can run.
      tail = run.catch(() => undefined)
      return run
    },
    async readProvenance(): Promise<ProvenanceState> {
      let text = await fs.readText(statePath)
      if (text === undefined) {
        // First run after the rename: adopt the old file's contents, once.
        //
        // The adoption promise is created synchronously by `adoptLegacy()`, so a
        // second reader that arrives during the legacy read joins the SAME
        // promise instead of starting its own migration.
        //
        // After waiting, the canonical file is re-read rather than returning
        // the legacy parse. That is the whole point: an update may have
        // committed while adoption was running, and the caller must see it.
        await adoptLegacy()
        text = await fs.readText(statePath)
        if (text === undefined) return emptyProvenance()
      }
      try {
        return parseProvenance(JSON.parse(text))
      } catch {
        // Unparseable JSON is not recoverable and not worth failing startup
        // over; starting from empty means the worst case is that previously
        // bundle-installed plugins look manual, which errs toward keeping them.
        return emptyProvenance()
      }
    },

    async writeProvenance(state: ProvenanceState): Promise<void> {
      await fs.mkdir(directory)
      await fs.writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`)
    },

    async readOperation(opId: string): Promise<OperationRecord | undefined> {
      const text = await fs.readText(join(operations, `${safeName(opId)}.json`))
      if (text === undefined) return undefined
      try {
        return parseOperation(JSON.parse(text))
      } catch {
        return undefined
      }
    },

    async writeOperation(record: OperationRecord): Promise<void> {
      await fs.mkdir(operations)
      await fs.writeAtomic(join(operations, `${safeName(record.opId)}.json`), `${JSON.stringify(record, null, 2)}\n`)
    },

    async listOperations(): Promise<OperationRecord[]> {
      const names = await fs.listDir(operations)
      const records: OperationRecord[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const text = await fs.readText(join(operations, name))
        if (text === undefined) continue
        try {
          const record = parseOperation(JSON.parse(text))
          if (record !== undefined) records.push(record)
        } catch {
          // A corrupt record describes an install nobody can resume; skipping
          // it is exactly as useful as reporting it.
        }
      }
      return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },

    async deleteOperation(opId: string): Promise<void> {
      await fs.remove(join(operations, `${safeName(opId)}.json`))
    },
    async pendingBuilds(): Promise<string[]> {
      const text = await fs.readText(join(profileDirectory, 'pnpm-workspace.yaml'))
      return text === undefined ? [] : pendingBuildsFrom(text)
    },
  }
}

/**
 * An in-memory store, for tests and for a profile whose directory is not
 * writable — an install still works, it just cannot be resumed.
 */
export function createMemoryInstallStore(initial?: ProvenanceState): InstallStore {
  let state = initial ?? emptyProvenance()
  const operations = new Map<string, OperationRecord>()
  let tail: Promise<void> = Promise.resolve()
  const self: InstallStore = {
    updateProvenance(updater) {
      const run = tail.then(async () => {
        const current = await self.readProvenance()
        const next = await updater(current)
        if (next !== current) await self.writeProvenance(next)
      })
      tail = run.catch(() => undefined)
      return run
    },
    async readProvenance() {
      return state
    },
    async writeProvenance(next) {
      state = next
    },
    async readOperation(opId) {
      return operations.get(opId)
    },
    async writeOperation(record) {
      operations.set(record.opId, record)
    },
    async listOperations() {
      return [...operations.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
    async deleteOperation(opId) {
      operations.delete(opId)
    },
    async pendingBuilds() {
      return []
    },
  }
  return self
}

/**
 * Keep an id usable as a file name.
 *
 * The ids are generated by this plugin (`op-<timestamp>-<random>`), so this is
 * belt and braces: if anything ever lets a caller pick an id, `../..` must not
 * be able to escape the operations directory.
 */
function safeName(opId: string): string {
  return opId.replace(/[^A-Za-z0-9._-]/gu, '_')
}

/** The slice of the filesystem this module needs, injected for tests. */
export interface FileSystem {
  readText(path: string): Promise<string | undefined>
  writeAtomic(path: string, content: string): Promise<void>
  mkdir(path: string): Promise<void>
  listDir(path: string): Promise<string[]>
  remove(path: string): Promise<void>
}

const nodeFileSystem: FileSystem = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  },

  async writeAtomic(path, content) {
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, content, 'utf8')
    try {
      await rename(temporary, path)
    } catch {
      // Windows refuses the rename while a reader holds the target. Overwrite
      // in place instead of losing the update; the reader sees either the old
      // or the new content, and both are valid documents.
      await writeFile(path, content, 'utf8')
      await unlink(temporary).catch(() => undefined)
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true })
  },

  async listDir(path) {
    try {
      return await readdir(path)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  },

  async remove(path) {
    try {
      await unlink(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  },
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
