/**
 * A React error boundary for the store panel.
 *
 * A render thrown anywhere under the panel unmounts the whole tree and leaves
 * the host's main column blank with no way back — the exact failure a user
 * hit after clicking uninstall. The host owns the surrounding shell, so the
 * boundary belongs at this panel's root: it can show the error and offer a
 * remount without taking the rest of the app down.
 *
 * Class component because React exposes `getDerivedStateFromError` /
 * `componentDidCatch` only on classes.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

import { t } from './copy.ts'
import type { Locale } from './copy.ts'
import { exportMarketLog, recordCrash } from './self-check.ts'
import { api } from './store-data.ts'
import css from './Store.module.css'

interface Props {
  locale: Locale
  children?: ReactNode
}

interface State {
  /**
   * The thrown value, or `undefined` for "nothing failed".
   *
   * Deliberately NOT the sentinel for a failure: React passes whatever the child
   * threw, and that can be `undefined` itself (`throw undefined`) or any
   * non-Error (`throw null`, `throw 'nope'`). Using `undefined` to mean "no
   * error" meant `throw undefined` re-rendered the children as if the render
   * had succeeded, and `throw null` got past the check and crashed on
   * `.message` — taking down the very tree this boundary exists to protect.
   */
  error: { value: unknown } | undefined
}

export class StoreErrorBoundary extends Component<Props, State> {
  state: State = { error: undefined }

  // `error` is typed `unknown` because that is the React contract: the value is
  // whatever the child threw. Wrapping it in an object keeps a thrown
  // `undefined` distinguishable from "nothing failed".
  static getDerivedStateFromError(error: unknown): State {
    return { error: { value: error } }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The desktop host has no console a user can read; keep the detail in the
    // page and the (best-effort) console for whoever does have one.
    console.error('[dsh-suite-store] render failed', error, info.componentStack)
    // Recorded for the exported log. A crash the reader has already dismissed
    // is still the most useful line in their report, and the export button
    // below only exists because a crashed panel used to lose it entirely.
    recordCrash(detailOf(error), info.componentStack ?? null, new Date().toISOString())
  }

  private remount = (): void => {
    this.setState({ error: undefined })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === undefined) return this.props.children
    return (
      <div className={css.errorBoundary} role="alert">
        <h2 className={css.errorBoundaryTitle}>{t('errorBoundaryTitle', this.props.locale)}</h2>
        <p className={css.errorBoundaryText}>{t('errorBoundaryText', this.props.locale)}</p>
        <pre className={css.errorBoundaryDetail}>{detailOf(error.value)}</pre>
        <div className={css.errorBoundaryActions}>
          <button type="button" className={css.errorBoundaryButton} onClick={this.remount}>
            {t('errorBoundaryRetry', this.props.locale)}
          </button>
          {/* A crashed panel is exactly when the log matters, and it is exactly
              when the page header's export button is no longer on screen. */}
          <button
            type="button"
            className={css.errorBoundaryButton}
            onClick={() => {
              // Best effort: the panel is already the failure path, so a failed
              // export has nowhere better to report than the console.
              exportMarketLog(api('/dsh-suite-store/api/logs')).catch((why: unknown) => {
                console.error('[dsh-suite-store] log export failed', why)
              })
            }}
          >
            {t('errorBoundaryExportLog', this.props.locale)}
          </button>
        </div>
      </div>
    )
  }
}

/**
 * One line of detail for whatever was thrown.
 *
 * An `Error` is the common case; anything else is serialized so the reader
 * still gets a fact (`throw 'boom'` used to render an empty block).
 */
function detailOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message === '' ? thrown.name : thrown.message
  if (typeof thrown === 'string') return thrown
  if (typeof thrown === 'object' && thrown !== null) {
    try {
      return JSON.stringify(thrown)
    } catch {
      // A cyclic or otherwise unserializable value: fall through.
    }
  }
  return String(thrown)
}
