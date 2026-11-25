/**
 * A request/response pair for driving a route handler without a socket.
 *
 * Shared because two suites drive the same routes: the general one
 * (`routes.spec.ts`) and the log-export one (`routes-logs.spec.ts`). A copy in
 * each would drift on the details that matter — the response needs an `on` stub
 * because the SSE route watches both sides for teardown, and the default headers
 * have to pass the same-origin guard or every mutation test would read as 403.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export interface Exchange {
  request: IncomingMessage
  response: ServerResponse
  status(): number
  body(): string
  headers: Record<string, unknown> | { value: Record<string, unknown> }
  state: { status: number; headers: Record<string, unknown> }
}

/** Loopback headers that satisfy the same-origin guard. */
export const LOOPBACK_HEADERS: Record<string, string> = {
  host: '127.0.0.1:3080',
  origin: 'http://127.0.0.1:3080',
}

/**
 * Build a request/response pair and the accessors a test asserts through.
 *
 * @param method - HTTP method.
 * @param url - the request path.
 * @param body - JSON body to send, if any.
 * @param headers - request headers; defaults to loopback.
 * @returns the pair plus `status()`/`body()`/`state`.
 */
export function exchange(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = LOOPBACK_HEADERS,
): Exchange {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = Readable.from(payload) as unknown as IncomingMessage
  request.method = method
  request.url = url
  request.headers = headers
  const chunks: string[] = []
  const state = { status: 0, headers: {} as Record<string, unknown> }
  const response = {
    writeHead(status: number, incoming: Record<string, unknown>) {
      state.status = status
      state.headers = incoming
      return this
    },
    write(chunk: string) {
      chunks.push(chunk)
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk)
    },
    // `openEventStream` watches both the request and the response for teardown,
    // so this double needs the listener stub for the SSE routes.
    on() {
      return this
    },
  } as unknown as ServerResponse
  const headersRef = {
    get value() {
      return state.headers
    },
  }
  return {
    request,
    response,
    status: () => state.status,
    body: () => chunks.join(''),
    headers: headersRef,
    state,
  }
}
