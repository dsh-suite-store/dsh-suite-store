/**
 * The catalog service: revalidate the document on every read, reusing the
 * previous bytes only when the source confirms they are unchanged.
 *
 * Three rules shape this class, and each one exists because of a specific
 * failure mode on a real network:
 *
 * 1. **The fallback walk is sequential, not a race.** Racing the CDN against
 *    npm doubles bandwidth on every cold start and can return two different
 *    generations of the document, so a card's member list could disagree with
 *    its detail payload.
 * 2. **A failed read is a failure, not yesterday's catalog.** The old 24h TTL
 *    plus stale fallback could show a list from days ago as if it were current;
 *    an unreachable catalog is reported so the page can offer a retry.
 * 3. **Concurrent cold starts share one download.** The settings page mounts
 *    the list, the detail drawer and the SSE stream at once.
 */

import { readFile } from 'node:fs/promises'

import { CatalogFetchError, describeFailures, kindFromStatus, kindFromThrow } from './errors.ts'
import {
  catalogPlan,
  sameSource,
  type CatalogSnapshot,
  type CatalogSource,
  type SnapshotStore,
} from './sources.ts'
import { CatalogFormatError, MAX_BUNDLE_MEMBERS, parseCatalogIndex } from './types.ts'
import { logEvent } from '../log/log.ts'
import { fileFromTarball } from './tarball.ts'
import { NetworkError, TimeoutError, type Transport } from './transport.ts'

/** Default ceiling for a catalog document; anything past 8 MB is not a catalog. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** How long one request may take before the next source is tried. */
const DEFAULT_TIMEOUT_MS = 8000

/** Ceiling for the small registry metadata document (`/<pkg>/latest`). */
const DEFAULT_MAX_METADATA_BYTES = 2 * 1024 * 1024

export interface CatalogServiceOptions {
  store: SnapshotStore
  transport: Transport
  /** Ordered sources; defaults to `catalogPlan()`. */
  plan?: CatalogSource[]
  /** Clock injection point: stamps `fetchedAt` on a new download. */
  now?: () => number
  timeoutMs?: number
  maxBytes?: number
  /**
   * Ceiling on one bundle's member list (see `MAX_BUNDLE_MEMBERS`).
   *
   * Wired through from the plugin config so raising the limit is a profile
   * edit rather than a rebuild: the number is an operational limit that will
   * move once a real suite needs more, and every layer between the config file
   * and the parser has to carry it or the config would be silently ignored.
   */
  maxMembers?: number
  /**
   * Whether a fetch result should be persisted.
   *
   * Tests set this to false when they care about the in-memory snapshot only;
   * production leaves it on so a cold start has something to show.
   */
  writeSnapshot?: boolean
}

export class CatalogService {
  private snapshot: CatalogSnapshot | undefined
  private inflight: Promise<CatalogSnapshot> | undefined
  private readonly options: Required<Omit<CatalogServiceOptions, 'plan'>> & { plan: CatalogSource[] }

  constructor(options: CatalogServiceOptions) {
    this.options = {
      store: options.store,
      transport: options.transport,
      plan: options.plan ?? catalogPlan(),
      now: options.now ?? Date.now,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxMembers: options.maxMembers ?? MAX_BUNDLE_MEMBERS,
      writeSnapshot: options.writeSnapshot ?? true,
    }
  }

  /**
   * The catalog, revalidated with its source on every call.
   *
   * The on-disk snapshot is only a validator/byte cache: it supplies the ETag
   * or npm version for the next conditional request, and the bytes of a 304.
   * It is never served as the answer when the source cannot be reached.
   */
  async current(): Promise<CatalogSnapshot> {
    return this.refresh()
  }

  /**
   * Revalidate against the source (rule 3: concurrent callers share one attempt).
   */
  async refresh(): Promise<CatalogSnapshot> {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchWithFallback().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** The snapshot without touching the network; used by request handlers. */
  peek(): CatalogSnapshot | undefined {
    return this.snapshot
  }

  private async cached(): Promise<CatalogSnapshot | undefined> {
    if (this.snapshot !== undefined) return this.snapshot
    try {
      const stored = await this.options.store.read()
      if (stored !== undefined) this.snapshot = stored
    } catch {
      // A broken or unreadable cache costs one download, never the refresh. It
      // used to reject the whole call BEFORE any source was tried, and with a
      // raw Error rather than the `CatalogFetchError` taxonomy the route and
      // the UI expect.
    }
    return this.snapshot
  }

  private async fetchWithFallback(): Promise<CatalogSnapshot> {
    const failures: CatalogFetchError[] = []
    const previous = await this.cached()

    for (const source of this.options.plan) {
      try {
        const fetched = await this.fetchOne(source, previous)
        if (fetched === undefined) {
          // 304 (or an unchanged npm version): the bytes we hold are still
          // current, so serve them with a new timestamp. Do NOT rewrite the
          // snapshot file — the document itself did not change.
          //
          // Both `undefined` returns in `fetchOne` are guarded on `previous`,
          // so this cannot happen; the explicit check is so the TYPE, not a
          // comment, carries that invariant.
          if (previous === undefined) {
            throw new CatalogFetchError('invalid', source.label, 'source reported unchanged with no cached snapshot')
          }
          const reinstated: CatalogSnapshot = { ...previous, fetchedAt: this.options.now() }
          this.snapshot = reinstated
          return reinstated
        }
        this.snapshot = fetched
        // Persistence is best-effort and deliberately OUTSIDE the source's
        // try: a read-only profile directory must not turn a good download
        // into a "failed source". The in-memory snapshot is already set, so
        // the page gets the new catalog regardless.
        const unchanged = previous !== undefined
          && fetched.etag !== undefined
          && previous.etag === fetched.etag
          // The PLACE, not its display label: every npm source is labelled
          // `npm`, so a registry switch looked "unchanged" and the old host's
          // snapshot stayed on disk.
          && sameSource(previous.source, fetched.source)
        if (this.options.writeSnapshot && !unchanged) {
          try {
            await this.options.store.write(fetched)
          } catch {
            // Losing the cache costs one download; losing the fetch costs the
            // whole refresh. Keep the fetch.
          }
        }
        return fetched
      } catch (error) {
        const failure = toFetchError(error, source)
        logEvent('warn', 'catalog', `source ${source.label} failed (${failure.kind}): ${failure.message}`)
        failures.push(failure)
      }
    }

    // An unreachable source has confirmed nothing: never answer from `previous`.
    // The route reports the failure and the page offers a retry.
    const summary = describeFailures(failures) || 'no catalog source configured'
    // Logged at `error`, not `warn`: this is the whole plan failing, which is
    // the state where the page shows no catalog at all.
    logEvent('error', 'catalog', `every source failed: ${summary}`)
    throw new CatalogFetchError(failures[0]?.kind ?? 'unreachable', 'catalog', summary)
  }

  /** Fetch one source. Returns `undefined` when the host answered 304. */
  private async fetchOne(
    source: CatalogSource,
    previous: CatalogSnapshot | undefined,
  ): Promise<CatalogSnapshot | undefined> {
    const headers: Record<string, string> = {}
    // Only a `url` source stores an HTTP validator. For npm, `etag` holds the
    // package VERSION, and replaying it as `If-None-Match` against
    // `/<pkg>/latest` is meaningless — the label comparison also cross-matched
    // registries, since every npm source is labelled `npm`.
    if (source.kind === 'url' && previous?.etag !== undefined && sameSource(previous.source, source)) {
      headers['if-none-match'] = previous.etag
    }

    if (source.kind === 'file') {
      // Read directly: no transport, no ETag, no timeout. The file is either
      // there or the operator has a broken configuration, and a network error
      // kind would misdescribe that.
      let body: Buffer
      try {
        body = await readFile(source.path)
      } catch (error) {
        throw new CatalogFetchError('unreachable', source.label, `cannot read ${source.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (body.length > this.options.maxBytes) {
        throw new CatalogFetchError('invalid', source.label, `document exceeds ${this.options.maxBytes} bytes`)
      }
      return {
        index: this.parse(body, source),
        source,
        fetchedAt: this.options.now(),
        bytes: body.length,
      }
    }

    const url = source.kind === 'url' ? source.url : `${trimSlash(source.registry)}/${source.pkg}`
    let body: Buffer
    let etag: string | undefined

    if (source.kind === 'url') {
      const response = await this.options.transport.get(url, { timeoutMs: this.options.timeoutMs, headers, maxBytes: this.options.maxBytes })
      if (response.status === 304) {
        // A 304 only means "unchanged" when we actually sent a validator.
        // Answering one to a cold start (no `previous`, no If-None-Match) is
        // a broken server or a lying proxy; treating it as "nothing changed"
        // spread `{ fetchedAt }` — a snapshot with no index — into every
        // consumer that reads `snapshot.index`.
        if (previous === undefined || headers['if-none-match'] === undefined) {
          throw new CatalogFetchError('invalid', source.label, `unexpected 304 without a sent validator`, { status: 304 })
        }
        return undefined
      }
      if (response.status !== 200) throw new CatalogFetchError(kindFromStatus(response.status), source.label, `status ${response.status}`, { status: response.status })
      body = response.body
      etag = response.headers.etag
    } else {
      const latest = await this.fetchJson(`${url}/latest`, source.label, headers, previous)
      if (latest === undefined) return undefined
      const version = pickLatestVersion(latest, source)
      // Downloads of the same version are skipped entirely when we already
      // hold that version's document: the tarball is the expensive part. The
      // source check keeps a registry switch from reporting "unchanged" — the
      // old snapshot belongs to the OLD host.
      if (previous !== undefined && sameSource(previous.source, source) && previous.index.catalogRef.etag === version) {
        return undefined
      }
      const tarballUrl = pickTarballUrl(latest, version, source)
      const response = await this.options.transport.get(tarballUrl, { timeoutMs: this.options.timeoutMs, maxBytes: this.options.maxBytes })
      if (response.status !== 200) {
        throw new CatalogFetchError(kindFromStatus(response.status), source.label, `status ${response.status}`, { status: response.status })
      }
      const file = fileFromTarball(response.body, source.file)
      if (file === undefined) {
        throw new CatalogFetchError('invalid', source.label, `tarball has no ${source.file}`)
      }
      body = file
      etag = version
    }

    if (body.length > this.options.maxBytes) {
      throw new CatalogFetchError('invalid', source.label, `document exceeds ${this.options.maxBytes} bytes`)
    }
    return {
      index: this.parse(body, source),
      source,
      fetchedAt: this.options.now(),
      bytes: body.length,
      ...(etag === undefined ? {} : { etag }),
    }
  }

  private parse(body: Buffer, source: CatalogSource): CatalogSnapshot['index'] {
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch (error) {
      throw new CatalogFetchError('invalid', source.label, 'body is not JSON', { cause: error })
    }
    try {
      return parseCatalogIndex(raw, { maxMembers: this.options.maxMembers })
    } catch (error) {
      if (error instanceof CatalogFormatError) {
        throw new CatalogFetchError('invalid', source.label, error.message, { cause: error })
      }
      throw error
    }
  }

  /** GET a JSON document; `undefined` for a 304 to a sent validator. */
  private async fetchJson(
    url: string,
    label: string,
    headers: Record<string, string>,
    previous: CatalogSnapshot | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.options.transport.get(url, { timeoutMs: this.options.timeoutMs, headers, maxBytes: DEFAULT_MAX_METADATA_BYTES })
    if (response.status === 304) {
      if (previous === undefined || headers['if-none-match'] === undefined) {
        throw new CatalogFetchError('invalid', label, `unexpected 304 without a sent validator`, { status: 304 })
      }
      return undefined
    }
    if (response.status !== 200) {
      throw new CatalogFetchError(kindFromStatus(response.status), label, `status ${response.status}`, { status: response.status })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(response.body.toString('utf8'))
    } catch (error) {
      throw new CatalogFetchError('invalid', label, 'registry metadata is not JSON', { cause: error })
    }
    // The shape matters: a captive portal that answers `200 null` made
    // `metadata['dist-tags']` a TypeError ("Cannot read properties of null"),
    // which surfaced to the reader verbatim as the failure reason.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CatalogFetchError('invalid', label, 'registry metadata is not a JSON object')
    }
    return parsed as Record<string, unknown>
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}

/**
 * Read the version to download.
 *
 * `dist-tags.latest` is authoritative — a version-scoped request
 * (`/<pkg>/<version>`) would work too but needs the version first, which is
 * exactly this call.
 */
function pickLatestVersion(metadata: Record<string, unknown>, source: CatalogSource): string {
  const tags = metadata['dist-tags'] as Record<string, unknown> | undefined
  const latest = tags?.latest
  if (typeof latest !== 'string') {
    throw new CatalogFetchError('invalid', source.label, 'registry metadata has no dist-tags.latest')
  }
  return latest
}

/**
 * Read `dist.tarball` for the version, resolved against the registry URL.
 *
 * Mirrors rewrite this field to their own origin (and may redirect further),
 * so it is followed rather than reconstructed from the package name.
 */
function pickTarballUrl(metadata: Record<string, unknown>, version: string, source: CatalogSource): string {
  if (source.kind !== 'npm') throw new Error('unreachable: source is not npm')
  const versions = metadata.versions as Record<string, { dist?: { tarball?: unknown } }> | undefined
  const tarball = versions?.[version]?.dist?.tarball
  if (typeof tarball !== 'string' || tarball === '') {
    throw new CatalogFetchError('invalid', source.label, `registry metadata has no dist.tarball for ${version}`)
  }
  // A relative path is legal in registry metadata and must resolve against the
  // registry origin, not the process cwd — `new URL` with a base does that.
  const resolved = new URL(tarball, `${trimSlash(source.registry)}/`)
  // The ORIGIN is deliberately not checked: a mirror legitimately points this
  // field at its own CDN, and the test "follows the tarball URL the registry
  // reports" pins exactly that. The SCHEME is checked, because `file:`/`data:`
  // here would turn a metadata field into an arbitrary local read.
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    throw new CatalogFetchError('invalid', source.label, `registry tarball URL has unsupported scheme ${resolved.protocol}`)
  }
  return resolved.toString()
}

function toFetchError(error: unknown, source: CatalogSource): CatalogFetchError {
  if (error instanceof CatalogFetchError) return error
  if (error instanceof TimeoutError) return new CatalogFetchError('timeout', source.label, error.message, { cause: error })
  if (error instanceof NetworkError) return new CatalogFetchError(kindFromThrow(error.cause), source.label, error.message, { cause: error })
  return new CatalogFetchError('invalid', source.label, error instanceof Error ? error.message : String(error), { cause: error })
}
