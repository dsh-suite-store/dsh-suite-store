import { describe, expect, it } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'

import { loopbackAuthority, openEventStream, readJsonBody, sameOrigin, sendJson } from '../src/server/http.ts'

/** A response that records what was written to it. */
function fakeResponse() {
  const chunks: string[] = []
  const response = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    ended: false,
    writeHead(status: number, headers: Record<string, unknown>) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    write(chunk: string) {
      chunks.push(chunk)
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk)
      this.ended = true
    },
    // The SSE stream watches the response for teardown as well as the request
    // (one `open` flag has to cover both sides), so the double needs a
    // listener stub. Nothing in these tests emits through it.
    on() {
      return this
    },
  }
  return { response: response as unknown as ServerResponse, raw: response, chunks }
}

/** A request with the headers a test cares about. */
function fakeRequest(headers: Record<string, string> = {}): IncomingMessage {
  const request = new PassThrough() as unknown as IncomingMessage
  request.headers = headers
  return request
}

describe('http helpers', () => {
  it('serializes JSON with no-store', () => {
    const { response, raw, chunks } = fakeResponse()
    sendJson(response, 200, { a: 1 })
    expect(raw.statusCode).toBe(200)
    expect(raw.headers['cache-control']).toBe('no-store')
    expect(raw.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(chunks.join('')).toBe('{"a":1}')
  })

  it('reads a JSON body', async () => {
    const request = Readable.from([Buffer.from('{"spec":"npm:x@1.0.0"}')]) as unknown as IncomingMessage
    expect(await readJsonBody(request)).toEqual({ spec: 'npm:x@1.0.0' })
  })

  it('treats an empty body as undefined', async () => {
    const request = Readable.from([]) as unknown as IncomingMessage
    expect(await readJsonBody(request)).toBeUndefined()
  })

  it('refuses a body over the cap', async () => {
    const request = Readable.from([Buffer.from(`{"a":"${'x'.repeat(200)}"}`)]) as unknown as IncomingMessage
    await expect(readJsonBody(request, 32)).rejects.toThrow(/too large/u)
  })

  it('recognizes loopback authorities only', () => {
    expect(loopbackAuthority('127.0.0.1:3080')).toBe(true)
    expect(loopbackAuthority('LOCALHOST')).toBe(true)
    expect(loopbackAuthority('[::1]:3080')).toBe(true)
    expect(loopbackAuthority('example.com')).toBe(false)
    expect(loopbackAuthority('192.168.1.4:3080')).toBe(false)
  })

  it('accepts a same-origin POST from a loopback page', () => {
    expect(sameOrigin(fakeRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }))).toBe(true)
  })

  it('accepts a loopback origin that omits the port', () => {
    expect(sameOrigin(fakeRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1' }))).toBe(true)
  })

  it('refuses a different loopback port', () => {
    // `same-site` includes the whole loopback family, so the fetch-site header
    // cannot help here. A dev server on :3000 must not drive these routes.
    expect(sameOrigin(fakeRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3000' }))).toBe(false)
  })

  it('refuses a cross-site request', () => {
    expect(sameOrigin(fakeRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })

  it('refuses a forged host', () => {
    expect(sameOrigin(fakeRequest({ host: 'evil.example', origin: 'http://evil.example' }))).toBe(false)
  })

  it('refuses a foreign origin on a loopback host', () => {
    expect(sameOrigin(fakeRequest({ host: '127.0.0.1:3080', origin: 'https://evil.example' }))).toBe(false)
  })

  it('accepts a request with no origin, because it is not a page', () => {
    expect(sameOrigin(fakeRequest({ host: '127.0.0.1:3080' }))).toBe(true)
  })

  it('opens a stream with the unbuffering preamble', () => {
    const { response, raw, chunks } = fakeResponse()
    const stream = openEventStream(fakeRequest(), response)
    expect(raw.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(raw.headers['x-accel-buffering']).toBe('no')
    expect((chunks[0] ?? '').length).toBeGreaterThan(2048)
    stream.send('op-start', { a: 1 })
    expect(chunks.at(-1)).toBe('event: op-start\ndata: {"a":1}\n\n')
    stream.keepAlive()
    expect(chunks.at(-1)).toBe(': keep-alive\n\n')
    stream.close()
    expect(raw.ended).toBe(true)
  })

  it('stops writing once the client goes away', () => {
    const request = fakeRequest()
    const { response, chunks } = fakeResponse()
    const stream = openEventStream(request, response)
    request.emit('close')
    stream.send('op-start', { a: 1 })
    expect(stream.open).toBe(false)
    expect(chunks.some((chunk) => chunk.includes('op-start'))).toBe(false)
  })
})
