import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendProfileBundle, dropProfileRows, profileHasBundle } from '../src/install/profile-bundle.ts'

let dir: string

function manifest(bundles: string[]): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }, null, 2))
}

function bundles(): string[] {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }).dsh.profile.bundles
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'profile-bundle-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('appendProfileBundle', () => {
  it('appends a new bundle, keeping every existing position', () => {
    manifest(['@deepseek-ai/dsh-base', '@scope/member-bundle', '@deepseek-ai/dsh-web-app'])
    expect(appendProfileBundle(dir, '@scope/new-bundle')).toBe(true)
    expect(bundles()).toEqual([
      '@deepseek-ai/dsh-base', '@scope/member-bundle', '@deepseek-ai/dsh-web-app', '@scope/new-bundle',
    ])
  })

  it('is idempotent — an existing row is left untouched', () => {
    manifest(['a', 'b'])
    expect(appendProfileBundle(dir, 'b')).toBe(false)
    expect(bundles()).toEqual(['a', 'b'])
  })

  it('never adds an official in-box bundle', () => {
    manifest(['a'])
    expect(appendProfileBundle(dir, '@deepseek-ai/dsh-base')).toBe(false)
    expect(bundles()).toEqual(['a'])
  })

  it('creates the dsh.profile.bundles path when the manifest has none', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile' }))
    expect(appendProfileBundle(dir, 'new-bundle')).toBe(true)
    expect(bundles()).toEqual(['new-bundle'])
  })

  it('answers false for an unreadable manifest rather than throwing', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(appendProfileBundle(dir, 'new-bundle')).toBe(false)
  })
})

describe('profileHasBundle', () => {
  it('reports membership without writing', () => {
    manifest(['a', 'b'])
    expect(profileHasBundle(dir, 'b')).toBe(true)
    expect(profileHasBundle(dir, 'c')).toBe(false)
  })

  it('answers false for an unreadable manifest', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(profileHasBundle(dir, 'a')).toBe(false)
  })
})

describe('dropProfileRows', () => {
  it('drops both the dependency and the bundle row', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@scope/gone': 'github:scope/gone', keep: '^1.0.0' },
      dsh: { profile: { bundles: ['a', '@scope/gone', 'b'] } },
    }, null, 2))
    expect(dropProfileRows(dir, '@scope/gone')).toEqual(['dependencies', 'dsh.profile.bundles'])
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(Object.keys(after.dependencies)).toEqual(['keep'])
    expect(after.dsh.profile.bundles).toEqual(['a', 'b'])
  })

  it('is idempotent — nothing to drop answers an empty list', () => {
    manifest(['a'])
    expect(dropProfileRows(dir, 'missing')).toEqual([])
  })

  it('never touches an official in-box bundle', () => {
    manifest(['a', '@deepseek-ai/dsh-base'])
    expect(dropProfileRows(dir, '@deepseek-ai/dsh-base')).toEqual([])
    expect(bundles()).toEqual(['a', '@deepseek-ai/dsh-base'])
  })
})
