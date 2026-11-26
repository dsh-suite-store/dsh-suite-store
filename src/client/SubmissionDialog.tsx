/**
 * The in-store suite submission flow.
 *
 * The form produces only the catalog's minimum template. Member selection is
 * restricted to the curated index by the server, so this component never has
 * to make a membership decision of its own.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { LocalizedText } from '../catalog/types.ts'
import type { CuratedMember } from '../submission/curated.ts'
import {
  SUBMISSION_MAX_MEMBERS,
  SUBMISSION_SUMMARY_MAX,
  submissionFilename,
  submissionYaml,
  validateDraft,
  type DraftIssue,
  type DraftIssueCode,
  type SubmissionDraft,
} from '../submission/model.ts'
import { primaryLabel } from './Card.tsx'
import { memberDescription, memberDisplayName, memberSource } from './submission-members.ts'
import { fill, t as copy, type CopyKey, type Locale } from './copy.ts'
import { wrapTab } from './modal-focus.ts'
import { Button, Input, Tag } from './ui.tsx'
import css from './Store.module.css'

const CONTRIBUTING_URL = 'https://github.com/dsh-suite-store/dsh-suite-store-catalog/blob/main/CONTRIBUTING.md'

/** Props of the submission dialog. */
export interface SubmissionDialogProps {
  locale: Locale
  /** Primary category id → secondary ids, straight from the loaded catalog. */
  categories: Record<string, string[]>
  categoryLabels?: Record<string, LocalizedText>
  /** Installed plugins that matched the curated index. */
  loadInstalled: () => Promise<CuratedMember[]>
  /** Search the curated index. */
  search: (query: string) => Promise<CuratedMember[]>
  onClose: () => void
}

const ERROR_COPY: Record<DraftIssueCode, CopyKey> = {
  required: 'submitErrorRequired',
  'invalid-owner': 'submitErrorOwner',
  'invalid-id': 'submitErrorId',
  'invalid-version': 'submitErrorVersion',
  'text-too-long': 'submitErrorTitleLong',
  'summary-too-long': 'submitErrorSummaryLong',
  'invalid-category': 'submitErrorCategory',
  'member-count': 'submitErrorMemberCount',
  'invalid-member': 'submitErrorInvalidMember',
  'duplicate-member': 'submitErrorDuplicateMember',
}

const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/yaml;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(href)
}

function MemberRow(props: {
  member: CuratedMember
  locale: Locale
  selected: boolean
  disabled: boolean
  installed: boolean
  onToggle: () => void
}): ReactNode {
  const { member, locale, selected, disabled, installed, onToggle } = props
  const description = memberDescription(member, locale)
  return (
    <button
      type="button"
      className={[css.memberResult, selected ? css.memberResultSelected : ''].filter(Boolean).join(' ')}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className={css.memberCheck} aria-hidden>{selected ? '✓' : ''}</span>
      <span className={css.memberResultText}>
        <span className={css.memberTitleRow}>
          <span className={css.memberTitle}>{memberDisplayName(member)}</span>
          <Tag tone="outline" className={css.memberCoordinateTag}>{member.key}</Tag>
        </span>
        <span className={css.memberMeta}>{description === '' ? copy('submitNoDescription', locale) : description}</span>
      </span>
      <span className={[css.memberSource, installed ? css.memberSourceInstalled : ''].filter(Boolean).join(' ')}>
        {copy(installed ? 'submitInstalledBadge' : 'submitCuratedBadge', locale)}
      </span>
    </button>
  )
}

/**
 * The submission sheet.
 *
 * No DOM test renderer exists in this project, so the rules that matter live in
 * `submission/model.ts` and the route/service tests. This component owns the
 * form interaction and the download gesture.
 */
export function SubmissionDialog(props: SubmissionDialogProps): ReactNode {
  const { locale, categories, categoryLabels, loadInstalled, search, onClose } = props
  const categoryIds = useMemo(() => Object.keys(categories), [categories])
  const [draft, setDraft] = useState<SubmissionDraft>({
    owner: '',
    id: '',
    version: '1.0.0',
    title: { en: '', zh: '' },
    summary: { en: '', zh: '' },
    category: '',
    members: [],
  })
  const [selected, setSelected] = useState<CuratedMember[]>([])
  const [installed, setInstalled] = useState<CuratedMember[] | undefined>(undefined)
  const [installedError, setInstalledError] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CuratedMember[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | undefined>(undefined)
  const [attempted, setAttempted] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)

  const selectedKeys = useMemo(() => new Set(selected.map((member) => member.key)), [selected])
  const installedKeys = useMemo(() => new Set((installed ?? []).map((member) => member.key)), [installed])
  const queryActive = query.trim() !== ''
  const fullDraft = useMemo<SubmissionDraft>(
    () => ({ ...draft, members: selected.map((member) => member.key) }),
    [draft, selected],
  )
  const issues = useMemo(() => validateDraft(fullDraft, categoryIds), [fullDraft, categoryIds])

  useEffect(() => {
    let live = true
    loadInstalled().then(
      (members) => { if (live) setInstalled(members) },
      (error: unknown) => { if (live) setInstalledError(reasonOf(error)) },
    )
    return () => { live = false }
  }, [loadInstalled])

  useEffect(() => {
    const term = query.trim()
    if (term === '') {
      setResults([])
      setSearching(false)
      setSearchError(undefined)
      return undefined
    }
    let live = true
    setSearching(true)
    setSearchError(undefined)
    const timer = setTimeout(() => {
      search(term).then(
        (members) => {
          if (!live) return
          setResults(members)
          setSearching(false)
        },
        (error: unknown) => {
          if (!live) return
          setSearchError(reasonOf(error))
          setSearching(false)
        },
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, search])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const sheet = sheetRef.current
      if (sheet === null) return
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

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    sheetRef.current?.focus()
    return () => {
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [])

  const setText = (field: 'owner' | 'id' | 'version', value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const setLocalized = (
    field: 'title' | 'summary',
    language: 'en' | 'zh',
    value: string,
  ): void => {
    setDraft((current) => ({
      ...current,
      [field]: { ...current[field], [language]: value },
    }))
  }

  const toggleMember = (member: CuratedMember): void => {
    if (selectedKeys.has(member.key)) {
      setSelected((current) => current.filter((item) => item.key !== member.key))
      return
    }
    if (selected.length >= SUBMISSION_MAX_MEMBERS) return
    setSelected((current) => [...current, member])
  }

  const removeMember = (key: string): void => {
    setSelected((current) => current.filter((member) => member.key !== key))
  }

  const errorsFor = (field: DraftIssue['field']): DraftIssue[] =>
    attempted ? issues.filter((issue) => issue.field === field) : []

  const renderErrors = (field: DraftIssue['field']): ReactNode => {
    const rows = errorsFor(field)
    if (rows.length === 0) return null
    return (
      <div className={css.fieldError} role="alert">
        {[...new Set(rows.map((issue) => copy(ERROR_COPY[issue.code], locale)))].join(' · ')}
      </div>
    )
  }

  const generate = (): void => {
    if (issues.length > 0) {
      setAttempted(true)
      return
    }
    downloadText(submissionFilename(fullDraft), submissionYaml(fullDraft))
  }

  const candidates = queryActive ? results : installed ?? []
  const loading = queryActive ? searching : installed === undefined && installedError === undefined
  const candidateError = queryActive ? searchError : installedError

  return (
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={copy('submitTitle', locale)}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className={[css.dialog, css.submissionDialog].join(' ')} ref={sheetRef} tabIndex={-1}>
        <header className={css.dialogHead}>
          <div className={css.grow}>
            <h2 className={css.dialogTitle}>{copy('submitTitle', locale)}</h2>
            <p className={css.sub}>{copy('submitIntro', locale)}</p>
          </div>
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

        <div className={[css.dialogBody, css.submissionBody].join(' ')}>
          <section className={css.submissionSection}>
            <h3 className={css.submissionSectionTitle}>{copy('submitBasics', locale)}</h3>
            <div className={css.submissionGrid}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{copy('submitOwner', locale)}</span>
                <Input value={draft.owner} onChange={(value) => setText('owner', value)} label={copy('submitOwner', locale)} />
                <span className={css.fieldHint}>{copy('submitOwnerHint', locale)}</span>
                {renderErrors('owner')}
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{copy('submitId', locale)}</span>
                <Input value={draft.id} onChange={(value) => setText('id', value)} label={copy('submitId', locale)} />
                <span className={css.fieldHint}>{copy('submitIdHint', locale)}</span>
                {renderErrors('id')}
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{copy('submitVersion', locale)}</span>
                <Input value={draft.version} onChange={(value) => setText('version', value)} label={copy('submitVersion', locale)} />
                <span className={css.fieldHint}>{copy('submitVersionHint', locale)}</span>
                {renderErrors('version')}
              </label>
            </div>

            <div className={css.submissionGridTwo}>
              <div className={css.fieldGroup}>
                <span className={css.fieldLabel}>{copy('submitTitleField', locale)}</span>
                <label className={css.field}>
                  <span className={css.fieldHint}>{copy('submitTitleEn', locale)}</span>
                  <Input value={draft.title.en} onChange={(value) => setLocalized('title', 'en', value)} label={copy('submitTitleEn', locale)} />
                  {renderErrors('title.en')}
                </label>
                <label className={css.field}>
                  <span className={css.fieldHint}>{copy('submitTitleZh', locale)}</span>
                  <Input value={draft.title.zh} onChange={(value) => setLocalized('title', 'zh', value)} label={copy('submitTitleZh', locale)} />
                  {renderErrors('title.zh')}
                </label>
              </div>

              <div className={css.fieldGroup}>
                <div className={css.fieldLabelRow}>
                  <span className={css.fieldLabel}>{copy('submitSummaryField', locale)}</span>
                  <span className={css.fieldHint}>{fill('submitSummaryCount', locale, { count: [...draft.summary.en.trim()].length })}</span>
                </div>
                <label className={css.field}>
                  <span className={css.fieldHint}>{copy('submitSummaryEn', locale)}</span>
                  <Input value={draft.summary.en} onChange={(value) => setLocalized('summary', 'en', value)} label={copy('submitSummaryEn', locale)} />
                  {renderErrors('summary.en')}
                </label>
                <div className={css.fieldLabelRow}>
                  <span className={css.fieldHint}>{copy('submitSummaryZh', locale)}</span>
                  <span className={css.fieldHint}>{[...draft.summary.zh.trim()].length}/{SUBMISSION_SUMMARY_MAX}</span>
                </div>
                <Input value={draft.summary.zh} onChange={(value) => setLocalized('summary', 'zh', value)} label={copy('submitSummaryZh', locale)} />
                {renderErrors('summary.zh')}
              </div>
            </div>

            <label className={css.field}>
              <span className={css.fieldLabel}>{copy('submitCategory', locale)}</span>
              <select
                className={css.submissionSelect}
                value={draft.category}
                disabled={categoryIds.length === 0}
                aria-label={copy('submitCategory', locale)}
                onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
              >
                <option value="">{categoryIds.length === 0 ? copy('submitCatalogLoading', locale) : copy('submitCategoryPlaceholder', locale)}</option>
                {categoryIds.map((id) => (
                  <option key={id} value={id}>{primaryLabel(id, locale, categoryLabels)}</option>
                ))}
              </select>
              {renderErrors('category')}
            </label>
          </section>

          <section className={css.submissionSection}>
            <div className={css.fieldLabelRow}>
              <div>
                <h3 className={css.submissionSectionTitle}>{copy('submitMembers', locale)}</h3>
                <p className={css.fieldHint}>{copy('submitMembersHint', locale)}</p>
              </div>
              <span className={css.memberCount}>{fill('submitMembersCount', locale, { count: selected.length, max: SUBMISSION_MAX_MEMBERS })}</span>
            </div>

            <div className={css.selectedMembers} aria-live="polite">
              {selected.length === 0 ? (
                <span className={css.fieldHint}>{copy('submitSelectedEmpty', locale)}</span>
              ) : selected.map((member) => (
                <div className={css.selectedMember} key={member.key}>
                  <code className={css.memberKey}>{member.key}</code>
                  <button
                    type="button"
                    className={css.selectedRemove}
                    onClick={() => removeMember(member.key)}
                    aria-label={`${copy('submitRemove', locale)} ${member.key}`}
                    title={copy('submitRemove', locale)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {renderErrors('members')}

            <div className={css.memberPicker}>
              <Input
                value={query}
                onChange={setQuery}
                label={copy('submitSearchPlaceholder', locale)}
                placeholder={copy('submitSearchPlaceholder', locale)}
                className={css.memberSearch}
              />
              <div className={css.memberPickerMeta} aria-live="polite">
                <span>
                  {queryActive && !loading
                    ? fill('submitResultCount', locale, { count: candidates.length })
                    : copy(queryActive ? 'submitSearchTab' : 'submitInstalledTab', locale)}
                </span>
                <span className={css.fieldHint}>{copy('submitSearchHint', locale)}</span>
              </div>

              <div className={css.memberResults}>
                {loading ? (
                  <p className={css.fieldHint}>{copy(queryActive ? 'submitSearchLoading' : 'submitInstalledLoading', locale)}</p>
                ) : candidateError !== undefined ? (
                  <p className={css.fieldError} role="alert">
                    {fill(queryActive ? 'submitSearchError' : 'submitInstalledError', locale, { reason: candidateError })}
                  </p>
                ) : candidates.length === 0 ? (
                  <p className={css.fieldHint}>{copy(queryActive ? 'submitSearchEmpty' : 'submitInstalledEmpty', locale)}</p>
                ) : candidates.map((member) => (
                  <MemberRow
                    key={member.key}
                    member={member}
                    locale={locale}
                    selected={selectedKeys.has(member.key)}
                    disabled={selected.length >= SUBMISSION_MAX_MEMBERS && !selectedKeys.has(member.key)}
                    installed={installedKeys.has(member.key)}
                    onToggle={() => toggleMember(member)}
                  />
                ))}
              </div>
            </div>
          </section>

          <div className={css.submissionGuide}>
            <span>{copy('submitGuideHint', locale)}</span>
            <a className={css.submissionGuideLink} href={CONTRIBUTING_URL} target="_blank" rel="noreferrer noopener">
              {copy('submitGuide', locale)}
            </a>
          </div>
        </div>

        <footer className={css.dialogFoot}>
          <div className={css.footBar}>
            <span className={css.fieldHint}>
              {fill('submitPathHint', locale, {
                owner: draft.owner.trim() || '<owner>',
                id: draft.id.trim() || '<suite_id>',
                version: draft.version.trim() || '<version>',
              })}
            </span>
            <Button tone="primary" onClick={generate} className={css.generateButton}>
              {copy('submitDownload', locale)}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}