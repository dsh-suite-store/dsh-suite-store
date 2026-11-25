/**
 * The event log behind `/api/logs`.
 *
 * Two jobs, and the tests are split by them:
 *
 *  1. **Record** what the store did, in memory (dies with the process) and in a
 *     profile-owned NDJSON sink (survives a restart). The failures worth
 *     reporting most are the ones that only appear after a restart, and a log
 *     that died with the process took exactly that story with it.
 *  2. **Export** it as plain text a user can attach to an issue — sanitised,
 *     capped, and stamped so the reader knows which clock the times are on.
 *
 * Nothing here throws into the caller: logging must never be the reason an
 * install fails.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearLog,
  configurePersistentLog,
  exportLogs,
  logEvent,
  readPersistentLog,
} from '../src/log/log.ts'

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: vi.fn(os.homedir) }
})

let home: string
let logFile: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-suite-store-log-'))
  logFile = join(home, '.dsh-suite-store', 'log.ndjson')
  vi.mocked(homedir).mockReturnValue(home)
  clearLog()
})

afterEach(() => {
  configurePersistentLog(null)
  clearLog()
  vi.mocked(homedir).mockReset()
  rmSync(home, { recursive: true, force: true })
})

describe('sanitising on write', () => {
  it('masks credential shapes and drops control characters', () => {
    // The control-character strip is a log-injection guard: a package name or a
    // bundle key reaches logEvent from catalog data, and a newline in it would
    // forge an extra line in the exported file.
    logEvent('error', 'install', 'a\nb\rc\u0000 sk-abcdefgh12345678 gh[pousr]PLACEHOLDER')
    logEvent('warn', 'net', 'npm_abcdefghijklmnop bare Bearer abc.def api-key=shhh password: s3cret')
    const text = exportLogs({})
    expect(text).toContain('abc sk-***')          // newline/CR/NUL are gone
  
    expect(text).not.toContain('abcdefgh12345678')
    expect(text).toContain('npm_***')
    expect(text).toContain('Bearer ***')
    expect(text).toContain('api-key=***')
    expect(text).toContain('password: ***')
  })

  it('caps one entry so a dumped response cannot flood the export', () => {
    logEvent('error', 'install', 'x'.repeat(5000))
    const line = exportLogs({}).split('\n').find((row) => row.includes('[error] install'))
    expect(line).toBeDefined()
    // 600 is the detail cap; the stamp/level/event prefix is on top of it.
    expect((line ?? '').length).toBeLessThan(600 + 120)
  })

  it('keeps only the newest entries in memory', () => {
    for (let index = 0; index < 260; index += 1) logEvent('info', 'tick', `entry-${String(index)}`)
    const text = exportLogs({})
    // The oldest entries are dropped, the newest survive.
    expect(text).not.toContain('entry-0\n')
    expect(text).toContain('entry-259')
  })
})

describe('the persistent sink', () => {
  it('appends sanitised ndjson and reads the tail back', () => {
    configurePersistentLog(logFile)
    logEvent('warn', 'install', `failed under ${join(home, 'profiles', 'web')} token sk-abcdefgh12345678`)
    const lines = readPersistentLog(logFile)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0]!) as { detail: string; level: string; event: string }
    expect(entry.level).toBe('warn')
    expect(entry.event).toBe('install')
    // Home folded to `~`, the rest of the path left as this machine writes it.
    expect(entry.detail).toContain(join('~', 'profiles', 'web'))
    expect(entry.detail).not.toContain('sk-abcdefgh12345678')
  })

  it('trims an oversized file to its newest half on configure', () => {
    mkdirSync(join(home, '.dsh-suite-store'), { recursive: true })
    writeFileSync(logFile, `${'x'.repeat(64)}\n`.repeat(6000))
    configurePersistentLog(logFile)
    const trimmed = readFileSync(logFile, 'utf8')
    expect(trimmed.length).toBeLessThanOrEqual(128 * 1024 + 128)
    expect(trimmed.endsWith('x\n')).toBe(true)
  })

  it('holds the cap while the process keeps running', () => {
    // Trimming only at mount left the ceiling unenforced for the life of a
    // process, and a retry loop is exactly the case that logs hardest and never
    // restarts.
    configurePersistentLog(logFile)
    for (let index = 0; index < 2100; index += 1) logEvent('error', 'install', `${'x'.repeat(120)} ${String(index)}`)
    expect(statSync(logFile).size).toBeLessThanOrEqual(256 * 1024)
    const lines = readPersistentLog(logFile)
    expect(lines.length).toBeGreaterThan(0)
    expect(JSON.parse(lines[lines.length - 1]!).detail).toContain('2099')
  })

  it('counts bytes, not characters, so CJK detail cannot overshoot the cap', () => {
    configurePersistentLog(logFile)
    for (let index = 0; index < 450; index += 1) logEvent('error', 'install', `${'安装失败：'.repeat(40)} ${String(index)}`)
    expect(statSync(logFile).size).toBeLessThanOrEqual(256 * 1024)
    const lines = readPersistentLog(logFile)
    expect(JSON.parse(lines[lines.length - 1]!).detail).toContain('449')
  })

  it('degrades to memory-only when the sink cannot be written', () => {
    // A read-only or full profile must not make every later event throw: the
    // export still answers from memory for this session. The commonest real
    // cause is that the sink's PARENT is a file, so the append cannot work.
    const blocker = join(home, 'a-file')
    writeFileSync(blocker, 'not a directory')
    configurePersistentLog(join(blocker, 'log.ndjson'))
    expect(() => logEvent('info', 'tick', 'still alive')).not.toThrow()
    expect(exportLogs({})).toContain('still alive')
  })

  it('answers an empty list for a missing file instead of throwing', () => {
    expect(readPersistentLog(join(home, 'absent.ndjson'))).toEqual([])
  })
})

describe('the export document', () => {
  it('states which clock the timestamps are on', () => {
    // Times stay UTC so two reporters' logs share one clock; the note closes
    // the gap for a reader looking at their own wall clock.
    const realOffset = Date.prototype.getTimezoneOffset
    Date.prototype.getTimezoneOffset = function getTimezoneOffset(): number {
      return -480 // UTC+8
    }
    try {
      const text = exportLogs({})
      expect(text).toContain('timestamps: UTC')
      expect(text).toContain('UTC+08:00')
      expect(text).toContain('add 8h for local time')
    } finally {
      Date.prototype.getTimezoneOffset = realOffset
    }
  })

  it('says nothing when the machine is already on UTC', () => {
    const realOffset = Date.prototype.getTimezoneOffset
    Date.prototype.getTimezoneOffset = function getTimezoneOffset(): number {
      return 0
    }
    try {
      expect(exportLogs({})).not.toContain('timestamps: UTC —')
    } finally {
      Date.prototype.getTimezoneOffset = realOffset
    }
  })

  it('keeps half-hour zones exact', () => {
    const realOffset = Date.prototype.getTimezoneOffset
    Date.prototype.getTimezoneOffset = function getTimezoneOffset(): number {
      return -330 // UTC+5:30
    }
    try {
      expect(exportLogs({})).toContain('add 5h30m for local time')
    } finally {
      Date.prototype.getTimezoneOffset = realOffset
    }
  })

  it('carries a header, the live snapshot and prior sessions, sanitised', () => {
    configurePersistentLog(logFile)
    logEvent('error', 'install', 'from a previous process')
    configurePersistentLog(null)
    clearLog()
    logEvent('info', 'uninstall', 'from this process')
    const text = exportLogs(
      { 'dsh-suite-store': '0.1.0', profile: home },
      [`dependencies (1):`, `  plug-a: ${join(home, 'x')}`],
      readPersistentLog(logFile),
    )
    expect(text).toContain('dsh-suite-store: 0.1.0')
    // The header is sanitised too: a path is a path wherever it appears.
    expect(text).toContain('profile: ~')
    expect(text).toContain('## profile state')
    expect(text).toContain('plug-a: ~')
    expect(text).toContain('## previous sessions (persisted log)')
    expect(text).toContain('from a previous process')
    expect(text).toContain('## events this session')
    expect(text).toContain('from this process')
  })

  it('says so when this session recorded nothing', () => {
    // A restart-only failure is the case this log exists for, so an empty
    // buffer must read as "nothing this session", never as a broken export.
    expect(exportLogs({})).toContain('(none')
  })

  it('omits the optional sections rather than printing their headings empty', () => {
    const text = exportLogs({})
    expect(text).not.toContain('## profile state')
    expect(text).not.toContain('## previous sessions')
  })
})
