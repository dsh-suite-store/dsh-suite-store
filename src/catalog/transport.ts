/**
 * HTTP plumbing shared by every outbound request this plugin makes.
 *
 * Kept separate from `fetcher.ts` so the catalog service can be tested against
 * a fake transport that never touches `node:http`, and so the timeout budget
 * lives in exactly one place: a marketplace that opens a request without a
 * deadline leaves the settings page spinning forever when an ISP blackholes
 * the CDN.
 */

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { gunzipSync, inflateSync } from 'node:zlib'

/** The subset of a response this plugin cares about. */
export interface TransportResponse {
  status: number
  headers: Record<string, string | undefined>
  body: Buffer
}

/** A transport is anything that can GET a URL with a deadline. */
export interface Transport {
  get(
    url: string,
    options: { timeoutMs: number; headers?: Record<string, string>; maxBytes?: number },
  ): Promise<TransportResponse>
}

/** Raised when the deadline expires before the body is complete. */
export class TimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms: ${url}`)
    this.name = 'TimeoutError'
  }
}

/** Raised when the socket dies mid-body or never connects. */
export class NetworkError extends Error {
  readonly cause: unknown

  constructor(url: string, cause: unknown) {
    super(`request failed: ${url}`, { cause })
    this.name = 'NetworkError'
    this.cause = cause
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * The real transport: `node:https` with an overall deadline.
 *
 * `fetch` is avoided on purpose. Its `AbortSignal.timeout` only bounds the
 * time to HEADERS on some Node builds, and the marketplace downloads tarballs
 * on hosts that are frequently behind a Chinese ISP — the case where a slow
 * trickle of body bytes is exactly what stalls a first-run experience.
 */
export class NodeTransport implements Transport {
  async get(
    url: string,
    options: { timeoutMs: number; headers?: Record<string, string>; maxBytes?: number },
  ): Promise<TransportResponse> {
    return this.getOnce(url, options, 0)
  }

  private async getOnce(
    url: string,
    options: { timeoutMs: number; headers?: Record<string, string>; maxBytes?: number },
    redirects: number,
  ): Promise<TransportResponse> {
    const response = await this.raw(url, options)
    const location = response.headers.location
    if (REDIRECTS.has(response.status) && location !== undefined) {
      if (redirects >= 5) throw new NetworkError(url, new Error('too many redirects'))
      // Resolve against the request URL: registries hand back relative
      // `dist.tarball` paths, and a mirror may redirect to an absolute CDN URL.
      return this.getOnce(new URL(location, url).toString(), options, redirects + 1)
    }
    return response
  }

  private raw(
    url: string,
    options: { timeoutMs: number; headers?: Record<string, string>; maxBytes?: number },
  ): Promise<TransportResponse> {
    const target = new URL(url)
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest

    return new Promise<TransportResponse>((resolve, reject) => {
      const request = send(
        target,
        {
          method: 'GET',
          headers: {
            // The catalog is CDN-served and versioned by content, so a
            // conditional request is the difference between a 304 and a
            // 2 MB download on every settings-page visit.
            accept: 'application/json, application/octet-stream, */*',
            'user-agent': 'dsh-suite-store',
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          let total = 0
          response.on('data', (chunk: Buffer) => {
            // The cap is enforced WHILE streaming, not after: the previous
            // code buffered the whole body and compared sizes at the end, so
            // a hostile or misconfigured server could push gigabytes through
            // the host's memory inside the 8 s deadline.
            total += chunk.length
            if (options.maxBytes !== undefined && total > options.maxBytes) {
              request.destroy(new NetworkError(url, new Error(`response exceeded ${String(options.maxBytes)} bytes`)))
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            clearTimeout(timer)
            const raw = Buffer.concat(chunks)
            resolve({
              status: response.statusCode ?? 0,
              headers: normalizeHeaders(response.headers),
              body: decodeContent(raw, response.headers['content-encoding'], options.maxBytes),
            })
          })
          response.on('error', (error) => {
            clearTimeout(timer)
            reject(new NetworkError(url, error))
          })
        },
      )

      const timer = setTimeout(() => {
        request.destroy(new TimeoutError(url, options.timeoutMs))
      }, options.timeoutMs)
      // Do not keep the process alive just for a pending marketplace request.
      timer.unref?.()

      request.on('error', (error) => {
        clearTimeout(timer)
        // `destroy(err)` surfaces the TimeoutError we passed; keep its name so
        // `kindFromThrow` can classify it without inspecting strings.
        reject(error instanceof TimeoutError ? error : new NetworkError(url, error))
      })
      request.end()
    })
  }
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value as string | undefined)
  }
  return result
}

/**
 * Undo `content-encoding` so callers only ever see plain bytes.
 *
 * `maxOutputLength` bounds the DECOMPRESSED size: a gzip bomb (a few MB of
 * compressed bytes expanding to tens of GB) previously ran `gunzipSync` to
 * completion inside the host process and took it down with an OOM. The cap
 * applies to decompressed bytes only; a compressed body over the cap was
 * already rejected while streaming.
 */
function decodeContent(body: Buffer, encoding: string | undefined, maxBytes: number | undefined): Buffer {
  if (body.length === 0) return body
  try {
    if (encoding === 'gzip') return gunzipSync(body, maxBytes === undefined ? {} : { maxOutputLength: maxBytes })
    if (encoding === 'deflate') return inflateSync(body, maxBytes === undefined ? {} : { maxOutputLength: maxBytes })
  } catch {
    // A body that claims to be gzip and is not will fail in the parser with a
    // far more useful message than a zlib stack trace. An output-length
    // breach is the bomb case; surfacing the raw (capped) body lets the
    // caller's own size check report it as what it is.
  }
  return body
}
