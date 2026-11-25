import { describe, expect, it } from 'vitest'

import { BusyError, ROUTE_PREFIX, filtersFrom, storeRoutes, type StoreApi } from '../src/server/routes.ts'
import { emptyProvenance } from '../src/install/state.ts'
import { exchange } from './support/http.ts'
import { card, fakeApi, snapshot } from './support/fake-api.ts'

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; api?: StoreApi } = {},
) {
  const routes = storeRoutes(options.api ?? fakeApi())
  const [routePath = ''] = path.split('?')
  const route = routes.find((entry) => entry.path === `${ROUTE_PREFIX}${routePath}`)
  if (route === undefined) throw new Error(`no route ${path}`)
  const ex = exchange(method, `${ROUTE_PREFIX}${path}`, options.body, options.headers)
  await route.handler(ex.request, ex.response)
  return ex
}

describe('store routes', () => {
  it('registers every documented path under the plugin prefix', () => {
    const paths = storeRoutes(fakeApi()).map((route) => route.path)
    expect(paths).toEqual([
      '/dsh-suite-store/api/bundles',
      '/dsh-suite-store/api/detail',
      // The pre-run question: which members need a build-script approval, and
      // what the install would touch. Asked before a run, not during one.
      '/dsh-suite-store/api/preflight',
      // The export a user attaches to a bug report: sanitised plain text with
      // the live profile state, so a restart-only failure still exports
      // something a maintainer can act on.
      '/dsh-suite-store/api/logs',
      '/dsh-suite-store/api/capabilities',
      // The client half's self-report: a desktop host has no console, so this
      // is how "did apply() run" becomes answerable from outside.
      '/dsh-suite-store/api/client-report',
      '/dsh-suite-store/api/install',
      '/dsh-suite-store/api/progress',
      '/dsh-suite-store/api/cancel',
      // §7.5's continue: retries the failed and never-started members of a
      // persisted operation, after a reload or a host restart.
      '/dsh-suite-store/api/resume',
      '/dsh-suite-store/api/uninstall/preview',
      '/dsh-suite-store/api/uninstall',
      '/dsh-suite-store/api/members',
      '/dsh-suite-store/api/members/enabled',
      '/dsh-suite-store/api/members/install',
    ])
  })

  it('serves the bundle list with its source', async () => {
    const ex = await call('GET', '/api/bundles')
    expect(ex.status()).toBe(200)
    const payload = JSON.parse(ex.body()) as Record<string, unknown>
    expect(payload.source).toEqual({
      kind: 'url',
      url: 'https://example.test/suites.json',
      label: 'cdn',
    })
    expect((payload.bundles as unknown[]).length).toBe(1)
  })

  it('answers 503 with the fetch failure when the catalog cannot be read', async () => {
    const ex = await call('GET', '/api/bundles', {
      api: fakeApi({
        async catalog() {
          throw new Error('catalog unreachable')
        },
      }),
    })
    expect(ex.status()).toBe(503)
    expect(JSON.parse(ex.body()).error).toMatch(/unreachable/u)
  })

  it('serves a detail document and 404s an unknown id', async () => {
    expect((await call('GET', '/api/detail?id=fin')).status()).toBe(200)
    const missing = await call('GET', '/api/detail?id=nope')
    expect(missing.status()).toBe(404)
  })

  it('requires an id on detail', async () => {
    expect((await call('GET', '/api/detail')).status()).toBe(400)
  })

  it('refuses a method the route does not serve', async () => {
    const ex = await call('POST', '/api/bundles', { body: {} })
    expect(ex.status()).toBe(405)
    expect(ex.state.headers.allow).toBe('GET')
  })
  it('installs from a POST body and answers with the running operation', async () => {
    const ex = await call('POST', '/api/install', { body: { id: 'fin' } })
    expect(ex.status()).toBe(200)
    // The record, not the report: the run outlives the request on purpose.
    const body = JSON.parse(ex.body())
    expect(body.opId).toBe('op-1')
    expect(body.status).toBe('preflight')
  })

  it('answers the pre-run question without starting anything', async () => {
    const ex = await call('GET', '/api/preflight?id=fin')
    expect(ex.status()).toBe(200)
    expect(JSON.parse(ex.body()).summary.members).toHaveLength(1)
  })

  it('refuses an install without an id', async () => {
    expect((await call('POST', '/api/install', { body: {} })).status()).toBe(400)
  })

  it('answers 409 with the running operation when the executor is busy', async () => {
    const operation = { opId: 'op-live', bundleId: 'fin' } as never
    const ex = await call('POST', '/api/install', {
      body: { id: 'fin' },
      api: fakeApi({
        async install() {
          throw new BusyError('already installing', operation)
        },
      }),
    })
    expect(ex.status()).toBe(409)
    expect(JSON.parse(ex.body()).operation).toEqual({ opId: 'op-live', bundleId: 'fin' })
  })

  it('refuses a mutation from another origin', async () => {
    const ex = await call('POST', '/api/install', {
      body: { id: 'fin' },
      headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' },
    })
    expect(ex.status()).toBe(403)
  })

  it('is unbothered by an unknown request body field', async () => {
    const ex = await call('POST', '/api/cancel', { body: { why: 'because' } })
    expect(ex.status()).toBe(202)
    expect(JSON.parse(ex.body()).stopped).toBe(true)
  })

  it('rejects a malformed body', async () => {
    const ex = await call('POST', '/api/install', { body: ['not', 'an', 'object'] })
    expect(ex.status()).toBe(400)
    expect(JSON.parse(ex.body()).error).toMatch(/JSON object/u)
  })

  it('previews an uninstall', async () => {
    const ex = await call('POST', '/api/uninstall/preview', { body: { id: 'fin' } })
    expect(JSON.parse(ex.body()).members).toEqual([{ id: 'npm:a', checked: true, reason: 'only-source' }])
  })

  it('requires a list of ids to uninstall', async () => {
    const ex = await call('POST', '/api/uninstall', { body: { id: 'fin', ids: 'npm:a' } })
    expect(ex.status()).toBe(400)
  })

  it('uninstalls the checked ids', async () => {
    const seen: string[] = []
    const ex = await call('POST', '/api/uninstall', {
      body: { id: 'fin', ids: ['npm:a'] },
      api: fakeApi({
        async uninstall(input) {
          seen.push(...input.ids)
          return {
            opId: 'op-2',
            bundleId: input.bundleId,
            status: 'done',
            ok: [...input.ids],
            skipped: [],
            skippedBuildDenied: [],
            failed: [],
            removed: [...input.ids],
          }
        },
      }),
    })
    expect(seen).toEqual(['npm:a'])
    expect(ex.status()).toBe(200)
  })

  it('lists member states for the sheet table (§8.3)', async () => {
    const ex = await call('POST', '/api/members', { body: { id: 'fin' } })
    expect(ex.status()).toBe(200)
    expect(JSON.parse(ex.body()).members).toEqual([
      { key: 'a', id: 'npm:a', present: true, enabled: true },
      { key: 'b', id: 'npm:b', present: false },
    ])
  })

  it('flips one member switch and reports what the host settled on', async () => {
    const seen: { id: string; enabled: boolean }[] = []
    const ex = await call('POST', '/api/members/enabled', {
      body: { id: 'npm:a', enabled: false },
      api: fakeApi({
        async setMemberEnabled(id, enabled) {
          seen.push({ id, enabled })
          return enabled
        },
      }),
    })
    expect(seen).toEqual([{ id: 'npm:a', enabled: false }])
    expect(ex.status()).toBe(200)
    expect(JSON.parse(ex.body())).toEqual({ id: 'npm:a', enabled: false })
  })

  it('refuses a switch request that does not say which way', async () => {
    // `enabled` is required rather than defaulted: a toggle route that reads a
    // missing field as "false" turns a malformed request into a silent disable.
    const ex = await call('POST', '/api/members/enabled', { body: { id: 'npm:a' } })
    expect(ex.status()).toBe(400)
  })

  it('installs one member named by key (§8.3)', async () => {
    const seen: { bundleId: string; key: string }[] = []
    const ex = await call('POST', '/api/members/install', {
      body: { id: 'fin', key: 'alpha' },
      api: fakeApi({
        async installMember(bundleId, key) {
          seen.push({ bundleId, key })
          return { opId: 'op-3', bundleId, status: 'done', ok: [key], skipped: [], skippedBuildDenied: [], failed: [] }
        },
      }),
    })
    expect(seen).toEqual([{ bundleId: 'fin', key: 'alpha' }])
    expect(ex.status()).toBe(200)
  })

  it('requires a member key to install one', async () => {
    const ex = await call('POST', '/api/members/install', { body: { id: 'fin' } })
    expect(ex.status()).toBe(400)
  })

  it('streams capabilities and a snapshot as soon as a client connects', async () => {
    const routes = storeRoutes(fakeApi())
    const progress = routes.find((route) => route.path.endsWith('/progress'))!
    const ex = exchange('GET', '/dsh-suite-store/api/progress')
    await progress.handler(ex.request, ex.response)
    const body = ex.body()
    expect(body).toContain('event: capabilities')
    expect(body).toContain('event: snapshot')
    expect(body).toContain('"canRestart":true')
  })

  it('forwards executor events to every open stream', async () => {
    let emit: ((event: unknown) => void) | undefined
    const api = fakeApi({
      subscribe(listener) {
        emit = listener as (event: unknown) => void
        return () => undefined
      },
    })
    const routes = storeRoutes(api)
    const progress = routes.find((route) => route.path.endsWith('/progress'))!
    const ex = exchange('GET', '/dsh-suite-store/api/progress')
    await progress.handler(ex.request, ex.response)
    emit?.({ type: 'member-done', opId: 'op-1', member: { key: 'a', state: 'ok' } })
    expect(ex.body()).toContain('event: member-done')
  })

  it('parses listing filters and ignores nonsense', () => {
    const params = new URLSearchParams('q=fin&primary=research&sort=hottest&hideBroken=1&secondary=')
    expect(filtersFrom(params)).toEqual({
      query: 'fin',
      primary: 'research',
      sort: 'hottest',
      hideBroken: true,
    })
    expect(filtersFrom(new URLSearchParams('sort=sideways&q=%20'))).toEqual({})
  })

  it('reads an update window only when it says a positive number', () => {
    expect(filtersFrom(new URLSearchParams('updatedWithin=30'))).toEqual({ updatedWithinDays: 30 })
    // Anything the page would never send is refused rather than coerced: a
    // window of 0 or a word would filter the whole store away if it slipped
    // through as a number.
    expect(filtersFrom(new URLSearchParams('updatedWithin=0'))).toEqual({})
    expect(filtersFrom(new URLSearchParams('updatedWithin=soon'))).toEqual({})
  })

  it('revalidates the catalog on every listing request', async () => {
    // No TTL and no fresh flag: every request reaches the catalog service,
    // which revalidates with its source.
    let calls = 0
    const api = fakeApi({
      async catalog() {
        calls += 1
        return snapshot()
      },
    })
    await call('GET', '/api/bundles', { api })
    await call('GET', '/api/bundles', { api })
    expect(calls).toBe(2)
  })
})

describe('route disposal', () => {
  it('unsubscribes from the service when disposed', () => {
    // Regression: `storeRoutes` used to drop the disposer `subscribe` returns,
    // so every reloaded plugin left one more listener forwarding progress
    // events into a stream set no page owned.
    let subscribed = 0
    let unsubscribed = 0
    const api = fakeApi({
      subscribe: () => {
        subscribed++
        return () => { unsubscribed++ }
      },
    })

    const routes = storeRoutes(api)
    expect(subscribed).toBe(1)
    expect(typeof routes.dispose).toBe('function')

    routes.dispose?.()
    expect(unsubscribed).toBe(1)
  })
})
