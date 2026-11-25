import { describe, expect, it } from 'vitest'

import { allowBuildKeyFromDepPath, prepareBuildKey, prepareRefusedPackage } from '../src/install/pnpm-builds.ts'

const REFUSAL = [
  'Progress: resolved 12, reused 1, downloaded 0, added 0',
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from',
  '"https://codeload.github.com/0xsline/dsh-spotlight/tar.gz/b3565e86": The git-hosted package "'
    + '@0xsline/dsh-spotlight@0.0.2" needs to execute build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  '  "@0xsline/dsh-spotlight@https://codeload.github.com/0xsline/dsh-spotlight/tar.gz/b3565e86": true',
].join('\n')

describe('reading a git prepare refusal', () => {
  it('names the refused package without its version', () => {
    // The regex anchors on the sentence, so the fixture has to carry it.
    const line = 'git-hosted package "@0xsline/dsh-spotlight@0.0.2" needs to execute build scripts'
    expect(prepareRefusedPackage(line, '')).toBe('@0xsline/dsh-spotlight')
    expect(prepareRefusedPackage(REFUSAL, '')).toBe('@0xsline/dsh-spotlight')
  })

  it('reads the exact allowBuilds key pnpm printed', () => {
    // The key names the COMMIT this install fetches; the installed spec still
    // carries the old pin on an update, which is why it cannot be derived.
    expect(prepareBuildKey(REFUSAL, '')).toBe(
      '@0xsline/dsh-spotlight@https://codeload.github.com/0xsline/dsh-spotlight/tar.gz/b3565e86',
    )
  })

  it('answers null for output that is some other failure', () => {
    expect(prepareRefusedPackage('ERR_PNPM_FETCH_404', '')).toBeNull()
    expect(prepareBuildKey('ERR_PNPM_FETCH_404', '')).toBeNull()
  })

  it('reads the key out of an ndjson string, where quotes and newlines are escaped', () => {
    // Production runs pnpm with --reporter=ndjson; without unescaping, the
    // approval banner never appears at all.
    const escaped = JSON.stringify({ err: REFUSAL })
    expect(prepareRefusedPackage(escaped, '')).toBe('@0xsline/dsh-spotlight')
    expect(prepareBuildKey(escaped, '')).toContain('codeload.github.com')
  })
})

describe('allowBuildKeyFromDepPath', () => {
  it('keeps the whole path for a git source', () => {
    expect(allowBuildKeyFromDepPath('pkg@https://codeload.github.com/o/r/tar.gz/abc')).toBe(
      'pkg@https://codeload.github.com/o/r/tar.gz/abc',
    )
  })

  it('collapses to the bare name for a registry version', () => {
    expect(allowBuildKeyFromDepPath('pkg@1.2.3')).toBe('pkg')
  })
})
