/** Presentation helpers for the suite member picker. */

import type { CuratedMember } from '../submission/curated.ts'
import type { Locale } from './copy.ts'

/**
 * The name a person recognises before the technical coordinate.
 *
 * The upstream index has no separate localized display-name field. Its npm
 * package is the most concrete name when present; for git-only monorepo
 * entries the indexed subpackage is more useful than the repository root.
 */
export function memberDisplayName(member: CuratedMember): string {
  if (member.npm !== null && member.npm.trim() !== '') return member.npm.trim()
  const hash = member.name.indexOf('#')
  if (hash !== -1) {
    const subpath = member.name.slice(hash + 1).replace(/\/+$/u, '')
    const leaf = subpath.slice(subpath.lastIndexOf('/') + 1)
    if (leaf !== '') return leaf
  }
  return member.name.trim()
}

/** The localized description, with a cross-language fallback. */
export function memberDescription(member: CuratedMember, locale: Locale): string {
  const description = member.description
  if (description === undefined) return ''
  const preferred = (description[locale] ?? '').trim()
  if (preferred !== '') return preferred
  return (description[locale === 'zh' ? 'en' : 'zh'] ?? '').trim()
}

/** Whether a curated member is also present in this profile. */
export function memberSource(
  member: CuratedMember,
  installed: ReadonlySet<string>,
): 'installed' | 'curated' {
  return installed.has(member.key) ? 'installed' : 'curated'
}