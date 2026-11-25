/**
 * Where the store puts its state: the `profileRoot()` contract.
 *
 * The live profile is what makes this worth a spec. The desktop host runs
 * plugins in a process that does NOT have `DSH_PROFILE_DIR` (that variable is
 * set for TOOL processes), so the env-only resolver fell through to
 * `~/.dsh` and the store wrote 237 records to a directory the profile never
 * reads — every uninstall preview then answered "unknown" for plugins the
 * store itself had installed minutes earlier. `profileContext.dir` is the
 * composition's own answer and must win over any reconstruction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

import { apply, profileRoot } from '../src/index.ts'
import { STATE_DIRECTORY } from '../src/install/store.ts'

// The two collaborators whose constructor arguments ARE the wiring under test.
// Spying on them (rather than recomputing the paths in the test) is what makes
// the assertions observe what `apply()` really passes.
const createFileInstallStoreSpy = vi.fn()
const snapshotStoreSpy = vi.fn()

vi.mock('../src/install/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/install/store.ts')>()
  return {
    ...actual,
    createFileInstallStore: (...args: unknown[]) => {
      createFileInstallStoreSpy(...args)
      return (actual.createFileInstallStore as (...a: unknown[]) => unknown)(...args)
    },
  }
})

vi.mock('../src/catalog/snapshot-file.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/catalog/snapshot-file.ts')>()
  return {
    ...actual,
    FileSnapshotStore: class extends actual.FileSnapshotStore {
      constructor(directory: string) {
        super(directory)
        snapshotStoreSpy(directory)
      }
    },
  }
})

const KEYS = ['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_PROFILE'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** A context that answers `get('profileContext', false)` like Cordis does. */
function contextProviding(service: unknown): { get: (name: string, strict?: boolean) => unknown } {
  return {
    get: (name: string) => (name === 'profileContext' ? service : undefined),
  }
}

describe('profileRoot', () => {
  it('prefers the composed profile the host published', () => {
    process.env.DSH_HOME = '/somewhere/else'
    expect(profileRoot(contextProviding({ dir: 'C:/Users/me/.dsh/profiles/desktop' }) as never)).toBe(
      'C:/Users/me/.dsh/profiles/desktop',
    )
  })

  it('wins over DSH_PROFILE_DIR, which names the tool process, not the plugin', () => {
    process.env.DSH_PROFILE_DIR = 'C:/stale/wrong'
    expect(profileRoot(contextProviding({ dir: 'C:/right' }) as never)).toBe('C:/right')
  })

  it('falls back to DSH_PROFILE_DIR without the service', () => {
    process.env.DSH_PROFILE_DIR = 'C:/Users/me/.dsh/profiles/desktop'
    expect(profileRoot()).toBe('C:/Users/me/.dsh/profiles/desktop')
  })

  it('reconstructs from DSH_HOME and DSH_PROFILE', () => {
    process.env.DSH_HOME = 'C:/Users/me/.dsh'
    process.env.DSH_PROFILE = 'desktop'
    expect(profileRoot()).toBe(join('C:/Users/me/.dsh', 'profiles', 'desktop'))
  })

  it('ignores a service whose dir is empty or not a string', () => {
    process.env.DSH_PROFILE_DIR = 'C:/from/env'
    expect(profileRoot(contextProviding({ dir: '' }) as never)).toBe('C:/from/env')
    expect(profileRoot(contextProviding({}) as never)).toBe('C:/from/env')
  })

  it('survives a context whose get throws', () => {
    process.env.DSH_PROFILE_DIR = 'C:/from/env'
    const throwing = {
      get: () => {
        throw new Error('service not provided')
      },
    }
    expect(profileRoot(throwing as never)).toBe('C:/from/env')
  })
})

describe('whose directory each store receives', () => {
  // The layout is FIXED: `<profile>/.dsh-suite-store`. `Config.stateDirectory`
  // used to override it and could not be honoured — `createFileInstallStore`
  // appends the directory name itself, so only a value literally NAMED
  // `.dsh-suite-store` survived, and a relative one resolved against the
  // process cwd. The option is gone.
  //
  // What remains worth pinning is the WIRING, because the two values are
  // different and swapping them is a bug this codebase already shipped:
  //
  //   - `createFileInstallStore` takes the ROOT and appends the name itself;
  //   - `FileSnapshotStore` takes the STATE directory directly.
  //
  // Handing the state directory to the first nested it as
  // `<profile>/.dsh-suite-store/.dsh-suite-store`, putting install records
  // where the profile never looks. These assertions therefore drive the real
  // `apply()` and observe the paths it actually hands over — a test that
  // recomputed the paths itself would pass no matter how they were wired.
  function fakeContext(): { ctx: never; effects: (() => void)[] } {
    const effects: (() => void)[] = []
    const ctx = {
      logger: { warn: () => undefined, debug: () => undefined },
      get: () => undefined,
      pluginManager: undefined,
      effect: (setup: () => () => void) => {
        const dispose = setup()
        effects.push(dispose)
        return dispose
      },
      webServer: { register: () => () => undefined },
    }
    return { ctx: ctx as never, effects }
  }

  it('gives the install store the profile root, which it appends to itself', () => {
    process.env.DSH_PROFILE_DIR = 'C:/from/env'
    const { ctx } = fakeContext()
    // A module-level spy is the only way to observe the argument without
    // reading the source: both stores build their own file paths.
    apply(ctx, {})
    expect(createFileInstallStoreSpy).toHaveBeenCalled()
    expect(join(createFileInstallStoreSpy.mock.calls[0]![0] as string, STATE_DIRECTORY))
      .toBe(join('C:/from/env', '.dsh-suite-store'))
  })

  it('gives the catalog cache the state directory, not the root', () => {
    process.env.DSH_PROFILE_DIR = 'C:/from/env'
    const { ctx } = fakeContext()
    apply(ctx, {})
    expect(snapshotStoreSpy).toHaveBeenCalled()
    // Spying on the class captures the constructor argument: this is the value
    // that must already include the directory name.
    expect(snapshotStoreSpy.mock.calls[0]![0]).toBe(join('C:/from/env', '.dsh-suite-store'))
  })

  it('never nests the state directory twice', () => {
    process.env.DSH_PROFILE_DIR = 'C:/from/env'
    const { ctx } = fakeContext()
    apply(ctx, {})
    const root = createFileInstallStoreSpy.mock.calls[0]![0] as string
    const state = snapshotStoreSpy.mock.calls[0]![0] as string
    expect(join(root, STATE_DIRECTORY)).toBe(state)
    expect(state).not.toContain(join('.dsh-suite-store', '.dsh-suite-store'))
  })
})
