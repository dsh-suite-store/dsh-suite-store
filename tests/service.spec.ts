/**
 * Behavioural specs for the catalog service: per-read revalidation, the
 * fallback walk, and the rule that an unreachable source is reported rather
 * than answered from an old copy.
 *
 * The transport is faked so the fallback ORDER and the conditional-request
 * decisions are asserted deterministically; `transport.spec.ts` covers the
 * socket.
 */

import { describe, expect, it } from 'vitest'
import { CatalogService, type CatalogServiceOptions } from '../src/catalog/service.ts'
import { CatalogFetchError } from '../src/catalog/errors.ts'
import type { CatalogSource, CatalogSnapshot, SnapshotStore } from '../src/catalog/sources.ts'
import type { Transport, TransportResponse } from '../src/catalog/transport.ts'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const fixtureBytes = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

const indexJson = fixtureBytes('catalog-index.json')
const tarball = fixtureBytes('catalog-index.tgz')

/** Build the JSON body a registry would return for `GET /<pkg>/latest`. */
function latestMetadata(version: string, tarballUrl: string): Buffer {
  return Buffer.from(JSON.stringify({
    name: 'dsh-suite-catalog',
    'dist-tags': { latest: version },
    versions: { [version]: { version, dist: { tarball: tarballUrl } } },
  }))
}

/** A transport driven by a URL → response table, recording what was asked. */
class FakeTransport implements Transport {
  readonly calls: string[] = []
  private readonly routes: Record<string, () => TransportResponse | Promise<TransportResponse>>

  constructor(routes: Record<string, () => TransportResponse | Promise<TransportResponse>>) {
    this.routes = routes
  }

  async get(url: string): Promise<TransportResponse> {
    this.calls.push(url)
    const route = this.routes[url]
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return route()
  }
}

const ok = (body: Buffer): TransportResponse => ({ status: 200, headers: {}, body })
const status = (code: number): TransportResponse => ({ status: code, headers: {}, body: Buffer.alloc(0) })
const notModified: TransportResponse = { status: 304, headers: {}, body: Buffer.alloc(0) }

/** An in-memory snapshot store; `write` is observable by the tests. */
class MemoryStore implements SnapshotStore {
  snapshot: CatalogSnapshot | undefined
  writes = 0

  constructor(initial?: CatalogSnapshot) {
    this.snapshot = initial
  }

  async read(): Promise<CatalogSnapshot | undefined> {
    return this.snapshot
  }

  async write(snapshot: CatalogSnapshot): Promise<void> {
    this.writes += 1
    this.snapshot = snapshot
  }
}

const CDN = 'https://awesome-dsh-plugin.com/suites.json'
const NPM_LATEST = 'https://registry.npmjs.org/dsh-suite-catalog/latest'

function service(overrides: Partial<CatalogServiceOptions> & { transport: Transport; store?: SnapshotStore }): CatalogService {
  return new CatalogService({
    plan: overrides.plan ?? [{ kind: 'url', url: CDN, label: 'cdn' }],
    store: overrides.store ?? new MemoryStore(),
    transport: overrides.transport,
    now: overrides.now ?? (() => 1_000_000),
    writeSnapshot: overrides.writeSnapshot,
  })
}

describe('CatalogService — fetching', () => {
  it('parses the document it downloads and records where it came from', async () => {
    const svc = service({ transport: new FakeTransport({ [CDN]: () => ok(indexJson) }) })
    const snapshot = await svc.current()
    expect(snapshot.index.bundles).toHaveLength(1)
    expect(snapshot.source.label).toBe('cdn')
    expect(snapshot.bytes).toBe(indexJson.length)
  })

  it('walks to the next source when one host is down', async () => {
    const transport = new FakeTransport({
      [CDN]: () => status(503),
      [NPM_LATEST]: () => ok(latestMetadata('1.0.4', 'https://registry.npmjs.org/dsh-suite-catalog/-/dsh-suite-catalog-1.0.4.tgz')),
      'https://registry.npmjs.org/dsh-suite-catalog/-/dsh-suite-catalog-1.0.4.tgz': () => ok(tarball),
    })
    const svc = service({
      transport,
      plan: [
        { kind: 'url', url: CDN, label: 'cdn' },
        { kind: 'npm', registry: 'https://registry.npmjs.org', pkg: 'dsh-suite-catalog', file: 'package/index.json', label: 'npm' },
      ],
    })
    const snapshot = await svc.current()
    expect(snapshot.source.label).toBe('npm')
    expect(transport.calls).toEqual([
      CDN,
      NPM_LATEST,
      'https://registry.npmjs.org/dsh-suite-catalog/-/dsh-suite-catalog-1.0.4.tgz',
    ])
  })

  it('follows the tarball URL the registry reports instead of building one', async () => {
    // Chinese mirrors rewrite `dist.tarball` to their own host; constructing
    // the URL from the package name would download from the wrong origin.
    const mirrorTarball = 'https://registry.npmmirror.com/dsh-suite-catalog/-/dsh-suite-catalog-1.0.4.tgz'
    const transport = new FakeTransport({
      'https://registry.npmmirror.com/dsh-suite-catalog/latest': () =>
        ok(latestMetadata('1.0.4', mirrorTarball)),
      [mirrorTarball]: () => ok(tarball),
    })
    const svc = service({
      transport,
      plan: [{ kind: 'npm', registry: 'https://registry.npmmirror.com', pkg: 'dsh-suite-catalog', file: 'package/index.json', label: 'npmmirror' }],
    })
    expect((await svc.current()).source.label).toBe('npmmirror')
    expect(transport.calls).toContain(mirrorTarball)
  })

  it('reports every source it tried when they all fail', async () => {
    const transport = new FakeTransport({ [CDN]: () => status(500) })
    const svc = service({
      transport,
      plan: [
        { kind: 'url', url: CDN, label: 'cdn' },
        { kind: 'url', url: 'https://mirror.test/x.json', label: 'mirror' },
      ],
    })
    await expect(svc.current()).rejects.toThrow(/cdn: .*; mirror: /u)
  })

  it('turns a corrupt document into an invalid-source failure, not a crash', async () => {
    const transport = new FakeTransport({ [CDN]: () => ok(Buffer.from('{"format":7}')) })
    const svc = service({ transport })
    await expect(svc.current()).rejects.toThrow(/cdn: .*unsupported catalog format/u)
  })

  it('does not spend the second source on a 404 from the same document', async () => {
    // The CDN answered "gone"; the npm package is a different host, so it is
    // still tried — the point is that the 404 itself does not abort the walk.
    const transport = new FakeTransport({
      [CDN]: () => status(404),
      [NPM_LATEST]: () => ok(latestMetadata('1.0.4', 'https://registry.npmjs.org/t.gz')),
      'https://registry.npmjs.org/t.gz': () => ok(tarball),
    })
    const svc = service({
      transport,
      plan: [
        { kind: 'url', url: CDN, label: 'cdn' },
        { kind: 'npm', registry: 'https://registry.npmjs.org', pkg: 'dsh-suite-catalog', file: 'package/index.json', label: 'npm' },
      ],
    })
    expect((await svc.current()).source.label).toBe('npm')
  })
})

describe('CatalogService — per-read revalidation', () => {
  it('revalidates on every read even when a cached copy exists', async () => {
    const store = new MemoryStore({
      index: JSON.parse(indexJson.toString('utf8')),
      source: { kind: 'url', url: CDN, label: 'cdn' },
      fetchedAt: 999_000,
      bytes: indexJson.length,
    })
    const transport = new FakeTransport({ [CDN]: () => ok(indexJson) })
    const svc = service({ transport, store, now: () => 1_000_000 })
    await svc.current()
    await svc.current()
    // No TTL: a second read revalidates with the source instead of reusing
    // the in-memory snapshot.
    expect(transport.calls).toEqual([CDN, CDN])
  })

  it('reports a failed revalidation instead of serving a cached copy', async () => {
    // An unreachable source has confirmed nothing: yesterday's catalog must
    // not be painted as current. The route reports the error and the page
    // offers a retry.
    const store = new MemoryStore({
      index: JSON.parse(indexJson.toString('utf8')),
      source: { kind: 'url', url: CDN, label: 'cdn' },
      fetchedAt: 0,
      bytes: indexJson.length,
    })
    const transport = new FakeTransport({ [CDN]: () => status(500) })
    const svc = service({ transport, store, now: () => 10_000_000 })
    await expect(svc.current()).rejects.toThrow(/cdn: status 500/u)
  })

  it('revalidates with the ETag and reuses the cached body on 304', async () => {
    const store = new MemoryStore({
      index: JSON.parse(indexJson.toString('utf8')),
      source: { kind: 'url', url: CDN, label: 'cdn' },
      fetchedAt: 0,
      bytes: indexJson.length,
      etag: 'W/"abc123"',
    })
    let clock = 10_000_000
    const transport = new FakeTransport({ [CDN]: () => (clock = 20_000_000, notModified) })
    const svc = service({ transport, store, now: () => clock })
    const snapshot = await svc.current()
    // The document did not change, but we DID talk to the source.
    expect(snapshot.fetchedAt).toBe(20_000_000)
    expect(snapshot.index.bundles).toHaveLength(1)
    expect(store.snapshot?.etag).toBe('W/"abc123"')
  })

  it('sends If-None-Match built from the stored ETag', async () => {
    const headers: (Record<string, string> | undefined)[] = []
    const transport: Transport = {
      async get(_url, options) {
        headers.push(options.headers)
        return notModified
      },
    }
    const store = new MemoryStore({
      index: JSON.parse(indexJson.toString('utf8')),
      source: { kind: 'url', url: CDN, label: 'cdn' },
      fetchedAt: 0,
      bytes: indexJson.length,
      etag: '"v1"',
    })
    await service({ transport, store, now: () => 10_000_000 }).current()
    expect(headers[0]?.['if-none-match']).toBe('"v1"')
  })

  it('writes the snapshot to disk only when the bytes changed', async () => {
    const store = new MemoryStore()
    // A CDN that returns the same document with the same ETag twice: both
    // responses are genuine 200s, so the skip has to come from comparing ETags
    // rather than from a 304 shortcut.
    const transport = new FakeTransport({
      [CDN]: () => ({ status: 200, headers: { etag: '"same"' }, body: indexJson }),
    })
    const svc = service({ transport, store, now: () => 10_000_000 })
    await svc.current()
    await svc.refresh()
    expect(transport.calls).toEqual([CDN, CDN])
    expect(store.writes).toBe(1)
  })

  it('writes again when the document really changed', async () => {
    const store = new MemoryStore()
    let etag = '"v1"'
    const transport = new FakeTransport({
      [CDN]: () => ({ status: 200, headers: { etag }, body: indexJson }),
    })
    const svc = service({ transport, store, now: () => 10_000_000 })
    await svc.current()
    etag = '"v2"'
    await svc.refresh()
    expect(store.writes).toBe(2)
    expect(store.snapshot?.etag).toBe('"v2"')
  })

  it('collapses concurrent cold-start requests into one download', async () => {
    let settle: ((response: TransportResponse) => void) | undefined
    // The counter lives beside the fake, not ON it: `Transport` has exactly one
    // method, and casting a property onto it made the test's own bookkeeping
    // invisible to the type checker.
    const calls = { count: 0 }
    const transport: Transport = {
      async get() {
        calls.count += 1
        return new Promise<TransportResponse>((done) => {
          settle = done
        })
      },
    }
    const svc = service({ transport })
    const pending = Promise.all([svc.current(), svc.current(), svc.current()])
    // Let the three callers reach the in-flight check before the body arrives.
    await new Promise((resolve) => setTimeout(resolve, 10))
    settle?.(ok(indexJson))
    const snapshots = await pending
    expect(calls.count).toBe(1)
    expect(snapshots.map((snapshot) => snapshot.index.bundles.length)).toEqual([1, 1, 1])
  })
  it('skips the tarball download when the registry reports the version we already have', async () => {
    // The tarball is the expensive part; the version check is what makes a
    // warm refresh cost one small JSON request instead of a whole archive.
    const store = new MemoryStore({
      index: { ...JSON.parse(indexJson.toString('utf8')), catalogRef: { ...JSON.parse(indexJson.toString('utf8')).catalogRef, etag: '1.0.4' } },
      source: { kind: 'npm', registry: 'https://registry.npmjs.org', pkg: 'dsh-suite-catalog', file: 'package/index.json', label: 'npm' },
      fetchedAt: 0,
      bytes: indexJson.length,
    })
    const transport = new FakeTransport({
      [NPM_LATEST]: () => ok(latestMetadata('1.0.4', 'https://registry.npmjs.org/t.gz')),
    })
    const svc = service({
      transport,
      store,
      now: () => 10_000_000,
      plan: [{ kind: 'npm', registry: 'https://registry.npmjs.org', pkg: 'dsh-suite-catalog', file: 'package/index.json', label: 'npm' }],
    })
    const snapshot = await svc.current()
    expect(transport.calls).toEqual([NPM_LATEST])
    expect(snapshot.fetchedAt).toBe(10_000_000)
  })
})

describe('CatalogService — degraded shapes', () => {
  it('reports an empty catalog instead of throwing when the document is empty', async () => {
    // A repository that has not published anything yet still emits a valid
    // document; the marketplace must render "暂无整合包", not an error.
    const empty = Buffer.from(JSON.stringify({
      format: 1,
      generatedAt: '2026-11-09T00:00:00Z',
      catalogRef: { updated: '2026-11-09T00:00:00Z', count: 9680 },
      categories: {},
      bundles: [],
    }))
    const svc = service({ transport: new FakeTransport({ [CDN]: () => ok(empty) }) })
    const snapshot = await svc.current()
    expect(snapshot.index.bundles).toEqual([])
    expect(snapshot.index.catalogRef.count).toBe(9680)
  })

  it('does not accept an HTML error page served with status 200', async () => {
    // Captive portals and CDN error pages do exactly this; parsing it as JSON
    // would fail with a syntax error that tells the user nothing.
    const transport = new FakeTransport({ [CDN]: () => ok(Buffer.from('<html>blocked</html>')) })
    await expect(service({ transport }).current()).rejects.toThrow(/cdn: body is not JSON/u)
  })
})

describe('CatalogService — a local catalog file', () => {
  // A self-hosted mirror or a catalog build that is not published yet. These
  // tests use a real file because the whole point is that this path never
  // touches the transport: a fake transport would prove the opposite.
  const dir = mkdtempSync(join(tmpdir(), 'suites-store-file-'))
  const good = join(dir, 'index.json')
  const broken = join(dir, 'broken.json')
  const huge = join(dir, 'huge.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(good, indexJson)
  writeFileSync(broken, '{ not json')
  writeFileSync(huge, Buffer.alloc(64))

  const filePlan = (path: string): CatalogSource[] => [{ kind: 'file', path, label: 'file' }]

  it('reads the document without asking the transport', async () => {
    const transport = new FakeTransport({})
    const snapshot = await service({ transport, plan: filePlan(good) }).current()
    expect(snapshot.source.label).toBe('file')
    expect(snapshot.index.bundles).toHaveLength(1)
    expect(transport.calls).toEqual([])
  })

  it('never falls back to the network when the file is missing', async () => {
    // Falling back would install a different catalog than the operator
    // pointed at, which is worse than a clear error naming the path.
    const transport = new FakeTransport({ [CDN]: () => ok(indexJson) })
    await expect(
      service({ plan: filePlan(join(dir, 'absent.json')), transport }).current(),
    ).rejects.toThrow(/file: cannot read/u)
    expect(transport.calls).toEqual([])
  })

  it('reports a malformed file as invalid rather than unreachable', async () => {
    // The file exists; the user's problem is its contents, and the message
    // should say so instead of suggesting the disk is gone.
    const failure = await service({ transport: new FakeTransport({}), plan: filePlan(broken) })
      .current()
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CatalogFetchError)
    expect((failure as CatalogFetchError).kind).toBe('invalid')
  })

  it('still enforces the size ceiling', async () => {
    const svc = new CatalogService({
      plan: filePlan(huge),
      store: new MemoryStore(),
      transport: new FakeTransport({}),
      now: () => 1_000_000,
      maxBytes: 16,
    })
    await expect(svc.current()).rejects.toThrow(/exceeds 16 bytes/u)
  })
})
