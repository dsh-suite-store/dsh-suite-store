/**
 * Host `@deepseek-ai/dsh-client-ui-primitives` resolved at render time, with
 * the store's own markup as the fallback.
 *
 * The primitives module is injected by whichever host is running, so the set
 * of components available is that host's — an external package cannot assume
 * the ones it imports exist. Two different answers follow from that:
 *
 * - `REQUIRED_PRIMITIVES` (index.ts) decide whether the page can mount at
 *   all. Missing any of them blanks the settings dialog, so the page refuses
 *   to register instead.
 * - Everything here is *optional*: a host that predates `Tag` gets the
 *   store's own chip. The difference matters, because the second failure is
 *   quiet and cosmetic while the first is the whole feature.
 *
 * Icons follow the same rule one step further: the host renamed its icon
 * exports mid-1.x and dropped the old spelling, so each glyph is looked up
 * under the new name, then the old one, then replaced by an empty component.
 * A missing glyph must cost that glyph, never React #130 and a blank panel.
 */

import type { ComponentType, ReactNode } from 'react'

/**
 * The injected module, or an empty table.
 *
 * A static import of a package that only exists inside the host's module
 * table would make this file impossible to load anywhere else, which would
 * make every pure part of the page untestable in Node. A guarded dynamic
 * `require` instead resolves to the host's module under the bundle and to
 * nothing at all under a test runner — where the fallback markup is exactly
 * what needs exercising anyway. `tsdown` is configured with `require` as a
 * shim, so the bundler still sees one external and emits no `import`.
 */
const HOST_MODULE = '@deepseek-ai/dsh-client-ui-primitives'

const primitives: Record<string, unknown> = (() => {
  try {
    const load = (globalThis as { require?: (id: string) => unknown }).require
    // A browser/AMD shim can expose a truthy `require` that is not callable;
    // calling it threw straight into the `catch` below and silently downgraded
    // EVERY host primitive to the fallback, with no diagnostic at all. The
    // receiver matters too: a `require` that reads `this` loses it when the
    // function is detached from `globalThis`.
    if (typeof load !== 'function') return {}
    return (load.call(globalThis, HOST_MODULE) as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
})()

/** Props every host icon accepts. */
export interface IconProps {
  size?: number
  className?: string
}

/** One resolved glyph. */
export type IconComponent = ComponentType<IconProps>

/**
 * Read one export from the injected module without trusting it.
 *
 * A shim can be a strict proxy that throws on an unknown name (test doubles
 * do exactly that), and "the host does not have it" and "asking threw" have
 * the same answer here.
 *
 * @param name - the export name.
 * @returns the value, or `undefined`.
 */
function readExport(name: string): unknown {
  try {
    return (primitives as unknown as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/**
 * Resolve an export to something React can render, or nothing.
 *
 * Functions and `$$typeof`-tagged objects (memo, forwardRef) are components;
 * anything else — a string from a bad shim — is not, and rendering it would
 * be a crash rather than a fallback.
 *
 * The tag must be a SYMBOL, not merely present: `{ $$typeof: 'bogus' }` passed
 * a bare `in` check and then threw React #130, the exact crash this function
 * exists to prevent. A symbol (rather than a comparison against this copy's
 * `react.memo`/`forward_ref` constants) keeps a shim built by a different React
 * copy working. The probe sits in a `try` because it runs outside
 * `readExport`'s guard, and a proxy with a throwing `has`/`get` trap would
 * otherwise escape and break the module-level `icons` initialisation.
 */
function asComponent<T>(name: string): T | undefined {
  const value = readExport(name)
  if (typeof value === 'function') return value as T
  if (value === null || typeof value !== 'object') return undefined
  try {
    const tag = (value as { $$typeof?: unknown }).$$typeof
    return typeof tag === 'symbol' ? (value as T) : undefined
  } catch {
    return undefined
  }
}

/**
 * The host's chip, when this host has one.
 *
 * @remarks `null` means "render your own", which is the ordinary outcome on
 *   an older host rather than an error.
 */
export const HostTag = asComponent<(props: {
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  className?: string
  children?: ReactNode
}) => ReactNode>('Tag') ?? null

/** The host's primary button; the store falls back to a styled `<button>`. */
export const HostButton = asComponent<(props: {
  tone?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
  className?: string
  onClick?: () => void
  title?: string
  children?: ReactNode
}) => ReactNode>('Button') ?? null

/** The host's text input; the store falls back to a styled `<input>`. */
export const HostInput = asComponent<(props: {
  value?: string
  placeholder?: string
  className?: string
  label?: string
  'aria-label'?: string
  onChange?: (event: { target: { value: string } }) => void
}) => ReactNode>('Input') ?? null

/**
 * The host's on/off switch, when this host has one.
 *
 * The host's own plugin list uses `Switch`, so a member row that carried a
 * checkbox looked like a different screen bolted onto the same list. The
 * contract is `checked` + `onChange(next)` + `label` (a STRING — the host
 * renders it itself). `null` means an older host, and the fallback below keeps
 * the same `role="switch"` semantics.
 */
export const HostSwitch = asComponent<(props: {
  checked?: boolean
  disabled?: boolean
  label?: string
  onChange?: (checked: boolean) => void
  className?: string
}) => ReactNode>('Switch') ?? null

/** The host's checkbox; the store falls back to a native one. */
export const HostCheckbox = asComponent<(props: {
  checked?: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
  children?: ReactNode
  className?: string
}) => ReactNode>('Checkbox') ?? null

/**
 * The icon names the store renders, newest spelling first.
 *
 * Each entry is `[local name, host export, older host export?]`. The local
 * name is what call sites import, so a host rename costs one line here.
 *
 * The tuple shape is asserted with `satisfies` AFTER `as const` rather than by
 * annotating the declaration: an annotation supplies the contextual type, which
 * erases the literal element types (`[number][0]` widens to `string`), and then
 * `IconName` below is `string` — so `Icon name="typo"` compiled and rendered
 * `undefined`, the React #130 this table exists to prevent. `satisfies` keeps
 * the literals AND still rejects a malformed entry.
 */
const ICON_ALIASES = [
  ['check', 'IconCheckOutlineRegular', 'IconCheckOutline16'],
  ['warning', 'IconWarningOutlineRegular', 'IconWarningOutline16'],
  ['close', 'IconCloseOutlineRegular', 'IconCloseOutline16'],
  ['refresh', 'IconRefreshOutlineRegular', 'IconRefreshOutline14'],
  ['search', 'IconSearchOutlineRegular', 'IconSearchOutline16'],
  ['download', 'IconDownloadOutlineRegular', 'IconDownloadOutline16'],
  ['chevronDown', 'IconChevronDownOutlineRegular', 'IconChevronDownOutline14'],
  ['loading', 'IconLoadingOutlineRegular', 'IconLoadingOutline16'],
  ['trash', 'IconTrashOutlineRegular', 'IconTrashOutline16'],
] as const satisfies readonly (readonly [string, ...string[]])[]

/** An icon drawn as nothing, so a host gap costs the glyph and not the page. */
const NO_ICON: IconComponent = () => null

/**
 * Look up one glyph under every spelling the host might use.
 *
 * @param aliases - the names to try, newest first.
 * @returns the glyph, or {@link NO_ICON}.
 */
export function resolveIcon(aliases: readonly string[]): IconComponent {
  for (const name of aliases) {
    const found = asComponent<IconComponent>(name)
    if (found !== undefined) return found
  }
  return NO_ICON
}

/** The store's glyphs, resolved once at module evaluation. */
export const icons = Object.fromEntries(
  ICON_ALIASES.map(([local, ...aliases]) => [local, resolveIcon(aliases)]),
) as Record<(typeof ICON_ALIASES)[number][0], IconComponent>

/**
 * Which of the icons the running host actually provides.
 *
 * @returns the local names that resolved to nothing — empty on a current
 *   host. Used by a warning line rather than to disable anything.
 */
export function missingIcons(): string[] {
  // `icons` above is already this question answered once; re-resolving through
  // `resolveIcon` was a second copy of the lookup that could only drift.
  return ICON_ALIASES.filter(([local]) => icons[local] === NO_ICON).map(([local]) => local)
}
