/**
 * The operation panel: one run, its members, and the one control that matters
 * while it runs (§7.5, §7.7, §8.5).
 *
 * The panel reads the operation record and derives every number from it, so
 * it cannot disagree with the card buttons or the server's report: the record
 * is the only store of per-member truth, and `progressOf` is the only rule
 * that turns it into counts.
 *
 * Installs and removals share this panel on purpose. Everything drawn here —
 * the ordered member list, one row per member, the final tally — is the same
 * for both, and §7.7 asks a removal for the same report an install gives. Only
 * the verbs differ, which is why `kind` switches the title and the completion
 * sentence and nothing else.
 *
 * Three sentences carry the whole §7.5 contract and are worth spelling out
 * here because each of them was a design decision rather than a phrasing:
 *
 * - **Stop is delayed, and says so.** The executor stops after the member it
 *   is on, because a half-installed member is the one state §7.3's rollback
 *   exists to avoid. A user who expects an instant stop will click twice, so
 *   the hint sits under the button, not in a tooltip.
 * - **A failed member does not end the run.** The panel reports the members
 *   that failed and keeps painting the ones after them, which is what §7.4's
 *   "failed member, continue with the next" looks like from here.
 * - **A too-late timeout is not a failure.** It says the install may have
 *   finished, because telling the user to reinstall something already on disk
 *   is how a working install gets removed.
 */

import type { ReactNode } from 'react'

import type { MemberRecord, OperationRecord } from '../install/operation.ts'
import { progressOf } from './store-data.ts'
import { fill, t as copy } from './copy.ts'
import type { Locale } from './copy.ts'
import { Button, Icon } from './ui.tsx'
import css from './Store.module.css'

/** Props of the progress panel. */
export interface ProgressPanelProps {
  /** The operation to render, live or finished. */
  operation: OperationRecord
  locale: Locale
  onCancel: () => void
  /** Whether the host's cancel is meaningful; a desktop host's is not. */
  cancelable: boolean
  /** Retry the members that did not finish (§7.5 "continue"). */
  onResume?: () => void
  /**
   * Dismiss a finished run.
   *
   * A finished panel is history: it keeps saying "卸载完成 5/5" over a store
   * whose cards have already caught up. The PAGE retires it after six seconds
   * when every member landed (`StorePage`'s `finishedCleanly`), and keeps it
   * when a member failed or needs a restart — a result the reader has to be
   * able to act on. `onDismiss` is the close control for both cases, and what
   * turns the banner back into an ordinary page.
   */
  onDismiss?: () => void
}

/**
 * One operation, as a card at the top of the page.
 *
 * @param props - see {@link ProgressPanelProps}.
 * @returns the panel.
 */
export function ProgressPanel({ operation, locale, onCancel, cancelable, onResume, onDismiss }: ProgressPanelProps): ReactNode {
  const counts = progressOf(operation)
  const live = isLive(operation.status)
  const percent = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100)
  // A removal cannot be cancelled (the host's `removeBundle` is one call with
  // no cancellation channel), so the button and its hint are install-only.
  const stoppable = live && cancelable && operation.kind !== 'uninstall'

  return (
    <section className={css.progressCard} aria-live="polite">
      <div className={css.progressTop}>
        <span className={css.progressTitle}>
          {live && operation.status !== 'restarting' && operation.status !== 'verifying'
            ? titleOf(operation, locale)
            : phaseWord(operation, counts, locale)}
        </span>
        <span className={css.meta}>{fill('progressCount', locale, { done: counts.done, total: counts.total })}</span>
        {stoppable ? <Button tone="ghost" onClick={onCancel}>{copy('progressCancel', locale)}</Button> : null}
        {!live && operation.status === 'partial' && onResume !== undefined && operation.kind !== 'uninstall' ? (
          <Button tone="secondary" onClick={onResume}>{copy('progressResume', locale)}</Button>
        ) : null}
        {!live && onDismiss !== undefined ? (
          <Button tone="ghost" onClick={onDismiss}>{copy('progressDismiss', locale)}</Button>
        ) : null}
      </div>

      {/* ARIA requires max > min and now inside the range, so an empty
          operation is clamped rather than announced as `0..0` (invalid). The
          bar also needs a NAME: it had none, so a screen reader reported an
          anonymous progressbar. */}
      <div
        className={css.bar}
        role="progressbar"
        aria-label={copy('progressBarLabel', locale)}
        aria-valuemin={0}
        aria-valuemax={counts.total === 0 ? 1 : counts.total}
        aria-valuenow={counts.total === 0 ? 0 : counts.done}
      >
        <div className={css.barFill} style={{ width: `${percent}%` }} />
      </div>

      {stoppable ? <div className={css.meta}>{copy('progressCancelHint', locale)}</div> : null}

      {/* `phaseWord` renders the panel's TITLE, and for every non-live status
          (`partial`, `blocked`, `done`, `cancelled`) it already produces the
          sentence this block used to repeat — so the same words appeared twice
          and the `aria-live` region announced them twice. The title keeps them;
          the body has nothing left to say. */}

      <div className={css.memberList}>
        {operation.members.map((member) => (
          <MemberLine key={member.key} member={member} locale={locale} />
        ))}
      </div>
    </section>
  )
}

/** One member's row: a mark, its key, and why it did not land. */
function MemberLine({ member, locale }: { member: MemberRecord; locale: Locale }): ReactNode {
  const { glyph, className, word } = stateGlyph(member, locale)
  // Computed once: this runs a localization lookup and a string build per row,
  // and it used to run twice (title and text) for every failed member on every
  // render of a live panel.
  const failure = member.failure === undefined ? '' : failureSentence(member, locale)
  return (
    <div className={css.memberRow}>
      <span className={[css.memberState, className].filter(Boolean).join(' ')} title={word}>{glyph}</span>
      <span className={css.memberKey}>{member.name === '' ? member.key : member.name}</span>
      {failure === '' ? null : <span className={css.stateFail} title={failure}>{failure}</span>}
    </div>
  )
}

/** A glyph, a colour class and a word for one member's state. */
function stateGlyph(member: MemberRecord, locale: Locale): { glyph: ReactNode; className: string; word: string } {
  switch (member.state) {
    case 'ok':
      return { glyph: <Icon name="check" size={11} />, className: css.stateOk, word: copy('stateOk', locale) }
    case 'needs-restart':
      // Done, not failed: the plugin is disabled and the next start will not
      // load it. The glyph is a check because nothing is left to repair.
      return { glyph: <Icon name="check" size={11} />, className: css.stateOk, word: copy('stateNeedsRestart', locale) }
    case 'failed':
      return { glyph: <Icon name="warning" size={11} />, className: css.stateFail, word: copy('stateFailed', locale) }
    case 'running':
      return { glyph: <Icon name="loading" size={11} />, className: css.stateRun, word: copy('stateRunning', locale) }
    case 'skipped':
      return { glyph: '–', className: css.stateSkip, word: copy('stateSkipped', locale) }
    case 'skipped-build-denied':
      return { glyph: '–', className: css.stateSkip, word: copy('stateBuildDenied', locale) }
    default:
      return { glyph: '·', className: css.stateSkip, word: copy('statePending', locale) }
  }
}

/**
 * What to say about why a member did not install (§7.4).
 *
 * The failure type picks the sentence; the drift, when present, is appended
 * rather than replacing it — both facts are true and the second is the one
 * that sends someone to the catalog's bug tracker.
 *
 * @param member - the member that failed.
 * @param locale - which language.
 * @returns one sentence, already filled in.
 */
export function failureSentence(member: MemberRecord, locale: Locale): string {
  const failure = member.failure
  if (failure === undefined) return ''
  const reason = failure.reason
  // A cause the client has wording for is said in the reader's language, with
  // the server's sentence kept as the detail after it: the sentence names the
  // package and the ranges, which no tag can carry.
  const translated = causeCopy(failure.cause, locale)
  const base = (() => {
    switch (failure.type) {
      // One helper for both cause-prefixing branches: the two spellings could
      // (and did) drift, and the split template literal was easy to leave
      // with unbalanced parentheses.
      case 'load-failed': return fill('failLoad', locale, { reason: withCause(translated, reason) })
      case 'verify-failed': return fill('failVerify', locale, { reason })
      case 'build-denied': return copy('failBuild', locale)
      case 'timeout-too-late': return copy('failTooLate', locale)
      case 'remove-failed': return member.state === 'needs-restart'
        // The removal is done bar the restart, so the sentence is the ACTION,
        // not the host's refusal — telling the reader why a done thing
        // happened leaves them looking for a problem to fix.
        ? copy('failRemoveNeedsRestart', locale)
        : fill('failRemove', locale, { reason })
      default: return fill('failInstall', locale, { reason: withCause(translated, reason) })
    }
  })()
  if (failure.versionDrift === undefined) return base
  const drift = fill('failDrift', locale, {
    requested: failure.versionDrift.requested,
    resolved: failure.versionDrift.resolved,
  })
  return `${base} — ${drift}`
}

/**
 * The host's sentence, prefixed by the cause's localized name when there is one.
 *
 * The full-width parentheses are the page's existing style in BOTH languages
 * (the default branch already shipped them to English readers), so changing
 * them would be a copy decision, not a de-duplication.
 */
function withCause(translated: string | undefined, reason: string): string {
  return translated === undefined ? reason : `${translated}（${reason}）`
}

/**
 * The localized sentence for a failure cause, when there is one.
 *
 * `unknown` deliberately has no wording: it means the tag does not identify
 * the situation, and printing a vague "something went wrong" in front of the
 * host's specific sentence would be worse than printing the sentence alone.
 */
function causeCopy(cause: string | undefined, locale: Locale): string | undefined {
  switch (cause) {
    case 'incompatible-version': return copy('causeIncompatibleVersion', locale)
    case 'incompatible-api': return copy('causeIncompatibleApi', locale)
    case 'git-prepare-refused': return copy('causeGitPrepareRefused', locale)
    case 'package-manager': return copy('causePackageManager', locale)
    case 'bundle-in-use': return copy('causeBundleInUse', locale)
    case 'not-removable': return copy('causeNotRemovable', locale)
    case 'stale-approval': return copy('causeStaleApproval', locale)
    case 'stop-profile': return copy('causeStopProfile', locale)
    case 'management-required': return copy('causeManagementRequired', locale)
    case 'ambiguous-install': return copy('causeAmbiguousInstall', locale)
    default: return undefined
  }
}

/** The panel's title while the run is still working through its members. */
function titleOf(operation: OperationRecord, locale: Locale): string {
  return operation.kind === 'uninstall'
    ? fill('progressRemoveTitle', locale, { id: operation.bundleId })
    : fill('progressTitle', locale, { id: operation.bundleId })
}

/**
 * What the panel's title says once the run is past its member loop.
 *
 * The partial sentence keeps its number. Stripping `{failed}` out of it left
 * the title reading "个成员未安装" — a sentence with the count missing, which
 * is the one fact the title exists to carry.
 */
function phaseWord(operation: OperationRecord, counts: { failed: number }, locale: Locale): string {
  switch (operation.status) {
    case 'restarting': return copy('progressRestarting', locale)
    case 'verifying': return copy('progressVerifying', locale)
    case 'done':
      return operation.kind === 'uninstall'
        ? copy('progressRemoveDone', locale)
        : copy('progressDone', locale)
    case 'partial':
      return fill(
        operation.kind === 'uninstall' ? 'progressRemovePartial' : 'progressPartial',
        locale,
        { failed: counts.failed },
      )
    case 'cancelled': return copy('progressCancelled', locale)
    case 'blocked':
      // A dedicated no-reason sentence. Stripping `{reason}` out of the other
      // one left the dangling colon of "未执行：" / "Not started: ", and it
      // silently depended on the exact placeholder token — a copy edit would
      // have leaked a literal `{reason}` into the title.
      return operation.reason === undefined
        ? copy('progressBlockedNoReason', locale)
        : fill('progressBlocked', locale, { reason: operation.reason })
    default: return titleOf(operation, locale)
  }
}

/** Whether a status still means "running". */
function isLive(status: OperationRecord['status']): boolean {
  return status === 'queued' || status === 'preflight' || status === 'installing'
    || status === 'restarting' || status === 'verifying'
}
