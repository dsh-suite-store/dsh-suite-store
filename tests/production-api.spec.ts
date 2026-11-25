/**
 * Verify the PRODUCTION StoreApi adapter, not a hand-built lookalike.
 *
 * The previous test in catalog-fetch-count.spec.ts built its own `api` object
 * that forwarded the snapshot to `cards()`. It stayed green while `src/index.ts`
 * — the adapter real requests go through — still had `cards: () => ...`, which
 * dropped the argument and fetched the catalog a second time. This test uses
 * the exported `bindApi()` that `apply()` itself uses.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { bindApi } from '../src/index.ts'
import { CatalogService } from '../src/catalog/service.ts'
import { MemorySnapshotStore } from '../src/catalog/snapshot-file.ts'
import { catalogPlan } from '../src/catalog/sources.ts'
import type { Transport } from '../src/catalog/transport.ts'
import { DetailLoader } from '../src/catalog/detail.ts'
import { StoreService } from '../src/store.ts'
import { storeRoutes, ROUTE_PREFIX } from '../src/server/routes.ts'
import type { HostAdapter } from '../src/install/host.ts'
import { emptyProvenance } from '../src/install/state.ts'
import { createMemoryInstallStore } from '../src/install/store.ts'

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'catalog-index.json'),
  'utf8',
)

describe('the production StoreApi forwards the catalog snapshot', () => {
  it('/api/bundles fetches once even with a second read that would fail', async () => {
    let calls = 0
    const catalog = new CatalogService({
      store: new MemorySnapshotStore(),
      transport: {
        async get() {
          calls += 1
          if (calls > 1) throw new Error('the second fetch fails')
          return { status: 200, headers: {}, body: Buffer.from(fixture, 'utf8') }
        },
      } as Transport,
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

    // The real adapter, not a re-created one.
    const routes = storeRoutes(bindApi(service), { version: 'test', profile: '/tmp' })
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
