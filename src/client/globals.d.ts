/**
 * Ambient declarations for the browser bundle.
 *
 * `tsdown` compiles the client through esbuild/rolldown rather than `tsc`, so
 * the `.module.css` imports need a module declaration of their own; the
 * virtual-CSS plugin in `tsdown.config.ts` turns each into the hashed class
 * map, and this file only tells TypeScript what that map looks like.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

/**
 * Type-only view of the host's design-system package.
 *
 * The package is injected by the host at runtime through the module loader and
 * is not a dependency of this plugin, so there is nothing on disk to resolve
 * types from. Everything the store touches is described here structurally; the
 * runtime module is read through `primitives.ts`, which falls back for every
 * name. The declaration lives in this file rather than in its own
 * `primitives.d.ts` because it must be part of the program for a bare module
 * specifier to resolve at all, and one ambient file that is always included is
 * simpler than a second one that must be listed.
 *
 * The list mirrors what `primitives.ts` resolves: `Button`, `Input`,
 * `Checkbox`, `Switch` (as `HostSwitch`) and nine `Icon*` exports. Every
 * component returns `ReactNode` rather than `unknown` — `unknown` is not a
 * valid JSX element type, so `import { Tag } … ; <Tag />` would fail to
 * compile against a declaration whose whole purpose is to describe a component.
 * The `import type` sits INSIDE the module body on purpose: a top-level import
 * would turn this file into a module and break the wildcard `*.module.css`
 * declaration above.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  /** Loose prop bag: the host re-exports dozens of components with their own. */
  type AnyProps = Record<string, unknown>

  export const Button: (props: AnyProps) => ReactNode
  export const Input: (props: AnyProps) => ReactNode
  export const Checkbox: (props: AnyProps) => ReactNode
  export const Switch: (props: AnyProps) => ReactNode
  export const Tag: (props: AnyProps) => ReactNode

  // The glyphs `primitives.ts`' `ICON_ALIASES` names, newest spelling first per
  // row. A host rename is handled by that table's fallback, not by widening
  // this list.
  export const IconCheckOutlineRegular: (props: AnyProps) => ReactNode
  export const IconWarningOutlineRegular: (props: AnyProps) => ReactNode
  export const IconCloseOutlineRegular: (props: AnyProps) => ReactNode
  export const IconRefreshOutlineRegular: (props: AnyProps) => ReactNode
  export const IconSearchOutlineRegular: (props: AnyProps) => ReactNode
  export const IconDownloadOutlineRegular: (props: AnyProps) => ReactNode
  export const IconChevronDownOutlineRegular: (props: AnyProps) => ReactNode
  export const IconLoadingOutlineRegular: (props: AnyProps) => ReactNode
  export const IconTrashOutlineRegular: (props: AnyProps) => ReactNode
}
