/**
 * Minimal HTTP helpers for the store's own routes: JSON replies, an SSE
 * stream, and the small amount of request hygiene the routes need.
 *
 * These are deliberately not a framework. Every route here is a single
 * `register({ kind, path, handler })` on the host's `webServer`, and the whole
 * surface is four endpoints; a router would add a dependency and a second way
 * to say "this route exists" without removing any of the code below.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Content type for every JSON answer; one place so the client can rely on it. */
const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * Write a JSON payload.
 *
 * `no-store` is not laziness: every one of these answers is derived from live
 * profile state or a snapshot that can change between two requests, and a
 * cached 200 for "is this bundle installed" would show a stale button that
 * triggers a second install.
 */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  // Serialize BEFORE committing the status line: a payload that throws in
  // `JSON.stringify` (a cycle, a BigInt, a hostile `toJSON`) would otherwise
  // leave headers on the wire with no body, and the caller's `sendError` in
  // the `catch` would then throw ERR_HTTP_HEADERS_SENT — turning an error
  // reply into an unanswered request.
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': JSON_TYPE,
  })
  response.end(body)
}

/** Write an error in the one shape the client parses. */
export function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message })
}

/** Answer a method the route does not serve. */
export function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  // The same shape as every other answer. A 405 with an empty body and no
  // content-type was the one reply a client could reach with a POST and then
  // fail to parse, which is the opposite of what an error answer is for.
  response.writeHead(405, {
    'cache-control': 'no-store',
    'content-type': JSON_TYPE,
    allow: allowed.join(', '),
  })
  response.end(JSON.stringify({ error: 'method not allowed' }))
}

/**
 * An open server-sent-events stream.
 *
 * The shape is a thin wrapper rather than a route-level concern because the
 * install progress stream outlives the request that started it: the client
 * reconnects to read progress it missed, and the route layer needs to hold,
 * forward to, and close these independently of `run()`.
 */
export interface EventStream {
  /** Send one event; a no-op once the client is gone. */
  send(event: string, payload: unknown): void
  /** Send a comment, which keeps proxies from dropping an idle connection. */
  keepAlive(): void
  /** Close the response and stop accepting writes. */
  close(): void
  /** Whether the client is still connected. */
  readonly open: boolean
}

/** Bytes of padding used to defeat a buffering proxy on first byte. */
const SSE_PREAMBLE = ':'.concat(' '.repeat(2046), '\n\n')

/**
 * Open an SSE stream on a response.
 *
 * The preamble is the §11② escape hatch: if the host's middleware buffers
 * responses, a client sees nothing at all until the buffer fills, and every
 * proxy in the chain has a >2 KiB heuristic for "this is a stream, flush it".
 * A client that ignores comments (every `EventSource` does) loses nothing.
 *
 * @param request - used only to notice the client hanging up.
 * @param response - the response to take over.
 * @returns the stream handle.
 */
export function openEventStream(request: IncomingMessage, response: ServerResponse): EventStream {
  response.writeHead(200, {
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    // Nginx and friends buffer text/* unless told otherwise.
    'x-accel-buffering': 'no',
  })
  response.write(SSE_PREAMBLE)

  let open = true
  const finish = () => {
    if (!open) return
    open = false
    response.end()
  }
  request.on('close', finish)
  request.on('error', finish)
  // The response can die on its own — a reset mid-write, a host middleware
  // ending it — and one `open` flag has to cover both sides. Without a
  // listener here an `'error'` emitted by the stream is unhandled, which throws.
  response.on('close', finish)
  response.on('error', finish)

  return {
    get open() {
      return open
    },
    send(event, payload) {
      if (!open) return
      // JSON is a valid single-line SSE payload as long as newlines are
      // escaped, which JSON.stringify already does for every value.
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    },
    keepAlive() {
      if (!open) return
      response.write(': keep-alive\n\n')
    },
    close: finish,
  }
}

/** Read and parse a JSON request body, refusing anything over `maxBytes`. */
export async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8')
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * Whether a mutating request came from the page this plugin is served in.
 *
 * `Host` is the header a rebinding page cannot forge, so checking it is the
 * actual defence; `origin` is checked when present because a browser always
 * sends it on a cross-origin POST. A missing `Origin` is accepted: a
 * non-browser caller can set any origin it likes, so refusing absence only
 * breaks proxies that strip it.
 *
 * @param request - the incoming request.
 * @returns false when the request is demonstrably foreign.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const host = request.headers.host
  // No `Host` means no defence at all, so a request that DOES name an origin is
  // not accepted on faith: that is exactly the case the header is meant to
  // settle. A caller that sent neither header (a proxy that strips both) keeps
  // the documented tolerance.
  if (host === undefined) return request.headers.origin === undefined
  if (!loopbackAuthority(host)) return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    // Chrome may state a loopback origin without its port. Accept that ONLY
    // when the origin really omitted the port: comparing hostnames alone
    // accepted any other local application, so a dev server on :3000 could
    // drive these routes on :56018 — the browser calls that `same-site`, so
    // the `sec-fetch-site` check above does not stop it.
    if (url.host.toLowerCase() === host.toLowerCase()) return true
    // The Host's HOST part, not `host.split(':')[0]`: that yields `[` for
    // `[::1]:56018` and silently rejected a legitimate IPv6 loopback origin.
    return loopbackAuthority(url.host) && url.port === '' && url.hostname.toLowerCase() === authorityName(host)
  } catch {
    return false
  }
}

/** The host part of an authority, brackets kept and case folded: `[::1]:3080` -> `[::1]`. */
function authorityName(host: string): string {
  const lower = host.toLowerCase()
  const close = lower.startsWith('[') ? lower.indexOf(']') : -1
  // A bracketed authority with no closing bracket is not a name; the raw first
  // segment it falls back to matches no loopback name, i.e. it fails closed.
  return close === -1 ? (lower.split(':')[0] ?? lower) : lower.slice(0, close + 1)
}

/** Whether an authority names this machine. */
export function loopbackAuthority(host: string): boolean {
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : (lower.split(':')[0] ?? lower)
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}
