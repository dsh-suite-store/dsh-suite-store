/**
 * React plumbing shared by every component in the page.
 *
 * Three small things, each of which would otherwise be copy-pasted:
 *
 * - {@link Button}, {@link Input}, {@link Checkbox}, {@link Switch},
 *   {@link Tag}: the host's primitive when the host has one, this page's own
 *   markup when it does not. The store must render on hosts of different
 *   vintages, and the primitives module is injected rather than installed —
 *   see `primitives.ts`.
 * - {@link Icon}: the store's glyphs, resolved once, drawn as nothing when
 *   the host renamed or dropped one.
 * - {@link formatDate} / {@link dateFormatter}: one cached `Intl.DateTimeFormat`
 *   per locale, so a grid of fifty cards does not construct fifty of them.
 *
 * Reading the page store is deliberately NOT wrapped here: `StorePage` hand-
 * rolls its single `useSyncExternalStore` call (see the note in
 * `page-store.ts` on why it is not context plumbing), and a second wrapper
 * would be a second way to do the same thing.
 *
 * Every component in this directory imports React from the host's module
 * table (the bundle declares `react` external), so these helpers work
 * wherever the page is mounted.
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'

import { HostButton, HostCheckbox, HostInput, HostSwitch, HostTag, icons } from './primitives.ts'
import { localeTag, type Locale } from './copy.ts'
import css from './Store.module.css'

/** Props of the page's buttons. */
export interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  tone?: 'primary' | 'secondary' | 'danger' | 'ghost'
  disabled?: boolean
  loading?: boolean
  className?: string
  title?: string
}

/**
 * A button, in the host's own shape when the host provides one.
 *
 * The fallback is a plain `<button>` with the sheet's own class: a host
 * without primitives still gets a working install button, which is the
 * difference between "off-brand" and "unusable".
 */
export function Button({ children, onClick, tone = 'secondary', disabled, loading, className, title }: ButtonProps): ReactNode {
  if (HostButton !== null) {
    // createElement, NOT a direct call: Host is a real React component, and
    // invoking it as a plain function runs its hooks inside THIS component's
    // render. A host Button whose hook count changes when `loading` flips
    // then throws "rendered fewer hooks than expected" and takes down the
    // whole tree — a blank, unrecoverable page after clicking uninstall.
    // `title` rides along when given: the blocked/busy card buttons put their
    // one explanation there, and dropping it hid exactly that distinction.
    return createElement(HostButton, {
      tone,
      disabled: disabled === true || loading === true,
      loading,
      onClick,
      className,
      ...(title === undefined ? {} : { title }),
      children,
    })
  }
  return (
    <button
      type="button"
      className={[css.fallbackButton, className].filter(Boolean).join(' ')}
      data-tone={tone}
      disabled={disabled === true || loading === true}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  )
}

/** Props of a text input. */
export interface InputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  className?: string
}

/** A single-line text field, in the host's shape when available. */
export function Input({ value, onChange, placeholder, label, className }: InputProps): ReactNode {
  if (HostInput !== null) {
    return createElement(HostInput, {
      value,
      placeholder,
      className,
      'aria-label': label,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    })
  }
  return (
    <input
      type="search"
      className={[css.fallbackInput, className].filter(Boolean).join(' ')}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** Props of a labelled checkbox. */
export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
  disabled?: boolean
}

/** A checkbox with its label, in the host's shape when available. */
export function Checkbox({ checked, onChange, children, disabled }: CheckboxProps): ReactNode {
  if (HostCheckbox !== null) {
    return createElement(HostCheckbox, { checked, disabled, onChange, children })
  }
  return (
    <label className={css.checkRow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  )
}

/**
 * An on/off switch, for state that applies immediately.
 *
 * A checkbox implies "part of a form I will submit"; these rows apply the
 * moment they are clicked, which is what a switch says. The host's own plugin
 * list draws a `Switch`, so the member rows use one too — a checkbox here made
 * the sheet look like a different screen from the list it sits beside.
 */
export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Rendered by the host; the fallback uses it as the accessible name. */
  label: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps): ReactNode {
  if (HostSwitch !== null) {
    return createElement(HostSwitch, { checked, disabled, label, onChange })
  }
  return createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      title: label,
      disabled,
      className: `${css.switch}${checked ? ` ${css.switchOn}` : ''}`,
      onClick: () => onChange(!checked),
    },
    createElement('span', { className: css.switchKnob }),
  )
}

/** Props of a chip. */
export interface TagProps {
  children: ReactNode
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet'
  className?: string
}

/** A small label, using the host's chip so the page matches its neighbours. */
export function Tag({ children, tone = 'neutral', className }: TagProps): ReactNode {
  if (HostTag !== null) {
    return createElement(HostTag, { tone, className, children })
  }
  return <span className={[css.badge, className].filter(Boolean).join(' ')}>{children}</span>
}

/** The store's glyph names. */
export type IconName = keyof typeof icons

/** Props of a glyph. */
export interface IconProps {
  name: IconName
  size?: number
  className?: string
}

/**
 * Draw one of the store's glyphs.
 *
 * A glyph the host does not export renders as nothing — an empty component
 * rather than a missing module — so a host rename costs one picture and
 * never the page.
 */
export function Icon({ name, size = 14, className }: IconProps): ReactNode {
  const Glyph = icons[name]
  return <Glyph size={size} className={className} />
}

/** Re-exported so the components import their copy types from one place. */
export type { Locale }

/**
 * `Intl.DateTimeFormat` for a locale (and shape), cached per key.
 *
 * The page formats dates in two places (a card's freshness and the stale
 * banner) and both run on every render of a long list; constructing a
 * formatter per card is measurable on a 50-card catalog.
 *
 * @param locale - which language.
 * @param short - omit the year (the card's meta line has no room for it).
 */
export function dateFormatter(locale: Locale, short = false): Intl.DateTimeFormat {
  const key = short ? `${locale}:short` : locale
  const cached = FORMATTERS.get(key)
  if (cached !== undefined) return cached
  const made = new Intl.DateTimeFormat(
    localeTag(locale),
    short ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' },
  )
  FORMATTERS.set(key, made)
  return made
}

/**
 * Format a catalog date without ever throwing.
 *
 * `updatedAt` is only checked to be a non-empty string on the wire, so an
 * arbitrary string reaches here; `Intl.format` throws RangeError on an Invalid
 * Date, and inside the dialog that replaced the WHOLE store page with the error
 * boundary. The raw text is a better fallback than a blank.
 *
 * `new Date(value)` alone is not a validator: V8 (and every other engine, each
 * differently) ROLLS OVER an out-of-range day, so `"2026-11-31"` silently
 * became 1 December rather than an Invalid Date — the sheet showed a date the
 * catalog never contained. The `YYYY-MM-DD` shape the catalog actually ships is
 * therefore checked explicitly, and anything else keeps the old parse-and-fall-
 * back behaviour so no existing format regresses.
 */
export function formatDate(value: string, locale: Locale, options: { short?: boolean } = {}): string {
  const formatter = dateFormatter(locale, options.short === true)
  const shape = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value)
  if (shape !== null) {
    const year = Number(shape[1])
    const month = Number(shape[2])
    const day = Number(shape[3])
    // `Date.UTC` rolls an impossible day over; comparing it back is what makes
    // "2026-02-30" invalid instead of 2 March.
    const parsed = new Date(Date.UTC(year, month - 1, day))
    const real = month >= 1 && month <= 12 && day >= 1 && parsed.getUTCDate() === day
    return real ? formatter.format(parsed) : value
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : formatter.format(parsed)
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>()
