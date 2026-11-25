/**
 * The host adapter: the only file in this plugin that knows what a
 * `pluginManager` is (§7.2, §7.3).
 *
 * Everything above this layer works on plain data — plans, records, members —
 * so that the dangerous logic can be tested without a package manager, a
 * network or a live host. Everything below it is the harness's own API, which
 * is not ours to control: it may grow optional members, it may report a
 * version differently on Windows, and it may not be there at all when this
 * plugin is loaded into a composition that never mounted it.
 *
 * That last case is why the adapter is written defensively rather than
 * trusting the type: `capabilities()` is the single place where a missing
 * member becomes a `false`, and every caller reads a capability before using
 * the corresponding call. A missing `cancelInstall` degrades to "installs
 * cannot be stopped" instead of a crash halfway through one.
 */

import type { Context } from '@deepseek-ai/cordis'

import { baseName, sameIdentity } from './plan.ts'
import { prepareBuildKey, prepareRefusedPackage } from './pnpm-builds.ts'
import { appendProfileBundle, dropBundleRow, dropProfileRows } from './profile-bundle.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The contract this plugin needs from `ctx.pluginManager`, narrowed.
 *
 * Declared structurally rather than imported from the harness so that a
 * harness version that adds or renames members cannot break compilation of
 * this package, and so the tests can hand in a fake that implements exactly
 * these members.
 */
export interface HostPluginManager {
  listPlugins?(): Promise<readonly HostPluginEntry[]>
  listBundles?(): Promise<readonly HostBundleEntry[]>
  installBundle?(
    spec: string,
    options?: {
      enabled?: boolean
      saveExact?: boolean
      requestId?: string
      approvedBuilds?: readonly string[]
      registry?: string
    },
  ): Promise<unknown>
  waitForInstall?(requestId: string): Promise<unknown>
  cancelInstall?(requestId: string): Promise<'cancelled' | 'too-late' | 'not-running'>
  removeBundle?(name: string): Promise<unknown>
  /**
   * Turn one installed plugin on or off without removing it (§8.3).
   *
   * The shipped manager implements this as `setPluginEnabled(entryId, enabled)`
   * and writes a `disabled:` line into the profile patch, so it survives a
   * restart — which is what "启用开关" means. Optional for the same reason as
   * the others: a narrower host simply has no such switch, and the sheet then
   * shows the row without one rather than a control that does nothing.
   */
  setPluginEnabled?(id: string, enabled: boolean): Promise<unknown>
  /**
   * Turn a whole bundle layer on or off, keeping its dependencies (§8.3).
   *
   * The write is narrower than it sounds: `setBundleEnabled` only changes the
   * profile's `dsh.profile.bundles` selection, so the packages stay on disk.
   * Used for a bundle-shaped member, where the per-plugin switch cannot reach.
   */
  setBundleEnabled?(name: string, enabled: boolean): Promise<unknown>
  inspect?(target: string): Promise<unknown>
}

/**
 * One installed plugin, as the host reports it.
 *
 * Two identities are in play, and which one the host fills in is not a
 * promise. The documented shape says `name`; the `pluginManager` this harness
 * actually ships answers `listPlugins()` with `{ id, version, enabled }`,
 * where `id` is the install reference (`npm:cc-safety-net`, `owner/repo`).
 * Reading only `name` therefore reported an EMPTY profile: every member
 * looked uninstalled, so a second click reinstalled the whole bundle and the
 * per-card "installed" counter never left zero. Both fields are accepted, and
 * {@link HostAdapter.installed} decides which one is the identity.
 */
export interface HostPluginEntry {
  /**
   * The plugin's declared name, or its install reference.
   *
   * Preferred over `id` when both are present: a host that reports both is
   * reporting an application-level name in `name` and an internal handle in
   * `id`, and only the former is comparable with a catalog member.
   */
  name?: string
  /**
   * Exact module specifier the Loader imported, as `listPlugins()` reports it.
   *
   * This is the field the shipped host actually fills (`{ entryId, moduleName,
   * enabled, fiberPhase }`), and for a registry-installed plugin it IS the
   * package name — the same string the catalog's `id` carries after the
   * `npm:` prefix is stripped. Reading only `name`/`id` therefore made every
   * plugin row unusable, so `installed()` saw an almost empty profile.
   */
  moduleName?: string
  /** Loader-tree entry id; a last-resort identity, never a package name. */
  entryId?: string
  /**
   * Install reference, when a host reports one.
   *
   * Not filled by the shipped `pluginManager.listPlugins()` (it returns
   * `moduleName` instead), but accepted because a narrower or older manager
   * documents `id` and `spec` — and reading them costs one array slot.
   */
  id?: string
  spec?: string
  version?: string
  enabled?: boolean
}

/** One installed bundle, as the host reports it. */
export interface HostBundleEntry {
  name?: string
  /**
   * The spec `pnpm add` accepts for this profile dependency.
   *
   * Present only for a bundle the installation does not itself ship; it is
   * `name@version` for a registry bundle. Kept because a suite member may BE a
   * bundle, and a pinned member is satisfied only by the version the author
   * tested — an entry without a version could never satisfy one.
   */
  source?: string
  /** Manifest version, when the host could read the bundle's package. */
  version?: string
  /**
   * Whether the profile still DECLARES this dependency.
   *
   * The host lists official and on-demand bundles it merely offers, with
   * `installed: false`. Treating every listed name as present made the planner
   * believe a bundle was installed when it had never been, and its members
   * were then skipped by a rule that only applies to real installs.
   */
  installed?: boolean
  /**
   * Whether the profile composes this bundle right now.
   *
   * This is what `removeBundle` switches off BEFORE it can fail: the host
   * deselects the bundle, reloads, and only then discovers that a live loader
   * entry still holds the package (`bundle-in-use`). The profile is left with
   * the plugin disabled and its files still on disk, so a caller that reports
   * only the failure is hiding a change the user did not ask for. Reading this
   * field before and after a refusal is what lets the report say what actually
   * happened.
   */
  enabled?: boolean
  plugins?: readonly { name?: string; version?: string }[]
}

/**
 * What `waitForInstall` is assumed to have resolved to.
 *
 * `unknown` is deliberately a third state rather than a flavour of `failed`.
 * The host reports `ambiguous-install` when pnpm succeeded but the dependency
 * diff could not name exactly one new package; that says the HOST cannot tell,
 * not that the install did not happen. The executor reconciles the profile
 * instead of trusting either verdict — rolling an `unknown` back would delete
 * a plugin that the very next click then has to download again.
 */
/**
 * Why an install failed, as a tag the UI can translate.
 *
 * Coarse on purpose: the sentence next to it carries the specifics (package
 * name, wanted range, runtime version), and this only has to pick which
 * localized sentence to put in front of them.
 */
export type InstallFailureCause =
  /** The plugin wants a dsh version this runtime does not provide. */
  | 'incompatible-version'
  /** pnpm refused to build a git dependency until its key is allowlisted. */
  | 'git-prepare-refused'
  /**
   * The plugin installed but could not be imported: it asks the dsh runtime for
   * a module or export this version does not have.
   *
   * Distinct from `incompatible-version`: that one is the host refusing to
   * START an install because declared ranges disagree. This one is the code
   * running far enough to import and failing on a symbol, which means the
   * package's own `engines` never claimed the range it actually needs.
   */
  | 'incompatible-api'
  /** The package manager refused; the sentence names its code. */
  | 'package-manager'
  /** Another plugin or layer still contributes this one. */
  | 'bundle-in-use'
  | 'not-removable'
  | 'stale-approval'
  | 'stop-profile'
  | 'management-required'
  /** The host finished without deciding whether the plugin landed. */
  | 'ambiguous-install'
  /** Anything else the host said, or said nothing about. */
  | 'unknown'

export type InstallOutcome =
  | { status: 'ok' }
  /**
   * `cause` is a machine-readable tag for the reason, so the UI can say it in
   * the reader's language. `reason` stays the full English sentence: it carries
   * detail no tag can (which package wanted which range from which runtime),
   * and it is the fallback when the tag is one the client has no wording for.
   */
  | {
      status: 'failed'
      reason: string
      cause?: InstallFailureCause
      /** The `allowBuilds` key pnpm printed, for a git prepare refusal. */
      buildKey?: string
    }
  | { status: 'unknown'; reason: string }

/**
 * What this host can actually do, once its optional members are probed.
 *
 * §7.2 requires the preflight to establish these BEFORE the first install,
 * because each one changes what the progress screen may promise: a host that
 * cannot restart cannot deliver a verified install, and a host that cannot
 * cancel turns a hung member into a five-minute wait.
 */
export interface HostCapabilities {
  /** True when the manager exposes enough to install anything at all. */
  installable: boolean
  /** Per-member install progress (`member-phase` events) is available. */
  granularProgress: boolean
  /** Install options accepted at all; without them approvals cannot be passed. */
  passOptions: boolean
  /** The host can restart itself to load new plugins (§7.6). */
  canRestart: boolean
  /** Build-script approvals are asked and honoured (desktop cannot, §7.2). */
  canApproveBuilds: boolean
  /** A hung install can be cancelled (§7.5). */
  cancelable: boolean
}

/** One row of the installed inventory the planner compares against. */
export interface InstalledEntry {
  /** Identity used for comparison: the package name or `owner/repo`. */
  id: string
  version?: string
}

/** Raised when the host refuses an install outright. */
export class HostInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostInstallError'
  }
}

/**
 * Narrow the Cordis context to the plugin manager, probing what is present.
 *
 * @param ctx - the plugin's own context.
 * @returns the adapter, or undefined when the composition has no
 *   `pluginManager` at all — in which case the routes report the store as
 *   unavailable instead of failing on the first click.
 */
export function connectHost(ctx: Context, profileDirectory?: string): HostAdapter | undefined {
  // Cordis throws on a plain property read of a service the plugin did not
  // declare in `inject` — the throw is the framework saying the dependency was
  // never requested, so a `try` here would only hide the real problem.
  // `pluginManager` is therefore listed in the entry module's `inject`, and
  // `apply` is not called until the service exists.
  const manager = (ctx as unknown as { pluginManager?: HostPluginManager }).pluginManager
  if (manager === undefined || manager === null) return undefined
  return new HostAdapter(manager, profileDirectory)
}

/** Thin, defensive wrapper around the host plugin manager. */
export class HostAdapter {
  /**
   * Whether host receipts are printed (§8.6).
   *
   * A field rather than a per-call check of the environment: the plugin's
   * config is the documented switch, and a value read once at mount cannot
   * disagree with what the caller asked for halfway through a session.
   */
  private debug = false

  constructor(
    readonly manager: HostPluginManager,
    /**
     * The profile root, for composing a bundle into `dsh.profile.bundles`.
     *
     * Optional because a host without it still installs; only bundle-shaped
     * members need the write, and tests supply a manager alone.
     */
    readonly profileDirectory?: string,
  ) {}

  /** Turn on `[DBG]` receipt printing, or off again. */
  setDebug(enabled: boolean): void {
    this.debug = enabled
  }

  /** Probe the optional members once, so callers never have to check twice. */
  capabilities(): HostCapabilities {
    const manager = this.manager
    return {
      installable: typeof manager.installBundle === 'function',
      // The harness emits these phases per member today; keep the probe
      // separate from `installable` so a host without them still installs,
      // it just shows a spinner instead of a step list.
      granularProgress: typeof manager.waitForInstall === 'function',
      passOptions: typeof manager.installBundle === 'function',
      // Desktop builds have no CLI to restart, so they report no restart
      // capability and the orchestrator skips the restart phase (§7.2).
      canRestart: typeof manager.installBundle === 'function',
      canApproveBuilds: typeof manager.installBundle === 'function',
      cancelable: typeof manager.cancelInstall === 'function',
    }
  }

  /**
   * Everything the profile already has, in the shape the planner compares.
   *
   * Both plugins and bundles are listed: a suite member may itself be a
   * bundle, and a member that is already installed as part of another suite
   * must be recognised. Unreadable entries are skipped rather than thrown,
   * because a single malformed install must not make the whole store
   * unusable.
   */
  async installed(): Promise<InstalledEntry[]> {
    return (await this.installedStrict()) ?? []
  }

  /**
   * The inventory, or `undefined` when a source could not be read.
   *
   * `installed()` above deliberately degrades: one failing host call yields a
   * shorter list and the store keeps working. That is right for DISPLAY, and
   * wrong for anything that DELETES — `reconcile`'s withdrawal treated an
   * exception as "the user uninstalled everything" and removed claims for
   * plugins that were still installed.
   *
   * This variant reports the failure instead of hiding it, so a mutating caller
   * can tell "nothing is installed" from "I could not find out". A missing
   * method (a host that does not expose the call at all) is not a failure.
   *
   * @returns the entries, or undefined when a source threw.
   */
  async installedStrict(): Promise<InstalledEntry[] | undefined> {
    const entries: InstalledEntry[] = []
    let plugins
    try {
      plugins = await this.manager.listPlugins?.()
    } catch {
      return undefined
    }
    for (const plugin of plugins ?? []) {
      // Field precedence is deliberate, and `moduleName` is FIRST because it
      // is what the shipped host fills. The other spellings are kept for
      // hosts that document them: `name` is an application-level label,
      // `id`/`spec` are install references. `??` (not `||`) is not enough
      // because the host really does send an empty string for a nameless row.
      const id = [plugin.moduleName, plugin.name, plugin.id, plugin.spec]
        .find((value) => typeof value === 'string' && value !== '')
      if (typeof id !== 'string') continue
      entries.push(typeof plugin.version === 'string' ? { id, version: plugin.version } : { id })
    }
    let bundles
    try {
      bundles = await this.manager.listBundles?.()
    } catch {
      return undefined
    }
    for (const bundle of bundles ?? []) {
      if (typeof bundle.name !== 'string' || bundle.name === '') continue
      // `installed: false` marks a bundle the host merely OFFERS (an official
      // or on-demand catalog entry). Counting it as present made the planner
      // skip members of a bundle that had never been installed.
      if (bundle.installed === false) continue
      // The version matters even though a plugin row does not carry one: a
      // member can be a bundle, and a PINNED member is satisfied only by the
      // version the author tested. `source` is the `name@version` spec the
      // host records for a profile dependency, so it is parsed rather than
      // trusted as an identity.
      const version = typeof bundle.version === 'string'
        ? bundle.version
        : versionFromSource(bundle.source, bundle.name)
      entries.push(version === undefined ? { id: bundle.name } : { id: bundle.name, version })
    }
    return entries
  }

  /**
   * Install one member and wait for it.
   *
   * @param input.spec - what the plan says to install.
   * @param input.approvedBuilds - approvals for THIS member only.
   * @param input.requestId - id the progress stream and the cancel route use.
   * @returns the outcome; a refusal to start is thrown, so the executor can
   *   tell "never started" (nothing to roll back) from "started and failed".
   */
  async install(input: {
    spec: string
    approvedBuilds: readonly string[]
    requestId: string
  }): Promise<InstallOutcome> {
    const install = this.manager.installBundle
    if (install === undefined) throw new HostInstallError('host cannot install plugins')
    const options: Parameters<NonNullable<HostPluginManager['installBundle']>>[1] = {
      requestId: input.requestId,
      // Only pass the field when there IS an approval. The host validates
      // every name against its pending list, and an empty array is still an
      // approval attempt on hosts that treat "present" as "validate" — it
      // produced stale-approval on members that needed no script at all.
      ...(input.approvedBuilds.length === 0 ? {} : { approvedBuilds: input.approvedBuilds }),
      // `enabled: true` is explicit rather than defaulted: a member the user
      // paid a suite for should be usable as soon as it is installed.
      enabled: true,
    }
    let receipt: unknown
    // The catalog's `spec` and the host's accepted spec are NOT the same
    // language, and the difference is not cosmetic (see `hostSpec`).
    const spec = hostSpec(input.spec)
    try {
      // The receipt is the verdict. A refused install does not reject — it
      // resolves with `application: 'failed'` and a diagnostic — so dropping
      // it here loses the only explanation the user would ever get.
      receipt = await install.call(this.manager, spec, options)
    } catch (error) {
      throw new HostInstallError(errorText(error))
    }
    if (this.debug) {
      // Off by default; the switch exists because the receipt is the only
      // place a host explains itself, and a live host cannot be poked.
      console.error('[DBG] receipt', spec, JSON.stringify(receipt).slice(0, 2000))
    }
    if (this.manager.waitForInstall === undefined) {
      const direct = this.outcomeOf(receipt)
      if (direct.status === 'ok') await this.selectIntoProfile(spec)
      return direct
    }
    try {
      const settled = await this.manager.waitForInstall.call(this.manager, input.requestId)
      if (this.debug) {
        console.error('[DBG] settled', spec, JSON.stringify(settled)?.slice(0, 2000))
      }
      // `waitForInstall` returns null when it does not know the request. That
      // establishes neither success nor failure, so the earlier receipt — the
      // one `installBundle` already returned — is the better evidence.
      const outcome = this.outcomeOf(settled ?? receipt)
      if (outcome.status === 'ok') await this.selectIntoProfile(spec)
      return outcome
    } catch (error) {
      // A reinstall of something already in the profile is not a failure: the
      // host short-circuits with `already-installed`, and reporting that as a
      // red row asked the reader to fix something that is already correct.
      // This is the common case after a restart, when the package is on disk
      // but the host had not loaded it yet.
      const text = errorText(error)
      if (/already-installed|already installed/iu.test(text)) {
        // The short-circuit is also the path that skips composition: the
        // package is on disk but its bundle row was never written. Repair it
        // here, or an "already installed" member stays unloaded forever.
        await this.selectIntoProfile(spec)
        return { status: 'ok' }
      }
      return { status: 'failed', reason: text, cause: 'unknown' }
    }
  }

  /**
   * Make sure a package the host just installed is SELECTED, not merely on disk.
   *
   * Measured gap: `installBundle(..., { enabled: true })` adds the package to
   * `package.json` and writes its files, but the profile's `dsh.profile.bundles`
   * list does not gain the entry. A plugin that ships its own `cordis.patch.yml`
   * — which is how a package adds a bundle layer — only takes effect when it is
   * listed there, so the install succeeded and the plugin still never loaded:
   * `listPlugins()` did not have it, and the row said "installed but not loaded"
   * until the profile was fixed by hand.
   *
   * `setBundleEnabled` writes exactly that list, so calling it here closes the
   * gap. Failure is swallowed on purpose: the install itself already succeeded,
   * and a host without this method must not turn a working install into an
   * error. The presence check still decides what the row says.
   *
   * @param spec - the host spec that was installed (`npm:@scope/name@1.2.3`).
   */
  private async selectIntoProfile(spec: string): Promise<void> {
    if (this.profileDirectory === undefined) return
    const name = declaresBundle(this.profileDirectory, spec)
    if (name === undefined) return
    appendProfileBundle(this.profileDirectory, name)
  }

  /**
   * Ask the host to stop an in-flight install (§7.5).
   *
   * @returns the host's own verdict, or `too-late` when it cannot be asked.
   *
   * `too-late` is the conservative answer and the one §7.5/§11 decides on: it
   * means "stop assuming this member did not happen", so the executor
   * reconciles the profile instead of retrying into a half-finished install.
   * `not-running` must NOT be treated the same way — it means the install
   * already ended, so whatever it was doing is done.
   */
  async cancel(requestId: string): Promise<'cancelled' | 'too-late' | 'not-running'> {
    if (this.manager.cancelInstall === undefined) return 'too-late'
    try {
      const verdict = await this.manager.cancelInstall.call(this.manager, requestId)
      if (verdict === 'cancelled' || verdict === 'too-late' || verdict === 'not-running') return verdict
      return 'too-late'
    } catch {
      return 'too-late'
    }
  }

  /**
   * Whether the profile holds the plugin an identity names.
   *
   * The identity a caller holds and the identity the host reports differ in
   * prefix and version more often than they agree (§7.4's drift note): the
   * bundle names `npm:alpha@1.0.0`, the host answers `npm:alpha`, and a
   * removal asks about `alpha`. Comparing the raw strings made every such
   * question answer "no", which reads as "the removal did nothing" even after
   * the plugin really was gone.
   */
  async has(id: string): Promise<boolean> {
    const installed = await this.installed()
    // `sameIdentity`, not a bare-name set: a git member is `owner/repo` while
    // the host lists the package as `@owner/repo`, and comparing those by any
    // exact spelling made a still-present plugin look removed — the uninstall
    // reported done with the files, the dependency and the bundle row intact.
    return installed.some((entry) => sameIdentity(entry.id, id))
  }

  /**
   * Remove a plugin the profile has, undoing a member that failed (§7.3).
   *
   * A member's package manager can add half a dependency tree and then fail on
   * a peer dependency. Those files are real: the profile lists the plugin, so
   * the next attempt answers `already-installed` and the user cannot get past
   * a failure they already saw. The rollback therefore asks the host to remove
   * what appeared, and this method has to actually do it.
   *
   * `removeBundle` takes the bare package name (`@scope/name`), not the
   * install reference the catalog stores (`npm:@scope/name@1.2.3`), so each
   * candidate spelling is tried in turn and the result is verified by asking
   * the profile again rather than by trusting the receipt — §7.5 establishes
   * the rule that a host's silence is not a verdict.
   *
   * @throws when every spelling was tried and the plugin is still there.
   */
  async remove(id: string): Promise<void> {
    const remove = this.manager.removeBundle
    if (remove === undefined) throw new Error('this host cannot remove plugins')
    // A bundle-shaped package must leave the stack BEFORE it can be removed:
    // while its row is in `dsh.profile.bundles` the host treats it as a
    // required layer and `removeBundle` answers `not-removable`. Taking the row
    // out first is the truthful order — the profile stops composing it, then
    // its files go.
    this.releaseBundleRow(id)
    const candidates = [...new Set([...bareNames(id), id])]
    // The host reports a refusal in the DATA (`{ application: 'failed', error:
    // { code: 'bundle-in-use' } }`), which RESOLVES normally — so dropping the
    // receipt here made every actionable refusal indistinguishable from a
    // wrong spelling, and the caller ended up with the generic sentence below
    // instead of the one `removalRefusal()` already knows how to write.
    let lastReason: string | undefined
    for (const candidate of candidates) {
      let receipt: unknown
      try {
        receipt = await remove.call(this.manager, candidate)
      } catch (error) {
        // Wrong spelling and a real refusal look the same from here; the
        // presence check below decides which it was — but the reason is kept,
        // because a host that refuses to start says nothing else anywhere.
        lastReason = errorText(error)
        continue
      }
      lastReason = removalRefusal(receipt) ?? lastReason
      if (!(await this.has(id))) {
        this.dropRowsIfGone(id)
        return
      }
    }
    // The host kept reporting success with the plugin still present. Disk truth
    // decides: if the files are gone, the manifest rows must follow or the next
    // boot fails composing a bundle that no longer exists; if they are not,
    // this is a real refusal and the caller has to say so — with the host's own
    // reason when it gave one.
    if (await this.has(id)) throw new Error(lastReason ?? `${id} is still installed after a removal attempt`)
    this.dropRowsIfGone(id)
  }

  /**
   * Take a package's row out of `dsh.profile.bundles` before removing it.
   *
   * The row is what makes the host treat the package as a required layer; it
   * stayed behind on an uninstall that the host then refused, because removing
   * a composed layer is not something `removeBundle` will do. Only the row is
   * dropped here — the dependency and the files are the install's business.
   */
  releaseBundleRow(id: string): void {
    if (this.profileDirectory === undefined) return
    const name = this.installedPackageName(id)
    if (name === undefined) return
    dropBundleRow(this.profileDirectory, name)
  }

  /**
   * Drop this package's manifest rows once its files are gone.
   *
   * `removeBundle` can answer success without removing anything — measured on a
   * git-hosted bundle whose directory, dependency and `dsh.profile.bundles` row
   * all survived, while the operation record said `done`. The rows are only
   * dropped once the directory is confirmed absent: an early drop would make a
   * still-installed plugin unloadable at the next boot.
   */
  private dropRowsIfGone(id: string): void {
    if (this.profileDirectory === undefined) return
    const name = this.installedPackageName(id)
    if (name === undefined) return
    if (existsSync(join(this.profileDirectory, 'node_modules', name, 'package.json'))) return
    dropProfileRows(this.profileDirectory, name)
  }

  /**
   * The package name this identity refers to, as the manifest spells it.
   *
   * A git member arrives as `owner/repo` while the dependency is `@owner/repo`
   * (scoped, lowercased), so the manifest's own dependency list is the only
   * place that knows the right spelling.
   */
  private installedPackageName(id: string): string | undefined {
    if (this.profileDirectory === undefined) return undefined
    const bare = bareNames(id).at(-1) ?? id
    try {
      const manifest = JSON.parse(
        readFileSync(join(this.profileDirectory, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, unknown> }
      const names = Object.keys(manifest.dependencies ?? {})
      // Compare against the FULL identity: `sameIdentity`'s git arm needs to
      // see that one side is a git reference before folding it to the package
      // name the manifest records (`dsh-perlica-ding`).
      return names.find((name) => sameIdentity(name, id)) ?? bare
    } catch {
      return bare
    }
  }

  /**
   * The spellings worth trying on `setPluginEnabled`, best first.
   *
   * The shipped manager keys on the Loader-tree `entryId` — a handle that looks
   * nothing like the package name (`include:billion-context`) and cannot be
   * derived from it. So the profile is asked first and its own answer goes to
   * the front of the list; the bare and versioned package names follow for a
   * host that documents `id` as the package instead. Order matters only for
   * how many refused calls are spent, not for correctness: every candidate is
   * read back before it counts as done.
   */
  private async enableCandidates(id: string): Promise<string[]> {
    const family = bareNames(id)
    const bare = family[family.length - 1] ?? id
    const wanted = new Set(family)
    const plugins = await this.manager.listPlugins?.().catch(() => [])
    const row = (plugins ?? []).find((plugin) => {
      const names = [plugin.moduleName, plugin.name, plugin.entryId, plugin.id, plugin.spec]
        .filter((value): value is string => typeof value === 'string' && value !== '')
      return names.some((name) => name === id || wanted.has(name) || bareNames(name).some((one) => wanted.has(one)))
    })
    const entryId = row?.entryId
    return [...new Set([...(typeof entryId === 'string' && entryId !== '' ? [entryId] : []), bare, ...family, id])]
  }

  /**
   * Turn one installed plugin on or off, verifying the result (§8.3).
   *
   * Two identities are possible and only one of them is documented: the
   * shipped `setPluginEnabled` keys on the Loader-tree `entryId`, while the
   * catalog and every other call in this file speak package names. Rather than
   * guess, this passes whatever it was given and then reads the profile back —
   * the same rule `remove()` follows, because a host's silence is not a verdict
   * (§7.5) and the switch must not show a state the host never reached.
   *
   * @param id - plugin id as the caller knows it (`npm:<name>` or the bare name).
   * @param enabled - the state to reach, not a toggle.
   * @returns whether the profile reports the requested state afterwards.
   */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const set = this.manager.setPluginEnabled
    if (set === undefined) throw new Error('this host cannot enable or disable plugins')
    const candidates = await this.enableCandidates(id)
    let refusal: string | undefined
    let saved: string | undefined
    let overridden = false
    let unknownEverywhere = true
    for (const candidate of candidates) {
      let receipt: unknown
      try {
        receipt = await set.call(this.manager, candidate, enabled)
      } catch (error) {
        // A thrown word is a refusal for this spelling. It is remembered only
        // until a spelling the host accepts proves the plugin is known: an
        // `unknown-plugin` from a wrong spelling must not become the answer to
        // "why did the switch not move" when an earlier one already wrote it.
        const reason = error instanceof Error ? error.message : String(error)
        if (saved === undefined) refusal = reason
        // A thrown word is a verdict for THIS spelling, so only
        // `unknown-plugin` means "the host does not know this name" — which is
        // the one case the bundle switch below exists for. Leaving the flag
        // true for every thrown refusal let a `management-required` or
        // `bundle-in-use` fall through to `setBundleState()`, flipping an
        // unrelated bundle instead of reporting the real refusal.
        if (!/unknown-plugin/iu.test(reason)) unknownEverywhere = false
        continue
      }
      const refused = removalRefusal(receipt)
      if (refused !== undefined) {
        if (saved === undefined) refusal = refused
        if (refused !== 'unknown-plugin') { unknownEverywhere = false; break }
        continue
      }
      // No error means the host wrote the change. From here the only open
      // question is whether this profile can show it. Stop trying other
      // spellings: a second write under a different id would be a second,
      // unrelated edit, and the `unknown-plugin` they all answer would mask
      // the truth (the shipped manager keys on `entryId`, not package names).
      saved = candidate
      unknownEverywhere = false
      overridden = overriddenIn(receipt)
      break
    }
    // A plugin that arrives through a bundle whose composition is switched off
    // has no Loader entry at all, so `setPluginEnabled` answers `unknown-plugin`
    // for every spelling. The switch that exists for it is the bundle's, and
    // the manager exposes that separately (§7.7).
    if (unknownEverywhere && (await this.setBundleState(id, enabled))) return true
    // Whether the change landed is answered by the profile, not the receipt.
    if ((await this.enabledState(id)) === enabled) return true
    if (saved !== undefined) {
      // The write is on disk but the running profile did not pick it up. This
      // is neither success nor a refusal: reporting either would leave the
      // switch showing a state the host never reached (§7.7 asymmetry), and
      // leaving the `disabled:` line behind would silently change a plugin the
      // user never asked to change once some unrelated reload finally applies
      // it. Undo the exact write, then say why the switch cannot move here.
      // Two different facts, and the user needs the right one. `overridden`
      // means the host kept the write but recomposed the profile WITHOUT
      // honouring it — the package is still contributed by a higher layer (it
      // is a member of another installed suite, or its bundle is still
      // selected), so this switch cannot move it from here. The other case is
      // a plain runtime lag: the write is correct and a reload applies it.
      // Naming the plugin in both keeps the sentence traceable — the earlier
      // wording named `id` once and left users guessing which row failed.
      const reason = overridden
        ? `${id}: the host kept the change, but the plugin is still contributed by another layer (another suite lists it, or its bundle is still selected), so this switch cannot take effect here`
        : `${id}: the host kept the change, but this profile still reports it as ${enabled ? 'off' : 'on'}; it takes effect after the host reloads`
      try {
        await set.call(this.manager, saved, !enabled)
      } catch (rollbackError) {
        // The undo is best-effort: the honest failure sentence still has to
        // reach the UI, and a second refusal is an extra detail to name, not
        // a reason to hide the first one.
        const extra = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(`${reason} (and the change could not be undone: ${extra})`)
      }
      throw new Error(reason)
    }
    throw new Error(refusal ?? `the host did not turn ${id} ${enabled ? 'on' : 'off'}`)
  }

  /**
   * Flip the bundle a package arrived in, for plugins with no Loader entry.
   *
   * @returns whether the profile reports the requested state afterwards.
   */
  private async setBundleState(id: string, enabled: boolean): Promise<boolean> {
    const set = this.manager.setBundleEnabled
    if (set === undefined) return false
    // The bundle name, never the `name@version` install reference: the host
    // selects compositions by the package name it knows, and a versioned
    // string would simply not match any bundle.
    const family = bareNames(id)
    for (const candidate of [...new Set([family[family.length - 1] ?? id, ...family, id])]) {
      try {
        const receipt = await set.call(this.manager, candidate, enabled)
        if (removalRefusal(receipt) !== undefined) continue
      } catch {
        continue
      }
      if ((await this.enabledState(id)) === enabled) return true
    }
    return false
  }

  /**
   * The host's current answer for "is this plugin on", or undefined when the
   * profile cannot say.
   *
   * Asked of `listPlugins()` first, then `listBundles()`. The second pass is not
   * a fallback for a host that answered badly: a plugin whose bundle is
   * deselected genuinely has no plugin row, and reporting "no state" for it
   * would leave the switch blank on exactly the members someone turned off.
   *
   * Read rather than remembered, because the switch is drawn on every open of
   * the sheet and a cached answer would show a state from before someone else's
   * edit.
   */
  async enabledState(id: string): Promise<boolean | undefined> {
    const plugins = await this.manager.listPlugins?.().catch(() => [])
    for (const plugin of plugins ?? []) {
      const names = [plugin.moduleName, plugin.name, plugin.entryId, plugin.id, plugin.spec]
        .filter((value): value is string => typeof value === 'string' && value !== '')
      if (!names.some((name) => sameIdentity(name, id))) continue
      return plugin.enabled
    }
    const bundles = await this.manager.listBundles?.().catch(() => undefined)
    for (const bundle of bundles ?? []) {
      const names = [bundle.name, bundle.source]
        .filter((value): value is string => typeof value === 'string' && value !== '')
      const matches = names.some((name) => sameIdentity(name, id))
      // A bundle also carries the packages it pulls in; matching on those keeps
      // a member reachable when the bundle's own name differs from the package.
      const carries = (bundle.plugins ?? []).some((plugin) => {
        const name = plugin.name
        return typeof name === 'string' && sameIdentity(name, id)
      })
      if (!matches && !carries) continue
      if (bundle.installed === false) continue
      if (bundle.enabled === undefined) return undefined
      return bundle.enabled
    }
    return undefined
  }

  /**
   * Read a `pluginManager` receipt and decide whether the member landed.
   *
   * The documented receipt is `ChangeResult` (§ "installBundle returns
   * Package-manager diagnostics, the registries asked, and the observed
   * activation outcome"). A refused install resolves normally and reports it
   * in the DATA, not by rejecting:
   *
   * ```
   * { changed: false, application: 'failed', stage: 'install',
   *   error: { code: 'operation-error', diagnostic: '...' },
   *   packageResult: { exitCode: 1, kind: 'not-found', output: '...' } }
   * ```
   *
   * Treating every resolved promise as success — which is what reading only
   * `ok`/`status` did — meant the executor reported `installBundle` as fine,
   * looked the plugin up, did not find it, and blamed ITSELF with
   * "the host reported success but the plugin is not in the installed
   * list". The user then had a red row with no reason and no way to act. The
   * host's own `error.diagnostic` and the package manager's exit code are
   * exactly the missing sentence, so they are carried into the failure.
   *
   * Unknown shapes still count as success: a harness that changes its receipt
   * must not make a working install look broken. The executor's presence
   * check is the backstop for that case.
   */
  private outcomeOf(result: unknown): InstallOutcome {
    if (typeof result !== 'object' || result === null) return { status: 'ok' }
    const record = result as Record<string, unknown>

    // 1. `ambiguous-install` is NOT a failure — it is the host saying it
    //    could not decide. pnpm exited 0, so files are on disk; what failed is
    //    the host's own `before/after` dependency diff, which needs exactly one
    //    changed dependency and cannot name one when the package was already
    //    declared at the same version (an empty diff) or when a second, earlier
    //    member landed in the same window. Reporting that as `failed` made the
    //    executor roll back a plugin that was installed correctly.
    const code = (record['error'] as Record<string, unknown> | undefined)?.['code']
    if (code === 'ambiguous-install') {
      return { status: 'unknown', reason: describeFailure(record).reason }
    }

    // 1b. A reinstall of something the profile already has. The host
    //     short-circuits it with `already-installed`, which is a FACT about the
    //     profile, not a failure — and it is the common case after a restart,
    //     when the package sits on disk but the host had not loaded it yet.
    //     Reporting it red asked the reader to fix something already correct.
    if (reportsAlreadyInstalled(record)) return { status: 'ok' }

    // 2. The documented failure channel.
    const application = record['application']
    if (application === 'failed') {
      return { status: 'failed', ...describeFailure(record) }
    }

    // 3. Package-manager level failure, even when activation was never
    //    attempted (`application` absent on an older receipt, or 'cancelled'
    //    on one that stopped half-way).
    const packageResult = record['packageResult'] as Record<string, unknown> | undefined
    if (typeof packageResult === 'object' && packageResult !== null) {
      const exitCode = packageResult['exitCode']
      if (typeof exitCode === 'number' && exitCode !== 0) {
        return { status: 'failed', ...describeFailure(record) }
      }
    }

    // 4. An install the host refuses to call a success.
    //
    //    `changed: false` alone is NOT evidence of failure: an install of a
    //    package the profile already declares at the same version legitimately
    //    changes nothing, and so does a successful install into a profile whose
    //    manifest pnpm rewrote identically. Only a receipt that ALSO carries a
    //    failure code reaches this arm — `application` and a non-zero exit code
    //    were handled above, so what is left is a flat field on an older host.
    //    The executor's presence check is the real backstop either way.
    if (record['changed'] === false && code !== undefined) {
      return { status: 'failed', ...describeFailure(record) }
    }

    // 5. An older or narrower receipt that signals failure in flat fields.
    if (record['ok'] === false || record['status'] === 'failed' || record['status'] === 'error') {
      return { status: 'failed', ...describeFailure(record) }
    }
    return { status: 'ok' }
  }
}

/**
 * One sentence a user can act on, from whatever the host reported.
 *
 * §7.4 failures are shown to a non-developer, so the package manager's raw
 * output is not passed through. `pnpm` prints several hundred progress lines
 * before its verdict, and echoing them buried the one line that mattered —
 * and in the reviewed run the verdict itself was `ERR_PNPM_IGNORED_BUILDS`,
 * a failure the store had already asked about and the user had already
 * answered, reported back as an anonymous wall of text.
 *
 * The order below is by usefulness, not by where the field sits:
 *
 * 1. pnpm's own error code (`ERR_PNPM_*`), which names the problem.
 * 2. The host's `error.diagnostic`, which is written for a person and usually
 *    carries the package and version that failed.
 * 3. The structured `packageResult.kind` ('not-found', 'build-blocked', …),
 *    which is coarser but still stable when there is no diagnostic.
 * 4. The last meaningful line of the log, filtered of `Progress:`/`[WARN]`.
 */
/**
 * Whether a receipt describes an install the profile already satisfies.
 *
 * The host says this in several places depending on version: `error.code`,
 * a flat `reason`, or the diagnostic text. All of them mean the same thing, and
 * none of them is a failure — the executor's presence check is what decides
 * whether the member is really there.
 */
function reportsAlreadyInstalled(record: Record<string, unknown>): boolean {
  const code = (record['error'] as Record<string, unknown> | undefined)?.['code']
  if (typeof code === 'string' && /already-installed/iu.test(code)) return true
  for (const field of ['reason', 'message', 'code']) {
    const value = record[field]
    if (typeof value === 'string' && /already-installed/iu.test(value)) return true
  }
  return false
}

function describeFailure(record: Record<string, unknown>): {
  reason: string
  cause: InstallFailureCause
  buildKey?: string
} {
  const packageResult = record['packageResult'] as Record<string, unknown> | undefined
  const output = typeof packageResult?.['output'] === 'string' ? (packageResult['output'] as string) : ''

  // A compatibility refusal is the one failure the user can act on without
  // changing anything else: the plugin's own version requirements do not
  // match this runtime. The host writes it as a structured list on some
  // builds and as a trailing log line on others, and the remedy is a version
  // exemption (§ "setVersionExemption"), so it is read before everything
  // else — the log's last line after this refusal is `Done in 1.4s`, which
  // reads as success.
  const incompatible = incompatibleSentence(record['incompatible']) ?? refusalSentence(output)
  if (incompatible !== undefined) return { reason: incompatible, cause: 'incompatible-version' }

  // A plugin that imports a symbol this runtime does not export. Node writes
  // this as a SyntaxError from the loader, and it is the one shape of "version
  // mismatch" the declared engines cannot catch: the package asked for a
  // version it thinks has the export, or declared no range at all.
  // A git prepare refusal carries the one key that would authorise the build;
  // pnpm prints it once and never stores it anywhere the profile can read.
  const prepareKey = prepareBuildKey(output, '')
  if (prepareKey !== null) {
    const refusal = prepareRefusedPackage(output, '')
    return {
      reason: refusal === null
        ? 'pnpm refused to build this git dependency; it needs an approval'
        : `${refusal}: pnpm refused to build this git dependency; approve it to install`,
      cause: 'git-prepare-refused',
      buildKey: prepareKey,
    }
  }

  const apiMismatch = moduleExportMismatch(record)
  if (apiMismatch !== undefined) return { reason: apiMismatch, cause: 'incompatible-api' }

  const pnpmCode = /(ERR_PNPM_[A-Z_]+)/u.exec(output)?.[1]
  if (pnpmCode !== undefined) {
    const detail = explainPnpmCode(pnpmCode)
    return { reason: detail === undefined ? pnpmCode : `${pnpmCode}: ${detail}`, cause: 'package-manager' }
  }

  const error = record['error'] as Record<string, unknown> | undefined
  if (typeof error === 'object' && error !== null) {
    const diagnostic = error['diagnostic']
    if (typeof diagnostic === 'string' && diagnostic.trim() !== '') {
      return { reason: lastLine(diagnostic), cause: 'unknown' }
    }
    const code = error['code']
    if (typeof code === 'string' && code !== '') {
      const named = explainHostCode(code)
      if (named !== undefined) return { reason: named, cause: causeOfHostCode(code) }
    }
  }

  if (typeof packageResult === 'object' && packageResult !== null) {
    const kind = packageResult['kind']
    if (typeof kind === 'string' && kind !== '') {
      return { reason: `package manager: ${kind}`, cause: 'package-manager' }
    }
  }

  if (output !== '') {
    const meaningful = lastLine(output)
    if (meaningful !== '') return { reason: meaningful, cause: 'unknown' }
  }

  if (typeof packageResult === 'object' && packageResult !== null) {
    const exitCode = packageResult['exitCode']
    if (typeof exitCode === 'number') {
      return { reason: `package manager exited ${exitCode}`, cause: 'package-manager' }
    }
  }

  const flat = record['error'] ?? record['reason']
  return {
    reason: flat === undefined ? 'the host did not say why the install failed' : errorText(flat),
    cause: 'unknown',
  }
}

/**
 * "dsh-win-toolkit 0.1.3 needs @deepseek-ai/dsh-tools ^0.1.0-rc.6, which this
 * runtime (0.2.1-rc.3) does not provide."
 *
 * The host reports incompatibility structurally as
 * `{ name, version, runtimeVersion, requirements }`, and repeats the same
 * sentence twice in its own log. Reading the structure keeps the sentence
 * short and keeps the requirement visible, which is what the user needs to
 * decide whether to upgrade or grant an exemption.
 */
function incompatibleSentence(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const first = value[0]
  if (typeof first !== 'object' || first === null) return undefined
  const entry = first as Record<string, unknown>
  const name = typeof entry['name'] === 'string' ? entry['name'] : undefined
  const version = typeof entry['version'] === 'string' ? entry['version'] : undefined
  const runtime = typeof entry['runtimeVersion'] === 'string' ? entry['runtimeVersion'] : undefined
  const requirements = entry['requirements']
  const wanted =
    typeof requirements === 'object' && requirements !== null && !Array.isArray(requirements)
      ? Object.entries(requirements as Record<string, unknown>)
          .map(([key, range]) => `${key} ${String(range)}`)
          .join(', ')
      : undefined
  if (name === undefined) return undefined
  const subject = version === undefined ? name : `${name} ${version}`
  const need = wanted === undefined ? 'requirements this runtime does not meet' : `needs ${wanted}`
  const where = runtime === undefined ? 'this dsh runtime' : `dsh ${runtime}`
  return `${subject} ${need}, which ${where} does not provide — grant a version exemption or install a compatible version`
}

/**
 * Read the host's plain-text compatibility refusal.
 *
 * The log line is
 * `dsh: installation rejected: Plugin dsh-api-relay-audit@2.5.0 is
 * incompatible with dsh 0.2.1-rc.3: requirements {...}. Running it may cause
 * crashes or data loss. ... grant the exact-version exemption for <spec> on
 * dsh <version> with `dsh plugin ...``.
 *
 * Only two parts of that are worth keeping: which requirement failed and
 * which runtime refused it. The rest is a legal notice repeated on every run.
 */
function refusalSentence(output: string): string | undefined {
  const match = /installation rejected: Plugin (\S+) is incompatible with dsh (\S+?): requirements (\{[^}]*\})/u.exec(output)
  if (match === null) return undefined
  const [, plugin, runtime, requirements] = match
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(requirements ?? '{}')
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>
  } catch {
    return undefined
  }
  const wanted = Object.entries(parsed)
    .map(([key, range]) => `${key} ${String(range)}`)
    .join(', ')
  if (wanted === '') return undefined
  return `${plugin ?? 'the plugin'} needs ${wanted}, which dsh ${runtime ?? 'this runtime'} does not provide — grant a version exemption or install a compatible version`
}

/**
 * The text of an ESM import failure, when the host reported one.
 *
 * Node's message is `The requested module 'X' does not provide an export named
 * 'Y'`, and the host wraps it as `failed to import: SyntaxError: ...`. Both
 * halves are searched across every string field the record has, because the
 * host puts the diagnostic in different places on different builds.
 *
 * @param record - the host's failure record.
 * @returns the sentence to show, or undefined when this is not that failure.
 */
function moduleExportMismatch(record: Record<string, unknown>): string | undefined {
  const seen: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || seen.length > 20) return
    if (typeof value === 'string') { seen.push(value); return }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item, depth + 1)
    }
  }
  walk(record, 0)
  for (const text of seen) {
    const match = /does not provide an export named '([^']+)'/u.exec(text)
      ?? /does not provide an export named "([^"]+)"/u.exec(text)
    if (match !== null) return firstMeaningfulLine(text)
  }
  return undefined
}

/** The first line of a message that names the failure rather than its stack. */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split(SPLIT_LINES)) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('at ') && !trimmed.startsWith('Node.js')) return trimmed
  }
  return text.trim()
}

/** Runs of line endings, for splitting a diagnostic into lines. */
const SPLIT_LINES = /[\r\n]+/u

/**
 * The tag for a host error code, for codes that have their own wording.
 *
 * A code with no entry falls back to `unknown`: the sentence beside it is still
 * the host's own explanation, and inventing a category for it would be worse
 * than admitting the tag does not cover this one.
 */
function causeOfHostCode(code: string): InstallFailureCause {
  switch (code) {
    case 'ambiguous-install': return 'ambiguous-install'
    case 'incompatible-version': return 'incompatible-version'
    case 'bundle-in-use': return 'bundle-in-use'
    case 'stale-approval': return 'stale-approval'
    case 'not-removable': return 'not-removable'
    case 'stop-profile': return 'stop-profile'
    case 'management-required': return 'management-required'
    default: return 'unknown'
  }
}

/** What a host error code means, in the user's terms. */
function explainHostCode(code: string): string | undefined {
  switch (code) {
    case 'ambiguous-install':
      // The host finished without deciding whether the plugin landed. Saying
      // "ambiguous" is honest; saying nothing is how `Done in 1.1s` was
      // reported to the user as a failure.
      return 'the host could not tell whether the install landed; check the plugin list before retrying'
    case 'incompatible-version':
      return 'the plugin requires a dsh version this runtime does not provide'
    case 'bundle-in-use':
      return 'another plugin is using this one, so it cannot be changed right now'
    case 'stale-approval':
      return 'the build-script approval expired; approve it again'
    case 'not-removable':
      // The refusal is about the RUNNING session: a plugin the host has
      // already composed into this process cannot be taken out of it, which
      // is why the store's own row was removed but the host still says no.
      // Naming the next step is the difference between a dead end and a
      // retry that works.
      return 'the host cannot remove a plugin that is already loaded; quit DSH completely and remove it from the profile'
    case 'stop-profile':
      return 'the host refused to change the profile while it is stopping'
    case 'management-required':
      // Reserved for the composition layers the harness needs in order to run
      // at all. Reported as a sentence rather than the code because the switch
      // that produced it stays on screen, and a bare `management-required`
      // reads like a crash rather than a decision the host made.
      return 'the host manages this plugin itself, so it cannot be changed here'
    default:
      return undefined
  }
}

/**
 * Why a `removeBundle` receipt says the plugin is still there.
 *
 * The host never rejects a removal: `change()` folds every `ManagementFailure`
 * into a resolved `{ application: 'failed', error: { code } }`. A caller that
 * reads only the promise therefore sees success for a removal that did
 * nothing, and the only symptom is the next preview offering the same plugin
 * again — which reads as "the button is broken" rather than "the host refused
 * for this reason".
 *
 * The codes worth surfacing are the ones with a remedy the user can act on:
 *
 * - `bundle-in-use` — a live loader entry still holds the package. The host
 *   deselects and reloads first, so this means the reload did not free it
 *   (a preset-scoped row, or a host that reports `restart-required`). Retrying
 *   in the same session cannot help; the plugin has to be stopped first.
 * - `not-removable` — a profile or built-in bundle the host protects.
 * - `stop-profile` — the profile was shutting down mid-request.
 *
 * @param receipt - whatever `removeBundle` resolved to.
 * @returns a sentence for the failure row, or undefined when the receipt
 *   carries no error at all (which means the host believes it worked, and the
 *   caller's own presence check decides).
 */
export function removalRefusal(receipt: unknown): string | undefined {
  if (typeof receipt !== 'object' || receipt === null) return undefined
  const error = (receipt as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null) return undefined
  const entry = error as Record<string, unknown>
  // A diagnostic is written for a person and names the package; prefer it over
  // the code, exactly as `describeFailure` does for installs.
  const diagnostic = entry['diagnostic']
  if (typeof diagnostic === 'string' && diagnostic.trim() !== '') return lastLine(diagnostic)
  const code = entry['code']
  if (typeof code !== 'string' || code === '') return undefined
  return explainHostCode(code) ?? code
}

/**
 * Whether the host saved a switch but cannot show it.
 *
 * `setPluginEnabled` resolves with `{ application: 'overridden' }` when it
 * wrote the patch, reloaded, and then found the plugin's composed state still
 * opposite to the request — another layer (a bundle patch, a preset) decides
 * the enabled flag. The write is real and the switch did not move, so neither
 * "success" nor "the host refused" is an honest answer (§7.7).
 *
 * Only this value is recognised: `applied`/`restart-required` are handled by
 * the caller's own read-back, and an `error` is handled by `removalRefusal`.
 */
function overriddenIn(receipt: unknown): boolean {
  if (typeof receipt !== 'object' || receipt === null) return false
  return (receipt as Record<string, unknown>)['application'] === 'overridden'
}

/**
 * What a pnpm error code means, in the user's terms.
 *
 * Only codes whose remedy the store can actually offer are translated; the
 * rest fall through to the bare code, which is at least searchable.
 */
function explainPnpmCode(code: string): string | undefined {
  switch (code) {
    case 'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED':
      // The fetcher refused before materialising anything. Approving it is a
      // real remedy — the key pnpm printed is what authorises the build — so
      // this is not the same dead end as an unapproved script the profile
      // never records.
      return 'pnpm refused to build this git dependency; it needs an approval'
    case 'ERR_PNPM_IGNORED_BUILDS':
      // §7.2: build scripts are approved once, before the run. pnpm looking at
      // its own ignore list means the approval did not reach it.
      return 'a dependency wanted to run a build script the profile had not approved'
    case 'ERR_PNPM_FETCH_404':
    case 'ERR_PNPM_NO_MATCHING_VERSION':
      return 'the registry does not have this package or version'
    case 'ERR_PNPM_FETCH_401':
    case 'ERR_PNPM_FETCH_403':
      return 'the registry refused the request'
    case 'ERR_PNPM_META_FETCH_FAIL':
    case 'ERR_PNPM_TARBALL_FETCH_FAIL':
      return 'the registry could not be reached'
    case 'ERR_PNPM_PEER_DEP_ISSUES':
      return 'the package needs a peer dependency the profile does not have'
    case 'ERR_PNPM_OUTDATED_LOCKFILE':
      return 'the profile lockfile does not match its package.json'
    case 'ERR_PNPM_ENOENT':
    case 'ERR_PNPM_EPERM':
      return 'the profile directory could not be written'
    default:
      return undefined
  }
}

/** The last log line that carries information rather than progress. */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !line.startsWith('Progress:'))
    .filter((line) => !line.startsWith('[WARN]'))
    .filter((line) => !line.startsWith('++++++++'))
    .filter((line) => !line.startsWith('+++'))
  const last = lines[lines.length - 1]
  if (last === undefined) return ''
  return last.length > 200 ? `${last.slice(0, 199)}…` : last
}

/**
 * Every spelling of the bare package an identity refers to.
 *
 * `npm:@scope/pkg@1.2.0` → `npm:@scope/pkg`, `@scope/pkg`;
 * `git:owner/repo#sub` → `owner/repo`. Scoping means the version separator is
 * the LAST `@`, not the first: `@scope/pkg` begins with one, and treating that
 * as a version boundary would reduce every scoped package to `scope/pkg`.
 */
function bareNames(id: string): string[] {
  // Delegated to `baseName` so every git spelling (`github:`, `git+https://…`)
  // and the subdirectory fragment are stripped in ONE place. A local copy that
  // only handled `git:`/`npm:` left a git member's manifest name unreachable,
  // which is what made `setPluginEnabled` and the profile lookup miss it.
  const bare = baseName(id)
  const withoutVersion = id.replace(/^(?:git|github):/u, '').split('#')[0] ?? id
  return bare === withoutVersion ? [bare] : [withoutVersion, bare]
}

/**
 * The version recorded inside a `name@version` source spec.
 *
 * `listBundles()` reports `source: 'dsh-cost-meter@1.9.62'` for a registry
 * bundle the profile owns, but a git or tarball source is a URL with no
 * meaningful version, and a range (`^1.2.0`) is not the version on disk. Both
 * are refused rather than guessed: a wrong version makes a pinned member look
 * unsatisfied and triggers the redundant reinstall the skip rule exists to
 * prevent — or, worse, makes it look satisfied when it is not.
 *
 * @param source - the host's installable spec for the dependency.
 * @param name - the dependency's own name, which must be what the spec names.
 * @returns the exact version, or undefined when the source does not state one.
 */
function versionFromSource(source: string | undefined, name: string): string | undefined {
  if (typeof source !== 'string' || source === '') return undefined
  // Only registry specs carry a comparable version; a `file:`, `link:`, git or
  // URL source does not.
  if (/^(?:file|link|git|github|gitlab|bitbucket|https?):/iu.test(source)) return undefined
  // Start at 1 so a scoped name's leading `@` is not read as the separator.
  const at = source.indexOf('@', 1)
  if (at === -1 || at !== name.length || source.slice(0, at) !== name) return undefined
  const version = source.slice(at + 1)
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(version) ? version : undefined
}

/**
 * The catalog's install spec, translated into what the host actually accepts.
 *
 * This is the single most load-bearing line in the adapter, and it is a
 * transcription difference rather than a feature: the catalog stores
 * `npm:<name>@<version>` (§5.5, chosen for a stable identity across sources),
 * while `pluginManager.installBundle` runs the spec through its own
 * `parseInstallSpec`, whose registry grammar is `[@scope/]name[@range]` and
 * which answers `invalid-spec` for anything starting with `npm:`. pnpm itself
 * takes both spellings, so the difference only shows up in what the HOST can
 * do with the result:
 *
 * - its `already-installed` short-circuit calls `specPackageName(spec, …)`,
 *   which returns undefined for a spec it could not parse, so re-adding an
 *   installed member never short-circuits;
 * - its success check diffs `package.json`'s dependencies before and after
 *   and requires exactly one new entry. pnpm asked to add an already-satisfied
 *   dependency writes nothing, the diff is empty, and the host reports
 *   `ambiguous-install` — a failure the store then has to explain for an
 *   install that in fact did nothing wrong.
 *
 * So the prefix is stripped at this boundary. `git:`/`github:` specs are left
 * alone except that `git:` becomes `github:`, which is the shorthand the host's
 * git branch and pnpm's own resolver both understand.
 *
 * @param spec - a member's `spec` as the catalog carries it.
 * @returns the spec to hand to `installBundle`.
 */
export function hostSpec(spec: string): string {
  const trimmed = spec.trim()
  if (/^npm:/iu.test(trimmed)) return trimmed.slice('npm:'.length)
  // `git:owner/repo#sub` is this project's own spelling; pnpm and the host
  // both read `github:` for the same thing, and a bare `owner/repo` would be
  // taken as a registry name.
  if (/^git:/iu.test(trimmed)) return `github:${trimmed.slice('git:'.length)}`
  return trimmed
}

/**
 * Whether the package just installed declares a bundle layer.
 *
 * The spec is not a package NAME: a git member is `git:owner/repo`, while the
 * package on disk is `@owner/repo` (scoped, and lowercased by npm). The profile
 * manifest's dependencies are what pnpm just wrote, so match the spec there
 * and read the resulting dependency's own manifest. A client-only package has
 * no `dsh.bundle` and needs no row.
 */
function declaresBundle(profileDir: string, spec: string): string | undefined {
  let dependencies: Record<string, unknown>
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
    }
    dependencies = manifest.dependencies ?? {}
  } catch {
    return undefined
  }
  // A git spec names `owner/repo`; the dependency names it `github:owner/repo`
  // or `git+https://…/repo.git#<sha>`. The last path segment is the repo.
  // The package NAME, not the install reference: a pinned spec ends in `@1.2.3`
  // and a git spec in `#sub`, and neither survives into the manifest's key — so
  // a pinned bundle-shaped member never matched and its row was never written.
  const wanted = baseName(hostSpec(spec))
  const repo = wanted.split('/').pop() ?? ''
  for (const [name, source] of Object.entries(dependencies)) {
    if (typeof source !== 'string') continue
    const depRepo = source.replace(/^git\+/u, '').split('#')[0]?.split('/').pop()?.replace(/\.git$/u, '') ?? ''
    if (depRepo !== repo && name !== wanted) continue
    try {
      const file = join(profileDir, 'node_modules', name, 'package.json')
      if (!existsSync(file)) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dsh?: { bundle?: unknown } }
      if (pkg.dsh?.bundle !== undefined) return name
    } catch {
      // A package unreadable right after install: no bundle claim.
    }
  }
  return undefined
}

/**
 * A sentence from whatever a host threw.
 *
 * A host does not have to throw an Error: the shipped manager rejects with a
 * plain record on some paths, and `String(record)` is `[object Object]` — which
 * is exactly what the sheet showed for a failed member. The known text fields
 * are tried first, then the record is serialised, so an unfamiliar shape still
 * says something a reader can act on.
 */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    for (const field of ['message', 'reason', 'diagnostic', 'error', 'code']) {
      const value = record[field]
      if (typeof value === 'string' && value !== '') return value
    }
    try {
      const json = JSON.stringify(error)
      if (typeof json === 'string' && json !== '{}') return json.slice(0, 400)
    } catch {
      // A cyclic record: fall through to the generic line.
    }
    return 'the host failed without saying why'
  }
  return String(error)
}
