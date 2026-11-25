/**
 * Behavioural specs for source planning and the failure taxonomy.
 *
 * No network: `catalogPlan` is pure and the error classes are plain data, so
 * this file pins the ORDER the marketplace will try things in — including the
 * case that matters most on a Chinese network, where the official registry is
 * slower than the mirror.
 */

import { describe, expect, it } from 'vitest'
import {
  CATALOG_PACKAGE,
  CATALOG_URL,
  CHINA_NPM_FALLBACK,
  NPM_OFFICIAL,
  catalogPlan,
} from '../src/catalog/sources.ts'
import {
  CatalogFetchError,
  describeFailures,
  kindFromStatus,
  kindFromThrow,
} from '../src/catalog/errors.ts'

describe('catalogPlan', () => {
  it('tries the CDN before any registry', () => {
    expect(catalogPlan().map((source) => source.label)).toEqual(['cdn', 'npm', 'npmmirror'])
  })

  it('points the first attempt at the document the data repo publishes', () => {
    const [first] = catalogPlan()
    expect(first).toEqual({ kind: 'url', url: CATALOG_URL, label: 'cdn' })
  })

  it('carries the host registry through to the npm step', () => {
    const [, npm] = catalogPlan({ registry: 'https://registry.example.test' })
    expect(npm).toEqual({
      kind: 'npm',
      registry: 'https://registry.example.test',
      pkg: CATALOG_PACKAGE,
      file: 'package/index.json',
      label: 'npm',
    })
  })

  it('does not request the same mirror twice when the host already points at it', () => {
    expect(catalogPlan({ registry: CHINA_NPM_FALLBACK }).map((source) => source.label)).toEqual(['cdn', 'npm'])
  })

  it('tolerates a registry URL with a trailing slash', () => {
    expect(catalogPlan({ registry: `${CHINA_NPM_FALLBACK}/` }).map((source) => source.label)).toEqual(['cdn', 'npm'])
  })

  it('moves the mirror first once a previous run saw the official host stall', () => {
    // D5's whole point: do not make the user wait through the same timeout
    // on every session after the first one proved the official host is slow.
    expect(catalogPlan({ preferFallback: true }).map((source) => source.label)).toEqual(['npmmirror', 'cdn', 'npm'])
  })

  it('does not duplicate the mirror when preferring the fallback on a mirror registry', () => {
    expect(catalogPlan({ registry: CHINA_NPM_FALLBACK, preferFallback: true }).map((source) => source.label)).toEqual(['cdn', 'npm'])
  })

  it('falls back to the public registry when the host names none', () => {
    const [, npm] = catalogPlan()
    expect(npm.kind === 'npm' && npm.registry).toBe(NPM_OFFICIAL)
  })

  it('reads a named file and nothing else', () => {
    // A local mirror or a not-yet-published catalog build. Adding the network
    // sources back after it would install whatever the CDN has instead, which
    // is exactly what the operator was trying to avoid.
    expect(catalogPlan({ file: '/srv/catalog/index.json' })).toEqual([
      { kind: 'file', path: '/srv/catalog/index.json', label: 'file' },
    ])
  })

  it('ignores an empty file value so a blank config field changes nothing', () => {
    expect(catalogPlan({ file: '' }).map((source) => source.label)).toEqual(['cdn', 'npm', 'npmmirror'])
  })
})

describe('CatalogFetchError', () => {
  it('marks a timeout as transient so the next source is tried', () => {
    const failure = new CatalogFetchError('timeout', 'cdn', 'timed out after 8000ms')
    expect(failure.transient).toBe(true)
    expect(failure.message).toBe('cdn: timed out after 8000ms')
  })

  it('does not call a 404 transient — that host simply has no such file', () => {
    const failure = new CatalogFetchError('not-found', 'cdn', 'status 404', { status: 404 })
    expect(failure.transient).toBe(false)
    expect(failure.status).toBe(404)
  })

  it('classifies a 5xx and a 429 as worth retrying elsewhere', () => {
    expect(kindFromStatus(503)).toBe('server-error')
    expect(kindFromStatus(429)).toBe('server-error')
  })

  it('does not mistake a 403 for a transient outage', () => {
    expect(kindFromStatus(403)).toBe('invalid')
  })

  it('classifies an aborted request as a timeout', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(kindFromThrow(aborted)).toBe('timeout')
    expect(kindFromThrow(new Error('ECONNREFUSED'))).toBe('unreachable')
  })

  it('summarises several failures in one readable line', () => {
    const failures = [
      new CatalogFetchError('timeout', 'cdn', 'timed out after 8000ms'),
      new CatalogFetchError('unreachable', 'npm', 'request failed'),
    ]
    expect(describeFailures(failures)).toBe('cdn: timed out after 8000ms; npm: request failed')
    expect(describeFailures([])).toBe('')
  })
})
