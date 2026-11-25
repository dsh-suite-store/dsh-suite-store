/**
 * One bundle's card: the face, the badges, and the action (§8.2).
 *
 * The card is deliberately dumb. Everything it shows is decided elsewhere —
 * `store-data.ts` owns `installState` and `installedCount`, `copy.ts` owns
 * the words — so this file is about ARRANGEMENT, and the rules it must
 * follow are visual:
 *
 * - the cover is either the author's picture or a 2×2 mosaic of the members'
 *   own marks, because a card with a blank grey box reads as broken;
 * - at most three tags are drawn and the rest become `+N`, because a card in
 *   a masonry column has a fixed width and wrapping tags push the button off
 *   the fold;
 * - the warning badge is about PERMISSIONS and HEALTH only. "Needs build
 *   approval" is a fact about installing, not a risk, and is drawn in the
 *   same row but in the quiet tone.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'

import type { BundleCard, LocalizedText } from '../catalog/types.ts'
import { warningCapabilities } from '../catalog/types.ts'
import type { OperationKind } from '../install/operation.ts'
import { capabilitySentence, installedCount, installState, needsWarning, text } from './store-data.ts'
import { fill, t as copy } from './copy.ts'
import type { Locale } from './copy.ts'
import { BundleIcon } from './BundleIcon.tsx'
import { Button, Icon, formatDate } from './ui.tsx'
import css from './Store.module.css'

/** Props of a card. */
export interface BundleCardViewProps {
  card: BundleCard
  /** Member keys this profile holds for this bundle. */
  installed: ReadonlySet<string>
  /** The operation running on this host, if any (§7.1: one at a time). */
  operationBundleId: string | undefined
  /** Which way that operation moves plugins; absent means an install. */
  operationKind: OperationKind | undefined
  /** The running operation's `done/total`, when it is this bundle's. */
  progress: { done: number; total: number } | undefined
  /** The host can install plugins at all (it has a plugin manager). */
  installable: boolean
  /**
   * Some OTHER bundle's operation owns the host right now.
   *
   * Separate from `installable` on purpose: this card's button is disabled
   * because the host is busy, not because the host cannot install, and the two
   * sentences are different claims about the user's machine.
   */
  hostBusy: boolean
  locale: Locale
  /** Category names in both languages, from the catalog. */
  categoryLabels?: Record<string, LocalizedText>
  onInstall: (bundleId: string) => void
  onCancel: () => void
  onOpen: (bundleId: string) => void
}

/** The number of tags a card draws before collapsing the rest. */
const VISIBLE_TAGS = 3

/**
 * One card.
 *
 * @param props - see {@link BundleCardViewProps}.
 * @returns the card, as a masonry column item.
 */
export function BundleCardView(props: BundleCardViewProps): ReactNode {
  const { card, installed, operationBundleId, operationKind, progress, installable, hostBusy, locale, categoryLabels, onInstall, onCancel, onOpen } = props
  const title = text(card.title, locale)
  const summary = text(card.summary, locale)
  // Pass the derived counters, never a hand-built OperationRecord:
  // `installState` iterates `operation.members` and a partial record used to
  // throw "operation.members is not iterable", blanking the whole page the
  // moment an uninstall started.
  const state = installState({
    card,
    installed,
    operation: undefined,
    operationBundleId,
    operationKind,
    progress: operationBundleId === card.id ? progress : undefined,
    installable,
    hostBusy,
  })
  const have = installedCount(card, installed)
  const tags = card.tags.slice(0, VISIBLE_TAGS)
  const extraTags = Math.max(0, card.tags.length - VISIBLE_TAGS)
  const warn = needsWarning(card)
  // The badge is a statement about declared capabilities, not a judgement, so
  // the set of tags that raise it lives in one place (`WARNING_CAPABILITIES`,
  // §8.2) rather than being re-listed here where a tag can be forgotten.
  const risky = warningCapabilities(card).length > 0

  return (
    <article
      className={[
        css.card,
        css.cardClickable,
        card.health.status === 'broken' ? css.cardBroken : '',
      ].filter(Boolean).join(' ')}
      // §8.2: the whole card is the target, not just a details button. A card
      // is already presented as one surface, and asking the reader to find the
      // small word to see what the surface is about is the dead end this
      // replaced. Inner controls stop the event so install still installs.
      role="button"
      tabIndex={0}
      aria-label={`${title === '' ? card.id : title} — ${copy('actionDetails', locale)}`}
      onClick={() => onOpen(card.id)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(card.id)
      }}
    >
      <div className={css.cover}>
        {card.cover === undefined || card.cover === null || card.cover === '' ? (
          <SuiteManifest card={card} installed={installed} />
        ) : (
          <img className={css.coverImg} src={card.cover} alt="" loading="lazy" />
        )}
      </div>

      <div className={css.cardTop}>
        {/* The suite's own mark, beside its name. `cover` above is the wide
            banner; this is the identity badge that also appears in the sheet,
            so the list and the dialog are recognisably the same suite. */}
        <BundleIcon card={card} size={24} className={css.cardIcon} />
        <div className={css.cardTitleWrap}>
          {/* Not a button any more: the card itself is the button, and a
              button inside a button is two tab stops for one destination. */}
          <h2 className={css.cardTitle}>{title === '' ? card.id : title}</h2>
          {/* §8.2 wants the identity on the card, not only in the dialog: two
              suites can share a display title, and "which one is this, and
              which version did I get" is the question a store card exists to
              answer before the click. */}
          <div className={css.cardId}>
            {card.id} · v{card.version}
          </div>
        </div>
      </div>

      {summary === '' ? null : <p className={css.summary}>{summary}</p>}

      <div className={css.badges}>
        <span className={[css.badge, css.badgeTag].join(' ')}>{primaryLabel(card.category.primary, locale, categoryLabels)}</span>
        {card.category.secondary === '' ? null : (
          <span className={[css.badge, css.badgeTag].join(' ')}>{secondaryLabel(card.category.secondary, locale, categoryLabels)}</span>
        )}
        {card.health.status === 'broken' ? (
          <span className={[css.badge, css.badgeError].join(' ')}>
            <Icon name="warning" size={12} />
            {copy('badgeBroken', locale)}
          </span>
        ) : null}
        {card.health.status === 'degraded' ? (
          <span className={[css.badge, css.badgeWarn].join(' ')}>{copy('badgeDegraded', locale)}</span>
        ) : null}
        {risky ? (
          <span className={[css.badge, css.badgeWarn].join(' ')} title={capabilityTitle(card, locale)}>
            {copy('badgeWarnPerm', locale)}
          </span>
        ) : null}
        {card.needsBuildApproval ? <span className={css.badge}>{copy('badgeBuild', locale)}</span> : null}
      </div>

      {card.tags.length === 0 ? null : (
        <div className={css.badges}>
          {/* Keyed by value AND index: the wire format only validates `tags` as
              a string array, so a catalog may repeat one, and duplicate React
              keys reconcile the wrong node. */}
          {tags.map((tag, index) => (
            <span className={[css.badge, css.badgeQuiet].join(' ')} key={`${tag}-${String(index)}`}>#{tag}</span>
          ))}
          {/* Through the copy table, like every other string on this card: the
              key already existed and was unused, so a wording change used to
              have to hunt down this literal. */}
          {extraTags === 0 ? null : (
            <span className={[css.badge, css.badgeQuiet].join(' ')}>{fill('moreTags', locale, { count: extraTags })}</span>
          )}
        </div>
      )}

      <div className={css.meta}>
        <span>{fill('cardMembers', locale, { count: card.memberCount })}</span>
        {/* Dropped entirely when the date cannot be read: the template alone
            renders "Updated " with nothing after it. */}
        {shortOf(card.updatedAt, locale) === '' ? null : (
          <span className={css.metaDot}>{fill('cardUpdated', locale, { date: shortOf(card.updatedAt, locale) })}</span>
        )}
        <span className={css.metaDot}>{fill('cardOwner', locale, { owner: card.owner })}</span>
      </div>

      <div
        className={css.actions}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <span className={css.actionGrow}>
          <ActionButton
            state={state}
            locale={locale}
            onInstall={() => onInstall(card.id)}
            onCancel={onCancel}
          />
        </span>
        {have > 0 && state.kind !== 'installed' ? (
          <span className={css.installedMark}>
            <Icon name="check" size={12} />
            {have}/{card.memberCount}
          </span>
        ) : null}
      </div>

      {state.kind === 'installing' ? (
        // Same ARIA rules as the sheet's bar: `max` must exceed `min`, and a
        // progressbar needs a name. A zero-member record would otherwise
        // announce the invalid range 0..0.
        <div
          className={css.bar}
          role="progressbar"
          aria-label={copy('progressBarLabel', locale)}
          aria-valuemin={0}
          aria-valuemax={state.total === 0 ? 1 : state.total}
          aria-valuenow={state.total === 0 ? 0 : state.done}
        >
          <div
            className={css.barFill}
            style={{ width: `${state.total === 0 ? 0 : Math.round((state.done / state.total) * 100)}%` }}
          />
        </div>
      ) : null}

      {warn && card.health.missing.length > 0 ? (
        <div className={css.meta}>{card.health.missing.slice(0, 3).join(', ')}</div>
      ) : null}

      {/* No second member list: the manifest at the top of this card already
          shows the real members with their install state, and a fold that
          repeats them below the button is the same fact twice. */}
    </article>
  )
}

/** The card's button, one branch per state of `installState`. */
function ActionButton(props: {
  state: ReturnType<typeof installState>
  locale: Locale
  onInstall: () => void
  onCancel: () => void
}): ReactNode {
  const { state, locale, onInstall, onCancel } = props
  switch (state.kind) {
    case 'installed':
      return (
        <span className={css.installedMark}>
          <Icon name="check" size={12} />
          {fill('actionInstalled', locale, { have: state.have, of: state.of })}
        </span>
      )
    case 'installing':
      // Two facts in the button's place: how far the run has got, and a way
      // out. The bar below already showed movement, but a number is what a
      // reader checks to answer "is this stuck?" — and the stop control is what
      // keeps a stalled run from being unkillable (§7.5).
      return (
        <span className={css.installRow}>
          <Button className={css.stAction} tone="secondary" onClick={onCancel}>
            {copy('actionStop', locale)}
          </Button>
          <span className={css.installCount}>
            {fill('actionInstalling', locale, { done: state.done, total: state.total })}
          </span>
        </span>
      )
    case 'removing':
      return (
        <Button className={css.stAction} tone="secondary" disabled>
          {fill('actionRemoving', locale, { done: state.done, total: state.total })}
        </Button>
      )
    case 'blocked':
      return (
        <Button
          className={css.stAction}
          tone="ghost"
          disabled
          title={copy(state.reason === 'busy' ? 'actionBusy' : 'actionBlocked', locale)}
        >
          {copy(state.reason === 'busy' ? 'actionBusy' : 'actionBlocked', locale)}
        </Button>
      )
    default:
      // No separate "details" button: the card opens on click or Enter, and a
      // bundle the host cannot install still has a way to be read.
      return <Button className={css.stAction} tone="primary" onClick={onInstall}>{copy('actionInstall', locale)}</Button>
  }
}

/**
 * The product's own subject, at a legible size: the install manifest this
 * store exists to run.
 *
 * A 2×2 grid of two-letter monograms was the placeholder before a picture
 * loads — it showed nothing about what the suite does. This draws the real
 * member names as a list with a state dot each, in the store's own accent, cut
 * by the frame's edge like a glimpse of a longer file. It is the same data the
 * install button acts on, so the card shows what pressing it will do.
 */
function SuiteManifest({ card, installed }: { card: BundleCard; installed: ReadonlySet<string> }): ReactNode {
  const rows = useMemo(
    () => card.members.slice(0, 5).map((member) => ({
      key: member.key,
      name: member.name === '' ? member.id : member.name,
      here: installed.has(member.key),
    })),
    [card.members, installed],
  )
  return (
    <div className={css.manifest} aria-hidden>
      <div className={css.manifestHead}>
        <span className={css.manifestDot} data-on="" />
        <span className={css.manifestTitle}>{card.id}</span>
        <span className={css.manifestCount}>{card.memberCount}</span>
      </div>
      <ul className={css.manifestList}>
        {rows.map((row) => (
          <li className={css.manifestRow} key={row.key} data-here={row.here ? '' : undefined}>
            <span className={css.manifestDot} data-on={row.here ? '' : undefined} />
            <span className={css.manifestName}>{row.name}</span>
            <span className={css.manifestState}>{row.here ? '✓' : '·'}</span>
          </li>
        ))}
      </ul>
      <div className={css.manifestFade} />
    </div>
  )
}

/**
 * A card's date, or an empty string when it cannot be parsed.
 *
 * Goes through `formatDate`'s shared, cached formatter rather than building a
 * new `Intl.DateTimeFormat` per card per render, and asks it for a short form.
 * An invalid stamp still yields `''`, which the caller uses to drop the whole
 * meta item instead of printing "Updated" with no date after it.
 */
function shortOf(iso: string, locale: Locale): string {
  // `formatDate` returns the raw text when the stamp is unparseable, which is
  // right for a banner but wrong here: "Updated <garbage>" is worse than no
  // meta item. The caller drops the item when this is empty.
  const formatted = formatDate(iso, locale, { short: true })
  return formatted === iso ? '' : formatted
}

/** The hover text on the permission badge: what the bundle actually asks for. */
function capabilityTitle(card: BundleCard, locale: Locale): string {
  return card.capabilitySummary
    .map((tag) => capabilitySentence(tag, locale) ?? tag)
    .join(' · ')
}

/**
 * A category id as a readable word.
 *
 * The name comes from the catalog: the data repository publishes
 * `categoryLabels` from the same tree that defines the slugs, so this page
 * never has to know that `academic-research` is called 学术研究与文献. An id
 * the catalog did not name falls back to the id in title case, which is what
 * a maintainer hand-editing the wire format would want to see rather than a
 * blank tab.
 *
 * @param labels - the catalog's `categoryLabels`, when the source had one.
 */
export function primaryLabel(id: string, locale: Locale, labels?: Record<string, LocalizedText>): string {
  return labeled(id, locale, labels)
}

/** A secondary category id as a readable word; same rules as {@link primaryLabel}. */
export function secondaryLabel(id: string, locale: Locale, labels?: Record<string, LocalizedText>): string {
  return labeled(id, locale, labels)
}

/** Look the id up in the catalog's label table, else title-case the id. */
function labeled(id: string, locale: Locale, labels?: Record<string, LocalizedText>): string {
  const named = labels === undefined ? undefined : labels[id]
  // `label`, not `text`: `text` is the module-level copy helper imported from
  // `store-data.ts`, and shadowing it here meant any later attempt to localize
  // a value in this function would silently call the string instead.
  const label = named === undefined ? '' : (named[locale] === '' ? named[locale === 'zh' ? 'en' : 'zh'] : named[locale])
  return label === undefined || label === '' ? prettyId(id, locale) : label
}

/** `breaking-news` → `Breaking news`; leaves non-ASCII ids alone. */
function prettyId(id: string, locale: Locale): string {
  void locale
  const spaced = id.replace(/[-_]+/g, ' ').trim()
  if (spaced === '') return id
  return spaced[0]!.toUpperCase() + spaced.slice(1)
}
