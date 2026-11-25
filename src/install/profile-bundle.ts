/**
 * Composing a bundle-shaped member into the profile's bundle stack.
 *
 * `installBundle(enabled: true)` adds the dependency and writes the files, but
 * can leave `dsh.profile.bundles` without the name. A package declaring
 * `dsh.bundle` only takes effect when it is listed there — its own
 * `cordis.patch.yml` is assembled from that list — so the install succeeds on
 * disk and the plugin never loads. The row is therefore written here as a
 * repair.
 *
 * Scope is deliberately additive: append the new bundle, keep every existing
 * entry's position, and let the host re-validate `before`/`after` rules when it
 * composes next. Reordering an existing stack is
 * a separate, user-driven operation and is not done here.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bundles the host ships; an install must never duplicate or move them. */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/**
 * Write the manifest via a same-directory temp file + rename.
 *
 * A crash mid-write cannot leave a truncated `package.json`, which would break
 * every later pnpm run and the next host boot.
 */
function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(temp, content)
  renameSync(temp, file)
}

/**
 * Whether a bundle name is already in the stack (and the stack is readable).
 *
 * @returns true when present; false when absent or the manifest is unreadable.
 */
export function profileHasBundle(profileDir: string, name: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(name)
  } catch {
    return false
  }
}

/**
 * Append one bundle to `dsh.profile.bundles`, preserving every existing entry.
 *
 * Idempotent: an existing row is left untouched. An official in-box name is
 * never added — the host owns those positions. Returns whether a row was added
 * so the caller can report a repair without claiming a change it did not make.
 *
 * Order: the name goes to the end. A bundle's declared `before`/`after` rules
 * are checked by the loader when the profile is composed, not here; a wrong
 * order surfaces at boot rather than being silently reshuffled at install time.
 *
 * @returns true when the row was added, false when present or unwritable.
 */
export function appendProfileBundle(profileDir: string, name: string): boolean {
  if (INBOX_BUNDLES.has(name)) return false
  const file = join(profileDir, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const existing = manifest.dsh?.profile?.bundles
    const bundles = Array.isArray(existing)
      ? existing.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (bundles.includes(name)) return false
    bundles.push(name)
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    manifest.dsh.profile.bundles = bundles
    writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`)
    return true
  } catch {
    // An unreadable or unwritable manifest is not an install failure: the
    // package is on disk, and the host may still compose it by other means.
    return false
  }
}

/**
 * Drop only the `dsh.profile.bundles` row, leaving `dependencies` alone.
 *
 * What an uninstall needs FIRST: while the row is present the host treats the
 * package as a required layer and refuses to remove it. The dependency is left
 * for the package manager to drop, so a removal that then fails still leaves a
 * profile whose dependency and files agree.
 *
 * @returns true when a row was removed.
 */
export function dropBundleRow(profileDir: string, name: string): boolean {
  if (INBOX_BUNDLES.has(name)) return false
  const file = join(profileDir, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const existing = manifest.dsh?.profile?.bundles
    if (!Array.isArray(existing) || !existing.includes(name)) return false
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    manifest.dsh.profile.bundles = existing.filter((entry) => entry !== name)
    writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Drop a package's dependency and bundle rows from the profile manifest.
 *
 * The uninstall mirror of {@link appendProfileBundle}, addressing the same
 * gap: `removeBundle` can report success while the package, its dependency and
 * its bundle row are all still present. Here DISK TRUTH decides — a package
 * that is really gone gets its manifest rows dropped, because a bundle row
 * naming a missing package makes the next
 * boot fail on composition, while leaving a dependency that no longer resolves
 * makes every later pnpm run complain.
 *
 * Only called when the caller has already established the files are gone; it
 * never decides that itself.
 *
 * @returns the dropped entries, empty when the manifest had none.
 */
export function dropProfileRows(profileDir: string, name: string): string[] {
  if (INBOX_BUNDLES.has(name)) return []
  const file = join(profileDir, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      dependencies?: Record<string, unknown>
      dsh?: { profile?: { bundles?: unknown } }
    }
    const dropped: string[] = []
    if (manifest.dependencies !== undefined && name in manifest.dependencies) {
      delete manifest.dependencies[name]
      dropped.push('dependencies')
    }
    const existing = manifest.dsh?.profile?.bundles
    if (Array.isArray(existing)) {
      const next = existing.filter((entry) => entry !== name)
      if (next.length !== existing.length) {
        manifest.dsh ??= {}
        manifest.dsh.profile ??= {}
        manifest.dsh.profile.bundles = next
        dropped.push('dsh.profile.bundles')
      }
    }
    if (dropped.length > 0) writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`)
    return dropped
  } catch {
    return []
  }
}
