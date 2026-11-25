/**
 * The detail sheet's document, derived from the catalog card.
 *
 * This used to be a second network tier: the index carried a `detail` path per
 * bundle, and opening a sheet fetched one more JSON document per bundle. The
 * catalog is now a SINGLE published file (like awesome-dsh-plugin's data
 * package), because a measurement showed the second tier was mostly a copy:
 * `members` was byte-identical to the card's, and `readme` equalled `summary`
 * in all 103 published submissions. The only thing a detail document carried
 * alone — the tag→member attribution in `capabilities` — now rides on the card.
 *
 * So this class keeps its old SHAPE (`load(snapshot, id)` / `clear()`) and does
 * no I/O at all. Keeping the port is deliberate: `StoreService` calls it from
 * eight places, and `detailFromCard()` gives them exactly the object they
 * already expected, so no call site had to change to follow the data model.
 */

import type { CatalogSnapshot } from './sources.ts'
import { detailFromCard, type BundleDetail } from './types.ts'

/** Options kept so a caller constructing the loader does not have to change. */
export interface DetailLoaderOptions {
  /** Unused: the document comes from the index, not the network. */
  transport?: unknown
}

export class DetailLoader {
  constructor(options: DetailLoaderOptions = {}) {
    // Nothing to wire: there is no transport to hold. The parameter stays so a
    // caller that passes one (and the host that injects it) keeps compiling.
    void options
  }

  /**
   * The sheet's document for one bundle.
   *
   * @param snapshot - the index the card came from.
   * @param bundleId - the card's id.
   * @returns the document, or `undefined` when no card carries that id.
   */
  async load(snapshot: CatalogSnapshot, bundleId: string): Promise<BundleDetail | undefined> {
    const card = snapshot.index.bundles.find((entry) => entry.id === bundleId)
    return card === undefined ? undefined : detailFromCard(card)
  }

  /**
   * Drop cached state.
   *
   * Kept because the catalog service calls it on a refresh; there is nothing to
   * drop any more, and a no-op is the honest implementation — the document is
   * derived per call from whatever snapshot the caller passes.
   */
  clear(): void {
    // Nothing is cached.
  }
}
