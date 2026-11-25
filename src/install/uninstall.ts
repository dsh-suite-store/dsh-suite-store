/**
 * Uninstall planning: deciding which of a bundle's plugins the user means to
 * remove, BEFORE anything is removed (§7.7).
 *
 * The danger here is asymmetric: a wrong "install" costs a download and a
 * retry, a wrong "uninstall" destroys work that cannot be recovered. But the
 * timid default (only `only-source` pre-checked) made "one-click uninstall"
 * remove almost nothing: in a profile where every member is also listed by
 * another suite, the panel opened with zero boxes checked and no explanation
 * a user could act on. So everything present is pre-checked now, and the
 * reasons below are advisory labels rather than silent exclusions:
 *
 * - `manual`: the user installed it themselves.
 * - `shared`: another bundle also declares a source for it; the host may
 *   refuse the removal with `bundle-in-use` (§16.5).
 * - `unknown`: no provenance at all.
 * - `only-source`: only this bundle claims it.
 *
 * The host's own protection is the final arbiter. The user can uncheck any
 * row, and the panel's "select all" toggles the whole list at once.
 */

import { baseName } from './plan.ts'
import type { ProvenanceEntry, ProvenanceState } from './state.ts'

/** One plugin the bundle lists, as the profile currently has it. */
export interface RemovableEntry {
  id: string
  version?: string
}

/**
 * Why an entry carries the advisory label it does.
 *
 * All entries are pre-checked; this says what to be aware of, not what is
 * excluded. `sharedWith` names the other bundles so the row can say them.
 */
export type UninstallReason = 'only-source' | 'manual' | 'shared' | 'unknown'

export interface UninstallChoice {
  id: string
  checked: boolean
  reason: UninstallReason
  /** For `shared`: the other bundles' ids, so the dialog can name them. */
  sharedWith?: string[]
}

export interface UninstallPlanInput {
  /** The bundle being removed. */
  bundleId: string
  /** The plugins it declares, in member order. */
  installed: readonly RemovableEntry[]
  provenance: ProvenanceState
}

/**
 * Decide the pre-checked defaults for removing a bundle.
 *
 * Every present member is pre-checked: "one-click uninstall" means removing
 * the bundle, not negotiating provenance one row at a time. `reason` is kept
 * as an advisory label so a member another bundle also uses is visible, but
 * it no longer silently excludes anything — the host's own `bundle-in-use`
 * protection is the final arbiter, and a hidden exclusion was the confusing
 * part (§16.5).
 *
 * @param input.installed - the bundle's members that are currently present.
 * @returns one choice per entry, in the caller's order.
 */
export function planUninstall(input: UninstallPlanInput): UninstallChoice[] {
  return input.installed.map((entry) => {
    const record = provenanceFor(input.provenance, entry.id)
    if (record === undefined) return { id: entry.id, checked: true, reason: 'unknown' }

    const manual = record.sources.some((source) => source.kind === 'manual')
    if (manual) return { id: entry.id, checked: true, reason: 'manual' }

    const others = new Set(
      record.sources
        .filter((source) => source.kind === 'bundle' && source.bundleId !== input.bundleId)
        .map((source) => (source.kind === 'bundle' ? source.bundleId : '')),
    )
    if (others.size > 0) {
      return { id: entry.id, checked: true, reason: 'shared', sharedWith: [...others] }
    }

    const ours = record.sources.some(
      (source) => source.kind === 'bundle' && source.bundleId === input.bundleId,
    )
    return { id: entry.id, checked: true, reason: ours ? 'only-source' : 'unknown' }
  })
}

/**
 * Every record describing one installed plugin, merged into a single answer.
 *
 * One plugin can legitimately appear under more than one provenance key, and
 * the live profile did: `npm:billion-context@0.1.213` (written by the install
 * that put it there) and `billion-context` (written by `reconcile()` from what
 * the host reported). Keying the uninstall plan on an exact string therefore
 * mislabels the plugin — the bundle-owned one showed up as `unknown`, which is
 * the one classification that tells the user "this is not ours to remove"
 * about the very plugin the card says the suite installed.
 *
 * Sources from all matching records are merged, and the merge is the
 * conservative direction: a `manual` source anywhere still makes the plugin
 * manual, and a second bundle's claim anywhere still makes it shared.
 *
 * @param state - the provenance document.
 * @param id - the member identity the plan carries (`npm:name@version`).
 * @returns the merged entry, or undefined when nothing describes the plugin.
 */
export function provenanceFor(state: ProvenanceState, id: string): ProvenanceEntry | undefined {
  // Fall back to the family even when the exact key exists: the live profile
  // had a bundle record under the spec AND a manual one under the bare name,
  // and returning only the exact hit read the user's own install as removable.
  // `baseName` strips the `npm:` prefix and the `@version`, which is the only
  // spelling every writer shares.
  const family = baseName(id)
  const matches = [state.entries[id], ...Object.values(state.entries)].filter(
    (entry, index, all): entry is ProvenanceEntry =>
      entry !== undefined
      && (entry.id === id || baseName(entry.id) === family || baseName(entry.spec) === family)
      // The exact key is also in `Object.values`, so it would be merged twice.
      && all.indexOf(entry) === index,
  )
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]
  const sources: ProvenanceEntry['sources'] = []
  for (const match of matches) {
    for (const source of match.sources) {
      const duplicate = sources.some(
        (existing) =>
          existing.kind === source.kind
          && (existing.kind !== 'bundle'
            || (source.kind === 'bundle' && existing.bundleId === source.bundleId)),
      )
      if (!duplicate) sources.push(source)
    }
  }
  return { id, spec: matches[0]?.spec ?? id, resolvedVersion: matches[0]?.resolvedVersion ?? null, sources }
}
