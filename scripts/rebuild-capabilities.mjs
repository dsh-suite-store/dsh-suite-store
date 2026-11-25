/**
 * Rebuilds the catalog's capability claims from the members' own shipped code.
 *
 * Why this exists: `capabilitySummary` on a card drives the warning badge
 * (`shell`, `fs-write`, `network` — `WARNING_CAPABILITIES` in
 * `src/catalog/types.ts`) and `capabilities[].sources` in the detail sheet
 * names which member wants what. The original words came from an
 * awesome-dsh-plugin snapshot that is not in this repository, so after
 * `fix-catalog-members.mjs` swapped six members the words described packages
 * that are no longer in the bundle. A warning a user cannot trace to a plugin
 * is a warning they learn to ignore (§5.5), so the claim has to be derived
 * again rather than inherited.
 *
 * Evidence: `.evidence/capability-scan.jsonl`, one line per package, produced by
 * `scripts/tmp-scan-capabilities.mjs` against the exact pinned version.
 *
 * Usage:
 *   node scripts/rebuild-capabilities.mjs           # report only
 *   node scripts/rebuild-capabilities.mjs --write   # rewrite data/index.json + data/bundles/*.json
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DATA = join(ROOT, 'data')
const EVIDENCE = join(ROOT, '..', '..', '.evidence', 'capability-scan.jsonl')
const WRITE = process.argv.includes('--write')

/**
 * A package whose behaviour the source scan cannot see, because it ships no
 * code of its own.
 *
 * `@next-ai-drawio/dsh` is a patch carrier: it mounts the official MCP client
 * and points it at `npx -y @next-ai-drawio/mcp-server@latest` (see its
 * `cordis.patch.yml`). The scan finds zero files, yet installing it does start a
 * process and reach the network — so the honest claim is the one the patch
 * file makes, and it is written here rather than silently dropped.
 */
const NO_CODE_OVERRIDES = {
  '@next-ai-drawio/dsh': {
    capabilities: ['network', 'shell'],
    why: 'patch carrier: mounts @deepseek-ai/dsh-mcp-client running `npx -y @next-ai-drawio/mcp-server@latest` (spawns a process, downloads from npm)',
  },
}

/**
 * Tags the scan reports for essentially every Cordis plugin and therefore
 * distinguish nothing.
 *
 * `host-runtime` means "registers with the host process", which is what being a
 * plugin *is* — it appeared on all 18 scanned packages. A permission list that
 * marks every bundle the same way is noise, and §5.5's point is that a claim a
 * user cannot act on is a claim they stop reading. Everything else the scan
 * finds stays, because it does vary between packages.
 */
const TAUTOLOGICAL = new Set(['host-runtime'])

/** One `{package, version, capabilities}` record per line of the evidence file. */
async function readScan() {
  const text = await readFile(EVIDENCE, 'utf8')
  const byPackage = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line)
    byPackage.set(record.package, record)
  }
  return byPackage
}

/** The npm package a member points at, from its id (`npm:<name>`). */
function packageOf(member) {
  const id = member.id ?? ''
  return id.startsWith('npm:') ? id.slice(4) : member.name
}

const scan = await readScan()
const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'))
const problems = []
const changes = []

// id → capabilities, resolved once per package so two members of the same
// package cannot disagree.
const capabilitiesOf = new Map()

function capabilitiesFor(member, version) {
  const npm = packageOf(member)
  const key = `${npm}@${version}`
  const cached = capabilitiesOf.get(key)
  if (cached !== undefined) return cached

  const override = NO_CODE_OVERRIDES[npm]
  if (override !== undefined) {
    capabilitiesOf.set(key, override.capabilities)
    return override.capabilities
  }
  const record = scan.get(npm)
  if (record === undefined) {
    problems.push(`${key}: no scan record in .evidence/capability-scan.jsonl`)
    return []
  }
  if (record.version !== version) {
    problems.push(`${key}: evidence is for ${record.version}`)
    return []
  }
  const capabilities = record.capabilities.filter((word) => !TAUTOLOGICAL.has(word))
  capabilitiesOf.set(key, capabilities)
  return capabilities
}

for (const card of index.bundles) {
  if (!Array.isArray(card.members)) {
    problems.push(`${card.id}: missing members`)
    continue
  }

  // One pass over the members: collect tag → sources, in the catalog's
  // alphabetical tag order so a diff between two runs is only real changes.
  const sources = new Map()
  for (const member of card.members) {
    for (const capability of capabilitiesFor(member, member.version)) {
      const list = sources.get(capability) ?? []
      list.push(member.name)
      sources.set(capability, list)
    }
  }
  const next = [...sources.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, list]) => ({ tag, sources: [...new Set(list)].sort() }))

  const before = JSON.stringify(card.capabilities ?? [])
  const after = JSON.stringify(next)
  if (before !== after) {
    changes.push(`${card.id}: ${next.length} capabilities (${next.map((entry) => entry.tag).join(', ')})`)
    card.capabilities = next
  }
  // The card's summary is the tag union, always — one derivation, one answer.
  const summary = next.map((entry) => entry.tag)
  if (JSON.stringify(card.capabilitySummary) !== JSON.stringify(summary)) {
    card.capabilitySummary = summary
  }
}

if (problems.length > 0) {
  // A silent empty capability list would make a bundle look harmless, which is
  // the one failure mode this script must not produce. NOTHING is written in
  // this case — the buffered detail writes are dropped with the run.
  console.error(problems.join('\n'))
  console.error(`rebuild-capabilities: ${problems.length} member(s) without evidence`)
  process.exitCode = 1
} else {
  if (WRITE) {
    index.generatedAt = new Date().toISOString()
    await writeFile(join(DATA, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }
  console.log(changes.length === 0 ? 'rebuild-capabilities: nothing to change' : changes.join('\n'))
  console.log(WRITE ? 'rebuild-capabilities: wrote data/index.json' : 'rebuild-capabilities: dry run (pass --write)')
}
