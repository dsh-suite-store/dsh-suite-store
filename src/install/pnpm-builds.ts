/**
 * Reading pnpm's build-script refusals out of its own output.
 *
 * Two different failures look alike and need different keys:
 *
 * - `ERR_PNPM_IGNORED_BUILDS` — pnpm installed the package and skipped its
 *   build script. The profile's `allowBuilds` file is where the decision lives,
 *   and the host writes an undecided entry there for the user.
 * - `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` — pnpm refused to PREPARE a
 *   git-hosted package before materialising it. Nothing reaches the profile
 *   file, so the only record of what needs approving is pnpm's own message.
 *
 * The shapes below were verified against the pnpm versions DSH Desktop bundles.
 * Matching pnpm's own wording matters: a key this module derives differently
 * from pnpm's own derivation is written to `allowBuilds` and then ignored on the
 * retry.
 */

/** Quotes and newlines escape inside an ndjson string; match on the real thing. */
function unquote(text: string): string {
  return text.replace(/\\"/g, '"')
}

/** The same, with newlines restored — the allowBuilds example spans lines. */
function unquoteMultiline(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\n/g, '\n')
}

/**
 * The package name pnpm's fetcher refused to prepare.
 *
 * Message: `The git-hosted package "name@2.8.0" needs to execute build scripts
 * but is not in the "allowBuilds" allowlist.`
 *
 * @returns the bare name with any version stripped, or null when this is a
 *   different failure.
 */
export function prepareRefusedPackage(stdout: string, stderr: string): string | null {
  const match = /git-hosted package "([^"]+)" needs to execute build scripts/.exec(
    unquote(`${stdout}\n${stderr}`),
  )
  if (match === null) return null
  // The name itself may be scoped, so strip only a trailing `@<version>`.
  const raw = (match[1] ?? '').trim()
  const at = raw.lastIndexOf('@')
  return at > 0 ? raw.slice(0, at) : raw
}

/**
 * The `allowBuilds` key pnpm printed with that refusal, when it printed one.
 *
 * pnpm 11 ends the error with the exact line to add:
 *
 *     For example:
 *     allowBuilds:
 *       @scope/pkg@https://codeload.github.com/o/r/tar.gz/<sha>: true
 *
 * That key names the commit THIS install fetches, which the installed spec
 * cannot: an update still carries the old pin, so deriving the key from it
 * writes an entry the profile already has and the retry fails identically.
 *
 * pnpm 10 prints an `onlyBuiltDependencies` example with the bare name instead,
 * so it answers null here — the bare name is what that version needs, and the
 * caller falls back to it.
 *
 * @returns the key, or null when the output carries no allowBuilds example.
 */
export function prepareBuildKey(stdout: string, stderr: string): string | null {
  const match = /For example:\s*\n\s*allowBuilds:\s*\n[ \t]+("?)([^\s"]+)\1:\s*true/.exec(
    unquoteMultiline(`${stdout}\n${stderr}`),
  )
  return match === null ? null : (match[2] ?? null)
}

/**
 * The `allowBuilds` key pnpm derives for one ignored build.
 *
 * pnpm keeps the whole dep path when what follows the name's `@` is not a
 * semver version — a git remote, a codeload archive, a tarball URL all contain
 * `:`, `/` or `#` — and collapses to the bare name otherwise. It compares an
 * existing entry against this result verbatim, so this module has to agree with
 * it exactly.
 *
 * @param depPath - one entry from pnpm's ignored-builds report.
 * @returns the key pnpm itself keys that decision by.
 */
export function allowBuildKeyFromDepPath(depPath: string): string {
  const at = depPath.lastIndexOf('@')
  if (at <= 0) return depPath
  const version = depPath.slice(at + 1)
  return version !== '' && /[:/#]/.test(version) ? depPath : depPath.slice(0, at)
}
