/**
 * Event log for bug reports: what the store did and how it failed, exportable
 * as plain text from `GET /dsh-suite-store/api/logs`.
 *
 * Privacy: every entry is sanitised ON WRITE — this machine's home directory
 * collapses to `~` (see `log-redaction.ts`), common credential shapes are
 * masked, control characters are stripped so catalog-provided text cannot forge
 * extra lines in the exported file, and every detail is capped at
 * {@link DETAIL_MAX}.
 *
 * Two buffers, deliberately:
 *
 * - in memory, {@link MAX_ENTRIES} entries, dies with the process. That is what
 *   "events this session" shows.
 * - a profile-owned NDJSON sink, capped at {@link PERSISTENT_MAX_BYTES}. This
 *   exists because the failures worth reporting most are the ones that only
 *   appear after a restart — and a log that died with the process took exactly
 *   that story with it.
 *
 * Logging never throws into the caller: a read-only profile or a full disk
 * downgrades this module to memory-only instead of failing an install.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { redactHomePaths } from './log-redaction.ts'
import { inProbe } from './probe-context.ts'

export type LogLevel = 'info' | 'warn' | 'error'

/** One recorded event, in the shape the NDJSON sink stores. */
export interface LogEntry {
  /** ISO timestamp, always UTC; see `timezoneNote` for why. */
  at: string
  level: LogLevel
  /** Short machine-ish name of the subsystem, e.g. `install`, `catalog`. */
  event: string
  detail: string
}

/** Most recent events kept in memory for this session's export. */
const MAX_ENTRIES = 200
/** Longest detail kept per entry; a dumped HTTP body is not a log line. */
const DETAIL_MAX = 600
/** Ceiling on the on-disk sink. Trimmed to its newest half when crossed. */
const PERSISTENT_MAX_BYTES = 256 * 1024

const entries: LogEntry[] = []
let persistentFile: string | null = null
/** Bytes in the sink, tracked so the cap holds without a stat per event. */
let persistentBytes = 0

/**
 * Sanitise one string for export.
 *
 * The control-character strip is the log-injection guard: catalog data (bundle
 * keys, member names, host messages) reaches `logEvent`, and a newline in any of
 * it would forge an extra line in the exported file.
 *
 * @param text - the raw text.
 * @returns the text with the home folded, secrets masked and controls removed.
 */
function sanitize(text: string): string {
  return redactHomePaths(text)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
    .replace(/npm_[A-Za-z0-9]{16,}/g, 'npm_***')
    .replace(/bearer\s+\S+/gi, 'Bearer ***')
    .replace(/(authorization|token|apikey|api-key|password)(["':=\s]+)\S+/gi, '$1$2***')
}

/**
 * Append one event, sanitised and truncated.
 *
 * @param level - severity, for how the export lists it.
 * @param event - short subsystem name (`install`, `catalog`, `host`, …).
 * @param detail - free-form context; paths and credentials are masked.
 */
export function logEvent(level: LogLevel, event: string, detail: string): void {
  // A probe replays a route only to inspect its target. Writing the same
  // "pinned to" line a second time would claim an operation happened before it
  // was even accepted.
  if (inProbe()) return
  const entry: LogEntry = {
    at: new Date().toISOString(),
    level,
    event,
    detail: sanitize(detail).slice(0, DETAIL_MAX),
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  if (persistentFile === null) return
  try {
    const line = `${JSON.stringify(entry)}\n`
    appendFileSync(persistentFile, line)
    // Bytes, not UTF-16 units: CJK detail is 3 bytes a character on disk and 1
    // in `string.length`, and the counter has to agree with `statSync().size`.
    persistentBytes += Buffer.byteLength(line)
    // Trimming only on mount left the cap unenforced for the life of a process;
    // a retry loop is exactly the case that logs hardest and never restarts.
    if (persistentBytes > PERSISTENT_MAX_BYTES) trimPersistentLog(persistentFile)
  } catch {
    // Only append failures reach this (read-only or full disk). The in-memory
    // log still serves this session's export, so persistence disables itself
    // rather than letting one bad write break every future event.
    persistentFile = null
  }
}

/**
 * Rewrite the sink keeping only its newest half, and resync the byte count.
 *
 * @param file - the sink file to trim in place.
 */
function trimPersistentLog(file: string): void {
  let lines: string[]
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
  } catch {
    return
  }
  const kept: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0 && bytes <= PERSISTENT_MAX_BYTES / 2; index -= 1) {
    const line = lines[index]!
    kept.unshift(`${line}\n`)
    bytes += Buffer.byteLength(line) + 1
  }
  try {
    writeFileSync(file, kept.join(''))
    persistentBytes = bytes
  } catch {
    // The next successful append will notice again.
  }
}

/**
 * Point the persistent sink at a profile-owned file, or stop persisting.
 *
 * Called once per mount with `<profile>/.dsh-suite-store/log.ndjson`, and with
 * `null` on dispose. An oversized file is trimmed on configure so one
 * long-lived profile cannot grow it without bound.
 *
 * @param file - the sink path, or null to disable persistence.
 */
export function configurePersistentLog(file: string | null): void {
  persistentFile = file
  if (file === null) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    persistentBytes = existsSync(file) ? statSync(file).size : 0
    if (persistentBytes <= PERSISTENT_MAX_BYTES) return
    trimPersistentLog(file)
  } catch {
    // Only configure-time failures reach this (the directory cannot be
    // created, the file cannot be read). The store must mount regardless; the
    // session then runs memory-only.
    persistentFile = null
  }
}

/**
 * The newest persisted lines, raw, for the export's prior-sessions section.
 *
 * Raw on purpose: the export sanitises them again, because a file written by an
 * older build may predate these rules, and the user's file is never rewritten
 * by merely exporting it.
 *
 * @param file - the sink file.
 * @param maxLines - how many trailing lines to return.
 * @returns lines, newest last; empty when nothing is readable.
 */
export function readPersistentLog(file: string, maxLines = 80): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').slice(-maxLines)
  } catch {
    // A missing or unreadable file simply has no prior sessions.
    return []
  }
}

/**
 * Forget the in-memory buffer.
 *
 * For tests, and for a clean re-mount: the exported "this session" section must
 * describe the session that is running, not everything since the process began.
 */
export function clearLog(): void {
  entries.length = 0
}

/**
 * How to read the `at` fields, stated once at the top of the export.
 *
 * Every line is stamped UTC and stays that way: the file exists to be attached
 * to an issue, and a maintainer comparing two reporters' logs needs one clock.
 * But the reader is looking at their own wall clock, so a UTC+8 user reading
 * `07:32` for something they watched at `15:32` cannot tell whether the log is
 * skewed or their machine is. So the offset is stated with the arithmetic
 * already done.
 *
 * @param now - the clock, injectable for tests.
 * @returns the note, or null on a machine already running UTC.
 */
function timezoneNote(now = new Date()): string | null {
  // getTimezoneOffset is minutes to ADD to local to reach UTC, so it is
  // positive west of Greenwich — the opposite sign from how offsets are
  // written. Negate once here rather than at each use.
  const minutes = -now.getTimezoneOffset()
  if (minutes === 0) return null
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  let zone = ''
  try {
    const named = Intl.DateTimeFormat().resolvedOptions().timeZone
    zone = typeof named === 'string' && named !== '' ? ` (${named})` : ''
  } catch {
    // A runtime without full ICU still has the numeric offset.
  }
  const shift = mm === '00'
    ? `${String(Math.floor(abs / 60))}h`
    : `${String(Math.floor(abs / 60))}h${mm}m`
  const direction = minutes < 0 ? 'subtract' : 'add'
  return `timestamps: UTC — this machine is UTC${sign}${hh}:${mm}${zone}, so ${direction} ${shift} for local time`
}

/** How long the export may be, in lines, before the header says it was cut. */
export const EXPORT_ENTRY_LIMIT = MAX_ENTRIES

/**
 * The export document for bug reports.
 *
 * @param header - environment lines to prepend (version, platform — no paths).
 * @param snapshot - the live state of the store right now, one line per fact.
 * @param priorSessions - persisted lines from earlier processes, oldest first.
 * @returns plain text, newest event last.
 */
export function exportLogs(
  header: Record<string, string>,
  snapshot: string[] = [],
  priorSessions: string[] = [],
): string {
  const note = timezoneNote()
  const head = [
    ...Object.entries(header).map(([key, value]) => `${key}: ${sanitize(value)}`),
    ...(note === null ? [] : [note]),
  ]
  const lines = entries.map((entry) => `${entry.at} [${entry.level}] ${entry.event}: ${entry.detail}`)
  return [
    '# dsh-suite-store log export',
    ...head,
    '',
    // The state of the store RIGHT NOW, which does not depend on anything having
    // been recorded this session. The in-memory buffer dies with the process, so
    // the failures worth reporting most — the ones that only appear after a
    // restart — were exactly the ones whose export said "(none)".
    ...(snapshot.length > 0 ? ['## profile state', ...snapshot.map((line) => sanitize(line)), ''] : []),
    ...(priorSessions.length > 0
      ? ['## previous sessions (persisted log)', ...priorSessions.map((line) => sanitize(line)), '']
      : []),
    '## events this session',
    ...(lines.length > 0 ? lines : ['(none — the buffer starts empty on every start)']),
    '',
  ].join('\n')
}
