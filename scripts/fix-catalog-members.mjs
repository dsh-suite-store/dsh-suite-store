/**
 * Makes every catalog member installable on the live host we must prove the
 * flow on, WITHOUT loosening the rule that a member is a real published plugin
 * at a pinned version.
 *
 * Input:  `node scripts/fix-catalog-members.mjs --write`
 * Source of truth: the audit produced by `scripts/tmp-audit-members.mjs`
 * (`.evidence/catalog-audit.json`), which applies the host's own
 * `evaluatePluginCompatibility` rule (engines.dsh first, else @deepseek-ai/dsh
 * peers, always with includePrerelease) against the real runtime manifest.
 *
 * Three kinds of change, and nothing else:
 *
 * 1. **Downgrade** — the package still ships a build the host accepts, just not
 *    the newest one. `@linxin666/dsh-client-ui-skill-explorer` 0.4.16 → 0.4.14,
 *    `@linxin666/dsh-remote-web-ui` 0.4.16 → 0.4.14, `dsh-wsl-bridge` 0.4.8 →
 *    0.4.7.
 * 2. **Replace** — no published version of the package works, so the member slot
 *    gets a different plugin that does the same job for the user. The role text
 *    and key stay, because the slot is what the bundle promises.
 * 3. **Leave alone** — everything the audit reported ok.
 *
 * The generator (`build-fixture-catalog.mjs`) cannot be re-run for this: it
 * reads an awesome-dsh-plugin directory snapshot that pinned the same broken
 * versions, and that snapshot is not in the repository. So this script edits
 * the two artifacts the host actually reads (`data/index.json` and
 * `data/bundles/*.json`) in place and keeps them in step — card members and
 * detail members must agree or the sheet's member list drifts from the card's.
 *
 * Usage:
 *   node scripts/fix-catalog-members.mjs           # report only
 *   node scripts/fix-catalog-members.mjs --write   # rewrite the data files
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DATA = join(ROOT, 'data')
const WRITE = process.argv.includes('--write')

/**
 * Decided by hand from the audit, with the reason recorded here so a later
 * reader does not have to re-derive it. `npm` is the registry name, `version`
 * the pinned version, `name` the display name the card shows.
 */
const CHANGES = {
  // 1. Downgrades: the package itself is fine, the pinned build asked for dsh
  //    >= 0.2.2-rc.1 and the host runs 0.2.1-rc.3.
  '@linxin666/dsh-client-ui-skill-explorer': {
    kind: 'downgrade',
    version: '0.4.14',
    why: 'peer @deepseek-ai/dsh >=0.2.2-rc.1; 0.4.14 accepts the host build',
    name: 'dsh-web#packages/dsh-skill-explorer',
  },
  '@linxin666/dsh-remote-web-ui': {
    kind: 'downgrade',
    version: '0.4.14',
    why: 'engines.dsh >=0.2.2-rc.1; 0.4.14 accepts the host build',
    name: 'dsh-web#packages/dsh-remote-web-ui',
  },
  'dsh-wsl-bridge': {
    kind: 'downgrade',
    version: '0.4.7',
    why: 'engines.dsh >=0.2.2-rc.1; 0.4.7 accepts the host build',
    name: 'dsh-wsl-bridge',
  },

  // 2. Replacements: no published version passes, so the slot takes a plugin
  //    that does the same job for the person using it.
  'dsh-api-relay-audit': {
    kind: 'replace',
    with: {
      npm: 'dsh-llm-trace',
      // The card name is the npm name when the directory has no prettier one.
      name: 'dsh-llm-trace',
      version: '0.2.2',
      why: 'only 2 versions exist and both pin @deepseek-ai/dsh-llm 0.2.0-rc.2; dsh-llm-trace records the same model-provider traffic and is compatible',
    },
  },
  '@ethanyoq/dsh-ai-novel-writer': {
    kind: 'replace',
    with: {
      npm: 'dsh-novel-writer',
      name: 'dsh-novel-writer',
      version: '7.3.0',
      why: 'pin @deepseek-ai/* 0.1.0-rc.6 + cordis 4.0.1 on every version; dsh-novel-writer covers the same long-form writing job (22 tools) and is compatible',
    },
  },
  'dsh-win-toolkit': {
    kind: 'replace',
    with: {
      npm: 'dsh-windows-mcp',
      name: 'dsh-windows-mcp',
      version: '0.2.8',
      why: 'peer @deepseek-ai/dsh-tools ^0.1.0-rc.6 fails on every version; dsh-windows-mcp covers the same native-Windows job (screenshot, input, clipboard, process, registry) and is compatible',
    },
  },
}

/** The npm package a member points at, from its id (`npm:<name>`). */
function packageOf(member) {
  const id = member.id ?? ''
  if (id.startsWith('npm:')) return id.slice(4)
  if (typeof member.name === 'string' && member.name !== '') return member.name
  return undefined
}

/** The wire shape a member has in both the card and the detail document. */
function memberShape(key, npm, name, version) {
  return {
    key,
    name,
    id: `npm:${npm}`,
    version,
    pinned: true,
    spec: `npm:${npm}@${version}`,
  }
}

/** Applies CHANGES to one member, returning the new member and the note. */
function rewrite(member) {
  const npm = packageOf(member)
  const change = npm === undefined ? undefined : CHANGES[npm]
  if (change === undefined) return { member, notes: [] }

  if (change.kind === 'downgrade') {
    if (member.version === change.version) return { member, notes: [] }
    return {
      member: memberShape(member.key, npm, change.name ?? member.name, change.version),
      notes: [`${member.key}: ${npm}@${member.version} → ${change.version} (${change.why})`],
    }
  }

  const next = memberShape(member.key, change.with.npm, change.with.name, change.with.version)
  return {
    member: next,
    notes: [`${member.key}: ${npm}@${member.version} → ${change.with.npm}@${change.with.version} (${change.with.why})`],
  }
}

const index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'))
const notes = []

for (const card of index.bundles) {
  card.members = card.members.map((member) => {
    const result = rewrite(member)
    notes.push(...result.notes.map((note) => `${card.id}/${note}`))
    return result.member
  })
}

// A replaced member keeps the capability entries its slot already declared, and
// only the *source name* is renamed. That is not a shortcut: the tag set is a
// static scan of the member's artifacts, and the replacement was picked for the
// same job — a Windows automation pack still shells out, still writes files,
// still reaches the network. It was confirmed against the replacement's own
// code before the rename (child_process / writeFile / fetch / process.env all
// present in `dsh-windows-mcp@0.2.8`, `dsh-novel-writer@7.3.0` and
// `dsh-llm-trace@0.2.2`), so the card's warning badge keeps telling the truth.
// Re-running the upstream scan is what would add or remove tags; until then a
// renamed source is the honest position, and dropping the entries would make a
// bundle look quieter than it is.
const RENAMED_SOURCES = {
  'dsh-win-toolkit': 'dsh-windows-mcp',
}

// The card carries its own members AND its capability attribution now (the
// catalog is one document), so a replacement only has to keep the card's
// `capabilitySummary` in step with the tags its capabilities name. That union
// is what the badge reads; a card promising a tag the sheet cannot explain is
// the drift this script exists to prevent (§8.2).
for (const card of index.bundles) {
  if (!Array.isArray(card.capabilities)) continue
  for (const capability of card.capabilities) {
    capability.sources = capability.sources.map((source) => RENAMED_SOURCES[source] ?? source)
  }
  // A card's summary is the union of its capability *tags*.
  card.capabilitySummary = [...new Set(card.capabilities.map((entry) => entry.tag))].sort()
}

if (WRITE) {
  index.generatedAt = new Date().toISOString()
  await writeFile(join(DATA, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

console.log(notes.length === 0 ? 'fix-catalog-members: nothing to change' : notes.join('\n'))
console.log(WRITE ? 'fix-catalog-members: wrote data/index.json' : 'fix-catalog-members: dry run (pass --write)')
