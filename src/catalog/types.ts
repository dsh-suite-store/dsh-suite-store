/**
 * Catalog data model: the shapes the data repository builds, the parser that
 * turns raw JSON into those shapes, and the derived scoring/sorting rules.
 *
 * Everything here is pure. The catalog is EXTERNAL input published as an npm
 * package, so `parseCatalogIndex` is the trust boundary: it narrows `unknown`
 * into the model and rejects the whole document rather than half-reading it.
 * A partially-parsed catalog is worse than no catalog — the UI would render
 * cards whose members silently vanished.
 *
 * Wire format lives in docs/specs/2026-11-11-dsh-suite-store-v4.md §5.3; the
 * two-level layout (`index.json` cards + `bundles/<owner>__<id>.json` detail)
 * is why the card type here carries no `description`/`reason` text: the first
 * screen must stay one small request.
 */

/** Bilingual text as the data repository stores it. */
export interface LocalizedText {
  zh: string
  en: string
}

/**
 * One member of a bundle, as the index carries it after build-time
 * resolution (§5.5).
 *
 * `id` is the stable identity and `spec` is what an install would actually
 * use. They are deliberately separate fields: the same plugin reaches the
 * catalog as `github:o/r`, `npm:name` or `npm:name@1.2.3` depending on how its
 * author published it, so only `id` can key provenance (§7.7), while only
 * `spec` can be executed.
 */
export interface BundleMember {
  /** Package-local key, unique inside the bundle; `requires` refers to it. */
  key: string
  /** Normalized identity: `npm:<name>` or `git:<owner>/<repo>#<subdir>`. */
  id: string
  /** Display name of the member (npm package name, or `<owner>/<repo>`). */
  name: string
  /** Version the author pinned, or null when the member floats (D18). */
  version: string | null
  /** True when `version` came from the bundle file rather than resolution. */
  pinned: boolean
  /** What an installer passes to the host runtime. */
  spec: string
  /**
   * The package's own one-line description, read from the registry at catalog
   * build time.
   *
   * SECOND choice, after the bundle author's `reason` on the detail document:
   * a member row answers "why is this plugin in this bundle", which only the
   * author can say. This field fills the rows where the author gave no reason.
   * Absent means "never fetched", never "has no description".
   */
  description?: LocalizedText
  /**
   * Where the plugin's source lives (repository, else homepage), as an https
   * URL. The member's name links here; a member without one is plain text
   * rather than a link that goes nowhere.
   */
  repo?: string
  /** npm registry page for the package, when the member came from npm. */
  npm?: string
  /** GitHub star count at catalog build time; absent when unknown. */
  stars?: number
  /**
   * The dsh versions the package itself says it supports, read from its npm
   * `engines.dsh` at catalog build time.
   *
   * Absent means "not declared or not fetched", never "supports everything":
   * roughly half the packages declare one, so a card that treated silence as
   * compatibility would be guessing. The host refuses an incompatible member
   * during install, and this field is what lets the sheet say so beforehand.
   */
  engines?: { dsh?: string }
}

export interface BundleCategory {
  primary: string
  secondary: string
}

/** Daily-detected rot, refreshed by CI (§6.5). */
export type BundleHealthStatus = 'ok' | 'degraded' | 'broken'

export interface BundleHealth {
  status: BundleHealthStatus
  /** When the check ran (ISO 8601, UTC). */
  checkedAt: string
  /** Member keys/ids that no longer resolve anywhere. */
  missing: string[]
  /** Member ids that are still installable but past their dsh support window. */
  deprecated: string[]
}

/**
 * Derived numbers the UI sorts by (§5.6).
 *
 * `hotness` aggregates MEMBER plugin popularity — it is not this bundle's own
 * install count, which v1 does not track (D26). The UI is required to say so
 * wherever it sorts by this field, which is why the interface comment repeats
 * it rather than only stating it in the spec.
 */
export interface BundleScore {
  /** Mean of member hotness; null when no member had weight data. */
  hotness: number | null
  /** Days since `updatedAt` at build time. */
  freshnessDays: number
  /** Share of members with weight data, 0..1. Below 0.5 → excluded from "hottest". */
  coverage: number
}

/** One catalog card — everything the first screen needs. */
export interface BundleCard {
  id: string
  owner: string
  version: string
  title: LocalizedText
  summary: LocalizedText
  category: BundleCategory
  tags: string[]
  cover: string | null
  /**
   * The card and sheet icon, resolved by the catalog builder.
   *
   * `null` is meaningful and not an omission: it means "draw the bundled
   * default" (what the first-party owner gets). The builder decides this
   * because choosing between a contributor's image, an avatar and the default
   * is a fact about the submission, not something a client can infer.
   */
  icon: string | null
  publishedAt: string
  updatedAt: string
  memberCount: number
  /** Union of member capability tags, lower-cased (`shell`, `network`, ...). */
  capabilitySummary: string[]
  /** True when at least one member needs a build-script approval before install. */
  needsBuildApproval: boolean
  members: BundleMember[]
  health: BundleHealth
  score: BundleScore
  /**
   * Body text for the detail sheet.
   *
   * The submission's `description` when it declared one, otherwise its
   * `summary`. Distinct from `summary` because the card clamps that to three
   * lines while the sheet renders this one whole.
   */
  readme: LocalizedText
  /**
   * Which members contribute each capability tag.
   *
   * The card's `capabilitySummary` is only the union of tags; the sheet's
   * permission rows say "network — from these two members", and that
   * attribution is what this field exists for.
   */
  capabilities: BundleCapability[]
  /** A message shown after installing (§8.3). Absent when the author wrote none. */
  postInstall?: LocalizedText
  /** Combinations the scanner flagged, in its own words (§5.5, §8.3). */
  capabilityRedLines?: CapabilityRedLine[]
  /** Host versions the author tested against (§8.3). */
  testedWith?: string
  /**
   * Retained only so a catalog published BEFORE the single-file change still
   * parses. It points at a per-bundle document this client no longer fetches;
   * nothing reads it, and the builder no longer writes it.
   * @deprecated the catalog is one document now.
   */
  detail?: string
}

export interface CatalogIndex {
  format: 1
  /** Build timestamp of the document (ISO 8601). */
  generatedAt: string
  /**
   * Snapshot of the upstream plugin directory this catalog was built against.
   *
   * `etag` is optional: the builder may stamp it with the content hash of the
   * document so the npm transport can decide "same version, nothing to
   * download" without pulling the tarball (§5.2). When it is absent the npm
   * source simply downloads and relies on HTTP caching instead.
   */
  catalogRef: { updated: string; count: number; etag?: string }
  /**
   * Primary category id → its secondary ids, in display order.
   *
   * The wire form wraps them (`{ secondaries: [...] }`) so a later version can
   * hang a label or icon off the same node without changing the type of this
   * field; the model flattens it because nothing in v1 reads the wrapper.
   */
  categories: Record<string, string[]>
  /**
   * Category id → its name in both languages.
   *
   * Optional: a v1 catalog predates it, and the page falls back to the id
   * turned into words. The data repository publishes it from its own category
   * tree, which is the only place that knows what `academic-research` is
   * called in Chinese — deriving it from the slug can spell it in English
   * only, which is how the store ended up showing English tabs to a Chinese
   * reader.
   */
  categoryLabels?: Record<string, LocalizedText>
  bundles: BundleCard[]
}

/** Raised when a catalog document does not match the wire format. */
export class CatalogFormatError extends Error {
  /**
   * @param message - what was wrong, naming the offending path.
   * @param path - dotted/indexed location inside the document (`bundles[3].id`).
   */
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path})`)
    this.name = 'CatalogFormatError'
  }
}

/**
 * How many members one bundle may declare (§5.4).
 *
 * The floor is a product rule: below it a "suite" is three plugins the reader
 * could have found themselves, which makes the bundle a worse market.
 *
 * The ceiling is an operational limit, not a taste one. Members install
 * serially at 30–60 s each on a desktop host, only one operation may run at a
 * time (§7.1), and a failure does not roll back the members that succeeded
 * (D5) — so every extra member is more minutes locked into one screen and a
 * larger chance of leaving a half-installed profile behind.
 *
 * It is a DEFAULT, not a law: `parseCatalogIndex` takes the ceiling as an
 * option so a host or a future catalog can raise it once a real suite needs
 * one, without every caller having to know the number.
 */
export const MIN_BUNDLE_MEMBERS = 2
export const MAX_BUNDLE_MEMBERS = 10

/**
 * Accept either a plain string or a `{ zh, en }` object as localized text.
 *
 * The data repository is allowed to write `title: foo` when both languages
 * happen to be identical (short ASCII names), and the builder keeps it that
 * way instead of inventing a translation. Reading tolerates both, writing is
 * always the object form.
 */
/**
 * A bilingual string, with the catalog's own language rule.
 *
 * `en` is required and `zh` may be ABSENT — that is what the submission schema
 * says, and the builder fills a missing `zh` from `en` before publishing. This
 * parser applies the same fallback rather than rejecting the shape: the two ends
 * have to agree on what a valid document is, and requiring `zh` here made the
 * client stricter than the contract it reads.
 *
 * An explicit `zh: ''` is kept as an empty string, not filled: it is a
 * different statement from "the key is absent" (the submission validator
 * rejects it as a mistake), and `text()` already falls back at render time, so
 * nothing prints a blank line either way.
 *
 * @param value - the wire value.
 * @param path - JSON path for error messages.
 * @returns both languages, `zh` defaulting to `en` only when absent.
 * @throws {CatalogFormatError} when `en` is absent or not a string.
 */
function asLocalized(value: unknown, path: string): LocalizedText {
  if (typeof value === 'string') return { zh: value, en: value }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const en = record.en
    if (typeof en === 'string' && en !== '') {
      return { zh: typeof record.zh === 'string' ? record.zh : en, en }
    }
  }
  throw new CatalogFormatError('expected localized text { en } (zh optional)', path)
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') throw new CatalogFormatError('expected a non-empty string', path)
  return value
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new CatalogFormatError('expected an array', path)
  return value
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new CatalogFormatError('expected an array of strings', path)
  return value.map((item, index) => asString(item, `${path}[${index}]`))
}

function asNullableString(value: unknown, path: string): string | null {
  // `''` is "no value", not a format error: the model documents an empty string
  // as "no secondary" / "the member floats", and `asString` rejects it — so a
  // perfectly valid wire document with `secondary: ""` used to reject the WHOLE
  // catalog.
  if (value === null || value === undefined || value === '') return null
  return asString(value, path)
}

/**
 * A boolean that may be absent.
 *
 * `record.x === true` turned `"true"`, `1` and a typo'd field into `false`,
 * which is the UNSAFE direction for both fields that use this: `pinned` drives
 * "the version the author tested", and `needsBuildApproval` drives the consent
 * prompt. Absence still means `false`, so older documents keep parsing.
 */
function asOptionalBoolean(value: unknown, path: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new CatalogFormatError('expected a boolean', path)
  return value
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatalogFormatError('expected an object', path)
  }
  return value as Record<string, unknown>
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null
  return asFiniteNumber(value, path)
}

/** A JSON number that exists on the number line. `1e999` parses as Infinity. */
function asFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new CatalogFormatError('expected a finite number', path)
  }
  return value
}

function asMember(value: unknown, path: string): BundleMember {
  const record = asRecord(value, path)
  const member: BundleMember = {
    key: asString(record.key, `${path}.key`),
    id: asString(record.id, `${path}.id`),
    name: asString(record.name, `${path}.name`),
    version: asNullableString(record.version, `${path}.version`),
    pinned: asOptionalBoolean(record.pinned, `${path}.pinned`),
    spec: asString(record.spec, `${path}.spec`),
  }
  // Optional enrichment, read from the registry at catalog build time. Each
  // one is validated rather than trusted: a malformed `repo` must not become
  // an `href` the host's window will follow.
  if (record.description !== undefined) {
    member.description = asLocalized(record.description, `${path}.description`)
  }
  const repo = asRepositoryLink(record.repo, `${path}.repo`)
  if (repo !== undefined) member.repo = repo
  const npm = asOptionalHttps(record.npm, `${path}.npm`)
  if (npm !== undefined) member.npm = npm
  if (record.stars !== undefined) member.stars = asFiniteNumber(record.stars, `${path}.stars`)
  if (record.engines !== undefined) {
    const engines = asRecord(record.engines, `${path}.engines`)
    const dsh = engines['dsh']
    if (typeof dsh === 'string' && dsh !== '') member.engines = { dsh }
  }
  return member
}

/** An optional https URL; anything else is dropped, not thrown, so an old
 * catalog without the field and a bad value behave the same way. */
function asOptionalHttps(value: unknown, _path: string): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^https:\/\//u.test(value) ? value : undefined
}

/**
 * A member's repository link.
 *
 * Two spellings exist in the wire: the full `https://github.com/owner/name`
 * URL, and the bare `owner/name` pair an earlier builder wrote. The bare pair
 * is not a URL, so the strict check dropped it and the member's name stopped
 * being clickable — the link was there in the markup but had no href. Accepting
 * both costs one branch and makes an already-published catalog work.
 */
function asRepositoryLink(value: unknown, path: string): string | undefined {
  const https = asOptionalHttps(value, path)
  if (https !== undefined) return https
  if (typeof value !== 'string') return undefined
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u.test(value)
    ? `https://github.com/${value}`
    : undefined
}

function asHealthStatus(value: unknown, path: string): BundleHealthStatus {
  if (value === 'ok' || value === 'degraded' || value === 'broken') return value
  throw new CatalogFormatError('expected one of ok|degraded|broken', path)
}

function asCard(value: unknown, path: string): BundleCard {
  const record = asRecord(value, path)
  const category = asRecord(record.category, `${path}.category`)
  const health = asRecord(record.health, `${path}.health`)
  const score = asRecord(record.score, `${path}.score`)
  if (!Array.isArray(record.members)) throw new CatalogFormatError('expected an array of members', `${path}.members`)
  const cardMembers = record.members.map((member, index) => asMember(member, `${path}.members[${index}]`))
  const cardCapabilities = asCapabilities(record.capabilities, `${path}.capabilities`, cardMembers)
  return {
    id: asString(record.id, `${path}.id`),
    owner: asString(record.owner, `${path}.owner`),
    version: asString(record.version, `${path}.version`),
    title: asLocalized(record.title, `${path}.title`),
    summary: asLocalized(record.summary, `${path}.summary`),
    category: {
      primary: asString(category.primary, `${path}.category.primary`),
      // `secondary` is optional in the v4 card schema: a bundle whose primary
      // tab has no subcategory omits it. An empty string means "no secondary",
      // which is what the filter compares against — not a format error.
      secondary: asNullableString(category.secondary, `${path}.category.secondary`) ?? '',
    },
    tags: asStringArray(record.tags ?? [], `${path}.tags`),
    cover: asOptionalHttps(record.cover, `${path}.cover`) ?? null,
    // `null` when absent AND when the value is not https: the catalog is remote
    // data, so something like `javascript:` or a `data:` URI must degrade to
    // "no image" rather than reach an `<img src>`. Same rule as `cover`, and the
    // same reason.
    icon: asOptionalHttps(record.icon, `${path}.icon`) ?? null,
    publishedAt: asString(record.publishedAt, `${path}.publishedAt`),
    updatedAt: asString(record.updatedAt, `${path}.updatedAt`),
    memberCount: asFiniteNumber(record.memberCount, `${path}.memberCount`),
    capabilitySummary: asStringArray(record.capabilitySummary ?? [], `${path}.capabilitySummary`),
    needsBuildApproval: asOptionalBoolean(record.needsBuildApproval, `${path}.needsBuildApproval`),
    members: cardMembers,
    // Optional in the wire so a catalog published before the single-file change
    // still parses: such a document carried these on a per-bundle detail
    // document instead, and this client no longer fetches one. Falling back to
    // `summary` keeps the sheet's body text non-empty for those.
    readme: record.readme === undefined
      ? asLocalized(record.summary, `${path}.summary`)
      : asLocalized(record.readme, `${path}.readme`),
    capabilities: cardCapabilities,
    ...(record.postInstall === undefined ? {} : { postInstall: asLocalized(record.postInstall, `${path}.postInstall`) }),
    ...(record.capabilityRedLines === undefined
      ? {}
      : { capabilityRedLines: asCapabilityRedLines(record.capabilityRedLines, `${path}.capabilityRedLines`, cardMembers) }),
    ...(record.testedWith === undefined || typeof record.testedWith !== 'string' || record.testedWith.trim() === ''
      ? {}
      : { testedWith: record.testedWith.trim() }),
    // Kept only so an older catalog parses; nothing reads it.
    ...(record.detail === undefined ? {} : { detail: asString(record.detail, `${path}.detail`) }),
    health: {
      status: asHealthStatus(health.status, `${path}.health.status`),
      checkedAt: asString(health.checkedAt, `${path}.health.checkedAt`),
      missing: asStringArray(health.missing ?? [], `${path}.health.missing`),
      deprecated: asStringArray(health.deprecated ?? [], `${path}.health.deprecated`),
    },
    score: {
      hotness: asNonNegativeNullable(score.hotness, `${path}.score.hotness`),
      freshnessDays: asNonNegative(score.freshnessDays, `${path}.score.freshnessDays`),
      coverage: asCoverage(score.coverage, `${path}.score.coverage`),
    },
  }
}

/** A nullable weight the ranking formulas multiply by; negative is nonsense. */
function asNonNegativeNullable(value: unknown, path: string): number | null {
  const parsed = asNullableNumber(value, path)
  if (parsed !== null && parsed < 0) throw new CatalogFormatError('expected a non-negative number', path)
  return parsed
}

function asNonNegative(value: unknown, path: string): number {
  const parsed = asFiniteNumber(value, path)
  if (parsed < 0) throw new CatalogFormatError('expected a non-negative number', path)
  return parsed
}

/** `coverage` is a fraction: it feeds both ranking formulas directly (§5.6). */
function asCoverage(value: unknown, path: string): number {
  const parsed = asFiniteNumber(value, path)
  if (parsed < 0 || parsed > 1) throw new CatalogFormatError('expected a number between 0 and 1', path)
  return parsed
}

/**
 * One risky capability and who declared it (§5.3 detail level).
 *
 * The member names are carried so the confirmation sheet can say
 * "@yolk_vat-y/dsh-project-memory 会执行 shell 命令" instead of a bare badge:
 * a warning a user cannot trace to a plugin is a warning they learn to ignore.
 */
export interface BundleCapability {
  tag: string
  /** Member display names that declare this capability. */
  sources: string[]
}

/**
 * One flagged combination, with the members behind it (§8.3).
 *
 * The upstream directory writes red lines as plain strings — the scanner's own
 * words — and those still parse unchanged. A bundle author who can say WHICH
 * member produced the line uses this object form instead, so the detail sheet
 * names it the same way the capability rows do instead of leaving the reader
 * to guess. A line without a name is still a line; a named one is traceable.
 */
export interface CapabilityRedLine {
  /** The scanner's own words, in both languages. */
  text: LocalizedText
  /** Member display names that produced this combination. */
  members: string[]
}

/** A bundle-level instruction the user must act on after install. */
export type BundlePostInstall = LocalizedText

/**
 * The detail document at `bundles/<owner>__<id>.json` (§5.3).
 *
 * Split from the card because the first screen must stay one small request:
 * a catalog of ten thousand bundles with readmes inline would be tens of
 * megabytes, and the list renders none of that text.
 */
export interface BundleDetail {
  format: 1
  id: string
  owner: string
  version: string
  readme: LocalizedText
  capabilities: BundleCapability[]
  /**
   * Combinations the scanner flagged, in its own words (§5.5, §8.3).
   *
   * Distinct from `capabilities` on purpose: that list says what a member
   * TOUCHES, which is disclosure; this says which combinations a reader should
   * look at, which is advice. §8.3 renders it in red and apart, so the two
   * cannot be merged into one list without losing the distinction the field
   * exists for.
   *
   * Absent when the upstream directory never scanned the members — the same
   * rule as the upstream schema, where `capabilities: []` means "scanned,
   * nothing found" and `undefined` means "we could not look".
   *
   * The wire format accepts plain upstream strings (the scanner's own words)
   * and the structured form with a bilingual sentence plus the members behind
   * it; the parser normalises both to `CapabilityRedLine[]` so the sheet can
   * always name the source (§8.3).
   */
  capabilityRedLines?: CapabilityRedLine[]
  /**
   * The host versions the author tested the bundle against (§8.3).
   *
   * A free-form label rather than a semver range: the upstream directory
   * records what the author typed, and this store does not gate installs on
   * it — showing it is the whole contract.
   */
  testedWith?: string
  /** Rendered after a successful install; absent when the author gave none. */
  postInstall?: BundlePostInstall
  /**
   * Install order, verbatim from the file.
   *
   * The builder has already topologically sorted by `requires`, so this order
   * is the contract the installer follows; re-sorting it here would break
   * intra-bundle dependencies.
   */
  members: BundleMemberDetail[]
}

/** A member in the detail document: the card fields plus the author's reason. */
export interface BundleMemberDetail extends BundleMember {
  /**
   * Why this plugin belongs in the bundle; the PRIMARY sentence of a member
   * row, and labelled "推荐理由 / why it is here" so a reader can tell it from
   * the package's own description.
   *
   * It wins over `description` because it answers the question the row exists
   * for — what this plugin is doing in THIS bundle — which the registry cannot
   * know. Optional: a submission may omit it, and the row then shows the
   * member's own registry description instead. Requiring it here would make
   * every catalog built from submission files without reasons fail to parse.
   */
  reason?: LocalizedText
}

/**
 * Parse a `bundles/<owner>__<id>.json` document.
 *
 * @param raw - parsed JSON of the detail document (not a string).
 * @param options.expect - the bundle id the caller asked for. When given, a
 *   mismatch is an error: the card and the detail are fetched as two separate
 *   requests and can be served from different generations of the catalog, and
 *   showing one bundle's members under another bundle's title is worse than an
 *   error message.
 * @returns the validated detail document.
 * @throws {CatalogFormatError} on any structural mismatch.
 */
export function parseBundleDetail(raw: unknown, options: { expect?: string } = {}): BundleDetail {
  const record = asRecord(raw, '$')
  if (record.format !== 1) throw new CatalogFormatError('unsupported bundle detail format, expected 1', '$.format')
  const id = asString(record.id, '$.id')
  if (options.expect !== undefined && options.expect !== id) {
    throw new CatalogFormatError(`bundle id ${id} does not match requested ${options.expect}`, '$.id')
  }
  // Members first: the capability attribution check needs them, and a source
  // that names no member of THIS document is exactly the untraceable warning
  // that check refuses.
  const members = asArray(record.members ?? [], '$.members').map((member, index) => {
    const path = `$.members[${index}]`
    const entry = asRecord(member, path)
    const detail: BundleMemberDetail = asMember(entry, path)
    if (entry.reason !== undefined) detail.reason = asLocalized(entry.reason, `${path}.reason`)
    return detail
  })

  const parsed: BundleDetail = {
    format: 1,
    id,
    owner: asString(record.owner, '$.owner'),
    version: asString(record.version, '$.version'),
    readme: asLocalized(record.readme, '$.readme'),
    capabilities: asCapabilities(record.capabilities ?? [], '$.capabilities', members),
    members,
  }
  if (record.postInstall !== undefined) {
    parsed.postInstall = asLocalized(record.postInstall, '$.postInstall')
  }
  const red = asCapabilityRedLines(record.capabilityRedLines, '$.capabilityRedLines', parsed.members)
  if (red.length > 0) parsed.capabilityRedLines = red
  if (typeof record.testedWith === 'string' && record.testedWith.trim() !== '') {
    parsed.testedWith = record.testedWith.trim()
  }
  return parsed
}

/**
 * The capability rows of a document.
 *
 * A capability with no `sources` is refused rather than rendered: the sheet
 * names the members behind every permission row, and an unattributed row is
 * exactly the warning a reader cannot trace (G15 at the trust boundary).
 *
 * When `members` is non-empty, every source must name one of them — a source the
 * sheet cannot resolve would promise a plugin it does not list. Both spellings
 * writers have used are accepted: the real catalog names members by `key`
 * (`owner/name`), while the fixture and older documents use the npm `name`.
 *
 * @param raw - the wire value; anything but an array is treated as empty.
 * @param path - JSON path for error messages.
 * @param members - the document's members, for the attribution check.
 * @returns the validated rows.
 * @throws {CatalogFormatError} on a shapeless row or an unresolvable source.
 */
function asCapabilities(raw: unknown, path: string, members: readonly BundleMember[]): BundleCapability[] {
  const rows = (Array.isArray(raw) ? raw : []).map((entry, index) => {
    const row = asRecord(entry, `${path}[${index}]`)
    const sources = asStringArray(row.sources, `${path}[${index}].sources`)
    if (sources.length === 0) {
      throw new CatalogFormatError('capability sources must name at least one member', `${path}[${index}].sources`)
    }
    return { tag: asString(row.tag, `${path}[${index}].tag`), sources }
  })
  if (rows.length === 0 || members.length === 0) return rows
  const identities = new Set(members.flatMap((member) => [member.key, member.name, member.id]))
  for (const [index, row] of rows.entries()) {
    const unknown = row.sources.filter((source) => !identities.has(source))
    if (unknown.length > 0) {
      throw new CatalogFormatError(
        `capability ${row.tag} names members absent from the document: ${unknown.join(', ')}`,
        `${path}[${index}].sources`,
      )
    }
  }
  return rows
}

/**
 * The red-line rows of a document.
 *
 * Empty rows are dropped rather than kept: §8.3 renders every line it is given,
 * so a `{ zh: '', en: '' }` entry would draw an empty red row.
 *
 * @param raw - the wire value; undefined means "not scanned".
 * @param path - JSON path for error messages.
 * @param members - the document's members, for the attribution check.
 * @returns the rows, possibly empty.
 * @throws {CatalogFormatError} on a shapeless row or an unresolvable member.
 */
function asCapabilityRedLines(
  raw: unknown,
  path: string,
  members: readonly BundleMember[],
): CapabilityRedLine[] {
  if (raw === undefined) return []
  const list = asArray(raw, path)
  const red: CapabilityRedLine[] = []
  for (const [index, item] of list.entries()) {
    const at = `${path}[${index}]`
    if (typeof item === 'string') {
      // Upstream plain string: one language, no named member. Keeping it a valid
      // line (rather than dropping it) is what makes a mixed catalog safe.
      if (item.trim() !== '') red.push({ text: { zh: item, en: item }, members: [] })
      continue
    }
    const entry = asRecord(item, at)
    const line = entry['text']
    if (typeof line !== 'string' && (typeof line !== 'object' || line === null)) {
      throw new CatalogFormatError('expected red-line text', `${at}.text`)
    }
    const text = asLocalized(line, `${at}.text`)
    if (text.zh.trim() === '' && text.en.trim() === '') continue
    red.push({
      text,
      members: entry['members'] === undefined ? [] : asStringArray(entry['members'], `${at}.members`),
    })
  }
  if (red.length === 0 || members.length === 0) return red
  const identities = new Set(members.flatMap((member) => [member.key, member.name, member.id]))
  for (const [index, line] of red.entries()) {
    const unknown = line.members.filter((member) => !identities.has(member))
    if (unknown.length > 0) {
      throw new CatalogFormatError(
        `red line names members absent from the document: ${unknown.join(', ')}`,
        `${path}[${index}].members`,
      )
    }
  }
  return red
}

/**
 * The sheet's view of a bundle, derived from its card.
 *
 * The catalog is ONE document, so the detail is no longer a second request: the
 * sheet shows what the card already carries. The shape is unchanged, which is
 * what lets the client keep calling `/api/detail` and rendering one object.
 *
 * @param card - a parsed card.
 * @returns the detail document.
 */
export function detailFromCard(card: BundleCard): BundleDetail {
  return {
    format: 1,
    id: card.id,
    owner: card.owner,
    version: card.version,
    readme: card.readme,
    capabilities: card.capabilities,
    members: card.members,
    ...(card.postInstall === undefined ? {} : { postInstall: card.postInstall }),
    ...(card.capabilityRedLines === undefined ? {} : { capabilityRedLines: card.capabilityRedLines }),
    ...(card.testedWith === undefined ? {} : { testedWith: card.testedWith }),
  }
}

/**
 * Parse an `index.json` document.
 *
 * Failures are structured (`CatalogFormatError` with a path) so the routes can
 * report WHICH bundle broke instead of a bare "invalid JSON", which is the
 * only actionable thing a maintainer can put in an issue.
 *
 * @param raw - parsed JSON of the catalog index (not a string).
 * @param options.maxMembers - the ceiling a bundle's member list may reach.
 *   Defaults to {@link MAX_BUNDLE_MEMBERS}; the floor is fixed because "a suite
 *   too small to be a suite" is never a valid document.
 * @returns the validated index.
 * @throws {CatalogFormatError} on any structural mismatch, including a bundle
 *   outside the member-count window.
 */
export function parseCatalogIndex(
  raw: unknown,
  options: { maxMembers?: number } = {},
): CatalogIndex {
  const maxMembers = options.maxMembers ?? MAX_BUNDLE_MEMBERS
  const record = asRecord(raw, '$')
  // A future format is refused rather than interpreted: `format` exists so a
  // v2 catalog with different card fields cannot be read by a v1 client as a
  // catalog whose cards lost their data.
  if (record.format !== 1) throw new CatalogFormatError('unsupported catalog format, expected 1', '$.format')
  const catalogRef = asRecord(record.catalogRef, '$.catalogRef')
  // `Object.create(null)` because the keys come from the wire: a document
  // naming a category `__proto__` would otherwise trigger the prototype
  // setter on a plain object and the category would silently vanish.
  const categories: Record<string, string[]> = Object.create(null)
  for (const [primary, node] of Object.entries(asRecord(record.categories, '$.categories'))) {
    // Accept both the wrapped wire form and a bare array: the data repository
    // may publish the flat form for a category with nothing to annotate yet,
    // and refusing that would reject a document a maintainer hand-edited.
    const secondaries = Array.isArray(node) ? node : asRecord(node, `$.categories.${primary}`).secondaries
    categories[primary] = asStringArray(secondaries, `$.categories.${primary}.secondaries`)
  }
  let categoryLabels: Record<string, LocalizedText> | undefined
  if (record.categoryLabels !== undefined) {
    const raw = asRecord(record.categoryLabels, '$.categoryLabels')
    const labels: Record<string, LocalizedText> = Object.create(null)
    for (const [id, node] of Object.entries(raw)) {
      labels[id] = asLocalized(node, `$.categoryLabels.${id}`)
    }
    categoryLabels = labels
  }
  if (!Array.isArray(record.bundles)) throw new CatalogFormatError('expected an array of bundles', '$.bundles')
  const seenIds = new Set<string>()
  const bundles = record.bundles.map((card, index) => {
    const path = `$.bundles[${index}]`
    const parsed = asCard(card, path)
    // Duplicate bundle ids make every per-id route (`?id=`) and provenance
    // claim ambiguous; the whole-file rejection policy covers this too.
    if (seenIds.has(parsed.id)) {
      throw new CatalogFormatError(`bundle id ${parsed.id} appears more than once`, `${path}.id`)
    }
    seenIds.add(parsed.id)
    // Member keys are per-bundle identities: `plan.steps.find(key)`,
    // `patchMember` and the per-row install all match on the first hit, so a
    // repeated key would make the second member unreachable.
    const keys = new Set<string>()
    for (const member of parsed.members) {
      if (keys.has(member.key)) {
        throw new CatalogFormatError(`member key ${member.key} appears twice in ${parsed.id}`, `${path}.members`)
      }
      keys.add(member.key)
    }
    // The member window is checked on the LIST, not on `memberCount`: the two
    // are separate fields and a document that disagrees with itself must be
    // rejected rather than read as one of them being right.
    if (parsed.members.length < MIN_BUNDLE_MEMBERS || parsed.members.length > maxMembers) {
      throw new CatalogFormatError(
        `expected ${String(MIN_BUNDLE_MEMBERS)}–${String(maxMembers)} members, got ${String(parsed.members.length)}`,
        `${path}.members`,
      )
    }
    // The comment above promises a self-consistent document; enforce it.
    // Otherwise `memberCount: 8` over a two-row list draws "8 members",
    // "2/8 installed" and an 8-wide progress bar above two rows at once.
    if (parsed.memberCount !== parsed.members.length) {
      throw new CatalogFormatError(
        `memberCount ${String(parsed.memberCount)} disagrees with ${String(parsed.members.length)} members`,
        `${path}.memberCount`,
      )
    }
    return parsed
  })
  return {
    format: 1,
    generatedAt: asString(record.generatedAt, '$.generatedAt'),
    catalogRef: {
      updated: asString(catalogRef.updated, '$.catalogRef.updated'),
      count: asFiniteNumber(catalogRef.count, '$.catalogRef.count'),
      // Optional by design: a builder that does not stamp a content hash must
      // not produce a document the client rejects.
      ...(typeof catalogRef.etag === 'string' && catalogRef.etag !== ''
        ? { etag: catalogRef.etag }
        : {}),
    },
    categories,
    ...(categoryLabels === undefined ? {} : { categoryLabels }),
    bundles,
  }
}

/** Which language a reader sees, decided by the host locale (§8.5). */
export type CatalogLocale = 'zh' | 'en'

/**
 * Pick one language, falling back to the other.
 *
 * §8.5: a missing translation falls back silently instead of rendering a
 * placeholder — a bundle whose `en` text is empty is still a bundle a reader
 * should be able to buy. Empty strings count as missing, because a builder
 * that emitted `""` meant "not translated" rather than "deliberately blank".
 */
export function localized(text: LocalizedText, locale: CatalogLocale): string {
  const preferred = text[locale]
  if (preferred !== '') return preferred
  return locale === 'zh' ? text.en : text.zh
}

export type SortMode = 'recommended' | 'updated' | 'members' | 'hottest'

export interface FilterOptions {
  /** Case-insensitive substring; matches title, summary, tags and member names. */
  query?: string
  /** Secondary category id; `primary` alone is not enough (§5.4). */
  primary?: string
  secondary?: string
  sort?: SortMode
  /** Exclude undecodable bundles from the default list (§6.5). */
  hideBroken?: boolean
  /**
   * Only bundles updated within this many days (§8.4).
   *
   * A number rather than a union of tiers, because the page draws the tiers
   * and the server should not have to learn a new one when the page does. Zero
   * and absent both mean "any time"; the page never sends `0` because that
   * would serialize as a filter that excludes everything.
   */
  updatedWithinDays?: number
  /**
   * Only bundles this profile has touched — fully or partly installed.
   *
   * Needs `installed` to answer; without it the flag is ignored rather than
   * emptying the list, because "we were not told" must not read as "nothing is
   * installed".
   */
  installedOnly?: boolean
}

/**
 * Default-order rank (§5.6): hotness decayed by age and damped by coverage.
 *
 * Written out as one expression rather than a chain of comparators so the
 * README's formula and the code cannot drift. A bundle with no weight data
 * (`hotness === null`) scores 0 here but is NOT filtered — "we have no
 * popularity signal" must not look like "unpopular".
 */
export function recommendationScore(card: BundleCard): number {
  const hotness = card.score.hotness ?? 0
  return hotness * Math.exp(-card.score.freshnessDays / 90) * card.score.coverage
}

/**
 * Whether a card answers a free-text query.
 *
 * Member names are searched deliberately (§8.4): users know the plugin they
 * want far more often than the bundle that happens to contain it, and a
 * bundle store that cannot be found by its members is a wall, not a store.
 */
function matchesQuery(card: BundleCard, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  // `card.id` first, then the owner (whose suite is this is a real query and
  // the card already prints it), then everything a reader might have in mind.
  const haystacks = [
    card.id,
    card.owner,
    card.title.zh,
    card.title.en,
    card.summary.zh,
    card.summary.en,
    ...card.tags,
    ...card.members.map((member) => member.name),
    ...card.members.map((member) => member.id),
  ]
  return haystacks.some((value) => value.toLowerCase().includes(needle))
}

/**
 * Apply filtering and ordering without mutating the input.
 *
 * Sorting is total: every mode ends in an `id` comparison so two cards that
 * tie on the primary key (very common — `updatedAt` is a date, not a
 * timestamp) do not swap places between renders and make the masonry jump.
 */
export function selectBundles(
  bundles: readonly BundleCard[],
  options: FilterOptions = {},
  /**
   * The member keys this profile holds, for `installedOnly`.
   *
   * A separate argument rather than a filter field because it is not a
   * user-chosen narrowing — it is a fact about this machine that the caller
   * happens to have.
   */
  installed: ReadonlySet<string> = new Set<string>(),
): BundleCard[] {
  const query = (options.query ?? '').trim()
  const filtered = bundles.filter((card) => {
    // A search is always an explicit request, so it outranks every preference:
    // answering "gamma" with nothing would read as "that suite does not exist"
    // when what happened is that we quietly hid it (§6.5).
    if (query === '') {
      if (options.hideBroken === true && card.health.status === 'broken') return false
    }
    // "Touched" means at least one member is here: a partly installed bundle
    // belongs in this view, which is where a reader looks to finish one.
    if (options.installedOnly === true && installed.size > 0
      && !card.members.some((member) => installed.has(member.key))) return false
    if (options.primary !== undefined && card.category.primary !== options.primary) return false
    if (options.secondary !== undefined && card.category.secondary !== options.secondary) return false
    // §8.4's "updated within N days". Measured with `score.freshnessDays`,
    // which the builder stamped against its own clock: the answer is therefore
    // "N days as of the last catalog build", not against this request's clock.
    // That is the honest reading for a document that is itself a snapshot, and
    // it keeps this function pure — no clock to inject, and the same query and
    // catalog always give the same list.
    if (options.updatedWithinDays !== undefined && options.updatedWithinDays > 0
      && card.score.freshnessDays > options.updatedWithinDays) return false
    return matchesQuery(card, query)
  })
  const byId = (a: BundleCard, b: BundleCard): number => a.id.localeCompare(b.id)
  /**
   * A date as a number, for ordering.
   *
   * `localeCompare` on the raw string was wrong for any catalog whose dates
   * are not zero-padded: `2026-11-9` sorts AFTER `2026-11-10` lexically,
   * because '9' > '1'. The catalog is hand-written JSON and nothing in the
   * parse step requires padding, so the comparison must be on time, not text.
   * An unparseable date sorts last rather than throwing.
   */
  const at = (card: BundleCard): number => {
    const parsed = Date.parse(card.updatedAt)
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
  }
  const sort = options.sort ?? 'recommended'
  return filtered.sort((a, b) => {
    switch (sort) {
      case 'updated':
        return at(b) === at(a) ? byId(a, b) : at(b) - at(a)
      case 'members':
        return b.memberCount - a.memberCount || byId(a, b)
      case 'hottest':
        // §5.6: `coverage < 0.5` does not take part in "hottest". A bundle
        // whose hotness comes from one measured member out of six is not
        // hotter than one measured across all of them — it is less known.
        // Ranking them together let a single popular dependency lift an
        // otherwise unmeasured suite to the top.
        if (hottestRank(a) !== hottestRank(b)) return hottestRank(b) - hottestRank(a)
        return byId(a, b)
      case 'recommended':
      default:
        return recommendationScore(b) - recommendationScore(a) || byId(a, b)
    }
  })
}

/** The weight `hottest` sorts by, with §5.6's coverage floor applied. */
function hottestRank(card: BundleCard): number {
  if (card.score.coverage < 0.5) return 0
  return card.score.hotness ?? 0
}

/** Capability tags the card surfaces as a warning badge (§8.2). */
const WARNING_CAPABILITIES = ['shell', 'fs-write', 'network'] as const

export type WarningCapability = (typeof WARNING_CAPABILITIES)[number]

/**
 * Which risky capabilities a bundle's members collectively declare.
 *
 * Displays a warning, never a verdict: the flags come from a static scan of
 * member artifacts upstream, and a bundle that legitimately needs network
 * access should not look suspicious — it should look *declared*.
 */
export function warningCapabilities(card: BundleCard): WarningCapability[] {
  return WARNING_CAPABILITIES.filter((capability) => card.capabilitySummary.includes(capability))
}
