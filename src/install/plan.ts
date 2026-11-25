/**
 * The install planner: turns "this bundle" plus "what the host already has"
 * into the exact, ordered list of installs the executor will run.
 *
 * This module is pure and touches nothing — no filesystem, no network, no
 * host service. That split is what makes the dangerous half of the plugin
 * testable: every decision about WHICH spec to install, WHICH member to skip
 * and WHICH approval to carry is asserted here without a package manager, and
 * the executor's remaining job is to run the steps in order and unwind one of
 * them when it fails (§7.3).
 *
 * Two rules deserve to be spelled out because they look arbitrary otherwise:
 *
 * - **The plan follows the author's order verbatim.** The catalog builder has
 *   already topologically sorted members by their `requires` edges (§5.2), so
 *   re-sorting here — by name, by pinned-ness, by anything — would break
 *   intra-bundle dependencies at install time.
 * - **An already-installed member is skipped only when it satisfies the
 *   bundle.** Re-installing over a good copy costs a download and a few
 *   seconds of "installing" the user did not ask for, and risks a remove step
 *   failing halfway through.
 */

import type { BundleDetail, BundleMember } from '../catalog/types.ts'

/**
 * The normalized identity the planner compares against.
 *
 * Deliberately the same string the catalog uses for a member (§5.5), not the
 * spec: an already-installed plugin reaches this plugin from the host as a
 * package name plus a resolved version, while the bundle stores a spec that
 * may omit the version entirely.
 */
export type MemberId = string

/** What the host reports as already present, narrowed to what planning needs. */
export interface InstalledMember {
  /** Normalized identity, compared to `memberSpecId()`. */
  id: MemberId
  /** Version the host reports, when it knows one. */
  version?: string
}

export interface InstallPlanInput {
  detail: BundleDetail
  /** Everything the host currently has installed, in any provenance. */
  installed: readonly InstalledMember[]
  /**
   * Package names the user has already allowed to run install scripts.
   *
   * Threaded per step rather than globally because the host takes the list per
   * install call: handing a member an approval that belongs to another member
   * is a supply-chain hole, and handing none to a member that needs one fails
   * the install AFTER earlier members were already written.
   */
  approvedBuilds: readonly string[]
}

/** One executable step: install exactly one member. */
export interface InstallStep {
  /** Package-local key, for reporting. */
  key: string
  /** Identity recorded in provenance. */
  id: MemberId
  /** What the host is asked to install. */
  spec: string
  /** Version the bundle pinned, or null when the member floats (D18). */
  pinnedVersion: string | null
  /** Package name; the key the host uses for build-script approvals. */
  name: string
  /** Build approvals to hand this specific install call. */
  approvedBuilds: string[]
}

/** Why a member was left out, in the terms the report uses (§7.6). */
export interface SkippedMember {
  key: string
  reason: 'already-installed'
}

export interface InstallPlan {
  steps: InstallStep[]
  skipped: SkippedMember[]
}

/** Raised when a bundle cannot be planned at all — before any side effect. */
export class InstallPlanError extends Error {
  /** Machine-readable cause, stable enough to switch on. */
  readonly reason: 'no-members' | 'nothing-to-do' | 'duplicate-key' | 'duplicate-id'

  constructor(reason: InstallPlanError['reason'], message: string) {
    super(message)
    this.name = 'InstallPlanError'
    this.reason = reason
  }
}

/**
 * The installed-host identity of a member.
 *
 * @param member - one member as the catalog carries it.
 * @returns the string the plan compares against `InstalledMember.id`.
 *
 * A pinned npm member is identified by its FULL spec, version included: the
 * catalog writes `npm:@scope/dsh-memory@0.6.11`, and that is exactly what an
 * install of it records, so a re-run can recognise its own work.
 *
 * A git member is NOT: the host reports git installs as `owner/repo` plus a
 * subdirectory, so `git:` and the `#<subdir>` fragment are stripped — keeping
 * them would make every git member look uninstalled forever, and the user
 * would get a redundant reinstall on every run of the same bundle.
 *
 * An unpinned member has no version to name (D18), so `id` is just
 * `npm:<name>`: "whatever the registry says today" is not an identity.
 */
export function memberSpecId(member: BundleMember): MemberId {
  if (member.id.startsWith('git:')) return trimSubdirectory(member.id.slice('git:'.length))
  if (member.pinned && member.version !== null) return member.spec
  return member.id
}

/**
 * Drop a `#<subdirectory>` fragment from a repo reference.
 *
 * The subdirectory selects WHICH package inside a monorepo to install; it is
 * not part of what the host reports back once installed, so it cannot be part
 * of an identity comparison — that is all this function is for.
 *
 * It is NOT an install identity on its own. A `#` in a git spec may name a tag
 * or a commit instead of a directory, and this function cannot tell them
 * apart, so anything that must distinguish two revisions has to compare the
 * full `spec` (which `buildInstallPlan` does when it rejects duplicate steps).
 */
export function trimSubdirectory(reference: string): string {
  const hash = reference.indexOf('#')
  return hash === -1 ? reference : reference.slice(0, hash)
}

/**
 * Transport prefixes a host or a catalog can put in front of a git reference.
 *
 * The shipped desktop host writes `github:owner/repo` into package.json for a
 * git install, while the catalog declares `git:owner/repo`; older specs use
 * `git+https://…`. All of them name the same package.
 */
const GIT_PREFIXES: readonly string[] = [
  'git+https://github.com/',
  'git+http://github.com/',
  'git+ssh://git@github.com/',
  'git@github.com:',
  'https://github.com/',
  'http://github.com/',
  'github:',
  'git:',
]

/** Whether an identity names a git install rather than a registry package. */
export function isGitIdentity(id: string): boolean {
  return GIT_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/** Drop a git transport prefix and a trailing `.git` from a reference. */
function stripGitPrefix(reference: string): string {
  for (const prefix of GIT_PREFIXES) {
    if (reference.startsWith(prefix)) {
      const stripped = reference.slice(prefix.length)
      return stripped.endsWith('.git') ? stripped.slice(0, -4) : stripped
    }
  }
  return reference
}

/** `owner/repo` → `repo`; undefined for a bare package name. */
function repoBasename(reference: string): string | undefined {
  const slash = reference.lastIndexOf('/')
  return slash === -1 || slash === reference.length - 1 ? undefined : reference.slice(slash + 1)
}

/**
 * The bare package name an identity refers to, with no version and no prefix.
 *
 * `npm:@scope/pkg@1.2.0` → `@scope/pkg`; `git:owner/repo#sub` → `owner/repo`;
 * `github:owner/repo` → `owner/repo`.
 *
 * The transport prefix is dropped first, because the host reports the same
 * install with any of several schemes while the catalog settles on `git:`;
 * keeping one of them would make otherwise equal identities differ and hide a
 * real install.
 *
 * The scoped-package case is why this is not a plain `split('@')`: splitting
 * `@scope/pkg@1.2.0` that way yields three parts and the name itself starts
 * with `@`, so the version separator has to be the LAST `@`, and only when it
 * is not the leading one.
 */
export function baseName(id: MemberId): string {
  const withoutGit = stripGitPrefix(id)
  const reference = trimSubdirectory(withoutGit.replace(/^npm:/u, ''))
  const at = reference.lastIndexOf('@')
  // A version separator is an `@` with something after it, which a scoped
  // name's leading `@` never is.
  if (at <= 0 || at === reference.length - 1) return reference
  return reference.slice(0, at)
}

/**
 * Whether two identities name the same member.
 *
 * A git-hosted member is written `owner/repo` in the catalog while the host
 * reports the loaded package as `@owner/repo` (npm scoped, owner lowercased),
 * so plain equality and `baseName` equality both miss it — and a miss is not
 * cosmetic: the sheet showed a plugin as both installed and "no state
 * reported", and offered to reinstall it.
 *
 * The repo-pair fold requires a slash: folding plain package names by case
 * would let `Foo` match `foo`, where case is significant.
 *
 * @param left - one identity (catalog id, spec, or the host's report).
 * @param right - the other.
 * @returns true when they name the same install.
 */
export function sameIdentity(left: string, right: string): boolean {
  if (left === right) return true
  const a = baseName(left)
  const b = baseName(right)
  if (a === b) return true
  const fold = (name: string): string | undefined => {
    const stripped = name.startsWith('@') ? name.slice(1) : name
    return stripped.includes('/') ? stripped.toLowerCase() : undefined
  }
  const folded = fold(a)
  if (folded !== undefined && folded === fold(b)) return true
  // A git member is `owner/repo` in the catalog but the host reports the
  // installed package by its own name (`repo`), e.g.
  // `git:117BS/dsh-perlica-ding` vs `dsh-perlica-ding`. Fold to the repo
  // basename when EITHER side still looks like a git reference, or when one
  // side is a bare package name and the other is a slash-bearing repo path.
  //
  // The second shape is the one that reaches here in practice: by the time an
  // uninstall plan or a verify check asks, `memberSpecId()` has already shed
  // the `git:` prefix, leaving `117BS/dsh-perlica-ding`.
  const git = isGitIdentity(left) || isGitIdentity(right)
  const slashA = a.includes('/')
  const slashB = b.includes('/')
  // Two exclusions keep the fold from making unrelated installs look equal.
  // Both are reached only when the exact and case-folded comparisons above
  // already failed, so neither can undo one of the documented matches.
  //
  // - An npm SCOPE (`@scope/pkg`) also contains a slash, but it is not a repo
  //   path: folding it against a bare package name made `@scope/pkg` and an
  //   unrelated `pkg` the same install, and the planner then skipped a member
  //   the user did not have.
  if (!git && (a.startsWith('@') || b.startsWith('@'))) return false
  // - Two slash-bearing git identities name different OWNERS (`alice/repo` vs
  //   `bob/repo`); dropping the owner would merge two different repos.
  if (git && slashA && slashB) return false
  if (!git && slashA === slashB) return false
  const basenameA = repoBasename(a) ?? a
  const basenameB = repoBasename(b) ?? b
  if (basenameA === basenameB) return true
  const foldedA = fold(basenameA)
  return foldedA !== undefined && foldedA === fold(basenameB)
}

/**
 * Whether an installed member satisfies a planned one.
 *
 * @param member - the bundle member.
 * @param installed - what the host reports under the same identity.
 * @returns true when re-installing would change nothing.
 *
 * A floating member (D18) is satisfied by any installed copy, at any version:
 * the author declined to pin it, so whatever the user already has is the
 * outcome a fresh install would try to reach anyway — and re-resolving it
 * would silently upgrade a user mid-task.
 *
 * A pinned member is satisfied only by the version the author tested. The
 * version is therefore the test, when the host reports one: the identity alone
 * cannot answer it, because the host names a registry install by the
 * versionless `npm:<name>`, and treating that id as satisfying the pin would
 * accept a completely different version.
 */
function satisfies(member: BundleMember, installed: InstalledMember): boolean {
  if (!member.pinned || member.version === null) return true
  if (installed.version !== undefined) return installed.version === member.version
  // No version reported. A git member has no version to compare (the repo
  // reference IS its identity), and a git install's package name is all the
  // host reports, so the identity comparison is the whole answer there.
  if (isGitIdentity(member.id)) return sameIdentity(installed.id, memberSpecId(member))
  // A registry member with no reported version: only the exact spec proves the
  // pinned version, and re-installing is the truthful answer otherwise.
  return installed.id === member.spec
}

/**
 * The build approvals that apply to one member.
 *
 * A user approves a package by name, and the same package can be named three
 * ways in the three places that meet here: the catalog's display label
 * (`api-relay-audit`), the spec (`npm:dsh-api-relay-audit@2.5.0`), and the
 * host's report (`npm:dsh-api-relay-audit`). Matching on the display label
 * alone silently dropped approvals for exactly the members that needed them.
 *
 * Approvals are matched on all three spellings so a sheet that asked about
 * "dsh-api-relay-audit" still covers it.
 *
 * @param packageName - the name derived from the spec, which is what the host
 *   uses for the approval list.
 * @param label - the catalog's display name for the member.
 * @param approved - the names the user approved, for the whole run.
 * @returns the approvals to hand THIS member's install call, or none.
 */
function approvalFor(packageName: string, label: string, approved: readonly string[]): string[] {
  const names = new Set([packageName, label])
  for (const approvedName of approved) {
    // A git dependency is authorised ONLY by its full dep path
    // (`name@https://codeload.../tar.gz/<sha>`); the bare name authorises a
    // registry dependency and nothing else. pnpm's own key is passed back
    // verbatim — deriving one from the installed spec would name the old
    // commit and the retry would fail identically.
    // A scope's leading `/` is not a git path; a dep path is, because what
    // follows the name contains a protocol or an archive URL.
    const at = approvedName.lastIndexOf('@')
    const tail = approvedName.slice(at + 1)
    if (!/:\/\/|#\w|^git\+/.test(tail)) continue
    // The dep path is `name@<archive url>`: only the name IN FRONT of it
    // authorises this member. `approvedBuilds` is one list per run, so
    // returning the first git-like entry handed every member the approval
    // that belongs to one member's dependency — a cross-member supply-chain
    // hole, since pnpm would then run that dependency's scripts.
    const head = at > 0 ? approvedName.slice(0, at) : approvedName
    if (names.has(head)) return [approvedName]
  }
  for (const approvedName of approved) {
    if (names.has(approvedName)) return [packageName]
  }
  return []
}

/**
 * Build the ordered plan for installing one bundle.
 *
 * @param input - the detail document, what is installed, what is approved.
 * @returns the steps to run and the members that were skipped.
 * @throws {InstallPlanError} when there is nothing to do or the bundle is
 *   internally inconsistent. Both are detected before a single install call,
 *   so a refused plan leaves the profile untouched.
 */
export function buildInstallPlan(input: InstallPlanInput): InstallPlan {
  const { detail, installed, approvedBuilds } = input

  if (detail.members.length === 0) {
    // §5.2 forbids 0-member bundles, so reaching here means the document is
    // wrong — but planning zero steps and reporting "done" would tell the user
    // they installed something they did not.
    throw new InstallPlanError('no-members', `bundle ${detail.id} has no members`)
  }

  const seenKeys = new Set<string>()
  const seenIds = new Set<MemberId>()
  const byId = new Map<MemberId, InstalledMember>()
  // A second index without the version, so a member can also be recognised by
  // the bare package it names. The host reports `@scope/pkg@1.2.0` for one
  // install and `@scope/pkg` for another depending on how it was added, and
  // treating those as two different plugins is how a user ends up with the
  // same plugin installed twice.
  //
  // Every entry is kept under a key, not just the last one: two installed
  // records really can share a bare name (a pinned copy and a floating one),
  // and letting the map decide which one counts made presence detection depend
  // on the order `installed` happened to arrive in. The caller below accepts
  // the member when ANY of the records satisfies it.
  const byName = new Map<string, InstalledMember[]>()
  const indexByName = (key: string, entry: InstalledMember): void => {
    if (key === '') return
    const list = byName.get(key)
    if (list === undefined) byName.set(key, [entry])
    else if (!list.includes(entry)) list.push(entry)
  }
  for (const entry of installed) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
    // Only `baseName` is indexed: it already drops the git prefix, the
    // `#subdirectory` fragment and the version, so it produces the key a
    // member's own `baseName` can match. The raw `trimSubdirectory(entry.id)`
    // used to be indexed beside it, which for `github:o/r` registered a
    // prefixed key no lookup could ever produce.
    indexByName(baseName(entry.id), entry)
  }

  const steps: InstallStep[] = []
  const skipped: SkippedMember[] = []

  for (const member of detail.members) {
    // Duplicate keys and duplicate ids are catalog bugs, and they are cheap to
    // detect here: two steps for one id would install it twice, and the second
    // install would report a failure the user cannot act on.
    if (seenKeys.has(member.key)) {
      throw new InstallPlanError('duplicate-key', `bundle ${detail.id} repeats member key ${member.key}`)
    }
    seenKeys.add(member.key)

    const id = memberSpecId(member)
    // The duplicate check keys on the SPEC, not on the normalized identity:
    // two packages of one monorepo share `owner/repo` once the `#subdirectory`
    // fragment is stripped from the identity (it has to be, because that is
    // what the host reports), so keying on the identity would call a legitimate
    // two-package bundle a duplicate and refuse to install it. Two steps for
    // one spec is the case that actually must not run twice.
    if (seenIds.has(member.spec)) {
      throw new InstallPlanError('duplicate-id', `bundle ${detail.id} repeats member id ${id}`)
    }
    seenIds.add(member.spec)

    const name = baseName(id)
    const exact = byId.get(id)
    const named = byName.get(name) ?? []
    const candidates = exact === undefined ? named : [exact, ...named.filter((entry) => entry !== exact)]
    if (candidates.some((entry) => satisfies(member, entry))) {
      skipped.push({ key: member.key, reason: 'already-installed' })
      continue
    }
    // The package name drives BOTH the build-script approval list and the
    // presence check after an install, so it must be the name npm knows. The
    // catalog's `name` is a display label and is not reliable for this: live
    // entries carry values like `dsh-web#packages/dsh-git-graph` and
    // `api-relay-audit` for packages actually published as
    // `@linxin666/dsh-client-ui-git-graph` and `dsh-api-relay-audit`. Taking
    // the name from the spec means the two can never disagree.
    const packageName = baseName(id)
    steps.push({
      key: member.key,
      id,
      spec: member.spec,
      pinnedVersion: member.pinned ? member.version : null,
      name: packageName,
      approvedBuilds: approvalFor(packageName, member.name, approvedBuilds),
    })
  }

  if (steps.length === 0) {
    // Every member is present at a satisfying version. Re-running the whole
    // install would re-download everything to change nothing, so this is
    // reported as an error the caller turns into "已经装好了".
    throw new InstallPlanError('nothing-to-do', `bundle ${detail.id} is already installed`)
  }

  return { steps, skipped }
}
