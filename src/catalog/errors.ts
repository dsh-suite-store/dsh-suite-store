/**
 * Failure taxonomy for catalog fetching.
 *
 * Every failure the catalog service can hit is one of these, because the
 * service's whole job on error is to decide *whether to try the next source*.
 * Flattening a timeout, a 404 and a corrupt document into one `Error` would
 * make "retry the mirror" and "give up and show the cached copy" the same
 * decision.
 */

/** Why a single fetch attempt failed. */
export type FetchFailureKind =
  /** The host answered `404`/`410` — the document is gone, retrying is useless. */
  | 'not-found'
  /** The host answered `5xx` — transient, the next source is worth trying. */
  | 'server-error'
  /** No answer before the budget expired. */
  | 'timeout'
  /** DNS/socket/TLS failure; the request never produced a response. */
  | 'unreachable'
  /** A response arrived but was not a usable document (bad JSON, wrong shape). */
  | 'invalid'

/**
 * One failed attempt.
 *
 * `source` is the label from `CatalogSource`, so the UI can say WHICH place
 * failed instead of "网络错误".
 */
export class CatalogFetchError extends Error {
  readonly kind: FetchFailureKind
  readonly source: string
  readonly status: number | undefined
  readonly cause: unknown

  constructor(
    kind: FetchFailureKind,
    source: string,
    detail: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(`${source}: ${detail}`)
    this.name = 'CatalogFetchError'
    this.kind = kind
    this.source = source
    this.status = options.status
    this.cause = options.cause
  }

  /**
   * Whether walking to the next source can plausibly help.
   *
   * A `404` from the CDN does NOT stop the plan — the npm package is a
   * different host — so this only reports what the ONE attempt tells us about
   * itself. The service decides about the rest.
   */
  get transient(): boolean {
    // `truncated` used to be listed here, but nothing ever produced it: a body
    // cut short surfaces as a socket reset, i.e. `unreachable` (verified against
    // a loopback that dropped the connection mid-body). A kind with no
    // construction site is a dead branch that reads as a guarantee.
    return this.kind === 'timeout' || this.kind === 'unreachable' || this.kind === 'server-error'
  }
}

/** Map an HTTP status to a failure kind. */
export function kindFromStatus(status: number): FetchFailureKind {
  if (status === 404 || status === 410) return 'not-found'
  // 408 is the host saying IT gave up waiting — the next host may not.
  if (status === 408) return 'timeout'
  // 429 is "come back later", which is exactly the case where the next host
  // (a different one) may succeed — treat it like a server error.
  if (status === 429 || status >= 500) return 'server-error'
  return 'invalid'
}

/** Map a thrown `fetch` error to a failure kind without guessing too hard. */
export function kindFromThrow(error: unknown): FetchFailureKind {
  const name = (error as { name?: unknown } | undefined)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  return 'unreachable'
}

/**
 * Render the collected failures as one sentence for the UI.
 *
 * Failures are common in the mirror case (two hosts down), and a list of
 * five stack traces is not an error message a user can act on.
 */
export function describeFailures(failures: readonly CatalogFetchError[]): string {
  if (failures.length === 0) return ''
  return failures.map((failure) => failure.message).join('; ')
}
