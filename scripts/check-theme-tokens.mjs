/**
 * Fail the build when the stylesheet reads a theme token the host does not
 * define.
 *
 * Why this is a build check and not a review checklist: a misspelled custom
 * property is invisible. `color: var(--dsw-alias-label-tertiary)` with no such
 * token resolves to the initial value, so the text renders in the browser's
 * default black — legible on a light theme, and an invisible black-on-black
 * smear on the dark one. It never throws, never logs, and looks fine on
 * whichever theme the author happened to be using.
 *
 * The authority is the theme bundle inside `app.asar` (403 tokens at the time
 * of writing), not a hand-copied list: a list drifts, and the drift is exactly
 * what this check exists to catch. `Theme.listTokens` from the Client inspect
 * provider publishes the CONTRACT; the bundle publishes the IMPLEMENTATION, and
 * a token must be in both to be safe to use.
 *
 * If the archive cannot be read (a source checkout without a built app), the
 * check degrades to a warning rather than failing a build for an environment
 * problem.
 *
 * Usage: node scripts/check-theme-tokens.mjs [<app.asar>] [<stylesheet>]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const STYLESHEET = process.argv[3] ?? resolve(HERE, '..', 'src', 'client', 'Store.module.css')
const THEME_ENTRY = '/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'

/**
 * Where the theme bundle might live, most explicit first.
 *
 * The archive is a property of the INSTALL, not of this package, so there is no
 * single portable absolute path for it: the environment variable and the
 * argument are the contract. The rest is discovered rather than hardcoded —
 * walking up from `scripts/` looking for `env/resources/app.asar` covers both
 * a checkout nested inside a harness tree and a sibling one. Hardcoding one
 * machine's path (as this did) made the guard a no-op everywhere else: it
 * printed a warning and exited 0, so a misspelled token sailed through the
 * build exactly where nobody was watching.
 */
function asarCandidates() {
  const explicit = process.argv[2] ?? process.env.DSH_APP_ASAR
  if (explicit !== undefined && explicit !== '') return [{ path: resolve(explicit), explicit: true }]
  const candidates = []
  // `DSH_HOME` is the documented way a machine says where the harness keeps its
  // data; a desktop install keeps the archive beside it under `resources/`.
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') candidates.push({ path: resolve(home, 'resources', 'app.asar') })
  // Then every ancestor: `<dsh>/projects/<x>/code/<x>/scripts` and
  // `<dsh>/plugins/<x>/scripts` both find `<dsh>/env/resources/app.asar`.
  let directory = HERE
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push({ path: join(directory, 'env', 'resources', 'app.asar') })
    candidates.push({ path: join(directory, 'resources', 'app.asar') })
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return candidates.map((candidate) => ({ ...candidate, explicit: false }))
}

/**
 * Every custom property the theme declares.
 *
 * @returns the set, or `undefined` when no archive is available here.
 *
 * An archive that reads but yields no token is NOT "no theme": it means the
 * entry path or the extraction regex has drifted, which is exactly the breakage
 * this check exists to catch, so it is reported as an error rather than being
 * folded into the "cannot read" warning. So is an explicitly named archive that
 * is missing — that is a misconfiguration, not an environment gap.
 */
function definedTokens() {
  const candidates = asarCandidates()
  const asar = candidates.find((candidate) => existsSync(candidate.path))
  if (asar === undefined) {
    const named = candidates.find((candidate) => candidate.explicit)
    if (named !== undefined) {
      console.error(`check-theme-tokens: no theme archive at ${named.path}`)
      console.error('Pass an existing <app.asar>, or unset it to skip the check in a source checkout.')
      process.exit(1)
    }
    console.warn(`check-theme-tokens: skipped — no theme archive found (looked in ${candidates.map((candidate) => candidate.path).join(', ')})`)
    console.warn('Pass <app.asar> as the first argument or set DSH_APP_ASAR to run the check.')
    return undefined
  }
  let source
  try {
    source = execFileSync(process.execPath, [join(HERE, 'asar-read.mjs'), asar.path, 'cat', THEME_ENTRY], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
  } catch (error) {
    console.error(`check-theme-tokens: cannot read ${THEME_ENTRY} from ${asar.path}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const tokens = new Set()
  for (const match of source.matchAll(/(--dsw-[a-z0-9-]+)\s*:/gu)) tokens.add(match[1])
  if (tokens.size === 0) {
    console.error(`check-theme-tokens: ${THEME_ENTRY} in ${asar.path} declares no --dsw-* tokens`)
    console.error('The entry path or the extraction pattern has drifted; the guard would pass vacuously.')
    process.exit(1)
  }
  return tokens
}

const known = definedTokens()
// `process.exit(0)` here would skip the success line below, so a passing run
// has to fall through to the report and decide there.
if (known !== undefined) {
  let css
  try {
    css = readFileSync(STYLESHEET, 'utf8')
  } catch (error) {
    console.error(`check-theme-tokens: cannot read ${STYLESHEET}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  // A read is a `var(--dsw-…)`; a declaration would be `--dsw-…:`, which this
  // stylesheet has no business making (the store consumes the host's tokens, it
  // does not own a palette).
  const missing = new Map()
  for (const match of css.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/gu)) {
    const name = match[1]
    if (!known.has(name)) missing.set(name, (missing.get(name) ?? 0) + 1)
  }

  if (missing.size > 0) {
    console.error(`check-theme-tokens: ${String(missing.size)} undefined token(s) in ${STYLESHEET}`)
    for (const [name, count] of missing) console.error(`  ${name}  (${String(count)}×)`)
    console.error('A custom property the theme does not define resolves to the initial value:')
    console.error('the surface renders in the browser default colour, which is invisible on one of the two themes.')
    process.exit(1)
  }

  console.log(`check-theme-tokens: ok (${String(known.size)} host tokens, ${STYLESHEET.split(/[\\/]/u).pop()} reads only defined ones)`)
}
