/**
 * The square mark next to a suite's name.
 *
 * Deliberately separate from `cover`, which the card draws as a wide banner (or
 * a mosaic of its members' own marks when it has none). An icon is a small
 * identity badge: it sits beside the title in the list and in the detail sheet,
 * where a banner would push the name off the fold.
 *
 * Three sources, in the order the catalog builder already decided:
 *
 *  1. `card.icon` — a resolved https URL. For a contributor that is either the
 *     image they submitted or their GitHub avatar; for the first-party owner it
 *     is `null` and case 2 draws instead.
 *  2. the bundled default mark, drawn as inline SVG.
 *  3. (nothing — `null` is only ever a signal to draw the default.)
 *
 * The default is INLINE rather than a file the plugin serves. The plugin has no
 * static-asset route, and adding one for a 718-byte SVG would put a second HTTP
 * surface behind a decorative image. Inline also means it follows
 * `currentColor`, so it is legible in the dark theme without a second asset.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'

import type { BundleCard } from '../catalog/types.ts'
import css from './Store.module.css'

/** Props of {@link BundleIcon}. */
export interface BundleIconProps {
  card: BundleCard
  /** Rendered box, in px. The row and the sheet ask for different sizes. */
  size: number
  /** Extra class, so the caller can place it (margins, rounding). */
  className?: string
}

/**
 * The default mark: three stacked panels in one rounded outline.
 *
 * The same drawing as `assets/logo.svg`, which is what a packaged install ships
 * and what the sidebar uses. Kept in sync by hand — it is ten lines of geometry,
 * and importing the file would need a bundler rule for a decorative asset.
 *
 * @param props.size - square size in px.
 * @returns the SVG.
 */
function DefaultMark({ size }: { size: number }): ReactNode {
  return (
    <svg
      className={css.iconMark}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-hidden
      focusable="false"
    >
      <rect
        x="6" y="6" width="52" height="52" rx="13"
        fill="none" stroke="currentColor" strokeWidth="4" opacity="0.45"
      />
      <rect x="16" y="18" width="32" height="8" rx="4" fill="currentColor" />
      <rect x="16" y="29" width="22" height="8" rx="4" fill="currentColor" opacity="0.72" />
      <rect x="16" y="40" width="27" height="8" rx="4" fill="currentColor" opacity="0.45" />
    </svg>
  )
}

/** What an icon draws: a remote image, or the bundled mark. */
export type IconSource = { kind: 'image'; src: string } | { kind: 'default' }

/**
 * Which image a card's icon should draw.
 *
 * Extracted from the component so the RULE can be tested without a DOM. This
 * module has no test renderer — the project's convention is that drawing is
 * verified in a real host — so a component-level assertion would have to be a
 * string match on JSX, which proves nothing. The decision itself is the part
 * that can be wrong in a way a reader would not notice: an `http://` URL that
 * slips through, or a `null` that renders an empty box instead of the mark.
 *
 * @param card - the card, from `parseCatalogIndex` (which already restricted
 *   `icon` to an https URL or null).
 * @param failedSrc - the URL this element already tried and could not load, if
 *   any. A contributed icon is a URL someone typed; when it 404s or its host is
 *   unreachable the browser renders an EMPTY BOX, which reads as a broken card
 *   rather than a missing picture. Passing the failed URL here is what turns
 *   that into the same default mark a card with no icon draws.
 * @returns the image to draw, or `default` for the bundled mark.
 */
export function iconSource(
  card: Pick<BundleCard, 'icon'>,
  failedSrc: string | null = null,
): IconSource {
  // The `https://` test repeats what the parser enforced. It is not redundant:
  // this is the one place an `<img src>` is built from catalog data, and a
  // catalog served by someone else is exactly the input the parser guards.
  if (typeof card.icon !== 'string' || !card.icon.startsWith('https://')) return { kind: 'default' }
  if (failedSrc !== null && failedSrc === card.icon) return { kind: 'default' }
  return { kind: 'image', src: card.icon }
}

/**
 * One suite's icon.
 *
 * `alt=""` and `aria-hidden`: the suite's name is always adjacent, so an
 * alternative text here would make a screen reader say the name twice.
 *
 * `referrerPolicy="no-referrer"` matters because the image is remote: without it
 * the request tells the image's host which page (and therefore which profile)
 * opened the store. `loading="lazy"` keeps a 60-card grid from opening 60
 * connections at once.
 *
 * @param props - see {@link BundleIconProps}.
 * @returns the image, or the default mark.
 */
export function BundleIcon({ card, size, className }: BundleIconProps): ReactNode {
  const box = { width: size, height: size }
  const classes = [css.iconBox, className ?? ''].filter(Boolean).join(' ')
  /**
   * The URL this element already tried and could not load.
   *
   * A contributed icon is a URL someone typed, and a URL that 404s or whose host
   * is unreachable renders as an EMPTY BOX — which reads as a broken card, not
   * as a missing picture. Recording the failure turns it into the same default
   * mark a card with no icon draws.
   *
   * Keyed by URL rather than a boolean: a re-render with a DIFFERENT url
   * deserves its own attempt, and comparing the two makes that automatic.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const source = iconSource(card, failedSrc)

  if (source.kind === 'image') {
    return (
      <img
        className={[classes, css.iconImg].join(' ')}
        style={box}
        src={source.src}
        alt=""
        aria-hidden
        loading="lazy"
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => { setFailedSrc(source.src) }}
      />
    )
  }
  return (
    <span className={classes} style={box} aria-hidden>
      <DefaultMark size={size} />
    </span>
  )
}
