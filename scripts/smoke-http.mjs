/**
 * End-to-end smoke test over real HTTP: the whole store minus the harness.
 *
 * The unit tests prove each layer against a fake; this proves the layers still
 * fit together when the only thing faked is `pluginManager` itself. It stands
 * up the actual `StoreService`, the actual route table and a real
 * `node:http` server, then walks the sequence a browser would walk — list,
 * open, install, watch progress, uninstall — and asserts on the bytes coming
 * back off the socket.
 *
 * Why this exists when `tests/store.spec.ts` already covers the service: the
 * two things that only break in composition are the ones nothing else can
 * catch. First, the route layer's serialization: a `Map` crossing `sendJson`
 * still logs a plausible-looking service value in a unit test while arriving
 * at the browser as `{}`. Second, the stream: SSE works by staying open and
 * flushing as events arrive, and a buffered stream looks identical to a
 * working one until a client waits on it.
 *
 * Usage: node scripts/smoke-http.mjs [--catalog <index.json>] [--keep-open <ms>]
 * Exit code 0 means every assertion held.
 */

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CatalogService } from '../lib/catalog/service.js'
import { DetailLoader } from '../lib/catalog/detail.js'
import { MemorySnapshotStore } from '../lib/catalog/snapshot-file.js'
import { catalogPlan } from '../lib/catalog/sources.js'
import { NodeTransport } from '../lib/catalog/transport.js'
import { HostAdapter } from '../lib/install/host.js'
import { createMemoryInstallStore } from '../lib/install/store.js'
import { emptyProvenance } from '../lib/install/state.js'
import { storeRoutes, ROUTE_PREFIX } from '../lib/server/routes.js'
import { StoreService } from '../lib/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = resolve(HERE, '..')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  // A flag at the END of the command line used to yield `undefined`, and
  // `resolve(PACKAGE, undefined)` then threw a raw TypeError with no clue which
  // flag was at fault.
  if (value === undefined || value.startsWith('--')) {
    console.error(`smoke: ${name} needs a value`)
    process.exit(2)
  }
  return value
}

const catalogFile = resolve(PACKAGE, argument('--catalog', 'data/index.json'))
const keepOpenMs = Number(argument('--keep-open', '0'))
if (!Number.isFinite(keepOpenMs) || keepOpenMs < 0) {
  // `NaN` silently disabled the keep-open path instead of failing.
  console.error('smoke: --keep-open needs a non-negative number of milliseconds')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// A fake pluginManager that behaves like the real one where it matters.
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in for the host's installer.
 *
 * It reproduces the three behaviours the store depends on and nothing else:
 * `listPlugins` reports what has been added, `installBundle` resolves only via
 * `waitForInstall` (so the executor's two-step protocol is exercised), and
 * `removeBundle` drops the entry. A member can be told to fail by name so the
 * partial-install path is reachable.
 */
function fakePluginManager({ failFor = new Set(), slowFor = new Set() } = {}) {
  const installed = new Map()
  const requests = new Map()

  const settle = (requestId, result) => {
    const entry = requests.get(requestId)
    if (entry === undefined) return
    entry.result = result
    entry.resolve?.(result)
  }

  return {
    installed,
    /** Members to refuse, settable after construction so one run can cover both paths. */
    failFor,
    async listPlugins() {
      return [...installed.entries()].map(([id, version]) => ({ id, version }))
    },
    async installBundle(spec, options = {}) {
      const requestId = options.requestId ?? `req-${String(requests.size)}`
      const id = spec.replace(/^npm:/u, '').replace(/@[^/]*$/u, '')
      const version = /@(\d[^/]*)$/u.exec(spec)?.[1] ?? '0.0.0'
      requests.set(requestId, { result: undefined })
      void (async () => {
        if (slowFor.has(id)) await new Promise((done) => setTimeout(done, 12))
        if (failFor.has(id)) {
          settle(requestId, { ok: false, reason: `pnpm refused ${id}` })
          return
        }
        installed.set(id, version)
        settle(requestId, { ok: true })
      })()
      // `installBundle` itself always resolves to the queued request; the
      // verdict arrives through `waitForInstall`, which is the contract the
      // executor is written against.
      return requestId
    },
    async waitForInstall(requestId) {
      const entry = requests.get(requestId)
      if (entry === undefined) return { ok: false, reason: 'unknown request' }
      if (entry.result !== undefined) return entry.result
      return new Promise((done) => {
        entry.resolve = done
      })
    },
    async cancelInstall() {
      return { status: 'cancelled' }
    },
    async removeBundle(name) {
      installed.delete(name)
      return { ok: true }
    },
    async inspect() {
      return { id: 'x', version: '1.0.0' }
    },
  }
}

// ---------------------------------------------------------------------------
// Harness: real service, real routes, real socket.
// ---------------------------------------------------------------------------

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition, detail })
  const mark = condition ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}

async function main() {
  const index = JSON.parse(await readFile(catalogFile, 'utf8'))
  const manager = fakePluginManager()
  const adapter = new HostAdapter(manager)

  const catalog = new CatalogService({
    store: new MemorySnapshotStore(),
    transport: new NodeTransport(),
    plan: catalogPlan({ file: catalogFile }),
  })
  const profile = await mkdtemp(join(tmpdir(), 'dsh-suite-store-smoke-'))
  const service = new StoreService({
    catalog,
    details: new DetailLoader({ transport: new NodeTransport() }),
    host: adapter,
    store: createMemoryInstallStore(emptyProvenance()),
    hostKind: 'desktop',
    memberTimeoutMs: 5000,
  })

  const api = {
    catalog: () => service.catalog(),
    detail: (id) => service.detail(id),
    cards: (snapshot) => service.cards(snapshot),
    install: (id) => service.install(id),
    running: () => service.running(),
    uninstallPreview: (id) => service.uninstallPreview(id),
    uninstall: (input) => service.uninstall(input),
    cancel: () => service.cancel(),
    subscribe: (listener) => service.subscribe(listener),
    capabilities: () => service.capabilities(),
  }

  const routes = storeRoutes(api, { version: 'smoke', profile, logFile: join(profile, '.dsh-suite-store', 'log.ndjson') })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const route = routes.find((entry) => entry.kind === 'exact' && entry.path === url.pathname)
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: `no route for ${url.pathname}` }))
      return
    }
    void Promise.resolve(route.handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })

  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const base = `http://127.0.0.1:${String(port)}${ROUTE_PREFIX}`
  console.log(`smoke: serving ${String(routes.length)} routes on ${base}`)
  console.log(`smoke: catalog ${catalogFile}\n`)

  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: `http://127.0.0.1:${String(port)}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, text, json, headers: response.headers }
  }

  // -- 1. the list ---------------------------------------------------------
  const list = await call('GET', '/api/bundles')
  check('GET /api/bundles answers 200', list.status === 200, `got ${String(list.status)}`)
  check('the list names its source', list.json?.source?.kind === 'file', JSON.stringify(list.json?.source))
  check(
    'every catalog bundle is listed',
    list.json?.bundles?.length === index.bundles.length,
    `${String(list.json?.bundles?.length)} of ${String(index.bundles.length)}`,
  )
  const first = list.json?.bundles?.[0]
  check(
    'cards are serializable (no Map/Set survives as {})',
    typeof first?.id === 'string' && Array.isArray(first?.members) && first.members.every((m) => typeof m.key === 'string'),
    JSON.stringify(first?.members)?.slice(0, 120),
  )
  check('a card carries its member count', typeof first?.memberCount === 'number', String(first?.memberCount))
  check('a card carries bilingual text', typeof first?.title?.zh === 'string' && typeof first?.title?.en === 'string')

  // -- 2. detail -----------------------------------------------------------
  const detail = await call('GET', `/api/detail?id=${encodeURIComponent(first.id)}`)
  check('GET /api/detail answers 200', detail.status === 200, detail.status === 200 ? '' : detail.text.slice(0, 160))
  check('detail carries a readme', typeof detail.json?.readme?.zh === 'string' && detail.json.readme.zh.length > 20)
  check('detail carries every member with a reason', (detail.json?.members?.length ?? 0) === first.memberCount, String(detail.json?.members?.length))
  check(
    'detail carries capability sources',
    Array.isArray(detail.json?.capabilities) && detail.json.capabilities.every((c) => Array.isArray(c.sources)),
  )
  const missing = await call('GET', '/api/detail?id=no-such-bundle')
  check('an unknown detail is a 404, not a 500', missing.status === 404, String(missing.status))

  // -- 3. capabilities -----------------------------------------------------
  const caps = await call('GET', '/api/capabilities')
  check('GET /api/capabilities answers the host kind', caps.json?.hostKind === 'desktop' && caps.json?.canRestart === false)

  // -- 4. the stream before anything happens -------------------------------
  const stream = await openStream(`${base}/api/progress`)
  const opening = await stream.next()
  check('the stream opens with capabilities', opening?.event === 'capabilities', JSON.stringify(opening))
  const snapshot = await stream.next()
  check('a fresh stream reports no operation', snapshot?.event === 'snapshot' && snapshot.data.op === null, JSON.stringify(snapshot?.data))

  // -- 5. install, watching the stream -------------------------------------
  // One member of the second bundle is made to fail, so that a single run
  // covers both the success path and the "a failed member does not end the
  // run" promise the whole design rests on (§7.3).
  const target = index.bundles[1] ?? index.bundles[0]
  const victimSpec = target.members[1]?.spec
  if (victimSpec !== undefined) manager.failFor.add(victimSpec.replace(/^npm:/u, '').replace(/@[^/]*$/u, ''))

  const install = await call('POST', '/api/install', { id: target.id })
  check('POST /api/install answers 200', install.status === 200, install.text.slice(0, 200))
  // The POST answers with the RUNNING record by design: a long run must not
  // hold an HTTP response open, so the report arrives on the stream's
  // `op-end`. The assertions below therefore read the run from the stream.
  check('the install is a live record', ['queued', 'preflight', 'installing'].includes(install.json?.status), String(install.json?.status))

  const seen = []
  let finished
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const event = await stream.next(deadline - Date.now())
    if (event === undefined) break
    seen.push(event.event)
    if (event.event === 'op-end') {
      finished = event.data?.op
      break
    }
  }
  check('the stream saw the run start', seen.includes('op-start'), seen.join(','))
  check('the stream saw member progress', seen.includes('member-start') || seen.includes('member-done'), seen.join(','))
  check('the stream saw the run end', seen.includes('op-end'), seen.join(','))
  check('the finished record carries a status', typeof finished?.status === 'string', String(finished?.status))
  check('the finished record reports per-member failure', Array.isArray(finished?.members))
  console.log(`     report: ${JSON.stringify({ status: finished?.status })}`)
  console.log(`     host now holds: ${[...manager.installed.keys()].join(', ') || '(nothing)'}`)
  if (victimSpec !== undefined) {
    check(
      'the doomed member is named in the failure list',
      (finished?.members ?? []).some((entry) => entry.state === 'failed' && entry.failure !== undefined),
      JSON.stringify((finished?.members ?? []).filter((entry) => entry.state === 'failed')),
    )
  }

  // -- 6. what the host now reports ---------------------------------------
  // The inventory is cached for a second, so a fresh read right after the run
  // would legitimately still miss it. Wait past the TTL rather than weakening
  // the assertion.
  await new Promise((done) => setTimeout(done, 1100))
  const after = await call('GET', '/api/bundles')
  const installedCard = after.json?.bundles?.find((entry) => entry.id === target.id)
  check('the installed bundle reports some members as installed', (installedCard?.installedCount ?? -1) > 0, String(installedCard?.installedCount))
  check('the host really holds the plugins', manager.installed.size > 0, `${String(manager.installed.size)} installed`)

  // -- 7. a second install while one is live ------------------------------
  // (Nothing is running now, so this checks the resting state instead.)
  const cancel = await call('POST', '/api/cancel')
  check('cancelling with nothing running is not an error', cancel.status === 202, String(cancel.status))

  // -- 8. uninstall preview and removal -----------------------------------
  const preview = await call('POST', '/api/uninstall/preview', { id: target.id })
  check('POST /api/uninstall/preview answers 200', preview.status === 200, preview.text.slice(0, 160))
  check('the preview explains why each member is checked', Array.isArray(preview.json?.members) && preview.json.members.every((m) => typeof m.reason === 'string'))
  const checked = (preview.json?.members ?? []).filter((m) => m.checked).map((m) => m.id)
  check('the members this bundle installed are pre-checked', checked.length > 0, `checked ${String(checked.length)}`)

  if (checked.length > 0) {
    const removal = await call('POST', '/api/uninstall', { id: target.id, ids: checked })
    check('POST /api/uninstall answers 200', removal.status === 200, removal.text.slice(0, 160))
    check('the removal lists what it removed', (removal.json?.removed?.length ?? 0) === checked.length, `${String(removal.json?.removed?.length)} of ${String(checked.length)}`)
    check('the host no longer holds them', manager.installed.size === 0, `${String(manager.installed.size)} still installed`)
    const emptyAgain = await call('POST', '/api/uninstall/preview', { id: target.id })
    const stillChecked = (emptyAgain.json?.members ?? []).filter((m) => m.checked)
    check('a second preview has nothing left pre-checked', stillChecked.length === 0, `${String(stillChecked.length)} checked`)
  }

  // -- 9. the guards -------------------------------------------------------
  const wrongMethod = await call('GET', '/api/install')
  check('a mutation refused by method is a 405', wrongMethod.status === 405, String(wrongMethod.status))
  const badBody = await call('POST', '/api/install', { nope: true })
  check('a body without an id is a 400', badBody.status === 400 && badBody.json?.allow === undefined, String(badBody.status))
  const crossSite = await fetch(`${base}/api/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ id: first.id }),
  })
  check('a cross-origin mutation is refused', crossSite.status === 403, String(crossSite.status))
  check('the idempotent GET works cross-origin', (await fetch(`${base}/api/bundles`, { headers: { origin: 'https://evil.example' } })).status === 200)

  // -- 10. the log export --------------------------------------------------
  // Driven over a real socket because its whole job is to be downloadable:
  // the headers decide whether the browser saves a file or renders text.
  const logs = await fetch(`${base}/api/logs`)
  const logText = await logs.text()
  check('the log export answers 200', logs.status === 200, String(logs.status))
  check(
    'the log export is a downloadable attachment',
    logs.headers.get('content-type') === 'text/plain; charset=utf-8'
      && (logs.headers.get('content-disposition') ?? '').includes('attachment; filename="dsh-suite-store-log.txt"'),
    `${logs.headers.get('content-type')} / ${logs.headers.get('content-disposition')}`,
  )
  check('the log export carries the live profile state', logText.includes('## profile state'), logText.slice(0, 120))
  check(
    'the log export recorded this run',
    logText.includes('## events this session') && /\[(info|warn|error)\] (install|catalog|mount|uninstall):/.test(logText),
    logText.split('\n').filter((line) => line.includes('[info]') || line.includes('[error]')).slice(0, 2).join(' | '),
  )
  // The export is meant to be pasted into a public issue.
  check(
    'the log export masks the home directory',
    !/Users[\\/][^\\/\s]+[\\/]/i.test(logText),
    (/(Users[\\/][^\\/\s]+[\\/].{0,40})/i.exec(logText) ?? [])[0] ?? '',
  )
  const logsByPost = await fetch(`${base}/api/logs`, { method: 'POST' })
  check('the log export refuses a non-GET', logsByPost.status === 405, String(logsByPost.status))

  stream.close()
  if (keepOpenMs > 0) {
    console.log(`\nsmoke: keeping ${base} open for ${String(keepOpenMs)} ms`)
    await new Promise((done) => setTimeout(done, keepOpenMs))
  }
  // Close idle/all connections first: `fetch` keeps sockets in a keep-alive
  // pool, and on Node 18+ `server.close()` waits for them, so shutdown could
  // stall at exit (or hang forever if the SSE socket was not fully released).
  await new Promise((done, fail) => {
    server.close((error) => (error === undefined || error === null ? done() : fail(error)))
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
  })

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\nsmoke: ${String(results.length - failed.length)}/${String(results.length)} checks passed`)
  if (failed.length > 0) {
    for (const entry of failed) console.log(`  failed: ${entry.name}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`)
    process.exitCode = 1
  }
  // The temp profile was never removed: every run leaked one directory.
  await rm(profile, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Read one SSE stream event by event.
 *
 * A parser rather than `EventSource`, because the script must see the frame
 * boundaries to assert on event names, and because undici's `EventSource` is
 * not available on every Node this package supports.
 */
async function openStream(url) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  if (response.body === null) throw new Error('the stream had no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const queue = []
  let done = false

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const event = /^event:\s*(.+)$/mu.exec(frame)?.[1]?.trim()
          const data = /^data:\s*(.*)$/mu.exec(frame)?.[1]
          if (event !== undefined) {
            let parsed = data
            try {
              parsed = JSON.parse(data ?? '')
            } catch {
              parsed = data
            }
            queue.push({ event, data: parsed })
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // Abort lands here; the queue already holds everything received.
    } finally {
      done = true
    }
  })()

  return {
    async next(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (queue.length === 0) {
        if (done || Date.now() > deadline) return undefined
        await new Promise((tick) => setTimeout(tick, 5))
      }
      return queue.shift()
    },
    close() {
      controller.abort()
      void pump
    },
  }
}

/**
 * Run the smoke suite, always tearing the server down.
 *
 * A throw inside `main` used to skip the stream close, the server close and the
 * summary block: the process then lingered with a listening server instead of
 * failing fast with a non-zero exit code.
 */
try {
  await main()
} catch (error) {
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
