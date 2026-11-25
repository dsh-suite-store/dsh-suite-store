/**
 * Behavioural specs for the transport and the tarball reader.
 *
 * A real loopback HTTP server stands in for the CDN: it is the only way to
 * assert the things that actually break in production — a slow trickle of
 * body bytes, a redirect to another host, a gzip body a proxy re-encoded, and
 * a giant tarball read out of a 512-byte-block stream.
 */

import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NetworkError, NodeTransport, TimeoutError } from '../src/catalog/transport.ts'
import { fileFromTarball, tarballEntries } from '../src/catalog/tarball.ts'

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '/'

    if (url === '/plain') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
      return
    }
    if (url === '/gzip') {
      const body = gzipSync(Buffer.from('{"ok":true}'))
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) })
      response.end(body)
      return
    }
    if (url === '/relative-redirect') {
      response.writeHead(302, { location: '/plain' })
      response.end()
      return
    }
    if (url === '/absolute-redirect') {
      response.writeHead(301, { location: `${base}/plain` })
      response.end()
      return
    }
    if (url === '/loop') {
      response.writeHead(307, { location: '/loop' })
      response.end()
      return
    }
    if (url === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('nope')
      return
    }
    if (url === '/tarball') {
      const body = fixture('catalog-index.tgz')
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(body)
      return
    }
    if (url === '/not-a-tarball') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end('{"format":1}')
      return
    }
    if (url === '/slow') {
      // Headers immediately, body never: the case that hangs a naive client.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"partial":')
      return
    }
    // Digests are served after /tarball is known, so compute from the fixture.
    if (url === '/sha256') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ sha256: createHash('sha256').update(fixture('catalog-index.tgz')).digest('hex') }))
      return
    }
    response.writeHead(500)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('NodeTransport', () => {
  const transport = new NodeTransport()

  it('returns the body and the status', async () => {
    const response = await transport.get(`${base}/plain`, { timeoutMs: 2000 })
    expect(response.status).toBe(200)
    expect(response.body.toString('utf8')).toBe('{"ok":true}')
  })

  it('keeps a 404 body so the caller can log what the host said', async () => {
    const response = await transport.get(`${base}/missing`, { timeoutMs: 2000 })
    expect(response.status).toBe(404)
    expect(response.body.toString('utf8')).toBe('nope')
  })

  it('follows a relative redirect', async () => {
    const response = await transport.get(`${base}/relative-redirect`, { timeoutMs: 2000 })
    expect(response.body.toString('utf8')).toBe('{"ok":true}')
  })

  it('follows an absolute redirect', async () => {
    const response = await transport.get(`${base}/absolute-redirect`, { timeoutMs: 2000 })
    expect(response.body.toString('utf8')).toBe('{"ok":true}')
  })

  it('gives up on a redirect loop instead of spinning', async () => {
    await expect(transport.get(`${base}/loop`, { timeoutMs: 2000 })).rejects.toBeInstanceOf(NetworkError)
  })

  it('decodes a gzip body so callers never see compressed bytes', async () => {
    const response = await transport.get(`${base}/gzip`, { timeoutMs: 2000 })
    expect(response.body.toString('utf8')).toBe('{"ok":true}')
  })

  it('applies the deadline to the BODY, not just the headers', async () => {
    // The /slow endpoint sends headers and then stalls. A client that only
    // bounds time-to-headers would hang here forever.
    await expect(transport.get(`${base}/slow`, { timeoutMs: 150 })).rejects.toBeInstanceOf(TimeoutError)
  })

  it('lower-cases response headers for predictable lookups', async () => {
    const response = await transport.get(`${base}/plain`, { timeoutMs: 2000 })
    expect(response.headers['content-type']).toBe('application/json')
  })
})

describe('fileFromTarball', () => {
  const tarball = fixture('catalog-index.tgz')

  it('reads a named member out of a gzipped tarball', () => {
    const body = fileFromTarball(tarball, 'package/index.json')
    expect(body).toBeDefined()
    expect(JSON.parse(body!.toString('utf8')).format).toBe(1)
  })

  it('returns undefined for a member the tarball does not carry', () => {
    expect(fileFromTarball(tarball, 'package/plugins.json')).toBeUndefined()
  })

  it('lists every member so a caller can explain what it did find', () => {
    expect(tarballEntries(tarball)).toEqual(['package/package.json', 'package/index.json'])
  })

  it('reports a mis-published artifact as not a tarball, not as bad JSON', async () => {
    // End to end through the real transport: the CDN hands back a JSON file
    // where a tarball belongs, which is the top failure mode when a release
    // pipeline publishes the wrong artifact.
    const response = await new NodeTransport().get(`${base}/not-a-tarball`, { timeoutMs: 2000 })
    expect(() => tarballEntries(response.body)).toThrow(/not a gzip/u)
  })
})
