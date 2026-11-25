/**
 * Which image a suite's icon draws.
 *
 * The rule, not the drawing. `BundleIcon` renders JSX and this project has no
 * test renderer — the convention is that pixels are verified in a real host — so
 * asserting on a component would mean string-matching JSX, which proves nothing.
 * The decision is the part that can be silently wrong: an `http://` URL that
 * reaches an `<img src>`, or a `null` that draws an empty box instead of the
 * bundled mark.
 */

import { describe, expect, it } from 'vitest'

import { iconSource } from '../src/client/BundleIcon.tsx'

describe('iconSource', () => {
  it('uses an https icon', () => {
    const src = 'https://raw.githubusercontent.com/a/b/main/icon.png'
    expect(iconSource({ icon: src })).toEqual({ kind: 'image', src })
  })

  it('falls back to the bundled mark when there is no icon', () => {
    // `null` is the builder's signal for "no contributed image and no avatar":
    // the first-party owner, or a catalog that predates the field.
    expect(iconSource({ icon: null })).toEqual({ kind: 'default' })
  })

  it('refuses any scheme but https even though the parser already did', () => {
    // Defence in depth at the one place an `<img src>` is built from catalog
    // data. The parser is the real gate; this makes a regression there a blank
    // icon rather than a request to a hostile origin.
    for (const bad of [
      'http://example.com/i.png',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//example.com/i.png',
      '/local.png',
      '',
    ]) {
      expect(iconSource({ icon: bad }), bad).toEqual({ kind: 'default' })
    }
  })

  it('treats a missing field as the default mark', () => {
    // An old catalog document has no `icon` key at all.
    expect(iconSource({} as { icon: null })).toEqual({ kind: 'default' })
  })

  it('falls back to the default mark once that URL has failed to load', () => {
    // A contributed icon is a URL someone typed. When it 404s, the browser
    // renders an empty box, which reads as a broken card rather than a missing
    // picture — so a recorded failure must draw the same mark as "no icon".
    const src = 'https://example.test/icon.png'
    expect(iconSource({ icon: src }, src)).toEqual({ kind: 'default' })
  })

  it('still shows a working icon when a DIFFERENT url failed', () => {
    // Keyed by URL, not a boolean: a re-render with a new source deserves its
    // own attempt, and a stale flag would hide a perfectly good image.
    const good = 'https://example.test/good.png'
    const dead = 'https://example.test/dead.png'
    expect(iconSource({ icon: good }, dead)).toEqual({ kind: 'image', src: good })
  })

  it('ignores a recorded failure when there is no icon at all', () => {
    expect(iconSource({ icon: null }, 'https://example.test/dead.png')).toEqual({ kind: 'default' })
  })
})
