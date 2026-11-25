/**
 * The details sheet: a bundle's description, its permissions, its members, and
 * the install/uninstall controls that belong with them (§8.3, §8.4).
 *
 * One column, 600px wide, and everything below the blurb is a folded panel —
 * for good reason: a two-column detail page left the document side as white
 * space whenever the README was short, and pushed the facts the reader came for
 * into a cramped rail. A fold
 * row states its subject and its size, and opens only when someone is
 * actually reading that part.
 *
 * The order is by how much each part changes a decision:
 *
 * 1. **what it can do**, because a suite that can run commands on this
 *    computer is a different proposition from one that cannot, and the
 *    catalog's raw tags (`shell`, `fs-write`) mean nothing to most readers;
 * 2. **its members**, with what floats and what is pinned, because "作者锁定"
 *    is why a member will not pick up a fix;
 * 3. **what happens after installing**, which is the one instruction people
 *    miss and then report as a bug.
 *
 * Uninstall lives here too, and it is deliberately the slower path: it shows
 * the preview, defaults every shared or manual member to unchecked, and says
 * who else uses what. §7.7's asymmetry — a wrong uninstall destroys work — is
 * mostly implemented server-side, but the dialog is where it becomes visible.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { BundleCard, BundleDetail, LocalizedText } from '../catalog/types.ts'
import type { MemberRecord, OperationKind } from '../install/operation.ts'
import { BundleIcon } from './BundleIcon.tsx'
import { failureSentence } from './ProgressPanel.tsx'
import type { UninstallChoice } from '../install/uninstall.ts'
import type { InstallReport } from '../install/executor.ts'
import type { MemberStateView, UninstallReport } from '../server/routes.ts'
import {
  CAPABILITY_GROUPS,
  capabilityGroupOf,
  capabilitySentence,
  inlineRuns,
  installedCount,
  markdownBlocks,
  text,
} from './store-data.ts'
import type { CapabilityGroupKey, InlineRun, MarkdownBlock, PreflightResponse } from './store-data.ts'
import { fill, t as copy } from './copy.ts'
import { wrapTab } from './modal-focus.ts'
import type { CopyKey, Locale } from './copy.ts'
import { Button, Checkbox, Switch, formatDate } from './ui.tsx'
import { primaryLabel, secondaryLabel } from './Card.tsx'
import css from './Store.module.css'

/** Props of the details dialog. */
export interface DetailsDialogProps {
  card: BundleCard
  locale: Locale
  /**
   * The catalog's category names, keyed by id.
   *
   * Without this the sheet could only title-case the raw id, which is an
   * English-looking slug in every language: the header said `Personal` for a
   * reader whose whole page was in Chinese, while the card behind it said
   * 个人效率. The catalog publishes these labels from the same tree that
   * defines the slugs, so passing them through is the only correct answer.
   */
  categoryLabels: Record<string, LocalizedText> | undefined
  /**
   * Which host performs the install (§8.3).
   *
   * Only used to say "the host's plugin manager does this" on the desktop,
   * where the store hands off rather than running pnpm itself. `undefined`
   * means the capabilities have not arrived yet, and the note is omitted
   * rather than guessed.
   */
  hostKind: 'cli' | 'desktop' | undefined
  /** Member keys this profile holds for this bundle. */
  installed: ReadonlySet<string>
  installable: boolean
  onClose: () => void
  /** Stop the running install from this sheet (§7.5). */
  onCancel: () => void
  /** This bundle's own install is in flight. */
  runningThisBundle: boolean
  /**
   * The live counters for this bundle's run, when there is one.
   *
   * `running` names the member currently being worked on, which is the one
   * thing a reader watching the sheet wants that a percentage cannot say.
   */
  runningProgress?: {
    done: number
    total: number
    running?: string | undefined
  }
  /**
   * Which way the run moves plugins.
   *
   * The counters alone cannot say it: `2/5` is the same shape for an install
   * and a removal, and the sheet printed 安装中 for both — a removal would
   * announce itself as an installation.
   */
  runningKind?: OperationKind
  /** Members that failed in this bundle's run, with their reasons. */
  failedMembers?: readonly MemberRecord[]
  /** Start the run, carrying any build-script approvals the user gave. */
  onInstall: (bundleId: string, approvedBuilds?: readonly string[]) => void
  /** Which members would need a build approval, asked when the sheet opens. */
  preflight: (bundleId: string) => Promise<PreflightResponse>
  /** Fetch the detail document; rejects with the reason. */
  load: (bundleId: string) => Promise<BundleDetail>
  /** What uninstalling would remove, with the server's defaults. */
  preview: (bundleId: string) => Promise<readonly UninstallChoice[]>
  uninstall: (bundleId: string, ids: readonly string[]) => Promise<UninstallReport>
  /**
   * Presence and switch state of every member, asked when the dialog opens.
   *
   * Separate from `preview` because the two answer different questions: the
   * preview is about removal (what would go), this is about the switch (what
   * is on), and a member that is present and off appears in one and not the
   * other.
   */
  memberStates: (bundleId: string) => Promise<readonly MemberStateView[]>
  /**
   * Turn one member's switch on or off (§8.3).
   *
   * @returns what the host settled on, which is not always what was asked.
   */
  setMemberEnabled: (id: string, enabled: boolean) => Promise<boolean>
  /** Install a single member without taking the rest of the bundle (§8.3). */
  installMember: (bundleId: string, key: string) => Promise<InstallReport>
}

/** The copy key for one capability family's label. */
const GROUP_LABELS: Record<CapabilityGroupKey, CopyKey> = {
  fileEnv: 'capGroupFileEnv',
  network: 'capGroupNetwork',
  exec: 'capGroupExec',
  credentials: 'capGroupCredentials',
  model: 'capGroupModel',
  host: 'capGroupHost',
  other: 'capGroupOther',
}

/**
 * The dialog.
 *
 * Both documents it shows are fetched on open rather than with the catalog:
 * a README per card would be 50 documents to browse 50 titles, and the
 * preview needs the profile's provenance which only matters here.
 */
export function DetailsDialog(props: DetailsDialogProps): ReactNode {
  const { card, locale, categoryLabels, hostKind, installed, installable, onClose, onCancel, runningThisBundle, runningProgress, runningKind, failedMembers, onInstall, preflight, load, preview, uninstall, memberStates, setMemberEnabled, installMember } = props
  const [detail, setDetail] = useState<BundleDetail | undefined>(undefined)
  /**
   * Bumped once whenever this bundle's run goes from live to finished.
   *
   * The member switch states, the uninstall preview and the detail document all
   * describe the profile at a moment in time, and an operation invalidates all
   * three at once: a member that was "not installed" a minute ago now exists,
   * and the uninstall preview that said "nothing to remove" now has rows. They
   * are re-fetched on this counter instead of on a timer or a websocket the
   * sheet would otherwise need to duplicate.
   */
  const [profileEpoch, setProfileEpoch] = useState(0)
  const wasLive = useRef(false)
  /** The sheet itself, focused on open so Tab starts inside the dialog. */
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (wasLive.current && !runningThisBundle) setProfileEpoch((epoch) => epoch + 1)
    wasLive.current = runningThisBundle
  }, [runningThisBundle])
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [choices, setChoices] = useState<readonly UninstallChoice[] | undefined>(undefined)
  const [choiceError, setChoiceError] = useState<string | undefined>(undefined)
  const [removing, setRemoving] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [states, setStates] = useState<readonly MemberStateView[] | undefined>(undefined)
  const [switchError, setSwitchError] = useState<string | undefined>(undefined)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  /**
   * Which members would need a build-script approval (§7.2).
   *
   * Asked once, when the sheet opens, so the question can be put BEFORE the
   * run. Asking mid-install interrupts a long operation to answer a question
   * the user could have answered on arrival.
   */
  const [buildMembers, setBuildMembers] = useState<readonly string[]>([])
  const [approveBuilds, setApproveBuilds] = useState(false)
  /** The removal checklist is opt-in: reading a bundle should not start with
      a row of checkboxes about deleting things. */
  const [uninstallOpen, setUninstallOpen] = useState(false)
  // Members are what the suite IS and what a reader came for, so they start
  // open. Permissions and package facts are reference material and start
  // folded — the dialog opens on the plugin list, not on a security brief.
  const [capsOpen, setCapsOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(true)
  const [infoOpen, setInfoOpen] = useState(false)

  /**
   * Members a removal run marked `needs-restart` — the ONLY ones waiting to be
   * removed. A plugin the user simply switched off is not in this set.
   */
  const needsRestartKeys = useMemo(
    () => new Set((failedMembers ?? []).filter((m) => m.state === 'needs-restart').map((m) => m.key)),
    [failedMembers],
  )

  useEffect(() => {
    let live = true
    setDetail(undefined)
    setDetailError(undefined)
    load(card.id).then(
      (document) => { if (live) setDetail(document) },
      (error: unknown) => { if (live) setDetailError(reasonOf(error)) },
    )
    return () => { live = false }
    // `profileEpoch` is a dependency because the detail document is what names
    // the members behind each capability and carries each member's `reason`:
    // leaving it out kept those describing the PRE-run profile while
    // `states`/`choices` (which do depend on the epoch) were refreshed.
  }, [card.id, load, profileEpoch])

  useEffect(() => {
    let live = true
    setChoices(undefined)
    setChoiceError(undefined)
    preview(card.id).then(
      (list) => {
        if (!live) return
        setChoices(list)
        setPicked(new Set(list.filter((choice) => choice.checked).map((choice) => choice.id)))
      },
      (error: unknown) => { if (live) setChoiceError(reasonOf(error)) },
    )
    return () => { live = false }
  }, [card.id, preview, profileEpoch])

  // Member switch states are fetched alongside the preview: both describe this
  // profile, both go stale the moment an operation runs, and one round trip is
  // easier to keep consistent than two that could land in either order.
  useEffect(() => {
    let live = true
    setStates(undefined)
    setSwitchError(undefined)
    memberStates(card.id).then(
      (list) => { if (live) setStates(list) },
      (error: unknown) => { if (live) setSwitchError(reasonOf(error)) },
    )
    return () => { live = false }
  }, [card.id, memberStates, profileEpoch])

  useEffect(() => {
    let live = true
    // A new bundle (or a refreshed profile) means NEW build approvals to ask
    // for: the previous bundle's pending list and the checkbox ticked for it
    // must never be carried across, or the sheet offers an approval the user
    // granted for something else.
    setBuildMembers([])
    setApproveBuilds(false)
    preflight(card.id).then(
      (answer) => {
        if (!live) return
        setBuildMembers(answer.summary.needsBuildApproval ? answer.summary.pendingBuilds : [])
      },
      // A failed preflight is not a failed sheet: the run still reports its own
      // refusals, and refusing to show the dialog would hide the whole bundle
      // because one question could not be asked.
      () => { if (live) setBuildMembers([]) },
    )
    return () => { live = false }
  }, [card.id, preflight, profileEpoch])

  // Escape closes. Bound on the document because the dialog is a portal-less
  // overlay: the focus may be anywhere in its subtree when the key arrives.
  // Tab is trapped inside the sheet: `aria-modal="true"` promises that the
  // rest of the page is inert, and without the trap a keyboard user reaches
  // controls behind the backdrop that the modal has disabled visually only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const sheet = sheetRef.current
      if (sheet === null) return
      // Buttons, links and tabbable rows; `tabIndex=-1` on the sheet itself is
      // deliberately excluded so the first Tab goes to a real control.
      const focusable = [...sheet.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        sheet.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const destination = wrapTab({
        active: document.activeElement,
        first,
        last,
        backwards: event.shiftKey,
        sheetFocused: document.activeElement === sheet,
      })
      if (destination === 'first') {
        event.preventDefault()
        first.focus()
      } else if (destination === 'last') {
        event.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * Focus belongs to the dialog while it is open, and returns to the card that
   * opened it when it closes.
   *
   * `aria-modal` alone does not move focus: without this, Tab from the "open"
   * card walks into the elements BEHIND the overlay — buttons that are visible
   * through the backdrop but cannot be used while the sheet owns the screen.
   * Restoring on unmount is the other half: closing with the keyboard used to
   * leave focus on a removed node, so the next Tab started again from the top
   * of the page.
   *
   * We move focus to the sheet itself (tabIndex=-1), not to the close button:
   * the first Tab then lands on the close button, which is the expected first
   * stop, while a screen reader announces the dialog's aria-label first.
   */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    sheetRef.current?.focus()
    return () => {
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [])

  // The run reports members by key; the card is what knows a human name for
  // one. Falling back to the key keeps the line useful when the run names a
  // member this card does not carry (a stale record from another catalog).
  const runningMemberName = useMemo(() => {
    const key = runningProgress?.running
    if (key === undefined) return undefined
    const member = card.members.find((entry) => entry.key === key)
    return member === undefined ? key : (member.name === '' ? member.key : member.name)
  }, [card.members, runningProgress?.running])

  const title = text(card.title, locale)
  // `postInstall` is localized text, not a string: a suite written by a
  // Chinese author may only ship the zh side, and `text` is the one place that
  // knows how to fall back.
  const postInstallText = text(detail?.postInstall, locale)

  // One permission list, not two. The card's `capabilitySummary` is the tag
  // union the badge is drawn from, and the detail document carries the same
  // tags with the members that asked for them — §8.3 wants both facts in one
  // line ("会读写你的文件（来自 3 个插件）"), so the card supplies the tags
  // before the document arrives and the document supplies the sources after.
  // Rendering two lists would show every permission twice, once unattributed.
  const capabilityRows = useMemo(() => {
    const sources = new Map<string, string[]>()
    for (const capability of detail?.capabilities ?? []) sources.set(capability.tag, capability.sources)
    const tags = card.capabilitySummary.length > 0
      ? card.capabilitySummary
      : [...sources.keys()]
    return tags.map((tag) => ({ tag, sources: sources.get(tag) ?? [] }))
  }, [card.capabilitySummary, detail?.capabilities])

  // Nine sentences in a column is nine lines nobody scans; the same nine in
  // three labelled rows is "files, network, execution" at a glance.
  const capabilityGroups = useMemo(() => {
    const grouped = new Map<CapabilityGroupKey, { tag: string; sources: string[] }[]>()
    for (const row of capabilityRows) {
      const key = capabilityGroupOf(row.tag)
      const list = grouped.get(key)
      if (list === undefined) grouped.set(key, [row])
      else list.push(row)
    }
    const order: CapabilityGroupKey[] = [...CAPABILITY_GROUPS.map((group) => group.key), 'other']
    return order
      .filter((key) => grouped.has(key))
      .map((key) => ({ key, rows: grouped.get(key)! }))
  }, [capabilityRows])

  return (
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={title === '' ? card.id : title}
      // Clicking the dimmed area closes, which is the gesture people try
      // first. The check keeps a click inside the sheet from closing it.
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className={css.dialog} ref={sheetRef} tabIndex={-1}>
        <header className={css.dialogHead}>
          {/* The same mark the card drew, at the same size as the title's line
              box: opening a sheet from a card should look like the same suite,
              not a different page about it. */}
          <BundleIcon card={card} size={40} className={css.dialogIcon} />
          <div className={css.grow}>
            <h2 className={css.dialogTitle}>{title === '' ? card.id : title}</h2>
            <div className={css.byline}>
              <span>{card.id}</span>
              <span className={css.bylineDot}>·</span>
              <span>v{card.version}</span>
              <span className={css.bylineDot}>·</span>
              <span>{card.owner}</span>
              <span className={css.bylineDot}>·</span>
              <span>
                {fill('cardUpdated', locale, { date: formatDate(card.updatedAt, locale) })}
              </span>
            </div>
            {/* Category and the tested-with label are one line of identity, not
                reference material: §8.3 wants them visible without opening a
                fold. */}
            <div className={css.dialogTags}>
              {/* Both levels in pill tabs, matching the filter row above the
                  grid: a reader who saw 个人效率 / 写作 on a card must find the
                  same words in the sheet, in the same shape. */}
              <div className={css.dialogCategoryTabs}>
                <span className={[css.badge, css.badgeTag].join(' ')}>
                  {primaryLabel(card.category.primary, locale, categoryLabels)}
                </span>
                {card.category.secondary === '' || card.category.secondary === undefined ? null : (
                  <span className={[css.badge, css.badgeTag].join(' ')}>
                    {secondaryLabel(card.category.secondary, locale, categoryLabels)}
                  </span>
                )}
              </div>
              {detail?.testedWith === undefined ? null : (
                <span className={css.dialogTagNote}>
                  {copy('infoTestedWith', locale)} {detail.testedWith}
                </span>
              )}
            </div>
          </div>
          {/* A plain button with a literal glyph, not the host's icon: the
              icon set is injected and a missing export renders as nothing,
              which is how this sheet ended up with no visible way out. */}
          <button
            type="button"
            className={css.closeButton}
            onClick={onClose}
            aria-label={copy('close', locale)}
            title={copy('close', locale)}
          >
            <span aria-hidden>×</span>
          </button>
        </header>

        <div className={css.dialogBody}>
          {detailError === undefined ? null : (
            <p className={[css.sideText, css.dangerText].join(' ')}>
              {fill('errorDetail', locale, { reason: detailError })}
            </p>
          )}
          {detail === undefined && detailError === undefined ? (
            <p className={css.sideText}>{copy('loadingDetail', locale)}</p>
          ) : null}

          {detail === undefined ? null : <Readme document={detail} locale={locale} />}

          {/* §8.3: red lines come first and apart, in red, with the member they
              came from. They are advice, not disclosure; folding them away
              would make them the one warning people never open. */}
          {detail?.capabilityRedLines === undefined ? null : (
            <section className={css.redBox}>
              <h4 className={css.redBoxLabel}>{copy('redLinesLabel', locale)}</h4>
              <ul className={css.capList}>
                {detail.capabilityRedLines.map((line, index) => (
                  <li key={`${line.text.en}-${index}`} className={[css.sideText, css.redLineText].join(' ')}>
                    {text(line.text, locale)}
                    {line.members.length === 0 ? null : (
                      <span className={css.capSource}> — {line.members.join(', ')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={css.fold}>
            <button
              type="button"
              className={css.foldRow}
              aria-expanded={membersOpen}
              onClick={() => setMembersOpen((open) => !open)}
            >
              <span className={css.foldTitle}>{copy('membersLabel', locale)}</span>
              <span className={css.foldMeta}>{fill('foldItems', locale, { count: card.memberCount })}</span>
              <span className={css.foldChevron} data-open={membersOpen ? '' : undefined} aria-hidden>›</span>
            </button>
            {membersOpen ? (
              <div className={css.foldBody}>
                <ul className={css.memberItems}>
                  {card.members.map((member, index) => {
                    const state = states?.find((row) => row.key === member.key)
                    const label = member.name === '' ? member.id : member.name
                    const engines = member.engines?.dsh
                    // Only an absolute `https:` destination is a link. The
                    // catalog is community-authored, so the scheme is what keeps
                    // `javascript:`/`data:` from becoming a live control here.
                    const safeRepo = member.repo !== undefined && /^https:\/\//u.test(member.repo)
                      ? member.repo
                      : undefined
                    // The bundle author's sentence FIRST: it says why this
                    // plugin is in THIS bundle, which is the question a member
                    // row answers. The package's own registry description is
                    // the fallback — a generic sentence about the package, not
                    // about its role here — and only fills rows the author left
                    // without a reason. Never both: two paragraphs per row is
                    // what made this list unreadable.
                    //
                    // The rule lives in `memberBlurb` so it is asserted once,
                    // in a test, instead of being re-derived per render.
                    const blurb = memberBlurb(
                      text(detail?.members.find((row) => row.key === member.key)?.reason, locale),
                      text(member.description, locale),
                    )
                    return (
                      // `data-blurb` sits on the ROW, not the paragraph: the
                      // paragraph clips its own overflow, so a tooltip drawn
                      // from it would be cut off. The row does not clip.
                      <li key={member.key} className={css.memberItem} data-blurb={blurb.text === '' ? undefined : blurb.text}>
                        <span className={css.memberItemIndex}>{String(index + 1).padStart(2, '0')}</span>
                        <div className={css.memberItemMain}>
                          <div className={css.memberItemHead}>
                            {/* `member.repo` is catalog data, so it is a URL only
                                when it passes the same rule README links do
                                (`https:` only). A `javascript:` or `data:` value
                                would otherwise become a live control in the
                                host's own window; anything else renders as
                                plain text. */}
                            {safeRepo === undefined ? (
                              <span className={css.memberItemName}>{label}</span>
                            ) : (
                              <a
                                className={css.memberItemLink}
                                href={safeRepo}
                                target="_blank"
                                rel="noreferrer noopener"
                                title={safeRepo}
                              >
                                {label}
                              </a>
                            )}
                            <span className={css.memberItemVersion}>
                              {member.pinned ? `v${member.version ?? ''}` : copy('memberFloating', locale)}
                            </span>
                            {/* Who publishes it. Derived from the key, which IS
                                `owner/name` — the member record on the wire has
                                no separate owner field, and adding one would be
                                a second copy of the same string. */}
                            <span className={css.memberItemOwner} title={member.key}>
                              {member.key.includes('/') ? member.key.slice(0, member.key.indexOf('/')) : ''}
                            </span>
                            {/* The package's own supported-dsh range. Shown
                                because the host refuses a member outside it,
                                and finding that out after starting a run is
                                worse than reading it here. Absent when the
                                package declares none, which is not a claim of
                                compatibility. */}
                            {engines === undefined ? null : (
                              <span className={css.memberItemEngines} title={engines}>
                                {fill('memberNeedsDsh', locale, { range: shortRange(engines) })}
                              </span>
                            )}
                            {installed.has(member.key) ? (
                              // Only a member THIS run marked `needs-restart`
                              // is waiting to be removed. A plugin merely
                              // switched off is the user's own choice and stays
                              // off across restarts — calling that "removed on
                              // restart" was wrong and contradicted what the
                              // host shows after rebooting.
                              <span className={css.memberItemChip}>
                                {needsRestartKeys.has(member.key)
                                  ? copy('memberPresentDisabled', locale)
                                  : copy('memberHere', locale)}
                              </span>
                            ) : null}
                            {member.stars === undefined ? null : (
                              <span className={css.memberItemStars} title={copy('memberStars', locale)}>
                                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                                  <path
                                    d="M6 1.2l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.75 3 10.3l.6-3.3L1.2 4.7l3.3-.5z"
                                    fill="currentColor"
                                  />
                                </svg>
                                {formatStars(member.stars)}
                              </span>
                            )}
                          </div>
                          {blurb.text === '' ? null : (
                            // Focusable so the tooltip is reachable without a
                            // mouse: the row already shows one clamped line,
                            // and a keyboard reader otherwise has no way to
                            // ask for the rest.
                            <p className={css.memberItemBlurb} tabIndex={0}>
                              {/* The tag labels the AUTHOR'S sentence, so it
                                  appears exactly when `reason` supplied the
                                  text. A registry description needs no label —
                                  it is obviously about the package itself. */}
                              {blurb.fromAuthor ? <span className={css.memberItemTag}>{copy('memberWhy', locale)}</span> : null}
                              {blurb.text}
                            </p>
                          )}
                        </div>
                        <div className={css.memberItemAction}>
                          {state === undefined ? (
                            // A host round trip per plugin, so the switch is
                            // undecided for a moment. A spinner says "working"
                            // without a word the reader has to parse.
                            <span className={css.memberLoading} role="status" aria-label={copy('memberStateLoading', locale)}>
                              <span className={css.memberLoadingRing} aria-hidden />
                            </span>
                          ) : !state.present ? (
                            <Button className={css.stAction}
                              tone="ghost"
                              disabled={!installable || busyKey !== undefined || runningThisBundle}
                              title={copy('memberInstallOneTitle', locale)}
                              onClick={() => {
                                setBusyKey(member.key)
                                setSwitchError(undefined)
                                installMember(card.id, member.key).then(
                                  (report) => {
                                    setBusyKey(undefined)
                                    // Only a refusal to START rejects; a run
                                    // that partly failed resolves with a
                                    // non-empty `failed` list. Ignoring it made
                                    // a failed one-member install show nothing.
                                    if (report.failed.length > 0) {
                                      setSwitchError(report.failed.map((entry) => entry.reason).join('; '))
                                    } else {
                                      // The profile changed, so the row states
                                      // and the uninstall preview are stale.
                                      setProfileEpoch((epoch) => epoch + 1)
                                    }
                                  },
                                  (error: unknown) => { setBusyKey(undefined); setSwitchError(reasonOf(error)) },
                                )
                              }}
                            >
                              {copy('memberInstallOne', locale)}
                            </Button>
                          ) : state.enabled === undefined ? (
                            <span className={css.sideText}>{copy('memberUnknownState', locale)}</span>
                          ) : (
                            <Switch
                              checked={state.enabled}
                              disabled={busyKey !== undefined || runningThisBundle}
                              label={
                                state.enabled
                                  ? copy('memberSwitchOn', locale)
                                  : copy('memberSwitchOff', locale)
                              }
                              onChange={(next) => {
                                setBusyKey(member.key)
                                setSwitchError(undefined)
                                setMemberEnabled(state.id, next).then(
                                  (settled) => {
                                    setBusyKey(undefined)
                                    // The host is the authority: report what it
                                    // settled on, not what was clicked.
                                    setStates((current) => current?.map((row) => (
                                      row.key === member.key ? { ...row, enabled: settled } : row
                                    )))
                                  },
                                  (error: unknown) => { setBusyKey(undefined); setSwitchError(reasonOf(error)) },
                                )
                              }}
                            />
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {switchError === undefined ? null : (
                  <p className={[css.sideText, css.dangerText].join(' ')}>
                    {fill('errorSwitch', locale, { reason: switchError })}
                  </p>
                )}
              </div>
            ) : null}
          </section>

          <section className={css.fold}>
            <button
              type="button"
              className={css.foldRow}
              aria-expanded={capsOpen}
              onClick={() => setCapsOpen((open) => !open)}
            >
              <span className={css.foldTitle}>{copy('capsLabel', locale)}</span>
              <span className={css.foldMeta}>{fill('foldItems', locale, { count: capabilityRows.length })}</span>
              <span className={css.foldChevron} data-open={capsOpen ? '' : undefined} aria-hidden>›</span>
            </button>
            {capsOpen ? (
              <div className={css.foldBody}>
                {capabilityRows.length === 0 ? (
                  <p className={css.sideText}>{copy('capsNone', locale)}</p>
                ) : (
                  <div className={css.capGroups}>
                    {capabilityGroups.map((group) => (
                      <section className={css.capGroup} key={group.key}>
                        <h5 className={css.capGroupLabel}>{copy(GROUP_LABELS[group.key], locale)}</h5>
                        <ul className={css.capItems}>
                          {group.rows.map((row) => (
                            <li
                              key={row.tag}
                              className={css.capItem}
                              // Keyboard reaches the same tooltip: a member list
                              // that can only be read with a mouse is a list
                              // half the users cannot read.
                              tabIndex={row.sources.length === 0 ? undefined : 0}
                            >
                              <span className={css.capItemDot} aria-hidden />
                              <span className={css.capItemText}>
                                {capabilitySentence(row.tag, locale) ?? row.tag}
                              </span>
                              {row.sources.length === 0 ? null : (
                                <>
                                  {/* The count is the affordance: it says which
                                      rows have members behind them. The tooltip
                                      is anchored on the ROW (below), so hovering
                                      the sentence works as well as the number —
                                      a 14px target is not the only way in. */}
                                  <span
                                    className={css.capItemCount}
                                    aria-hidden
                                  >
                                    {row.sources.length}
                                  </span>
                                  <span className={css.capTip} role="tooltip">
                                    <span className={css.capTipTitle}>
                                      {fill('capSourcesTitle', locale, { count: row.sources.length })}
                                    </span>
                                    {row.sources.map((source) => (
                                      <span className={css.capTipRow} key={source}>{source}</span>
                                    ))}
                                  </span>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}
                <p className={css.capCaveat}>{copy('capsCaveat', locale)}</p>
              </div>
            ) : null}
          </section>

          <section className={css.fold}>
            <button
              type="button"
              className={css.foldRow}
              aria-expanded={infoOpen}
              onClick={() => setInfoOpen((open) => !open)}
            >
              <span className={css.foldTitle}>{copy('bundleInfoLabel', locale)}</span>
              <span className={css.foldMeta}>v{card.version}</span>
              <span className={css.foldChevron} data-open={infoOpen ? '' : undefined} aria-hidden>›</span>
            </button>
            {infoOpen ? (
              <div className={css.foldBody}>
                <dl className={css.infoList}>
                  <dt>{copy('infoCategory', locale)}</dt>
                  <dd>
                    {primaryLabel(card.category.primary, locale, categoryLabels)}
                    {card.category.secondary === '' ? null : ` / ${secondaryLabel(card.category.secondary, locale, categoryLabels)}`}
                  </dd>
                  <dt>{copy('infoOwner', locale)}</dt>
                  <dd>{card.owner}</dd>
                  <dt>{copy('infoVersion', locale)}</dt>
                  <dd>v{card.version}</dd>
                  {detail?.testedWith === undefined ? null : (
                    <>
                      <dt>{copy('infoTestedWith', locale)}</dt>
                      <dd>{detail.testedWith}</dd>
                    </>
                  )}
                  <dt>{copy('infoUpdated', locale)}</dt>
                  <dd>{formatDate(card.updatedAt, locale)}</dd>
                </dl>
                {/* §8.3: on the desktop the install is not this plugin's work —
                    the host's own plugin manager performs it, and saying so is
                    what stops a user blaming the store for a pnpm failure. */}
                {hostKind === 'desktop' ? (
                  <p className={css.sideText}>{copy('infoDesktopHost', locale)}</p>
                ) : null}
                {postInstallText === '' ? null : (
                  <>
                    <h4 className={css.sideLabel}>{copy('postInstall', locale)}</h4>
                    <p className={css.sideText}>{postInstallText}</p>
                  </>
                )}
              </div>
            ) : null}
          </section>
        </div>

        <footer className={css.dialogFoot}>
          {/* §7.2: the build-script question is asked ONCE, before the run.
              pnpm refuses such a member outright (ERR_PNPM_IGNORED_BUILDS),
              so a suite containing one would otherwise report a failure the
              user has no way to act on. */}
          {buildMembers.length === 0 ? null : (
            <div className={css.approveBox}>
              <Checkbox checked={approveBuilds} onChange={setApproveBuilds}>
                {/* The key exists so the APPROVAL can be addressed to pnpm; the
                    reader only needs the package name. `name@<git url>#<sha>`
                    is fifty characters of the same fact. */}
                {fill('approveBuilds', locale, {
                  count: buildMembers.length,
                  names: [...new Set(buildMembers.map((entry) => {
                    // `pendingBuildsFrom` yields plain package names and
                    // `refusedBuildKeys` yields `name@<url>#<sha>`; stripping at
                    // the LAST `@` mangled the first shape (`esbuild` became
                    // `esbuil`, `@scope/pkg` became `''`). The name/version
                    // boundary is the first `@` after position 0.
                    const at = entry.indexOf('@', 1)
                    return at === -1 ? entry : entry.slice(0, at)
                  }))].join(', '),
                })}
              </Checkbox>
              <p className={css.approveNote}>{copy('approveBuildsNote', locale)}</p>
            </div>
          )}
          <div className={css.footBar}>
            {/* Shown only when the preview found something on disk: `choices` is
                one row per installed member, so a non-empty list IS the
                "this suite is at least partly here" test. `undefined` is the
                preview still loading, which must not flash the button in. */}
            {choices === undefined || choices.length === 0 ? null : (
              <Button className={css.stAction} tone="ghost" onClick={() => setUninstallOpen((open) => !open)}>
                {copy('uninstallAll', locale)}
              </Button>
            )}
            <span className={css.grow} />
            {runningThisBundle ? (
              // Same place as the install button: a run this long needs a way
              // out, and a second button elsewhere is easy to miss (§7.5).
              <span className={css.installRow}>
                <Button className={css.stAction} tone="secondary" onClick={onCancel}>
                  {copy('actionStop', locale)}
                </Button>
                {runningProgress === undefined ? null : (
                  <span className={css.installCount}>
                    {fill(runningKind === 'uninstall' ? 'actionRemoving' : 'actionInstalling', locale, runningProgress)}
                  </span>
                )}
              </span>
            ) : installedCount(card, installed) >= card.memberCount && card.memberCount > 0 ? null : (
              // Everything is on disk: a second "install all" only offers to
              // redo work. The uninstall button above is the action that
              // remains meaningful here.
              <Button className={css.stAction}
                tone="primary"
                disabled={!installable}
                onClick={() => {
                  // Declining leaves the members out of the plan, so they are
                  // reported as `skipped-build-denied` and the rest still
                  // installs — never a silent run of code the user did not allow.
                  // The sheet stays open: the run it just started is drawn right
                  // here, and closing would make the reader reopen it to watch.
                  onInstall(card.id, approveBuilds ? buildMembers : [])
                }}
              >
                {copy('actionInstallAll', locale)}
              </Button>
            )}
          </div>

          {/* The same bar the card draws. It sits above the member rows, which
              is where a reader looks to see which member is running now. */}
          {runningProgress !== undefined ? (
            <div className={css.sheetProgress}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={runningProgress.total}
              aria-valuenow={runningProgress.done}
            >
              <div className={css.bar}>
                <div className={css.barFill}
                  style={{ width: `${runningProgress.total === 0 ? 0 : Math.round((runningProgress.done / runningProgress.total) * 100)}%` }}
                />
              </div>
              {/* One line naming what the run is doing right now. A bar shows
                  that something is happening; this says WHICH member, which is
                  the question a reader has when a run is slow. */}
              <p className={css.sheetProgressNote}>
                {runningMemberName === undefined
                  ? copy(runningKind === 'uninstall' ? 'progressWorkingOff' : 'progressWorkingOn', locale)
                  : fill(runningKind === 'uninstall' ? 'progressWorkingOff' : 'progressWorkingOn',
                      locale, { name: runningMemberName })}
              </p>
            </div>
          ) : null}

          {/* Failures belong next to the members they are about. The page-level
              banner says a run went wrong; this says which plugin and why,
              without asking the reader to close the sheet to find out. */}
          {(failedMembers ?? []).length === 0 ? null : (
            <ul className={css.sheetFailures}>
              {(failedMembers ?? []).map((member) => (
                <li key={member.key} className={css.sheetFailure}>
                  <span className={css.sheetFailureName}>{member.name === '' ? member.key : member.name}</span>
                  <span className={css.sheetFailureWhy}>{failureSentence(member, locale)}</span>
                </li>
              ))}
            </ul>
          )}

          {uninstallOpen ? (
            <div className={css.uninstallPanel}>
              {choices === undefined ? (
                <p className={css.sideText}>{copy('uninstallPreview', locale)}</p>
              ) : choices.length === 0 ? (
                <p className={css.sideText}>{copy('uninstallNothing', locale)}</p>
              ) : (
                <>
                  <h4 className={css.uninstallHead}>
                    {fill('uninstallTitle', locale, { id: card.id })}
                    <span className={css.uninstallCount}>
                      {fill('uninstallPicked', locale, { count: picked.size, total: choices.length })}
                    </span>
                    <Button
                      className={css.selectAllButton}
                      tone="ghost"
                      onClick={() => setPicked(
                        picked.size === choices.length
                          ? new Set()
                          : new Set(choices.map((choice) => choice.id)),
                      )}
                    >
                      {copy(picked.size === choices.length ? 'selectNone' : 'selectAll', locale)}
                    </Button>
                  </h4>
                  <ul className={css.uninstallList}>
                    {choices.map((choice) => {
                      // Only-source members are the safe default; anything
                      // else carries a warning the row must make visible
                      // before the checkbox is even reached.
                      const safe = choice.reason === 'only-source'
                      return (
                        <li key={choice.id} className={css.uninstallRow} data-safe={safe ? '' : undefined}>
                          <Checkbox
                            checked={picked.has(choice.id)}
                            disabled={removing}
                            onChange={(next) => {
                              const copyOf = new Set(picked)
                              if (next) copyOf.add(choice.id)
                              else copyOf.delete(choice.id)
                              setPicked(copyOf)
                            }}
                          >
                            <span className={css.uninstallId}>{choice.id}</span>
                          </Checkbox>
                          <span className={safe ? css.uninstallReasonSafe : css.uninstallReasonWarn}>
                            {uninstallReasonCopy(choice, locale)}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                  <div className={css.uninstallBar}>
                    <span className={css.uninstallNote}>
                      {picked.size === 0
                        ? copy('uninstallNonePicked', locale)
                        : fill('uninstallWillRemove', locale, { count: picked.size })}
                    </span>
                    {/* A destructive confirm must not be clickable while a run
                        owns the host: the server answers busy, so the reader
                        would get a failure sentence instead of a disabled
                        control. The trigger above is gated the same way. */}
                    <Button className={css.stAction}
                      tone="danger"
                      disabled={picked.size === 0 || removing || runningThisBundle}
                      loading={removing}
                      onClick={() => {
                        setRemoving(true)
                        uninstall(card.id, [...picked]).then(
                          (report) => {
                            setRemoving(false)
                            // Same rule as the per-member install: a partly
                            // failed removal resolves. Without this the
                            // preview kept listing removed members and rows
                            // kept offering the old action.
                            if (report.failed.length > 0) {
                              setChoiceError(report.failed.map((entry) => entry.reason).join('; '))
                            } else {
                              setProfileEpoch((epoch) => epoch + 1)
                            }
                          },
                          (error: unknown) => { setRemoving(false); setChoiceError(reasonOf(error)) },
                        )
                      }}
                    >
                      {fill('uninstallConfirm', locale, { count: picked.size })}
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {choiceError === undefined ? null : (
            <span className={[css.sideText, css.dangerText].join(' ')}>
              {fill('errorUninstall', locale, { reason: choiceError })}
            </span>
          )}
        </footer>
      </div>
    </div>
  )
}

/** The sentence that explains why a member is or is not pre-checked (§7.7). */
function uninstallReasonCopy(choice: UninstallChoice, locale: Locale): string {
  switch (choice.reason) {
    case 'only-source':
      return copy('uninstallOnlySource', locale)
    case 'manual':
      return copy('uninstallManual', locale)
    case 'shared':
      return choice.sharedWith === undefined || choice.sharedWith.length === 0
        ? copy('uninstallShared', locale)
        : fill('uninstallSharedWarn', locale, { others: choice.sharedWith.join(', ') })
    default:
      return copy('uninstallUnknown', locale)
  }
}

/**
 * A version range squeezed into something a member row can hold.
 *
 * The real ranges are long (`>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`),
 * and the row is 12px tall with three other facts in it. The tooltip carries
 * the whole string; this shows the lower bound, which is the half a reader
 * actually needs to answer "can my dsh run this?".
 */
function shortRange(range: string): string {
  const first = range.split(/\s*\|\|\s*/u)[0]?.trim() ?? range
  return first.length > 24 ? `${first.slice(0, 22)}…` : first
}

/**
 * The detail document, rendered from the reduced markdown.
 *
 * Not a markdown library: `markdownBlocks` supports the handful of nodes a
 * package README actually uses, strips HTML, and refuses every link that is
 * not `https:`. A community-authored document is untrusted input in the
 * host's own window, and the cheapest way to keep that true is to render
 * only the nodes this file knows how to draw.
 */
function Readme({ document, locale }: { document: BundleDetail; locale: Locale }): ReactNode {
  const blocks = markdownBlocks(text(document.readme, locale))
  if (blocks.length === 0) return <p className={css.sideText}>{copy('readmeEmpty', locale)}</p>
  return (
    <div>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  )
}

/** One reduced markdown block. */
function Block({ block }: { block: MarkdownBlock }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const size = block.level <= 1 ? css.readmeH1 : block.level === 2 ? css.readmeH2 : css.readmeH3
      const Tag = (block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4'
      return <Tag className={size}>{runs(block.inline)}</Tag>
    }
    case 'list':
      return (
        <ul className={css.readmeBullets}>
          {block.items.map((item, index) => <li key={index}>{runs(item)}</li>)}
        </ul>
      )
    case 'code':
      return (
        <pre className={css.readmeFence}>
          <code className={css.readmeCode}>{block.text}</code>
        </pre>
      )
    case 'quote':
      return <blockquote className={css.readmeQuote}>{runs(block.inline)}</blockquote>
    default:
      return <p className={css.readmeP}>{runs(block.inline)}</p>
  }
}

/** Inline runs: text, bold, code, and https links as real anchors. */
function runs(inline: readonly InlineRun[]): ReactNode {
  return inline.map((run, index) => {
    switch (run.kind) {
      case 'strong':
        return <strong key={index}>{run.text}</strong>
      case 'code':
        return <code key={index} className={css.readmeCode}>{run.text}</code>
      case 'link':
        return (
          <a
            key={index}
            className={css.readmeLink}
            href={run.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {run.text}
          </a>
        )
      default:
        return <span key={index}>{run.text}</span>
    }
  })
}

/** The message of anything thrown, for a sentence that names the reason. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The one sentence a member row shows, and whose sentence it is.
 *
 * The bundle author's `reason` WINS over the package's own registry
 * `description`, because a member row answers "why is this plugin part of this
 * bundle" — a question only the bundle author can answer. A registry sentence
 * describes the package in general and was written for nobody's bundle in
 * particular, so it is the fallback for rows the author left without a reason.
 *
 * `fromAuthor` exists because the sheet labels the author's sentence ("推荐理由
 * / why it is here") and must not label a registry description as one.
 *
 * @param reason - the author's sentence, already resolved for the locale.
 * @param description - the package's own sentence, already resolved.
 * @returns the text to draw, and whether the author wrote it.
 */
export function memberBlurb(
  reason: string,
  description: string,
): { text: string; fromAuthor: boolean } {
  if (reason !== '') return { text: reason, fromAuthor: true }
  return { text: description, fromAuthor: false }
}

/** 35300 -> 35.3k, so a five-digit count does not widen the row. */
function formatStars(count: number): string {
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}k`
}

