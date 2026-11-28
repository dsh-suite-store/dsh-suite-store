/**
 * Pure submission rules shared by the dialog and its tests.
 *
 * This module intentionally mirrors the catalog's admission rules instead of
 * importing the catalog repository. The plugin ships independently, so the
 * generated file must be valid even when the catalog checkout is not present.
 */

/** Member rules currently enforced by dsh-suite-store-catalog. */
export const SUBMISSION_MIN_MEMBERS = 2
export const SUBMISSION_MAX_MEMBERS = 10
export const SUBMISSION_LOCALIZED_TEXT_MAX = 100

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/u
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u
const MEMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:#[A-Za-z0-9._/-]+)?$/u

/** Editable form state for one catalog submission. */
export interface SubmissionDraft {
  owner: string
  id: string
  version: string
  title: { en: string; zh: string }
  summary: { en: string; zh: string }
  category: string
  members: string[]
}

/** A field-level problem, kept as data so the UI can localize it. */
export type DraftIssueCode =
  | 'required'
  | 'invalid-owner'
  | 'invalid-id'
  | 'invalid-version'
  | 'text-too-long'
  | 'invalid-category'
  | 'member-count'
  | 'invalid-member'
  | 'duplicate-member'

export interface DraftIssue {
  field:
    | 'owner'
    | 'id'
    | 'version'
    | 'title.en'
    | 'title.zh'
    | 'summary.en'
    | 'summary.zh'
    | 'category'
    | 'members'
  code: DraftIssueCode
}

const trim = (value: string): string => value.trim()

/**
 * Validate the minimum catalog submission.
 *
 * @param draft - the current form state.
 * @param categories - primary category slugs the catalog currently accepts.
 * @returns every problem, in a stable field order.
 */
export function validateDraft(draft: SubmissionDraft, categories: readonly string[]): DraftIssue[] {
  const issues: DraftIssue[] = []
  const owner = trim(draft.owner)
  if (owner === '') issues.push({ field: 'owner', code: 'required' })
  else if (!OWNER_PATTERN.test(owner)) issues.push({ field: 'owner', code: 'invalid-owner' })

  const id = trim(draft.id)
  if (id === '') issues.push({ field: 'id', code: 'required' })
  else if (!ID_PATTERN.test(id)) issues.push({ field: 'id', code: 'invalid-id' })

  const version = trim(draft.version)
  if (version === '') issues.push({ field: 'version', code: 'required' })
  else if (!VERSION_PATTERN.test(version)) issues.push({ field: 'version', code: 'invalid-version' })

  if (trim(draft.title.en) === '') issues.push({ field: 'title.en', code: 'required' })
  else if ([...trim(draft.title.en)].length > SUBMISSION_LOCALIZED_TEXT_MAX) {
    issues.push({ field: 'title.en', code: 'text-too-long' })
  }
  if (trim(draft.title.zh) !== '' && [...trim(draft.title.zh)].length > SUBMISSION_LOCALIZED_TEXT_MAX) {
    issues.push({ field: 'title.zh', code: 'text-too-long' })
  }

  if (trim(draft.summary.en) === '') issues.push({ field: 'summary.en', code: 'required' })
  else if ([...trim(draft.summary.en)].length > SUBMISSION_LOCALIZED_TEXT_MAX) {
    issues.push({ field: 'summary.en', code: 'text-too-long' })
  }
  if (trim(draft.summary.zh) !== '' && [...trim(draft.summary.zh)].length > SUBMISSION_LOCALIZED_TEXT_MAX) {
    issues.push({ field: 'summary.zh', code: 'text-too-long' })
  }

  const category = trim(draft.category)
  if (category === '') issues.push({ field: 'category', code: 'required' })
  else if (!categories.includes(category)) issues.push({ field: 'category', code: 'invalid-category' })

  const members = draft.members.map(trim).filter((member) => member !== '')
  if (members.length < SUBMISSION_MIN_MEMBERS || members.length > SUBMISSION_MAX_MEMBERS) {
    issues.push({ field: 'members', code: 'member-count' })
  }
  if (members.some((member) => !MEMBER_PATTERN.test(member))) {
    issues.push({ field: 'members', code: 'invalid-member' })
  }
  const seen = new Set<string>()
  for (const member of members) {
    const key = member.toLowerCase()
    if (seen.has(key)) {
      issues.push({ field: 'members', code: 'duplicate-member' })
      break
    }
    seen.add(key)
  }
  return issues
}

/** A YAML double-quoted scalar. JSON string escaping is valid YAML. */
const scalar = (value: string): string => JSON.stringify(trim(value))

/**
 * Serialize the minimum valid submission file.
 *
 * Blank optional Chinese text is omitted rather than emitted as `zh: ""`,
 * which the catalog rejects as an explicit empty value.
 */
export function submissionYaml(draft: SubmissionDraft): string {
  const lines = [
    `id: ${scalar(draft.id)}`,
    `owner: ${scalar(draft.owner)}`,
    `version: ${scalar(draft.version)}`,
    'title:',
    `  en: ${scalar(draft.title.en)}`,
    ...(trim(draft.title.zh) === '' ? [] : [`  zh: ${scalar(draft.title.zh)}`]),
    'summary:',
    `  en: ${scalar(draft.summary.en)}`,
    ...(trim(draft.summary.zh) === '' ? [] : [`  zh: ${scalar(draft.summary.zh)}`]),
    'category:',
    `  primary: ${scalar(draft.category)}`,
    'members:',
    ...draft.members.map((member) => `  - plugin: ${scalar(member)}`),
  ]
  return `${lines.join('\n')}\n`
}

/** The filename the contributor drops into `suites/<owner>/<id>/`. */
export function submissionFilename(draft: SubmissionDraft): string {
  return `${trim(draft.version) || '1.0.0'}.yml`
}