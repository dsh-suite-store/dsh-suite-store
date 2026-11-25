/**
 * The copy table's own contract: both columns say the same thing.
 *
 * `Copy` is `{ zh: string; en: string }`, which the compiler checks for
 * presence and nothing else. What it cannot check is that the two columns
 * carry the SAME PLACEHOLDERS — so a translator writing `{reson}` in one column
 * (or dropping a `{count}` in the other) compiles, ships, and then leaks the
 * literal token to the reader: `fill()` leaves an unknown placeholder as it
 * found it, on purpose, so the bug is visible rather than silently blank.
 *
 * That trade-off only works if something notices. This is that something.
 *
 * The table is also asserted to be non-empty and to hold no empty sentence,
 * because a key present with `''` in one language is the other half of the
 * same "typed but not synced" gap.
 */

import { describe, expect, it } from 'vitest'

import { COPY, fill, type Copy } from '../src/client/copy.ts'

/** Every `{name}` token in a sentence, as a sorted, de-duplicated list. */
function placeholders(sentence: string): string[] {
  return [...new Set([...sentence.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!))].sort()
}

const entries = Object.entries(COPY) as [string, Copy][]

describe('the copy table', () => {
  it('has sentences in it', () => {
    // A guard on the guard: an empty or broken import would make every
    // assertion below vacuously true.
    expect(entries.length).toBeGreaterThan(100)
  })

  it('holds no empty sentence in either language', () => {
    const empty: string[] = []
    for (const [key, pair] of entries) {
      if (pair.zh.trim() === '') empty.push(`${key}.zh`)
      if (pair.en.trim() === '') empty.push(`${key}.en`)
    }
    expect(empty).toEqual([])
  })

  it('declares the same placeholders in both languages', () => {
    // This is the assertion the `Copy` type cannot express. A mismatch means
    // one column renders a sentence with a literal `{token}` in it while the
    // other renders the value — the exact failure `fill()` refuses to hide.
    const mismatched: string[] = []
    for (const [key, pair] of entries) {
      const zh = placeholders(pair.zh)
      const en = placeholders(pair.en)
      if (zh.join(',') !== en.join(',')) {
        mismatched.push(`${key}: zh{${zh.join(',')}} vs en{${en.join(',')}}`)
      }
    }
    expect(mismatched).toEqual([])
  })

  it('leaves an unknown placeholder in place rather than blanking it', () => {
    // The behaviour the mismatch check above depends on: a leaked token is a
    // visible bug report, not a silently shortened sentence.
    expect(fill('errorLoad', 'en', {})).toContain('{reason}')
  })

  it('fills a declared placeholder in both languages', () => {
    expect(fill('errorLoad', 'en', { reason: 'offline' })).toBe('Could not load the catalog: offline')
    expect(fill('errorLoad', 'zh', { reason: '离线' })).toBe('目录加载失败：离线')
  })
})
