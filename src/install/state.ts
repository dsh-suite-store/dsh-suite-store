/**
 * Provenance: which bundle put which plugin into this profile (§7.7).
 *
 * The host already knows WHAT is installed; it does not know WHY. That is the
 * only thing this file adds, and it adds it because uninstalling a bundle has
 * to answer one question before it deletes anything: *was this plugin here
 * before I arrived?* Getting that wrong in the destructive direction removes
 * a plugin the user installed deliberately months ago, so every rule below
 * defaults to "do not touch".
 *
 * Entries are keyed by the normalized member identity (§5.5), not by the spec
 * that was passed to the installer: the spec is an instruction (and may carry
 * a version, a `#subdir` or a tag), while the identity is what the profile
 * reports back later. Keying by spec would mean the same plugin installed
 * twice through two bundles left two entries that can never be matched.
 *
 * The file lives in `<profile>/.dsh-suite-store/state.json`; §7.8 keeps this
 * directory disjoint from any other plugin's so the two never have to know
 * about each other.
 */

/**
 * One bundle that put a plugin here.
 *
 * `version` is recorded so a bundle upgrade can tell "this member changed"
 * from "this member was reinstalled at the same version" — the latter is a
 * no-op the executor skips anyway, but the report still needs to be honest
 * about which bundle version last touched the plugin.
 */
export interface BundleSource {
  kind: 'bundle'
  bundleId: string
  version: string
  /** ISO 8601 timestamp of the install that wrote this source. */
  at: string
}

/**
 * The user installed this plugin themselves.
 *
 * Permanent on purpose: a manual install is the user's choice, so once a
 * plugin has ever been installed outside a bundle it stops being something a
 * bundle may uninstall, even if that bundle also lists it (D15/§7.7 point 3).
 * The alternative — dropping the flag when a bundle claims the plugin — would
 * let a bundle quietly launder a manual install into a removable one.
 */
export interface ManualSource {
  kind: 'manual'
  at: string
}

export type ProvenanceSource = BundleSource | ManualSource

/** Provenance of one installed plugin. */
export interface ProvenanceEntry {
  /** The normalized identity this entry is keyed by. */
  id: string
  /** The spec the host was actually asked to install. */
  spec: string
  /**
   * Version that install resolved to, when the host reported one.
   *
   * Distinct from a bundle's pinned version (§5.5): the pin says what the
   * author tested, this says what is on disk. A divergence between them is
   * what the report calls version drift, and it is the only way to notice
   * that an unpinned member moved.
   */
  resolvedVersion: string | null
  /** Where the plugin came from, oldest first. */
  sources: ProvenanceSource[]
}

/** The whole state document, as persisted. */
export interface ProvenanceState {
  format: 1
  entries: Record<string, ProvenanceEntry>
}

/** An empty state, for a profile that has never installed a bundle. */
export function emptyProvenance(): ProvenanceState {
  return { format: 1, entries: {} }
}

/**
 * Read a persisted state document back.
 *
 * Deliberately lenient about CLAIMED provenance and strict about SHAPE:
 * a state file is written by this plugin on this machine, so a node that
 * fails validation means the file was corrupted or hand-edited, and the safe
 * reading of "I cannot tell where this came from" is "not from a bundle".
 * Sources that fail validation are therefore dropped one by one instead of
 * discarding the whole document — losing every provenance record because one
 * of them is malformed would strand every bundle member as unremovable.
 *
 * An entry with no `spec` is dropped whole: `spec` is the only field that can
 * describe the plugin again, and every other field is keyed off the identity.
 *
 * @param raw - parsed JSON, or anything that was on disk.
 * @returns the validated state; never throws.
 */
export function parseProvenance(raw: unknown): ProvenanceState {
  if (!isRecord(raw) || raw.format !== 1) return emptyProvenance()
  const entries: Record<string, ProvenanceEntry> = {}
  for (const [id, value] of Object.entries(asRecordOrEmpty(raw.entries))) {
    if (!isRecord(value)) continue
    const sources = (Array.isArray(value.sources) ? value.sources : [])
      .map(asSource)
      // A dropped source is not an empty list: an entry that loses its last
      // recognizable source becomes an entry with none, which reads as "not
      // removable by a bundle" — the conservative direction.
      .filter((source): source is ProvenanceSource => source !== null)
    if (typeof value.spec !== 'string') continue
    entries[id] = {
      id,
      spec: value.spec,
      resolvedVersion: typeof value.resolvedVersion === 'string' ? value.resolvedVersion : null,
      sources,
    }
  }
  return { format: 1, entries }
}

/**
 * Record that a bundle successfully installed one member.
 *
 * @param state - current state; not mutated.
 * @param input.member - identity and spec the plan used.
 * @param input.resolvedVersion - what the host reported, if it reported one.
 * @param input.bundleId - the bundle being installed.
 * @param input.bundleVersion - the bundle version being installed.
 * @param input.now - ISO timestamp for the source record.
 * @returns a new state with the member's source list updated.
 *
 * Re-installing the same bundle version twice rewrites the existing bundle
 * source instead of appending a second copy: a user who hits "retry" must not
 * end up with three "bundle fin-analyst v1.2.0" rows in the uninstall sheet,
 * and the sheet's "default checked / not checked" decision (§7.7) counts
 * distinct sources.
 */
export function recordBundleInstall(
  state: ProvenanceState,
  input: {
    id: string
    spec: string
    resolvedVersion: string | null
    bundleId: string
    bundleVersion: string
    now: string
  },
): ProvenanceState {
  const previous = state.entries[input.id]
  const kept = (previous?.sources ?? []).filter(
    (source) => !(source.kind === 'bundle' && source.bundleId === input.bundleId),
  )
  const entry: ProvenanceEntry = {
    id: input.id,
    spec: input.spec,
    resolvedVersion: input.resolvedVersion ?? previous?.resolvedVersion ?? null,
    sources: [
      ...kept,
      { kind: 'bundle', bundleId: input.bundleId, version: input.bundleVersion, at: input.now },
    ],
  }
  return { format: 1, entries: { ...state.entries, [input.id]: entry } }
}

/**
 * Record that the user installed a plugin outside any bundle.
 *
 * Called for every plugin the host reports that this plugin has no record of,
 * which is what keeps a pre-existing plugin from looking bundle-owned just
 * because a bundle happens to list the same package.
 *
 * @returns a new state; the input is returned unchanged when the manual
 *   source is already present, so the caller can skip a disk write.
 */
export function recordManualInstall(state: ProvenanceState, input: { id: string; spec: string; now: string }): ProvenanceState {
  const previous = state.entries[input.id]
  if (previous !== undefined && previous.sources.some((source) => source.kind === 'manual')) return state
  const entry: ProvenanceEntry = {
    id: input.id,
    spec: previous?.spec ?? input.spec,
    resolvedVersion: previous?.resolvedVersion ?? null,
    sources: [...(previous?.sources ?? []), { kind: 'manual', at: input.now }],
  }
  return { format: 1, entries: { ...state.entries, [input.id]: entry } }
}

/** Whether the user installed this plugin themselves at any point. */
export function hasManualSource(entry: ProvenanceEntry | undefined): boolean {
  return entry !== undefined && entry.sources.some((source) => source.kind === 'manual')
}

/**
 * Drop one bundle's claim on a member, after that member was uninstalled.
 *
 * @returns a new state; an entry whose last source is removed disappears from
 *   the document rather than lingering as an empty record — an entry with no
 *   sources means nothing, and keeping it would grow the file forever.
 */
export function forgetBundleSource(state: ProvenanceState, input: { id: string; bundleId: string }): ProvenanceState {
  const previous = state.entries[input.id]
  if (previous === undefined) return state
  const sources = previous.sources.filter(
    (source) => !(source.kind === 'bundle' && source.bundleId === input.bundleId),
  )
  const entries = { ...state.entries }
  if (sources.length === 0) delete entries[input.id]
  else entries[input.id] = { ...previous, sources }
  return { format: 1, entries }
}

/**
 * The bundles this profile has actually installed, with when it last did.
 *
 * Read from provenance rather than from "does any member happen to be here":
 * a plugin can be present because the user installed it by hand, or because
 * another suite pulled it in, and neither means this suite was installed. Only
 * a run this store performed writes a bundle source, so this is the record of
 * the user's own action.
 *
 * A partly installed bundle is included — one surviving member is the proof
 * the run happened — and an uninstalled one drops out, because
 * `forgetBundleSource` removes the last source with the last member.
 *
 * @param state - the provenance document.
 * @returns bundle id -> ISO timestamp of the most recent source, oldest first.
 */
export function installedBundles(state: ProvenanceState): Map<string, string> {
  const seen = new Map<string, string>()
  for (const entry of Object.values(state.entries)) {
    for (const source of entry.sources) {
      if (source.kind !== 'bundle') continue
      const current = seen.get(source.bundleId)
      if (current === undefined || source.at > current) seen.set(source.bundleId, source.at)
    }
  }
  return new Map([...seen].sort(([, a], [, b]) => a.localeCompare(b)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asSource(value: unknown): ProvenanceSource | null {
  if (!isRecord(value)) return null
  if (typeof value.at !== 'string') return null
  if (value.kind === 'manual') return { kind: 'manual', at: value.at }
  if (value.kind === 'bundle' && typeof value.bundleId === 'string' && typeof value.version === 'string') {
    return { kind: 'bundle', bundleId: value.bundleId, version: value.version, at: value.at }
  }
  return null
}
