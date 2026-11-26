import { describe, expect, it } from 'vitest'

import type { CuratedMember } from '../src/submission/curated.ts'
import {
  memberDescription,
  memberDisplayName,
  memberSource,
} from '../src/client/submission-members.ts'

const member = (overrides: Partial<CuratedMember> = {}): CuratedMember => ({
  key: 'owner/repo',
  owner: 'owner',
  name: 'repo',
  npm: null,
  version: null,
  url: 'https://github.com/owner/repo',
  ...overrides,
})

describe('submission member presentation', () => {
  it('prefers the npm package name as the readable plugin name', () => {
    expect(memberDisplayName(member({ npm: '@owner/dsh-memory' }))).toBe('@owner/dsh-memory')
  })

  it('uses the monorepo subpackage name when no npm name exists', () => {
    expect(memberDisplayName(member({ name: 'repo#packages/dsh-toolbox' }))).toBe('dsh-toolbox')
  })

  it('falls back to the repository name', () => {
    expect(memberDisplayName(member({ name: 'dsh-memory' }))).toBe('dsh-memory')
  })

  it('uses the active locale and falls back to the other locale', () => {
    const localized = member({ description: { zh: '中文说明', en: 'English description' } })
    expect(memberDescription(localized, 'zh')).toBe('中文说明')
    expect(memberDescription(member({ description: { en: 'Only English', zh: '' } }), 'zh')).toBe('Only English')
    expect(memberDescription(member({ description: { en: '', zh: '只有中文' } }), 'en')).toBe('只有中文')
  })

  it('marks curated entries that are already installed', () => {
    expect(memberSource(member(), new Set(['owner/repo']))).toBe('installed')
    expect(memberSource(member(), new Set())).toBe('curated')
  })
})