/**
 * Source resolution for the bundle catalog.
 *
 * Two transports carry the same document (§5.2): a plain HTTPS URL served by
 * the CDN, and an npm tarball whose `index.json` is the same bytes. They are
 * modelled as one `CatalogSource` union so the cache, the freshness rule and
 * the "which mirror answered" line in the UI do not fork per transport.
 *
 * Nothing here talks to the network — `catalog/errors.ts` and this module are
 * pure so the fallback ORDER can be asserted without a socket.
 */

import type { CatalogIndex } from './types.ts'

/** Metadata document published by the catalog repository (D6, §5.3 step 1). */
export const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/dsh-suite-store-catalog@latest/index.json'

/**
 * The same document republished as an npm package (§5.2 option A).
 *
 * Kept as a separate source rather than derived from {@link CATALOG_URL}
 * because the two go stale independently: the CDN may serve a cached
 * generation while the registry already has the next one.
 */
export const CATALOG_PACKAGE = 'dsh-suite-store-catalog'

/** npm mirror used when `registry.npmjs.org` is unreachable or slow (D5). */
export const CHINA_NPM_FALLBACK = 'https://registry.npmmirror.com'

/** Default npm registry, used when the host does not name one. */
export const NPM_OFFICIAL = 'https://registry.npmjs.org'

/**
 * Entry path of the catalog document inside the published npm tarball.
 *
 * One constant because the primary and the mirror must slice the same member:
 * two literals three lines apart drifted apart once already.
 */
const CATALOG_ENTRY = 'package/index.json'

/**
 * Where a catalog document can come from.
 *
 * `label` is what the UI shows next to "更新于 …" so a user on a mirror can
 * tell which mirror actually answered — silently serving stale bytes from
 * npmmirror while the UI says "official" would be a lie.
 */
export type CatalogSource =
  | { kind: 'url'; url: string; label: string }
  | { kind: 'npm'; registry: string; pkg: string; file: string; label: string }
  | { kind: 'file'; path: string; label: string }

/**
 * Options that change where the catalog comes from.
 *
 * `file` exists for two real cases, not as a test hook: a self-hosted mirror
 * that serves the document over a share instead of HTTPS, and a developer
 * pointing the store at a local build of the catalog repository before it is
 * published. Without it the only way to see the store work would be to
 * publish to npm first.
 */
export interface CatalogPlanOptions {
  /** npm registry named by the host, if any. */
  registry?: string
  /** Try the npm mirror before the official registry (§5.3 step 2 first). */
  preferFallback?: boolean
  /** Read the document from this path instead of the network. */
  file?: string
}

/**
 * The ordered plan for fetching the catalog once.
 *
 * This is a pure function of configuration so the order is testable and so
 * every caller (startup prefetch, per-read revalidation, SSE reconnect) walks
 * the same plan. The mirror is only tried after the official URL failed; we do not
 * race them, because a race costs double bandwidth on every cold start and
 * can return two different generations of the document.
 *
 * @param options - see {@link CatalogPlanOptions}.
 */
export function catalogPlan(options: CatalogPlanOptions = {}): CatalogSource[] {
  // An unset env var or an empty config field arrives as `''` far more often
  // than as `undefined`, and `??` let it through: the plan then built
  // `/dsh-suite-store-catalog` (a relative URL) and every read failed with
  // "Invalid URL" for a registry nobody configured. Note `file: ''` below has
  // always been treated as absent; the two options now agree.
  const configuredRegistry = options.registry?.trim() ?? ''
  const npmRegistry = configuredRegistry === '' ? NPM_OFFICIAL : configuredRegistry
  if (options.file !== undefined && options.file !== '') {
    // A named file is the whole plan: falling back to the network after it
    // fails would install a different catalog than the one the operator
    // pointed at, which is worse than a clear error.
    return [{ kind: 'file', path: options.file, label: 'file' }]
  }
  const primary: CatalogSource[] = [
    { kind: 'url', url: CATALOG_URL, label: 'cdn' },
    { kind: 'npm', registry: npmRegistry, pkg: CATALOG_PACKAGE, file: CATALOG_ENTRY, label: 'npm' },
  ]
  const fallback: CatalogSource[] = [
    { kind: 'npm', registry: CHINA_NPM_FALLBACK, pkg: CATALOG_PACKAGE, file: CATALOG_ENTRY, label: 'npmmirror' },
  ]

  // The mirror is only worth a slot when it is not already the registry we
  // just tried — otherwise the same request runs twice against one host.
  const mirrorIsPrimary = sameRegistry(npmRegistry, CHINA_NPM_FALLBACK)
  const tail = mirrorIsPrimary ? [] : fallback
  return options.preferFallback === true ? [...tail, ...primary] : [...primary, ...tail]
}

/**
 * Whether two registry values name the same host, whatever the spelling.
 *
 * Comparing the strings only after trimming trailing slashes treated
 * `http://registry.npmmirror.com`, `https://Registry.NPMMirror.com` and a value
 * with a path as three different registries, so the same host was planned twice
 * and the UI showed two labels for one server.
 */
function sameRegistry(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    // An unparseable value is compared as text: the transport will reject it
    // anyway, and this keeps the "same registry" answer deterministic.
    return left.replace(/\/+$/u, '') === right.replace(/\/+$/u, '')
  }
}

/**
 * Whether two plan entries name the same PLACE.
 *
 * `label` is a display name, not an identity: every npm source is labelled
 * `npm`, so using the label as identity replayed one registry's validator
 * against another. This is the comparison that question needs.
 */
export function sameSource(left: CatalogSource, right: CatalogSource): boolean {
  if (left.kind === 'url' && right.kind === 'url') return left.url === right.url
  if (left.kind === 'file' && right.kind === 'file') return left.path === right.path
  if (left.kind === 'npm' && right.kind === 'npm') {
    return left.pkg === right.pkg && sameRegistry(left.registry, right.registry)
  }
  return false
}

/** A catalog document plus the provenance the UI needs to describe it. */
export interface CatalogSnapshot {
  index: CatalogIndex
  /** Which source produced these bytes. */
  source: CatalogSource
  /** When we fetched it (ms since epoch), not when the document was built. */
  fetchedAt: number
  /** Raw bytes length, used to sanity-check "did we really get a document". */
  bytes: number
  /**
   * Validator for the bytes we already have, replayed as `If-None-Match`.
   *
   * Absent when the host did not send one; without it every refresh pays for
   * the whole document.
   */
  etag?: string
}

/**
 * Storage for the last good snapshot, used as a conditional-request validator
 * and as the body a 304 reuses.
 *
 * It is never a fallback answer when the source cannot be reached: a failed
 * read reports an error, so stale bytes are never passed off as current.
 *
 * The interface is deliberately narrow: the catalog service only needs "read
 * what you saved last time" and "save what worked", and keeping disk concerns
 * out of it lets the service tests run against an in-memory store.
 */
export interface SnapshotStore {
  read(): Promise<CatalogSnapshot | undefined>
  write(snapshot: CatalogSnapshot): Promise<void>
}
