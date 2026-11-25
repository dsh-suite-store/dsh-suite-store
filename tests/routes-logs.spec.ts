/**
 * `GET /api/logs` — the export a user attaches to a bug report.
 *
 * Three properties matter, and each has its own reason:
 *
 *  1. It is a DOWNLOAD: a plain-text body with an attachment filename, so the
 *     browser saves it instead of rendering it.
 *  2. It carries the state of THIS profile, not only this session's events. The
 *     in-memory buffer starts empty on every start, so a restart-only failure
 *     would otherwise export nothing useful.
 *  3. It is safe to publish: home paths and credentials are masked, and the
 *     protocol is GET-only (a mutation must not be able to trigger it).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ROUTE_PREFIX, storeRoutes, type StoreApi } from '../src/server/routes.ts'
import { clearLog, configurePersistentLog, logEvent } from '../src/log/log.ts'
import { exchange, type Exchange } from './support/http.ts'
import { fakeApi as baseApi } from './support/fake-api.ts'

beforeEach(() => {
  clearLog()
})

afterEach(() => {
  configurePersistentLog(null)
  clearLog()
})

function logsRoute(api: StoreApi = baseApi()): (path: string, method?: string) => Promise<Exchange> {
  const routes = storeRoutes(api)
  return async (path, method = 'GET') => {
    const route = routes.find((entry) => entry.path === `${ROUTE_PREFIX}${path}`)
    if (route === undefined) throw new Error(`no route ${path}`)
    const ex = exchange(method, `${ROUTE_PREFIX}${path}`)
    await route.handler(ex.request, ex.response)
    return ex
  }
}

describe('GET /api/logs', () => {
  it('is mounted', () => {
    const paths = storeRoutes(baseApi()).map((route) => route.path)
    expect(paths).toContain(`${ROUTE_PREFIX}/api/logs`)
  })

  it('answers a downloadable plain-text attachment', async () => {
    const ex = await logsRoute()('/api/logs')
    expect(ex.status()).toBe(200)
    const headers = ex.state.headers
    expect(String(headers['content-type'])).toBe('text/plain; charset=utf-8')
    // The filename is what the browser saves it as; without this header the
    // export opens in a tab and the user has to copy it by hand.
    expect(String(headers['content-disposition'])).toBe('attachment; filename="dsh-suite-store-log.txt"')
    // A log that can be cached is a log the next export may not reflect.
    expect(String(headers['cache-control'])).toBe('no-store')
  })

  it('carries this session\'s events', async () => {
    logEvent('error', 'install', 'pnpm exited 1 for alpha')
    const body = (await logsRoute()('/api/logs')).body()
    expect(body).toContain('## events this session')
    expect(body).toContain('[error] install: pnpm exited 1 for alpha')
  })

  it('carries the live profile state, so a restart-only failure still exports something', async () => {
    // Nothing was logged this session, which is exactly the case the export has
    // to still answer.
    const body = (await logsRoute()('/api/logs')).body()
    expect(body).toContain('## profile state')
    expect(body).toContain('catalog bundles (1)')
    expect(body).toContain('fin 1.0.0: 2 members')
  })

  it('names the running versions, which every report needs', async () => {
    const body = (await logsRoute()('/api/logs')).body()
    expect(body).toContain('dsh-suite-store:')
    expect(body).toContain('platform:')
    expect(body).toContain('node:')
  })

  it('says so when the session recorded nothing', async () => {
    expect((await logsRoute()('/api/logs')).body()).toContain('(none')
  })

  it('survives a profile state it cannot read', async () => {
    // A broken profile is precisely when the log matters, so the export must
    // still render — with the failure stated in place of the snapshot.
    const ex = await logsRoute({
      ...baseApi(),
      cards: async () => {
        throw new Error('profile unreadable')
      },
    })('/api/logs')
    expect(ex.status()).toBe(200)
    const body = ex.body()
    expect(body).toContain('## events this session')
    expect(body).toContain('profile state unavailable')
  })

  it('refuses a method that is not GET', async () => {
    const ex = await logsRoute()('/api/logs', 'POST')
    expect(ex.status()).toBe(405)
    expect(ex.state.headers.allow).toBe('GET')
  })

  it('masks the home directory and credentials in whatever it exports', async () => {
    // The header carries `profile`, and the state lines carry absolute paths:
    // this is the assertion that the export is safe to paste in public.
    const body = (await logsRoute()('/api/logs')).body()
    expect(body).not.toMatch(/[A-Za-z]:\\Users\\[^\\\s]+\\/u)
  })
})
