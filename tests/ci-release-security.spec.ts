/**
 * The release pipeline must not expose NPM_TOKEN to repository code.
 *
 * The published package's bytes come from `pnpm pack` in a job that runs the
 * repository's own scripts. That job must therefore be SEPARATE from the one
 * that holds the credential: a build step can append `BASH_ENV=` to
 * $GITHUB_ENV (bash sources it before every later script in that job) or a fake
 * `npm` to $GITHUB_PATH, and a publish step in the same job would run through
 * the attacker's shell. Cleaning up is not a defence — the contamination has
 * already happened by then.
 *
 * These assertions are structural because that is the property that matters:
 * which job owns the token, and what that job is allowed to run.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const workflowPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml')

/** Parsed workflow. */
async function workflow(): Promise<{
  jobs: Record<string, { needs?: string; permissions?: Record<string, string>; steps?: Array<Record<string, unknown>> }>
  permissions?: Record<string, string>
}> {
  const { parse } = await import('yaml')
  return parse(readFileSync(workflowPath, 'utf8')) as never
}

describe('release credentials', () => {
  it('the job holding NPM_TOKEN runs no repository code', async () => {
    const doc = await workflow()
    const publish = doc.jobs.publish
    expect(publish).toBeDefined()

    // No checkout: nothing from the repository may be on disk in this job.
    const uses = (publish.steps ?? []).map((step) => String(step.uses ?? ''))
    expect(uses.some((entry) => entry.startsWith('actions/checkout'))).toBe(false)

    // No install and no build of repository code. Installing npm ITSELF
    // (`npm install -g npm@…`) is the one allowed install: it fetches a tool
    // from the registry, not a package from this repository, and the OIDC path
    // requires a newer CLI than Node 22 ships.
    for (const step of publish.steps ?? []) {
      const run = String(step.run ?? '')
      expect(run).not.toMatch(/\bpnpm (install|run)\b/u)
      expect(run).not.toMatch(/\bnpm (install|ci)\b(?!\s+-g\s+npm@)/u)
      expect(run).not.toMatch(/\bpnm (install|run)\b/u)
    }
  })

  it('the packaging job has no secret and does not publish', async () => {
    const doc = await workflow()
    const release = doc.jobs.release
    expect(JSON.stringify(release)).not.toMatch(/secrets\.NPM_TOKEN/u)
    for (const step of release.steps ?? []) {
      expect(String(step.run ?? '')).not.toMatch(/\bnpm publish\b/u)
    }
  })

  it('publish consumes the artifact the release job produced', async () => {
    const doc = await workflow()
    expect(doc.jobs.publish.needs).toBe('release')
    const uses = (doc.jobs.publish.steps ?? []).map((step) => String(step.uses ?? ''))
    expect(uses.some((entry) => entry.startsWith('actions/download-artifact'))).toBe(true)
  })

  it('the release job disables credential persistence and install scripts', async () => {
    const doc = await workflow()
    const steps = doc.jobs.release.steps ?? []
    const checkout = steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout'))
    const withOptions = checkout?.with as Record<string, unknown> | undefined
    expect(withOptions?.['persist-credentials']).toBe(false)

    const install = steps.find((step) => String(step.run ?? '').includes('pnpm install'))
    expect(String(install?.run ?? '')).toMatch(/--ignore-scripts/u)
  })

  it('declares the permissions each job needs, and no more', async () => {
    const doc = await workflow()
    // Workflow default stays read-only: a job that forgets to opt in must not
    // silently inherit write access.
    expect(doc.permissions).toEqual({ contents: 'read' })
    // `id-token: write` is what npm trusted publishing needs.
    expect(doc.jobs.publish.permissions?.['id-token']).toBe('write')
    // The packaging job must not carry write access to the repository.
    expect(doc.jobs.release.permissions?.['contents']).toBe('read')
  })

  it('publishes with OIDC when no token is configured', async () => {
    const doc = await workflow()
    const publish = (doc.jobs.publish.steps ?? []).find((step) => step.name === 'Publish')
    expect(publish).toBeDefined()
    const run = String(publish?.run ?? '')
    // The auth line is conditional, and the tokenless branch is explicit: a
    // fresh package needs a token once, and every publish after that should run
    // without one.
    expect(run).toMatch(/if \[ -n "\$\{NPM_TOKEN:-\}" \]/u)
    expect(run).toMatch(/using OIDC trusted publishing/u)
    // The publish target is the packed tarball, not a directory: a directory
    // would re-read `package.json` from whatever is on disk.
    expect(run).toMatch(/npm publish \.\/dsh-suite-store-\*\.tgz/u)
    expect(run).toMatch(/--ignore-scripts/u)
    expect(run).toMatch(/--registry https:\/\/registry\.npmjs\.org\//u)
  })

  it('every checkout in the workflow disables credential persistence', async () => {
    const doc = await workflow()
    for (const [name, job] of Object.entries(doc.jobs)) {
      for (const step of job.steps ?? []) {
        if (!String(step.uses ?? '').startsWith('actions/checkout')) continue
        const withOptions = step.with as Record<string, unknown> | undefined
        expect(withOptions?.['persist-credentials'], `${name}: checkout without persist-credentials:false`).toBe(false)
      }
    }
  })
})
