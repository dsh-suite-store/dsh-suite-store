/**
 * The state directory moved with the package's rename.
 *
 * `dsh-suites-store` became `dsh-suite-store`, so the profile's state folder
 * went from `.dsh-suites-store` to `.dsh-suite-store`. A rename must not cost
 * the user their provenance: without it, plugins this store installed would
 * look hand-installed and the next uninstall would stop offering to clean up
 * their source records. The store therefore reads the old file once and
 * adopts it under the new name.
 *
 * These run against a real temporary directory, because the behaviour under
 * test is a filesystem migration rather than a pure fold.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { createFileInstallStore, STATE_DIRECTORY } from '../src/install/store.ts'

/** One provenance document in the shape the store writes. */
const PROVENANCE = JSON.stringify({
  format: 1,
  entries: {
    'npm:kept@1.0.0': {
      id: 'npm:kept@1.0.0',
      spec: 'npm:kept@1.0.0',
      resolvedVersion: '1.0.0',
      sources: [{ kind: 'bundle', bundleId: 'research-notes' }],
    },
  },
})

const made: string[] = []

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-suite-store-'))
  made.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('state directory migration', () => {
  it('uses the current name', () => {
    expect(STATE_DIRECTORY).toBe('.dsh-suite-store')
  })

  it('adopts provenance left under the old directory name', async () => {
    const dir = await profile()
    const legacy = join(dir, '.dsh-suites-store')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'state.json'), PROVENANCE, 'utf8')

    const store = createFileInstallStore(dir)
    const state = await store.readProvenance()

    expect(Object.keys(state.entries)).toEqual(['npm:kept@1.0.0'])
    // And the adoption is written under the new name, so it happens once.
    const adopted = join(dir, STATE_DIRECTORY, 'state.json')
    expect(existsSync(adopted)).toBe(true)
    expect(JSON.parse(await readFile(adopted, 'utf8')).entries['npm:kept@1.0.0'].sources[0].bundleId)
      .toBe('research-notes')
  })

  it('starts empty when neither directory has a document', async () => {
    const dir = await profile()
    const store = createFileInstallStore(dir)
    expect((await store.readProvenance()).entries).toEqual({})
  })

  it('prefers the current document over the legacy one', async () => {
    const dir = await profile()
    const legacy = join(dir, '.dsh-suites-store')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'state.json'), PROVENANCE, 'utf8')
    const current = join(dir, STATE_DIRECTORY)
    await mkdir(current, { recursive: true })
    await writeFile(join(current, 'state.json'), JSON.stringify({ format: 1, entries: {} }), 'utf8')

    const store = createFileInstallStore(dir)
    expect((await store.readProvenance()).entries).toEqual({})
  })
})

describe('pendingBuildsFrom', () => {
  it('reads only the names pnpm left undecided', async () => {
    const { pendingBuildsFrom } = await import('../src/install/store.ts')
    const text = [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'allowBuilds:',
      "  'cloudflared': set this to true or false",
      '  esbuild@0.21.0: true',
      '  protobufjs@7.6.6: set this to true or false',
      '  "*": false',
      'minimumReleaseAgeExclude:',
      '  - pkg@1.0.0',
    ].join('\n')
    expect(pendingBuildsFrom(text)).toEqual(['cloudflared', 'protobufjs@7.6.6'])
  })

  it('answers an empty list when the profile has no undecided scripts', async () => {
    const { pendingBuildsFrom } = await import('../src/install/store.ts')
    expect(pendingBuildsFrom('packages:\n  - .\n\nnodeLinker: hoisted\n')).toEqual([])
  })
})
