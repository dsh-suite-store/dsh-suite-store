/**
 * The generated submission must be valid before it is ever downloaded.
 *
 * These tests mirror the catalog's own admission rules: if this module gets
 * looser than the catalog, the UI would happily produce a file CI rejects.
 */
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import {
  submissionFilename,
  submissionYaml,
  validateDraft,
  type SubmissionDraft,
} from '../src/submission/model.ts'

const CATEGORIES = ['productivity', 'research']

function draft(overrides: Partial<SubmissionDraft> = {}): SubmissionDraft {
  return {
    owner: 'octocat',
    id: 'daily-driver',
    version: '1.0.0',
    title: { en: 'Daily driver', zh: '日常主力' },
    summary: { en: 'A practical everyday setup.', zh: '实用的日常配置。' },
    category: 'productivity',
    members: ['owner-one/plugin-one', 'owner-two/plugin-two'],
    ...overrides,
  }
}

describe('submission draft validation', () => {
  it('accepts the minimum valid draft', () => {
    expect(validateDraft(draft(), CATEGORIES)).toEqual([])
  })

  it('rejects missing and malformed identity fields', () => {
    const issues = validateDraft(draft({ owner: '-bad', id: 'A', version: '1.0' }), CATEGORIES)
    expect(issues.map((issue) => [issue.field, issue.code])).toEqual([
      ['owner', 'invalid-owner'],
      ['id', 'invalid-id'],
      ['version', 'invalid-version'],
    ])
  })

  it('applies the catalog summary limit by Unicode code point', () => {
    const issues = validateDraft(draft({ summary: { en: 'x'.repeat(41), zh: '好'.repeat(41) } }), CATEGORIES)
    expect(issues.map((issue) => issue.field)).toEqual(['summary.en', 'summary.zh'])
    expect(issues.every((issue) => issue.code === 'summary-too-long')).toBe(true)
  })

  it('requires 2-10 unique, well-formed members', () => {
    expect(validateDraft(draft({ members: ['owner-one/plugin-one'] }), CATEGORIES)[0]?.code).toBe('member-count')
    expect(validateDraft(draft({ members: Array.from({ length: 11 }, (_, index) => `owner/plugin-${String(index)}`) }), CATEGORIES)[0]?.code).toBe('member-count')
    expect(validateDraft(draft({ members: ['owner/plugin', 'owner/plugin'] }), CATEGORIES)[0]?.code).toBe('duplicate-member')
    expect(validateDraft(draft({ members: ['not a member', 'owner/plugin'] }), CATEGORIES)[0]?.code).toBe('invalid-member')
  })

  it('rejects a category outside the catalog tree', () => {
    expect(validateDraft(draft({ category: 'not-a-category' }), CATEGORIES)).toEqual([
      { field: 'category', code: 'invalid-category' },
    ])
  })
})

describe('submission YAML', () => {
  it('emits the minimal template and omits blank optional Chinese text', () => {
    const yaml = submissionYaml(draft({ title: { en: 'Quoted: title', zh: '' }, summary: { en: 'A "quoted" summary.', zh: '' } }))
    const parsed = parseYaml(yaml) as Record<string, unknown>
    expect(parsed).toMatchObject({
      id: 'daily-driver',
      owner: 'octocat',
      version: '1.0.0',
      title: { en: 'Quoted: title' },
      summary: { en: 'A "quoted" summary.' },
      category: { primary: 'productivity' },
      members: [{ plugin: 'owner-one/plugin-one' }, { plugin: 'owner-two/plugin-two' }],
    })
    expect(parsed['title']).not.toHaveProperty('zh')
    expect(parsed['summary']).not.toHaveProperty('zh')
    expect(yaml.endsWith('\n')).toBe(true)
  })

  it('uses the version as the downloaded filename', () => {
    expect(submissionFilename(draft())).toBe('1.0.0.yml')
  })
})