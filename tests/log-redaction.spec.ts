/**
 * Home-path redaction for the exported log.
 *
 * The export is meant to be pasted into a public issue, so the machine's user
 * directory must not survive the trip. The rule is deliberately narrow: only
 * THIS user's home prefix is masked, and only where it is really a path — the
 * rest of the filesystem has to stay readable, because a maintainer needs to
 * see where a file was.
 *
 * A naive `text.replace(home, '~')` fails in both directions and each is a bug:
 *   - too loose: `Alice-other` and `Alice.backup` are different people's
 *     directories and must NOT be folded into `~`;
 *   - too tight: Windows accepts either separator and any case, `file://`
 *     URLs embed the home verbatim, and NDJSON history carries escaped
 *     backslashes — all of which are still the same directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'

import { redactHomePaths } from '../src/log/log-redaction.ts'

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: vi.fn(os.homedir) }
})

const windowsHome = String.raw`C:\Users\Alice.test+(dev)`

beforeEach(() => {
  vi.mocked(homedir).mockReturnValue(windowsHome)
})

afterEach(() => {
  vi.mocked(homedir).mockReset()
})

describe('redactHomePaths — what must be masked', () => {
  it.each([
    // Windows accepts both separators, mixed, and any case.
    [String.raw`C:\Users\Alice.test+(dev)\private`, String.raw`~\private`],
    ['C:/Users/Alice.test+(dev)/private', '~/private'],
    [String.raw`C:/Users\Alice.test+(dev)/private`, '~/private'],
    ['c:/uSeRs/ALICE.TEST+(DEV)/private', '~/private'],
  ])('masks %s', (path, masked) => {
    expect(redactHomePaths(`link:${path}`)).toBe(`link:${masked}`)
  })

  it('masks a bare home directory, with or without surrounding punctuation', () => {
    expect(redactHomePaths(`home: "${windowsHome}"`)).toBe('home: "~"')
    expect(redactHomePaths(`(${windowsHome})`)).toBe('(~)')
    expect(redactHomePaths(windowsHome)).toBe('~')
  })

  it('masks the home inside a file URL', () => {
    // `file://` is how a path reaches a log when a module name or a fetch URL
    // is the thing that failed, so it is not an exotic shape.
    expect(redactHomePaths('file:///c:/users/ALICE.TEST+(dev)/private')).toBe('file:///~/private')
  })

  it('masks every occurrence, not just the first', () => {
    expect(redactHomePaths(`${windowsHome}/a and ${windowsHome}/b`)).toBe('~/a and ~/b')
  })
})

describe('redactHomePaths — what must be left alone', () => {
  it.each([
    // Different users whose names merely start with this one.
    'C:/Users/Alice.test+(dev)-other/private',
    'C:/Users/Alice.test+(dev).backup/private',
    // A home-like sequence embedded in a longer path or in prose.
    'D:/copy/C:/Users/Alice.test+(dev)/private',
    'prefixC:/Users/Alice.test+(dev)/private',
    'Alice.test+(dev) is a user',
    // Someone else's home.
    'C:/Users/Bob/private',
    'D:/work/private',
  ])('leaves %s untouched', (text) => {
    expect(redactHomePaths(text)).toBe(text)
  })
})

describe('redactHomePaths — platform shapes', () => {
  it('keeps a POSIX home case-sensitive and does not reinterpret backslashes', () => {
    vi.mocked(homedir).mockReturnValue('/home/alice.test+(dev)')
    expect(redactHomePaths('link:/home/alice.test+(dev)/private')).toBe('link:~/private')
    // `/home/Alice…` is a different directory on a case-sensitive filesystem.
    expect(redactHomePaths('/home/Alice.test+(dev)/private')).toBe('/home/Alice.test+(dev)/private')
    // A Windows-looking path is not this home.
    expect(redactHomePaths(String.raw`\home\alice.test+(dev)\private`))
      .toBe(String.raw`\home\alice.test+(dev)\private`)
    expect(redactHomePaths('/copy/home/alice.test+(dev)/private')).toBe('/copy/home/alice.test+(dev)/private')
  })

  it('treats a POSIX root home as a root, not as a prefix for every path', () => {
    // Without this guard every absolute path on the box would become `~/…`.
    vi.mocked(homedir).mockReturnValue('/')
    const absolute = '/home/alice/private'
    expect(redactHomePaths(absolute)).toBe(absolute)
  })

  it('handles a UNC home with equivalent separators and case', () => {
    vi.mocked(homedir).mockReturnValue(String.raw`\\server\share\Alice`)
    expect(redactHomePaths('link://SERVER/share/aLiCe/private')).toBe('link:~/private')
    // A sibling share directory is a different home.
    expect(redactHomePaths('link://server/share/Alice-other/private'))
      .toBe('link://server/share/Alice-other/private')
  })

  it('trims a trailing separator from the home before matching', () => {
    vi.mocked(homedir).mockReturnValue('C:\\Users\\Alice\\')
    expect(redactHomePaths('c:/Users\\ALICE\\private')).toBe('~\\private')
  })
})
