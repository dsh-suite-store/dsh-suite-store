/**
 * Does one page load fetch the catalog twice?
 *
 * `/api/bundles` awaits `api.catalog()` and then `api.cards()`, and `cards()`
 * calls `current()` itself. `CatalogService.refresh()` dedupes CONCURRENT
 * callers, but these two are sequential — the first has finished and cleared
 * its in-flight promise before the second starts. So the dedupe does not apply
 * and the page pays for two round trips.
 *
 * The fixture is the repository's own `tests/fixtures/catalog-index.json`, not a
 * hand-written minimum: a bundle needs 2–10 members and an invented one-member
 * card is rejected by the parser before the behaviour under test is reached.
 *
 * Fetches are counted at the transport, so a fix anywhere (a shared snapshot, an
 * argument, a cache) satisfies this.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CatalogService } from '../src/catalog/service.ts'
import { MemorySnapshotStore } from '../src/catalog/snapshot-file.ts'
import { catalogPlan } from '../src/catalog/sources.ts'
import type { Transport } from '../src/catalog/transport.ts'
import { DetailLoader } from '../src/catalog/detail.ts'
import { StoreService } from '../src/store.ts'
import type { HostAdapter } from '../src/install/host.ts'
import { emptyProvenance } from '../src/install/state.ts'
import { createMemoryInstallStore } from '../src/install/store.ts'

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-index.json'),
  'utf8',
)

/** A transport that answers with the fixture and counts every request. */
function countingTransport(): { calls: string[]; transport: Transport } {
  const calls: string[] = []
  return {
    calls,
    transport: {
      async get(url: string) {
        calls.push(url)
        return { status: 200, headers: {}, body: Buffer.from(fixture, 'utf8') }
      },
    },
  }
}

describe('one page load fetches the catalog once', () => {
  it('does not refresh twice between catalog() and cards()', async () => {
    const { calls, transport } = countingTransport()
    const catalog = new CatalogService({
      store: new MemorySnapshotStore(),
      transport,
      plan: catalogPlan(),
    })
    const service = new StoreService({
      catalog,
      details: new DetailLoader({}),
      host: {
        installable: false,
        capabilities: async () => ({ canRestart: false, installable: false, canApproveBuilds: false }),
        installed: async () => [],
        install: async () => ({ status: 'failed', reason: 'n/a' }),
        cancel: async () => 'not-running',
        setEnabled: async () => undefined,
      } as unknown as HostAdapter,
      store: createMemoryInstallStore(emptyProvenance()),
      hostKind: 'cli',
      memberTimeoutMs: 1_000,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })

    // The exact sequence `/api/bundles` runs.
    const snapshot = await service.catalog()
    await service.cards(snapshot)

    expect(calls).toHaveLength(1)
  })
})

/**
 * The same guarantee at the route, which is what the page actually calls.
 *
 * The bug had a second half: the extra fetch could FAIL. A catalog that was
 * read successfully once and then flaked turned the page's 200 into a 503,
 * because the handler awaited the second read inside its own try block.
 */
describe('GET /api/bundles', () => {
  it('answers 200 after one fetch, even when a second would have failed', async () => {
    const { createServer } = await import('node:http')
    const { storeRoutes, ROUTE_PREFIX } = await import('../src/server/routes.ts')

    let calls = 0
    const catalog = new CatalogService({
      store: new MemorySnapshotStore(),
      transport: {
        async get() {
          calls += 1
          // The document reads fine once; any later attempt fails.
          if (calls > 1) throw new Error('the network flaked')
          return { status: 200, headers: {}, body: Buffer.from(fixture, 'utf8') }
        },
      },
      plan: catalogPlan(),
    })
    const service = new StoreService({
      catalog,
      details: new DetailLoader({}),
      host: {
        installable: false,
        capabilities: async () => ({ canRestart: false, installable: false, canApproveBuilds: false }),
        installed: async () => [],
        install: async () => ({ status: 'failed', reason: 'n/a' }),
        cancel: async () => 'not-running',
        setEnabled: async () => undefined,
      } as unknown as HostAdapter,
      store: createMemoryInstallStore(emptyProvenance()),
      hostKind: 'cli',
      memberTimeoutMs: 1_000,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })

    const routes = storeRoutes({
      catalog: () => service.catalog(),
      cards: (snapshot: Parameters<typeof service.cards>[0]) => service.cards(snapshot),
      detail: (id: string) => service.detail(id),
      capabilities: async () => ({ canRestart: false, hostKind: 'cli', installable: false, canApproveBuilds: false, memberEstimateMs: [1, 2] }),
      installed: async () => [],
      running: () => undefined,
      subscribe: () => () => undefined,
    } as never, { version: 'test', profile: '/tmp' })

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://x')
      const route = routes.find((entry) => entry.path === url.pathname)
      if (route === undefined) {
        response.writeHead(404).end()
        return
      }
      void Promise.resolve(route.handler(request, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }

    try {
      const answer = await fetch(`http://127.0.0.1:${port}${ROUTE_PREFIX}/api/bundles`)
      expect(answer.status).toBe(200)
      expect(calls).toBe(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
