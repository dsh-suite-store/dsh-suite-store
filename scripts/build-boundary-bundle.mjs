/**
 * Adds (or removes) the ten-member boundary bundle used to prove the install
 * path at the ceiling of §5.4.
 *
 * Why a script rather than a hand-edited entry: the card and its detail
 * document must agree member for member, and a card whose `detail` path has no
 * document behind it opens a sheet that silently falls back to the degraded
 * path. Both are generated here from the SAME member list, so they cannot
 * drift.
 *
 * The members are copied out of the shipped catalog rather than written by
 * hand: each one is already a real published plugin at a pinned version that
 * `.evidence/catalog-audit.json` recorded as `state: ok` against this host, and
 * copying keeps the ids and specs consistent with every other card.
 *
 * Usage:
 *   node scripts/build-boundary-bundle.mjs --write    # add the card
 *   node scripts/build-boundary-bundle.mjs --remove   # take it back out
 *   node scripts/build-boundary-bundle.mjs            # dry run, print the card
 *
 * `--index <path>` targets a different index document, which is how the
 * boundary card is tested without ever entering the shipped catalog:
 *
 *   node scripts/build-boundary-bundle.mjs --write --index data/index-boundary.json
 *
 * then point the profile's `catalogFile` at that path.
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(PACKAGE_DIR, 'data')
/**
 * The capability evidence for the ten members.
 *
 * A fixture under `data/fixtures/`, not a per-bundle document: the catalog is
 * one file now, so this is the only copy of "which member declares what" that
 * the boundary card can be derived from.
 */
const ACCEPTANCE_FIXTURE = join(DATA_DIR, 'fixtures', 'acceptance-run.json')

const ID = 'boundary-ten'

/**
 * Exactly ten, which is `MAX_BUNDLE_MEMBERS`.
 *
 * Chosen for spread rather than usefulness: a metering plugin, three web-UI
 * panels from one scope, two security plugins, a trace plugin, and three
 * document/creative plugins. Different publishers, different capability
 * profiles, and no two share an npm package — which is what makes a
 * ten-slot install exercise what a real one would.
 */
const MEMBER_NAMES = [
  'dsh-cost-meter',
  'dsh-web#packages/dsh-skill-explorer',
  'dsh-web#packages/dsh-git-graph',
  'dsh-web#packages/dsh-remote-web-ui',
  'cc-safety-net',
  'dsh-llm-trace',
  'dsh-auto-review',
  'EduWork#dsh-knowledge-studio',
  'dsh-univer-office',
  'dsh-novel-writer',
]

/** Slot keys, one per member, in the same order. */
const KEYS = [
  'cost',
  'skills',
  'git-graph',
  'remote',
  'safety',
  'trace',
  'review',
  'knowledge',
  'office',
  'novel',
]

/**
 * The member keys the SHIPPED catalog uses for the same plugins.
 *
 * A `key` is the card-side identity: `installedFrom` builds one `member.id →
 * member.key` map across every card and the last card wins, so a boundary
 * fixture that renamed `safety-net` to `safety` overwrote the shipped mapping
 * for that id and an install recorded by plugin id could be attributed to this
 * fixture's key. Reusing the shipped key keeps resume/uninstall targets stable
 * across catalogs — the slots are still distinct, which is all the boundary
 * test needs.
 */
function shippedKeyFor(member, index) {
  for (const card of index.bundles) {
    if (card.id === ID) continue
    for (const candidate of card.members) {
      if (candidate.id === member.id) return candidate.key
    }
  }
  return undefined
}

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const REMOVE = args.includes('--remove')
/**
 * Which index to write.
 *
 * `--index data/index-boundary.json` keeps the boundary card OUT of the shipped
 * catalog while still producing a document the store can be pointed at through
 * `catalogFile`. It has to live beside `index.json` because it is a self-contained
 * document now — there is no companion directory for it to resolve against.
 */
const indexAt = args.indexOf('--index')
const INDEX = indexAt === -1 || args[indexAt + 1] === undefined
  ? join(DATA_DIR, 'index.json')
  : resolve(args[indexAt + 1])

// The detail document always lands in `data/bundles`, and the store resolves a
// card's `detail` against the index's own directory — refusing a path that
// escapes it (`src/catalog/detail.ts` containment) rather than opening a
// degraded sheet. So an index outside `data/` could only ever carry a detail
// path that cannot resolve. Refuse the combination instead of writing it.
if (dirname(INDEX) !== DATA_DIR) {
  console.error(`build-boundary-bundle: --index must live in ${DATA_DIR}`)
  process.exit(1)
}

let index
try {
  index = JSON.parse(await readFile(INDEX, 'utf8'))
} catch (error) {
  console.error(`build-boundary-bundle: cannot read index ${INDEX}: ${error.message}`)
  process.exit(1)
}
if (!Array.isArray(index?.bundles) || index?.catalogRef == null || typeof index.catalogRef !== 'object') {
  console.error(`build-boundary-bundle: ${INDEX} has no bundles array / catalogRef`)
  process.exit(1)
}

if (REMOVE) {
  const before = index.bundles.length
  index.bundles = index.bundles.filter((card) => card.id !== ID)
  index.catalogRef.count = index.bundles.length
  if (before === index.bundles.length) {
    console.log(`build-boundary-bundle: nothing to remove (${before} cards)`)
  } else {
    await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    console.log(`build-boundary-bundle: removed ${ID} (${before} -> ${index.bundles.length} cards)`)
  }
  process.exit(0)
}

// Members are copied from the shipped cards, so their ids and specs are the
// ones the rest of the catalog already resolved against this host.
const byName = new Map()
for (const card of index.bundles) {
  if (card.id === ID) continue
  for (const member of card.members) if (!byName.has(member.name)) byName.set(member.name, member)
}

const missing = MEMBER_NAMES.filter((name) => !byName.has(name))
if (missing.length > 0) {
  console.error(`build-boundary-bundle: no shipped card lists ${missing.join(', ')}`)
  process.exit(1)
}

const members = MEMBER_NAMES.map((name, at) => {
  const source = byName.get(name)
  return {
    // The shipped catalog's own key when it has one (see `shippedKeyFor`), so
    // this fixture cannot overwrite the `member.id → member.key` map the page
    // builds across all cards.
    key: shippedKeyFor(source, index) ?? KEYS[at],
    name: source.name,
    id: source.id,
    version: source.version,
    pinned: source.pinned,
    spec: source.spec,
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.repo === undefined ? {} : { repo: source.repo }),
    ...(source.npm === undefined ? {} : { npm: source.npm }),
    ...(source.stars === undefined ? {} : { stars: source.stars }),
  }
})

const keys = new Set(members.map((member) => member.key))
if (keys.size !== members.length) throw new Error('duplicate slot key')

// The union of what the members ask for, which is what the card's warning
// badge reads. Filled in below from the same per-member data the detail
// document carries, so a tag can only come from one of the ten: taking a
// shipped card's whole summary pulled in every capability of every member on
// that card, including members this bundle does not contain.
const capabilitySummary = []

const card = {
  id: ID,
  owner: 'dsh-suite-store',
  version: '0.1.0',
  title: { zh: '十件套（边界测试）', en: 'Ten-pack (boundary test)' },
  summary: {
    zh: '恰好十个成员，用来验证成员数量上限下的安装、续装与卸载。',
    en: 'Exactly ten members, to exercise install, resume and uninstall at the member ceiling.',
  },
  category: { primary: 'getting-started', secondary: 'daily-driver' },
  tags: ['boundary', 'testing'],
  cover: null,
  // Date-only, like every other card in the file: full ISO stamps were the
  // only ones of their kind, and a consumer comparing raw strings ordered them
  // wrong. `index.generatedAt` is the snapshot's own date, so the card can never
  // claim content NEWER than the document that carries it (which is what a
  // hardcoded future date did, and any age/freshness computation then went
  // negative).
  publishedAt: index.catalogRef.updated,
  updatedAt: index.catalogRef.updated,
  memberCount: members.length,
  capabilitySummary,
  // Two of the ten pull native/dependency build scripts (knowledge-studio,
  // novel-writer), so this card is also the case that proves the §7.2
  // approval prompt appears before a run instead of failing mid-install.
  needsBuildApproval: true,
  members,
  // The sheet's body text, on the card: the catalog is one document now.
  readme: {
    zh: '这是边界测试数据，不是给用户装的整合包。它正好十个成员，用来把「成员数量上限」那条规则从头走一遍：一次装完、装一半、断点续装、一键卸载。\n\n十个成员来自不同的发布者，能力画像各不相同，且没有任何两个共用同一个 npm 包 —— 这样的十槽位安装才和真实情况一样。',
    en: 'Boundary test data, not a suite meant for users. It holds exactly ten members so the member ceiling can be walked end to end: install in one go, install halfway, resume, and uninstall in one press.\n\nTen members from different publishers with different capability profiles, and no two share an npm package — which is what makes a ten-slot install resemble a real one.',
  },
  // Filled in below, once the per-member capabilities are resolved.
  capabilities: [],
  health: { status: 'ok', checkedAt: index.catalogRef.updated, missing: [], deprecated: [] },
  // `coverage` 0 is deliberate, and documented here so it is not read as a
  // scoring bug: this card is boundary data, never ranked, and the shipped
  // catalog's cards all report 1 because every member was measured.
  score: { hotness: null, freshnessDays: 0, coverage: 0 },
}

// The per-member capability tags come from the OTHER cards, which already carry
// `{ tag, sources }`. Deriving them here is what makes the permission tooltip
// work: without sources the sheet shows a count of zero and no plugin names,
// which is the one thing that row exists to answer.
const capabilityByMember = new Map()
// Read once, outside the member loop: the acceptance-run fixture is ONE
// document, not one per member, and re-parsing it ten times was dead work.
let acceptance
try {
  acceptance = JSON.parse(await readFile(ACCEPTANCE_FIXTURE, 'utf8'))
} catch { /* a fixture that is not there simply contributes nothing */ }
for (const name of MEMBER_NAMES) {
  for (const capability of acceptance?.capabilities ?? []) {
    if (!(capability.sources ?? []).includes(name)) continue
    const set = capabilityByMember.get(name) ?? new Set()
    set.add(capability.tag)
    capabilityByMember.set(name, set)
  }
}
for (const existing of index.bundles) {
  if (existing.id === ID) continue
  for (const capability of existing.capabilities ?? []) {
    for (const source of capability.sources ?? []) {
      // The source may be a display label; only members of THIS bundle count.
      if (!MEMBER_NAMES.includes(source)) continue
      const set = capabilityByMember.get(source) ?? new Set()
      set.add(capability.tag)
      capabilityByMember.set(source, set)
    }
  }
}
const byTag = new Map()
for (const member of members) {
  for (const tag of capabilityByMember.get(member.name) ?? []) {
    const list = byTag.get(tag) ?? []
    list.push(member.name)
    byTag.set(tag, list)
  }
}
const capabilities = [...byTag.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([tag, sources]) => ({ tag, sources: [...new Set(sources)].sort() }))

// The card's badge reads the same tags its own `capabilities` names, so the two
// cannot disagree.
card.capabilities = capabilities
capabilitySummary.push(...capabilities.map((entry) => entry.tag))

// The card IS the document: no second file, and its members carry the human
// `reason` the sheet prints under each row.
card.members = members.map((member) => ({
  ...member,
  reason: {
    zh: `边界测试槽位 ${member.key}`,
    en: `Boundary test slot ${member.key}`,
  },
}))

if (!WRITE) {
  // The whole document, not a truncated blob: a dry run exists to be read, piped
  // or diffed, and `.slice(0, 1200)` cut the JSON mid-object into something that
  // could do none of the three. The note goes to stderr so `| jq` still receives
  // valid JSON and nothing else.
  console.log(JSON.stringify(card, null, 2))
  console.error(`build-boundary-bundle: dry run, ${String(members.length)} members; pass --write to add it.`)
  process.exit(0)
}

index.bundles = [...index.bundles.filter((entry) => entry.id !== ID), card]
index.catalogRef.count = index.bundles.length
await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`build-boundary-bundle: wrote ${ID} with ${String(members.length)} members (${index.bundles.length} cards)`)
