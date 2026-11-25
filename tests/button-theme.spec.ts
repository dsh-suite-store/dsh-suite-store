/**
 * Button fills must come from the host's theme tokens, not a fixed colour.
 *
 * The page used to paint its primary buttons in a brand cobalt
 * (`#1f2de6`). On the host's light theme that reads as a different product;
 * on the dark theme it is nearly invisible. The host already publishes the
 * pair this needs:
 *
 *   --dsw-alias-button-primary-fill        black in light, near-white in dark
 *   --dsw-alias-label-primary-foreground   the ink that inverts with it
 *
 * Because the theme redefines those two under `body[data-ds-dark-theme]`,
 * reading them is what makes a button invert without a media query here.
 * This spec fails if the stylesheet goes back to a literal colour.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(new URL('../src/client/Store.module.css', import.meta.url), 'utf8')

describe('button colour follows the host theme', () => {
  it('declares its accent from the host primary-button tokens', () => {
    // The token must be the VALUE the declaration reads; a light-mode literal
    // may follow as the fallback, because a host that does not publish these
    // three aliases would otherwise render the accent surfaces transparent
    // (`var()` with no fallback is invalid at computed-value time). The
    // literal is the last resort, never the primary value.
    expect(CSS).toMatch(/--st-accent:\s*var\(--dsw-alias-button-primary-fill(?:,|\))/u)
    expect(CSS).toMatch(/--st-accent-ink:\s*var\(--dsw-alias-label-primary-foreground(?:,|\))/u)
    expect(CSS).toMatch(/--st-accent-hover:\s*var\(--dsw-alias-button-primary-hover(?:,|\))/u)
  })

  it('carries no hard-coded brand blue anywhere', () => {
    // The old cobalt and the old host-link fallbacks; any of these returning
    // means a button that ignores the theme.
    for (const literal of ['#1f2de6', '#4176e6', '#7b8cff']) {
      expect(CSS.toLowerCase()).not.toContain(literal)
    }
  })

  it('never hard-codes white as a button label', () => {
    // A fixed #fff label disappears on the dark theme's near-white fill.
    const primaryBlocks = [...CSS.matchAll(/\.(?:chip\.on|fallbackButton\[data-tone='primary'\])[^{]*\{([^}]*)\}/gu)]
    expect(primaryBlocks.length).toBeGreaterThan(0)
    for (const [, body] of primaryBlocks) {
      expect(body).not.toMatch(/color:\s*#fff/iu)
    }
  })

  it('uses the host hover token instead of brightening', () => {
    // brightness() on a near-white fill does nothing; the host token works in
    // both themes.
    expect(CSS).toMatch(/\.fallbackButton\[data-tone='primary'\]:hover[^{]*\{[^}]*var\(--st-accent-hover\)/u)
  })
})
