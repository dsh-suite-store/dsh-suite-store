/**
 * Mask this machine's user directory out of text that leaves the process.
 *
 * The exported log is written to be attached to a public issue, so the user's
 * home prefix must not survive the trip. The rule is deliberately NARROW:
 * only this user's home is folded to `~`, and only where it really is a path.
 * The rest of the filesystem stays readable — a maintainer needs to see where a
 * file was, and a blanket path scrub would delete that.
 *
 * Both failure directions are bugs, and each has a test:
 *   - too loose: `Alice-other/` and `Alice.backup/` belong to different people
 *     and must not become `~`;
 *   - too tight: Windows accepts either separator in any case, `file://` URLs
 *     embed the home verbatim, and NDJSON history carries escaped backslashes —
 *     all of them are still the same directory.
 */

import { homedir } from 'node:os'

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a home directory string is written in Windows form.
 *
 * Detected from the STRING's syntax rather than from `process.platform`: the
 * text being redacted may come from another machine (a pasted log, a config
 * file), and the separators to accept follow the home we are matching, not the
 * host doing the matching.
 */
function isWindowsStyle(directory: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(directory)
}

/**
 * Fold the current user's home directory to `~`.
 *
 * @param text - any string that may embed the home path.
 * @returns the text with the home prefix masked, everything else intact.
 */
export function redactHomePaths(text: string): string {
  const directory = homedir()
  const windows = isWindowsStyle(directory)
  // A trailing separator would make the pattern demand a doubled one.
  const home = directory.replace(windows ? /[\\/]+$/ : /\/+$/, '')
  // A POSIX root home is not a prefix for every absolute path on the box.
  if (home === '') return text

  // Windows: any separator, any position, any case. POSIX: exact, case-sensitive.
  const path = windows
    ? home.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]+')
    : escapeRegExp(home)

  // Do not match a home embedded inside another path or word: `D:/copy/C:/…`
  // and `prefixC:/…` are different locations, and `Alice-other` is a different
  // user. A `file://` URL is the one place the home follows a `/` and is still
  // ours, so allow those lookbehinds too.
  const before = String.raw`(?:(?<![\p{L}\p{N}_./\\-])|(?<=\bfile://)|(?<=\bfile:///))`
  // Trailing context: end of string, a separator, whitespace, or the punctuation
  // that wraps a path in prose/JSON. Trimming `C:\` leaves `C:`, and only an
  // absolute path belongs to that root, so it needs a separator, not an end.
  const after = windows && /^[a-z]:$/i.test(home)
    ? String.raw`(?=[\\/])`
    : windows
      ? String.raw`(?=$|[\\/\s"'\x60<>()[\]{},;:!?])`
      : String.raw`(?=$|[/\s"'\x60<>()[\]{},;:!?])`

  return text.replace(new RegExp(before + path + after, windows ? 'giu' : 'gu'), '~')
}
