#!/usr/bin/env node
/**
 * Guard for the one line of `client/client.js` the host actually parses.
 *
 * The loader finds a client plugin by matching
 * `window.__ModuleLoader__.load({ id: "<name>"` in the emitted file, and it
 * answers that factory's `require` calls from its own module table. Both are
 * silent failure modes otherwise: a renamed banner produces "plugin did not
 * register its client", and an externalised dependency produces a `require`
 * of something the table has never heard of — at runtime, in the browser, for
 * the user. Neither shows up in type-checking or in the Node tests, so the
 * build checks the artifact itself.
 *
 * Run as `node scripts/check-client-banner.mjs [packageDir]`. Exits non-zero
 * with a specific complaint rather than a generic failure.
 *
 * The expected id comes from `package.json#name`, which is the same value
 * `tsdown.config.ts` writes into the banner (its `id` constant). They happen to
 * match today; if one is renamed alone this guard fails pointing at the banner,
 * which is why the two are noted as one identity in both files.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The package root, so the script works from any working directory.
 *
 * The optional `[packageDir]` argument documented in the usage line is real
 * now: before this it was ignored, so a caller asking to check another build
 * silently had this repo's artifact checked instead.
 */
const packageRoot = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

/**
 * Modules the loader's module table can answer; everything else must be inlined.
 *
 * Must mirror `CLIENT_EXTERNALS` in `tsdown.config.ts` — a name listed there
 * but missing here fails the build for a `require` the table really can
 * answer, which is a false positive that costs a debugging round. Only the two
 * `react` entries are ever emitted today; the other two document the table.
 */
const ALLOWED_REQUIRES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/**
 * The two entries the bundle unconditionally emits.
 *
 * Kept separate from the allow-list: "this id is permitted" and "this id must
 * be present" are different questions, and only these two are imported by the
 * source.
 */
const REQUIRED_REQUIRES = ['react', 'react/jsx-runtime']

const artifact = resolve(packageRoot, 'client/client.js')

let source
try {
  source = await readFile(artifact, 'utf8')
} catch (error) {
  console.error(`check-client-banner: cannot read ${artifact}: ${error.message}`)
  console.error('check-client-banner: run `npm run build:client` first')
  process.exit(1)
}

/** Collected complaints, reported together so one run shows every problem. */
const problems = []

/** Collapse runs of whitespace so formatting cannot fail a semantic check. */
const flat = source.replace(/\s+/g, ' ')

let manifest
try {
  manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`check-client-banner: cannot read ${packageRoot}/package.json: ${error.message}`)
  process.exit(1)
}
const { name } = manifest
if (typeof name !== 'string' || name === '') {
  console.error('check-client-banner: package.json has no usable "name" to check the banner against')
  process.exit(1)
}

const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}`
if (!flat.includes(banner)) {
  problems.push(`the banner must contain ${banner}`)
}

if (!flat.trimEnd().endsWith('return module.exports; } });')) {
  problems.push('the artifact must end with `return module.exports; } });`')
}

if (!flat.includes('var module = { exports: {} }; var exports = module.exports;')) {
  problems.push('the intro (var module = …) is missing, so the factory would return nothing')
}

// Require calls the factory makes — the only reachable ones, since the
// bundle is a single scope.
const requires = new Set([...source.matchAll(/\brequire\("([^"]+)"\)/g)].map((match) => match[1]))
for (const id of requires) {
  if (!ALLOWED_REQUIRES.has(id)) {
    problems.push(`client.js requires "${id}", which the loader's module table cannot answer`)
  }
}
for (const id of REQUIRED_REQUIRES) {
  // Both are referenced from JSX and hooks unconditionally, so a missing one
  // means externals were inlined — which would ship a second React.
  if (!requires.has(id)) {
    problems.push(`client.js never requires "${id}", which suggests externals were inlined`)
  }
}

// A stylesheet that failed to compile leaves components with undefined class
// names; that renders an unstyled page rather than an error.
if (!source.includes(`style[data-plugin-css=`)) {
  problems.push('no CSS Modules sheet is injected by the bundle')
}

if (problems.length > 0) {
  console.error('check-client-banner: client/client.js is not loadable as a client plugin:')
  for (const problem of problems) console.error(`  - ${problem}`)
  // `exitCode`, not `exit(1)`: a hard exit can truncate these lines when
  // stdout/stderr is a pipe, which is exactly the report this script exists to
  // produce.
  process.exitCode = 1
} else {
  console.log(`check-client-banner: ok (${name}, requires: ${[...requires].sort().join(', ')})`)
}
