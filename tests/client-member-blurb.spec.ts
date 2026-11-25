/**
 * Which sentence a member row shows: the author's reason, or the registry's
 * description.
 *
 * The order is a product decision, not an implementation detail: a member row
 * exists to answer "why is this plugin part of THIS bundle", and only the bundle
 * author can answer that. The package's own registry sentence describes the
 * package in general, was written for no bundle in particular, and is the
 * fallback for rows the author left without a reason.
 *
 * Both inputs reach `memberBlurb` already resolved for the locale (`text()`),
 * so this is the whole rule:
 *
 *   reason (author) > description (registry)
 *
 * The label matters as much as the text: the sheet tags the author's sentence
 * "推荐理由 / why it is here", and must not tag a registry description as one.
 */

import { describe, expect, it } from 'vitest'

import { memberBlurb } from '../src/client/Details.tsx'

describe('memberBlurb', () => {
  it("prefers the bundle author's reason over the package description", () => {
    // Both present: the author wins. This is the assertion that flipped — the
    // sheet used to show the registry description whenever it had one, which
    // hid the reason on almost every row of a shipped catalog.
    expect(memberBlurb('这里提供会话记忆', 'A memory plugin for DSH')).toEqual({
      text: '这里提供会话记忆',
      fromAuthor: true,
    })
  })

  it('falls back to the description when the author gave no reason', () => {
    expect(memberBlurb('', 'A memory plugin for DSH')).toEqual({
      text: 'A memory plugin for DSH',
      fromAuthor: false,
    })
  })

  it('yields nothing when neither sentence exists', () => {
    // The row draws no paragraph at all in this case, rather than an empty one.
    expect(memberBlurb('', '')).toEqual({ text: '', fromAuthor: false })
  })

  it('never marks a registry description as the author’s', () => {
    // The tag is derived from this flag, so a wrong flag mislabels the text.
    expect(memberBlurb('', 'registry text').fromAuthor).toBe(false)
    expect(memberBlurb('author text', '').fromAuthor).toBe(true)
  })
})
