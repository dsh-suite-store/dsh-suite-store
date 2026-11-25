import { describe, expect, it, vi } from 'vitest'

import { HostAdapter, hostSpec, removalRefusal, type HostCapabilities, type HostPluginManager } from '../src/install/host.ts'

/**
 * The catalog's spec grammar and the host's are different languages.
 *
 * Pinned because the live failure mode is invisible until an install runs: the
 * host parses with `[@scope/]name[@range]`, refuses `npm:…` as `invalid-spec`,
 * and — more quietly — cannot short-circuit an already-installed member whose
 * spec it could not read. That non-short-circuit is what produced a wall of
 * `ambiguous-install` receipts for members that were already present.
 */
describe('hostSpec', () => {
  it('drops the identity prefix the host cannot parse', () => {
    expect(hostSpec('npm:billion-context@0.1.213')).toBe('billion-context@0.1.213')
    expect(hostSpec('npm:dsh-cost-meter')).toBe('dsh-cost-meter')
  })

  it('keeps a scoped name intact, leading @ and all', () => {
    expect(hostSpec('npm:@linxin666/dsh-client-ui-git-graph@0.4.14')).toBe('@linxin666/dsh-client-ui-git-graph@0.4.14')
  })

  it('turns the project\'s git spelling into the shorthand pnpm resolves', () => {
    expect(hostSpec('git:someone/dsh-log#packages/log')).toBe('github:someone/dsh-log#packages/log')
  })

  it('leaves an already-acceptable spec alone', () => {
    expect(hostSpec('cc-safety-net@2.7.8')).toBe('cc-safety-net@2.7.8')
    expect(hostSpec('github:owner/repo')).toBe('github:owner/repo')
    expect(hostSpec('  pkg@1.0.0  ')).toBe('pkg@1.0.0')
  })
})

/**
 * A removal receipt is the only place the host explains a refusal.
 *
 * `removeBundle` never rejects: `change()` folds every `ManagementFailure`
 * into a resolved `{ application: 'failed', error: { code } }`. Reading only
 * the promise made a refusal indistinguishable from success, so the uninstall
 * sheet re-offered the same plugin with no reason attached.
 */
describe('removalRefusal', () => {
  it('turns the bundle-in-use code into the sentence the user needs', () => {
    expect(removalRefusal({ application: 'failed', error: { code: 'bundle-in-use' } })).toBe(
      'another plugin is using this one, so it cannot be changed right now',
    )
  })

  it('prefers a diagnostic the host wrote itself', () => {
    expect(
      removalRefusal({
        application: 'failed',
        error: { code: 'bundle-in-use', diagnostic: 'Progress: resolved 4\ncannot remove x: still loaded' },
      }),
    ).toBe('cannot remove x: still loaded')
  })

  it('falls through to the bare code when it has no sentence of its own', () => {
    expect(removalRefusal({ application: 'failed', error: { code: 'something-new' } })).toBe('something-new')
  })

  it('says nothing when the receipt carries no error at all', () => {
    // `{ application: 'applied' }`, a bare `undefined`, and a host that answers
    // with something that is not an object all mean "no refusal to report"; the
    // caller's own presence check is what decides whether it worked.
    expect(removalRefusal({ application: 'applied' })).toBeUndefined()
    expect(removalRefusal(undefined)).toBeUndefined()
    expect(removalRefusal('ok')).toBeUndefined()
    expect(removalRefusal({ application: 'failed', error: { code: '' } })).toBeUndefined()
  })
})

function manager(overrides: Partial<HostPluginManager> = {}): HostPluginManager {
  return {
    listPlugins: async () => [{ name: '@scope/dsh-memory', version: '0.6.11' }],
    listBundles: async () => [],
    installBundle: async () => ({ ok: true }),
    waitForInstall: async () => ({ ok: true }),
    cancelInstall: async () => 'cancelled',
    ...overrides,
  }
}

/**
 * Enable and disable is the one member control the sheet draws (§8.3).
 *
 * The live shape that forced this: a plugin can be installed and switched off
 * with no Loader entry at all, because it arrived through a bundle whose
 * composition is deselected. `setPluginEnabled` then answers `unknown-plugin`
 * for every spelling and `listPlugins()` has no row, so a switch that only knew
 * those two would go blank on exactly the members someone had turned off.
 */
describe('enabledState', () => {
  it('reads the plugin row when the host has one', async () => {
    const adapter = new HostAdapter(
      manager({ listPlugins: async () => [{ name: 'dsh-cost-meter', enabled: false }] }),
    )
    expect(await adapter.enabledState('npm:dsh-cost-meter@1.9.62')).toBe(false)
  })

  it('falls through to the bundle that carries the plugin', async () => {
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [],
        listBundles: async () => [{ name: 'dsh-cost-meter', installed: true, enabled: false }],
      }),
    )
    expect(await adapter.enabledState('npm:dsh-cost-meter@1.9.62')).toBe(false)
  })

  it('matches a bundle through the packages it pulls in', async () => {
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [],
        listBundles: async () => [
          { name: 'some-suite', installed: true, enabled: true, plugins: [{ name: 'billion-context' }] },
        ],
      }),
    )
    expect(await adapter.enabledState('npm:billion-context@0.1.213')).toBe(true)
  })

  it('says nothing when neither table knows the package', async () => {
    const adapter = new HostAdapter(manager({ listPlugins: async () => [], listBundles: async () => [] }))
    expect(await adapter.enabledState('npm:nope')).toBeUndefined()
  })

  it('does not answer from a bundle that is not installed', async () => {
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [],
        listBundles: async () => [{ name: 'nope', installed: false, enabled: true }],
      }),
    )
    expect(await adapter.enabledState('npm:nope')).toBeUndefined()
  })
})

describe('setEnabled', () => {
  it('takes the plugin switch when the host has an entry for it', async () => {
    const calls: { id: string; enabled: boolean }[] = []
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [{ name: 'billion-context', enabled: false }],
        setPluginEnabled: async (id, enabled) => {
          calls.push({ id, enabled })
          return { application: 'applied' }
        },
      }),
    )
    expect(await adapter.setEnabled('npm:billion-context@0.1.213', false)).toBe(true)
    expect(calls).toEqual([{ id: 'billion-context', enabled: false }])
  })

  it('flips the bundle when the plugin has no Loader entry of its own', async () => {
    const flips: { name: string; enabled: boolean }[] = []
    let bundleOn = true
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [],
        listBundles: async () => [{ name: 'dsh-cost-meter', installed: true, enabled: bundleOn }],
        setPluginEnabled: async () => ({ application: 'failed', error: { code: 'unknown-plugin' } }),
        setBundleEnabled: async (name, enabled) => {
          flips.push({ name, enabled })
          bundleOn = enabled
          return { application: 'applied' }
        },
      }),
    )
    expect(await adapter.setEnabled('npm:dsh-cost-meter@1.9.62', false)).toBe(true)
    expect(flips).toEqual([{ name: 'dsh-cost-meter', enabled: false }])
  })

  it('reports a refusal instead of pretending the switch moved', async () => {
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [{ name: 'billion-context', enabled: true }],
        setPluginEnabled: async () => ({ application: 'failed', error: { code: 'management-required' } }),
      }),
    )
    await expect(adapter.setEnabled('npm:billion-context@0.1.213', false)).rejects.toThrow(
      'the host manages this plugin itself, so it cannot be changed here',
    )
  })

  it('says the write was overridden, not "unknown-plugin", when the host saved it', async () => {
    // The live desktop shape: the first (entryId) spelling writes the patch,
    // reloads, and the host answers `{ application: 'overridden' }` because a
    // higher layer still composes the plugin as on. Every other spelling then
    // answers `unknown-plugin`; reporting that last word hid the fact that the
    // profile had already been edited. It also must not be tried at all — a
    // second write under another id is an unrelated edit.
    const calls: { id: string; enabled: boolean }[] = []
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [
          { entryId: 'include:ui-git-graph', name: '@linxin666/dsh-client-ui-git-graph', enabled: true },
        ],
        setPluginEnabled: async (id, enabled) => {
          calls.push({ id, enabled })
          return id === 'include:ui-git-graph'
            ? { application: 'overridden' }
            : { application: 'failed', error: { code: 'unknown-plugin' } }
        },
      }),
    )
    await expect(adapter.setEnabled('npm:@linxin666/dsh-client-ui-git-graph@0.4.14', false)).rejects.toThrow(
      'the host kept the change, but the plugin is still contributed by another layer',
    )
    // One write under the entryId, then the exact undo under the same id. No
    // second spelling is tried, so no stray `disabled:` line is left behind.
    expect(calls).toEqual([
      { id: 'include:ui-git-graph', enabled: false },
      { id: 'include:ui-git-graph', enabled: true },
    ])
  })

  it('reports "saved, not yet visible" when an applied write did not move the state', async () => {
    const calls: { id: string; enabled: boolean }[] = []
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [
          { entryId: 'include:ui-git-graph', name: '@linxin666/dsh-client-ui-git-graph', enabled: true },
        ],
        setPluginEnabled: async (id, enabled) => {
          calls.push({ id, enabled })
          return { application: 'applied' }
        },
      }),
    )
    await expect(adapter.setEnabled('npm:@linxin666/dsh-client-ui-git-graph@0.4.14', false)).rejects.toThrow(
      'it takes effect after the host reloads',
    )
    expect(calls).toEqual([
      { id: 'include:ui-git-graph', enabled: false },
      { id: 'include:ui-git-graph', enabled: true },
    ])
  })

  it('names a failed undo instead of leaving the profile silently edited', async () => {
    let once = false
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [
          { entryId: 'include:ui-git-graph', name: '@linxin666/dsh-client-ui-git-graph', enabled: true },
        ],
        setPluginEnabled: async () => {
          if (once) throw new Error('profile is shutting down')
          once = true
          return { application: 'overridden' }
        },
      }),
    )
    await expect(adapter.setEnabled('npm:@linxin666/dsh-client-ui-git-graph@0.4.14', false)).rejects.toThrow(
      /the change could not be undone: profile is shutting down/,
    )
  })
})

describe('capabilities', () => {
  it('reports everything a full harness provides', () => {
    expect(new HostAdapter(manager()).capabilities()).toEqual<HostCapabilities>({
      installable: true,
      granularProgress: true,
      passOptions: true,
      canRestart: true,
      canApproveBuilds: true,
      cancelable: true,
    })
  })

  it('degrades instead of throwing when the host lacks install support', () => {
    const { installBundle, waitForInstall, cancelInstall, ...rest } = manager()
    void installBundle
    void waitForInstall
    void cancelInstall
    const capabilities = new HostAdapter(rest).capabilities()
    expect(capabilities.installable).toBe(false)
    expect(capabilities.cancelable).toBe(false)
  })
})

describe('installed', () => {
  it('lists plugins by name and bundles by name', async () => {
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [
          { name: '@scope/dsh-memory', version: '0.6.11' },
          { spec: 'git:someone/dsh-log' },
          { name: '' },
        ],
        listBundles: async () => [{ name: 'fin-analyst-workstation' }, {}],
      }),
    )
    expect(await adapter.installed()).toEqual([
      { id: '@scope/dsh-memory', version: '0.6.11' },
      { id: 'git:someone/dsh-log' },
      { id: 'fin-analyst-workstation' },
    ])
  })

  it('survives a host that refuses to list anything', async () => {
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => {
          throw new Error('nope')
        },
        listBundles: async () => {
          throw new Error('nope')
        },
      }),
    )
    expect(await adapter.installed()).toEqual([])
  })

  it('reads the id field the real pluginManager reports', async () => {
    // The live host answers `listPlugins()` with `{ id, version, … }`, not
    // `{ name }`. Reading only `name` made every installed plugin invisible,
    // so a second click on the same bundle reinstalled all of it and the
    // "already installed" counter stayed at zero. The fixture here is the
    // shape taken from the running manager rather than the documented one.
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [
          { id: 'npm:cc-safety-net', version: '2.7.8', enabled: true },
          { id: 'dsh-auto-review', version: '0.15.0' },
        ],
      }),
    )
    expect(await adapter.installed()).toEqual([
      { id: 'npm:cc-safety-net', version: '2.7.8' },
      { id: 'dsh-auto-review', version: '0.15.0' },
    ])
  })

  it('prefers the name over the id when a host reports both', async () => {
    // Both fields present means the host is one whose `name` is the identity
    // the catalog uses; `id` is then an internal handle and not comparable
    // with a member spec.
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [{ name: 'dsh-auto-review', id: 'internal-4', version: '0.15.0' }],
      }),
    )
    expect(await adapter.installed()).toEqual([{ id: 'dsh-auto-review', version: '0.15.0' }])
  })

  // Verbatim from the running `pluginManager.listPlugins()`: it fills
  // `moduleName`, never `name`/`id`/`spec`. Without this field the adapter saw
  // a profile holding only the bundles it could name, so every plugin member
  // looked uninstalled — and re-installing an already-satisfied package is
  // what produced the `ambiguous-install` receipts in the live run.
  it('reads moduleName, the field the shipped listPlugins actually fills', async () => {
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [
          { entryId: 'a1', moduleName: 'dsh-cost-meter', enabled: true, fiberPhase: 'active' },
          { entryId: 'a2', moduleName: '@scope/dsh-memory', enabled: false, fiberPhase: null },
        ],
      }),
    )
    expect(await adapter.installed()).toEqual([{ id: 'dsh-cost-meter' }, { id: '@scope/dsh-memory' }])
  })

  it('keeps the version of an installed bundle, from source when the host has none', async () => {
    // A member can BE a bundle, and a pinned member is satisfied only by the
    // version the author tested. A host row carrying just `name` could never
    // satisfy one, so the bundle was reinstalled on every run.
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [],
        listBundles: async () => [
          { name: 'dsh-cost-meter', source: 'dsh-cost-meter@1.9.62', installed: true },
          { name: 'dsh-ops', version: '0.4.1', installed: true },
          { name: 'dsh-unversioned', source: 'https://example.test/x.tgz', installed: true },
        ],
      }),
    )
    expect(await adapter.installed()).toEqual([
      { id: 'dsh-cost-meter', version: '1.9.62' },
      { id: 'dsh-ops', version: '0.4.1' },
      { id: 'dsh-unversioned' },
    ])
  })

  it('does not mistake an offered bundle for an installed one', async () => {
    // The host lists official/on-demand catalog entries with `installed: false`
    // to make them browsable. Counting those as present made the planner skip
    // the members of a bundle that had never been installed at all.
    const adapter = new HostAdapter(
      manager({
        listPlugins: async () => [],
        listBundles: async () => [
          { name: 'offered', installed: false, source: 'offered@1.0.0' },
          { name: 'present', installed: true },
        ],
      }),
    )
    expect(await adapter.installed()).toEqual([{ id: 'present' }])
  })
})

describe('install', () => {
  it('passes only this member\'s approvals, plus the request id', async () => {
    const installBundle = vi.fn(async () => ({ ok: true }))
    const adapter = new HostAdapter(manager({ installBundle }))
    const outcome = await adapter.install({ spec: 'npm:pkg@1.0.0', approvedBuilds: ['pkg'], requestId: 'req-1' })
    expect(outcome).toEqual({ status: 'ok' })
    // The `npm:` prefix is this catalog's identity spelling, not something the
    // host can parse: `pluginManager.installBundle` refuses it as
    // `invalid-spec` inside its own `parseInstallSpec`, and a spec it cannot
    // parse is one it also cannot short-circuit as `already-installed`.
    expect(installBundle).toHaveBeenCalledWith('pkg@1.0.0', {
      requestId: 'req-1',
      approvedBuilds: ['pkg'],
      enabled: true,
    })
  })

  it('throws when the host refuses to start, before anything was written', async () => {
    const adapter = new HostAdapter(
      manager({
        installBundle: async () => {
          throw new Error('a host install is already running')
        },
      }),
    )
    await expect(adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })).rejects.toThrow(
      /already running/u,
    )
  })

  it('turns a failed wait into a failed outcome', async () => {
    const adapter = new HostAdapter(
      manager({
        waitForInstall: async () => ({ ok: false, error: 'pnpm exited with 1' }),
      }),
    )
    const outcome = await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'pnpm exited with 1' })
    expect('cause' in outcome).toBe(true)
  })

  it('treats an already-installed rejection as success, not as a failure', async () => {
    // Seen after a restart: the package is on disk, the host short-circuits a
    // reinstall with `already-installed`, and the row went red for something
    // that was already correct. The host rejects with a plain record, so this
    // also covers reading a reason out of a non-Error object.
    const adapter = new HostAdapter(
      manager({
        waitForInstall: async () => {
          throw { reason: 'already-installed' }
        },
      }),
    )
    expect(await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' }))
      .toEqual({ status: 'ok' })
  })

  it('reads a receipt that says the member is already installed as success', async () => {
    // The host resolves (it does not reject) with `already-installed`. That is
    // a fact about the profile, and the presence check decides the rest.
    const adapter = new HostAdapter(
      manager({
        installBundle: async () => ({ changed: false, status: 'error', reason: 'already-installed' }),
        waitForInstall: async () => null,
      }),
    )
    expect(await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' }))
      .toEqual({ status: 'ok' })
  })

  it('treats a rejected wait as a failure, not as a crash', async () => {
    const adapter = new HostAdapter(
      manager({
        waitForInstall: async () => {
          throw new Error('install timed out')
        },
      }),
    )
    const outcome = await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'install timed out' })
    expect('cause' in outcome).toBe(true)
  })

  it('counts a wait that resolves with no status as success', async () => {
    const adapter = new HostAdapter(manager({ waitForInstall: async () => undefined }))
    expect(await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })).toEqual({ status: 'ok' })
  })

  // The shape below is the one the desktop host actually resolves with when a
  // member does not exist. It is a RESOLVED promise carrying `application:
  // 'failed'`; reading only `ok`/`status` reported it as a success and left
  // the executor to invent a reason it did not have.
  const refused = {
    changed: false,
    application: 'failed',
    stage: 'install',
    target: 'npm:@scope/pkg@1.0.0',
    error: { code: 'operation-error', diagnostic: 'pnpm: 404 Not Found - @scope/pkg@1.0.0' },
    packageResult: { exitCode: 1, output: '...', truncated: false, logPath: '', kind: 'not-found' },
  }

  it('reads a refused install out of the receipt the host resolves with', async () => {
    const adapter = new HostAdapter(manager({ installBundle: async () => refused, waitForInstall: async () => null }))
    const outcome = await adapter.install({ spec: 'npm:@scope/pkg@1.0.0', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'pnpm: 404 Not Found - @scope/pkg@1.0.0' })
    expect('cause' in outcome).toBe(true)
  })

  it('reads the receipt when the host has no waitForInstall at all', async () => {
    const { waitForInstall, ...rest } = manager({ installBundle: async () => refused })
    void waitForInstall
    const adapter = new HostAdapter(rest)
    const outcome = await adapter.install({ spec: 'npm:@scope/pkg@1.0.0', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'pnpm: 404 Not Found - @scope/pkg@1.0.0' })
    expect('cause' in outcome).toBe(true)
  })

  // Captured verbatim from a live run. The host finishes the install, decides
  // it cannot tell whether the plugin landed, and says so with a code and NO
  // diagnostic. Falling through to the log's last line reported `Done in
  // 1.1s` — a success message — as the reason the member failed.
  it('reports an ambiguous install as unknown, not as a failure', async () => {
    const ambiguous = {
      stage: 'install',
      target: 'npm:dsh-wsl-tool@2.2.6',
      enabled: true,
      changed: false,
      application: 'failed',
      approvedBuilds: [],
      packageResult: { exitCode: 0, output: 'Packages: -8\n\nDone in 1.1s using pnpm v11.28.5\n', truncated: false },
      error: { code: 'ambiguous-install' },
    }
    const adapter = new HostAdapter(manager({ installBundle: async () => ambiguous, waitForInstall: async () => null }))
    // pnpm exited 0, so the files are on disk; what failed is the host's own
    // `before/after` dependency diff. Calling that `failed` made the executor
    // roll back a plugin that was installed correctly — and the retry then had
    // to download it again. `unknown` sends the executor to the profile.
    expect(await adapter.install({ spec: 'npm:dsh-wsl-tool@2.2.6', approvedBuilds: [], requestId: 'r' })).toEqual({
      status: 'unknown',
      reason: 'the host could not tell whether the install landed; check the plugin list before retrying',
    })
  })

  // Also captured live: pnpm exits 1 AFTER writing `Done in …` because the
  // host rejects the plugin's own version requirements. The log's last line is
  // again a success message, and the requirement — the one thing the user can
  // act on — is only in the structured field.
  // The live receipt has NO structured `incompatible` field — the whole
  // refusal lives in the log's last line, after pnpm has already printed
  // `Done in 2.4s` and after the host has restored package.json. Quoting that
  // line verbatim is 700 characters of legal notice; the requirement is the
  // only part the user can act on.
  it('digs the failed requirement out of the host refusal in the log', async () => {
    const refusalInLog = {
      stage: 'install',
      target: 'npm:dsh-api-relay-audit@2.5.0',
      changed: false,
      application: 'failed',
      packageResult: {
        exitCode: 1,
        output:
          'Packages: +1 -8\nDone in 2.4s using pnpm v11.28.5\n\n' +
          'dsh: installation rejected: Plugin dsh-api-relay-audit@2.5.0 is incompatible with dsh 0.2.1-rc.3: ' +
          'requirements {"@deepseek-ai/dsh-llm":"0.1.0-rc.6 || 0.1.7-rc.2 || 0.2.0-rc.2"}. ' +
          'Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime.\n',
      },
      error: { code: 'incompatible-version' },
    }
    const adapter = new HostAdapter(
      manager({ installBundle: async () => refusalInLog, waitForInstall: async () => null }),
    )
    const outcome = await adapter.install({ spec: 'npm:dsh-api-relay-audit@2.5.0', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({
      status: 'failed',
      cause: 'incompatible-version',
      reason:
        'dsh-api-relay-audit@2.5.0 needs @deepseek-ai/dsh-llm 0.1.0-rc.6 || 0.1.7-rc.2 || 0.2.0-rc.2, which dsh 0.2.1-rc.3 does not provide — grant a version exemption or install a compatible version',
    })
  })

  it('recognizes a plugin that imports a symbol this runtime lacks', async () => {
    // Seen in the wild: the install succeeds, then the loader fails with an
    // ESM SyntaxError naming a missing export. The declared engines cannot
    // catch this, so it needs its own cause rather than falling into unknown.
    const receipt = {
      stage: 'install',
      target: 'npm:huguangyu666/dsh-plugin-notify',
      changed: true,
      application: 'failed',
      error: {
        code: 'operation-error',
        diagnostic:
          "notify (dsh-plugin-notify): failed to import: SyntaxError: The requested module "
          + "'@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'",
      },
    }
    const adapter = new HostAdapter(
      manager({ installBundle: async () => receipt, waitForInstall: async () => null }),
    )
    const outcome = await adapter.install({ spec: 'npm:huguangyu666/dsh-plugin-notify', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', cause: 'incompatible-api' })
    expect(outcome).toHaveProperty('reason')
  })

  // A refusal whose log the host did not carry still has its code, and the
  // code must not degrade to the log tail (`Done in 1.0s`).
  it('falls back to the error code when the refusal line cannot be parsed', async () => {
    const odd = {
      stage: 'install',
      target: 'npm:odd@1.0.0',
      changed: false,
      application: 'failed',
      packageResult: { exitCode: 1, output: 'Done in 1.0s using pnpm v11.28.5\n' },
      error: { code: 'incompatible-version' },
    }
    const adapter = new HostAdapter(manager({ installBundle: async () => odd, waitForInstall: async () => null }))
    const outcome = await adapter.install({ spec: 'npm:odd@1.0.0', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'the plugin requires a dsh version this runtime does not provide' })
    expect('cause' in outcome).toBe(true)
  })

  it('turns an incompatibility refusal into the requirement that failed', async () => {
    const refusedForVersion = {
      stage: 'install',
      target: 'npm:dsh-wsl-bridge@0.4.8',
      changed: false,
      application: 'failed',
      packageResult: {
        exitCode: 1,
        output: 'dsh: installation rejected.\ndsh: restored package.json, pnpm-lock.yaml, and node_modules.\nDone in 1.3s\n',
        kind: 'unknown',
      },
      incompatible: [
        { name: 'dsh-wsl-bridge', version: '0.4.8', runtimeVersion: '0.2.1-rc.3', requirements: { 'engines.dsh': '>=0.2.2-rc.1' } },
      ],
      error: { code: 'incompatible-version' },
    }
    const adapter = new HostAdapter(manager({ installBundle: async () => refusedForVersion, waitForInstall: async () => null }))
    const outcome = await adapter.install({ spec: 'npm:dsh-wsl-bridge@0.4.8', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({
      status: 'failed',
      cause: 'incompatible-version',
      reason:
        'dsh-wsl-bridge 0.4.8 needs engines.dsh >=0.2.2-rc.1, which dsh 0.2.1-rc.3 does not provide — grant a version exemption or install a compatible version',
    })
  })

  it('falls back to the package manager kind when the host gives no diagnostic', async () => {
    const adapter = new HostAdapter(
      manager({
        installBundle: async () => ({ application: 'failed', packageResult: { exitCode: 1, kind: 'network' } }),
        // No settled receipt: the failure can only come from `installBundle`.
        waitForInstall: async () => null,
      }),
    )
    const outcome = await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'package manager: network' })
    expect('cause' in outcome).toBe(true)
  })

  it('fails an install whose package manager exited non-zero even if activation says nothing', async () => {
    const adapter = new HostAdapter(
      manager({
        installBundle: async () => ({ packageResult: { exitCode: 1, output: 'warn a\nERR disk full' } }),
        waitForInstall: async () => null,
      }),
    )
    const outcome = await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'ERR disk full' })
    expect('cause' in outcome).toBe(true)
  })

  // Observed verbatim in a live run: several hundred `Progress:` lines, a
  // wall of `[WARN]` noise, and the verdict at the very end. Echoing that into
  // the progress row buried the only sentence worth reading.
  const noisyOutput = [
    '✓ Lockfile passes supply-chain policies',
    'Progress: resolved 1, reused 0, downloaded 0, added 0',
    'Progress: resolved 419, reused 26, downloaded 58, added 6',
    '[WARN] Tarball download average speed 22 KiB/s (size 28 KiB) is below 50 KiB/s',
    'Packages: +270 -6',
    '++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++--',
    'dependencies:',
    '+ @eduwork/dsh-knowledge-studio 0.6.4',
    '- @linxin666/dsh-remote-web-ui 0.4.16',
    '',
    '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.1',
    '',
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
    '',
  ].join('\n')

  it('names the pnpm error instead of echoing its progress log', async () => {
    const adapter = new HostAdapter(
      manager({
        installBundle: async () => ({ packageResult: { exitCode: 1, output: noisyOutput, kind: 'build-blocked' } }),
        waitForInstall: async () => null,
      }),
    )
    const outcome = await adapter.install({ spec: 'npm:@eduwork/dsh-knowledge-studio', approvedBuilds: [], requestId: 'r' })
    expect(outcome.status).toBe('failed')
    expect(outcome).toMatchObject({
      status: 'failed',
      cause: 'package-manager',
      reason:
        'ERR_PNPM_IGNORED_BUILDS: a dependency wanted to run a build script the profile had not approved',
    })
  })

  it('uses the last meaningful line when the log carries no pnpm code', async () => {
    const adapter = new HostAdapter(
      manager({
        installBundle: async () => ({
          packageResult: { exitCode: 1, output: 'Progress: resolved 3\n[WARN] noisy\nENOTFOUND registry.npmjs.org\n' },
        }),
        waitForInstall: async () => null,
      }),
    )
    const outcome = await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })
    expect(outcome).toMatchObject({ status: 'failed', reason: 'ENOTFOUND registry.npmjs.org' })
    expect('cause' in outcome).toBe(true)
  })

  it('does not fail an install the host merely allowed to restart', async () => {
    const adapter = new HostAdapter(
      manager({
        installBundle: async () => ({ changed: true, application: 'restart-required', stage: 'install', target: 'pkg' }),
        waitForInstall: async () => null,
      }),
    )
    expect(await adapter.install({ spec: 'npm:pkg', approvedBuilds: [], requestId: 'r' })).toEqual({ status: 'ok' })
  })
})

describe('cancel', () => {
  it('reports the host verdict', async () => {
    const adapter = new HostAdapter(manager({ cancelInstall: async () => 'too-late' }))
    expect(await adapter.cancel('r')).toBe('too-late')
  })

  it('falls back to too-late when the host cannot cancel', async () => {
    const { cancelInstall, ...rest } = manager()
    void cancelInstall
    expect(await new HostAdapter(rest).cancel('r')).toBe('too-late')
  })

  it('falls back to too-late when the host throws or answers nonsense', async () => {
    expect(
      await new HostAdapter(
        manager({
          cancelInstall: async () => {
            throw new Error('boom')
          },
        }),
      ).cancel('r'),
    ).toBe('too-late')
    expect(
      await new HostAdapter(manager({ cancelInstall: async () => 'whatever' as unknown as 'cancelled' })).cancel('r'),
    ).toBe('too-late')
  })
})

describe('has', () => {
  it('matches on the reported identity', async () => {
    const adapter = new HostAdapter(manager())
    expect(await adapter.has('@scope/dsh-memory')).toBe(true)
    expect(await adapter.has('@scope/other')).toBe(false)
  })
})
