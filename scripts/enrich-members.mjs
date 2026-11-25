/**
 * Fill in each member's real description, repository link and star count.
 *
 * The catalog fixture was authored by hand, so a member carries only the key,
 * version and the bundle author's `reason`. The sheet shows the author's reason
 * FIRST (it answers "why is this in this bundle") and this description as the
 * fallback for rows without one, so a sheet whose members all carry a reason
 * would still render — but the card's member list and the package facts need
 * the registry data, which is what this script copies in rather than inventing.
 *
 * Both documents that carry members are written: `bundles/*.json` backs the
 * detail API, and `index.json` backs the cards — and the sheet draws the
 * CARD's member list. Enriching only one leaves the visible rows bare while
 * the API looks correct.
 *
 * Every value written here is traceable: the source is recorded in
 * `data/members.provenance.json` with the time it was read. A member the
 * registry does not know is left alone; the sheet then keeps showing the
 * author's reason and no link, which is honest, where a guessed URL would not
 * be.
 *
 * Usage: node scripts/enrich-members.mjs [--write]
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE = resolve(HERE, '..')
const DATA = join(PACKAGE, 'data')
const WRITE = process.argv.includes('--write')
const UA = { 'user-agent': 'dsh-suite-store-catalog (member enrichment)' }

/**
 * How the run went, by outcome.
 *
 * `unresolved` is the expected case (the registry genuinely does not know the
 * package); `failed` is the run's own problem (rate limiting, DNS, a timeout).
 * Collapsing the two into one `undefined` made a throttled run print the same
 * "without a registry entry" summary as a healthy one and still exit 0.
 */
const counts = { resolved: 0, unresolved: 0, failed: 0 }

/**
 * Registry answers by package name, star counts by `owner/repo`.
 *
 * The same member id appears in its bundle document AND in `index.json`, so
 * without this every package was fetched twice. Memoised rather than run
 * concurrently on purpose: GitHub's unauthenticated budget is 60 requests an
 * hour, and a `Promise.all` over ten members only reaches the limit faster.
 */
const registryCache = new Map()
const starCache = new Map()

/** One lookup per key per run, shared by every document naming that key. */
function cached(map, key, load) {
  let pending = map.get(key)
  if (pending === undefined) {
    pending = load()
    map.set(key, pending)
  }
  return pending
}

/** `npm:@scope/name` -> `@scope/name`; anything else -> undefined. */
function npmName(id) {
  return id.startsWith('npm:') ? id.slice(4) : undefined
}

/** `git:owner/repo#sub` -> `owner/repo`. */
function gitRepo(id) {
  if (!id.startsWith('git:')) return undefined
  return id.slice(4).split('#')[0]
}

/**
 * The registry's answer for one package, or undefined when it does not know it.
 *
 * A 404 is "unknown package" and stays quiet. Anything else — 429/403 from the
 * rate limit, a 5xx, a dropped connection — is counted as `failed` so the run
 * cannot report a broken lookup as a missing package.
 */
async function registry(pkg) {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}/latest`,
      { headers: UA },
    )
    if (response.ok) return await response.json()
    if (response.status !== 404) counts.failed += 1
    return undefined
  } catch {
    counts.failed += 1
    return undefined
  }
}

/** Stars for a `owner/repo`, or undefined when the API refuses or fails. */
async function stars(repo) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { ...UA, accept: 'application/vnd.github+json' },
    })
    if (response.ok) {
      const body = await response.json()
      if (typeof body.stargazers_count === 'number') return body.stargazers_count
    }
    // 404 for a repo that does not exist is not a failed run; a 403 is the
    // rate limit and is.
    if (response.status !== 404) counts.failed += 1
    return undefined
  } catch {
    counts.failed += 1
    return undefined
  }
}

/** Normalize the shapes npm allows for `repository` down to an https page. */
function cleanRepoUrl(value) {
  if (value !== null && typeof value === 'object' && typeof value.url === 'string') {
    return cleanRepoUrlFromString(value.url)
  }
  if (typeof value === 'string') return cleanRepoUrlFromString(value)
  return undefined
}

function cleanRepoUrlFromString(raw) {
  let url = raw.trim()
  url = url.replace(/^git\+/u, '')
  url = url.replace(/^git:\/\//u, 'https://')
  url = url.replace(/^ssh:\/\/git@/u, 'https://')
  url = url.replace(/^git@github\.com:/u, 'https://github.com/')
  url = url.replace(/\.git$/u, '')
  return url.startsWith('https://') ? url : undefined
}

/** `owner/repo` out of a GitHub URL, for the stars call. */
function githubRepoOf(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/u.exec(url ?? '')
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

/** One member, enriched in place. */
async function enrichMember(member, provenance, counts, seen) {
  // A member object without an id used to throw out of `npmName` and kill the
  // whole run; the sibling maintainer scripts guard the same field.
  const id = typeof member.id === 'string' ? member.id : ''
  // A member that already carries everything costs no request. Stars are the
  // field that must keep retrying: a rate-limited stars call is the one thing
  // a later run can still fix.
  //
  // `seen` is recorded for EVERY member this run walks, including the settled
  // ones that return immediately below — the provenance merge keeps the records
  // of the ids in `seen` and drops the rest, so a set that only holds freshly
  // fetched members would erase the whole file on a settled catalog.
  if (id !== '') seen.add(id)
  if (
    member.description !== undefined
    && member.repo !== undefined
    && member.npm !== undefined
    && member.stars !== undefined
  ) {
    return false
  }
  const pkg = npmName(id)
  const git = gitRepo(id)
  let description
  let repo
  let npmPage

  if (pkg !== undefined) {
    const meta = await cached(registryCache, pkg, () => registry(pkg))
    if (meta === undefined) {
      counts.unresolved += 1
    } else {
      if (typeof meta.description === 'string' && meta.description.trim() !== '') {
        // The registry ships English only. The field is still bilingual, so the
        // Chinese column is left empty and a Chinese reader gets the author's
        // reason (which always has both) rather than a machine translation.
        description = { en: meta.description.trim(), zh: '' }
      }
      // `repository` only. npm's `homepage` is frequently a docs site or a
      // project page, and writing it here puts a non-repository link behind
      // the sheet's "visit the repo" control — and makes `githubRepoOf` miss,
      // so the star count is dropped too.
      repo = cleanRepoUrl(meta.repository)
      npmPage = `https://www.npmjs.com/package/${pkg}`
      provenance[id] = { source: `https://registry.npmjs.org/${pkg}/latest`, readAt: new Date().toISOString() }
      counts.resolved += 1
    }
  } else if (git !== undefined) {
    repo = `https://github.com/${git}`
    provenance[id] = { source: `https://github.com/${git}`, readAt: new Date().toISOString() }
    counts.resolved += 1
  } else {
    counts.unresolved += 1
  }

  const gh = githubRepoOf(repo)
  const starCount = gh === undefined ? undefined : await cached(starCache, gh, () => stars(gh))

  let changed = false
  if (description !== undefined && member.description === undefined) {
    member.description = description
    changed = true
  }
  if (repo !== undefined && member.repo === undefined) {
    member.repo = repo
    changed = true
  }
  if (npmPage !== undefined && member.npm === undefined) {
    member.npm = npmPage
    changed = true
  }
  if (starCount !== undefined && member.stars === undefined) {
    member.stars = starCount
    changed = true
  }
  return changed
}

let files
try {
  files = (await readdir(join(DATA, 'bundles'))).filter((name) => name.endsWith('.json'))
} catch (error) {
  console.error(`enrich: cannot read ${join(DATA, 'bundles')}: ${error.message}`)
  process.exit(1)
}
const provenance = {}
const seen = new Set()
let touched = 0
let failed = 0

/**
 * Every document with a member list, and how to reach those lists inside it.
 *
 * `index.json` nests them under `bundles[]`; a bundle document has one list at
 * the top level.
 */
const targets = [
  ...files.map((name) => ({
    path: join(DATA, 'bundles', name),
    lists: (document) => [document],
  })),
  {
    path: join(DATA, 'index.json'),
    lists: (document) => document.bundles ?? [],
  },
]

for (const target of targets) {
  let document
  try {
    document = JSON.parse(await readFile(target.path, 'utf8'))
  } catch (error) {
    // Reported per file rather than aborting: a malformed fourth document used
    // to leave the first three already rewritten and print a bare SyntaxError.
    console.error(`enrich: cannot read ${target.path}: ${error.message}`)
    failed += 1
    continue
  }
  let changed = false
  for (const list of target.lists(document)) {
    for (const member of list.members ?? []) {
      if (await enrichMember(member, provenance, counts, seen)) changed = true
    }
  }
  if (changed) {
    touched += 1
    if (WRITE) await writeFile(target.path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  }
}

if (WRITE) {
  // Merged, not replaced. A member this run could not reach (rate limit,
  // offline) keeps the record that explains the values already in the
  // fixtures, so the header's traceability claim survives a bad run. Records
  // for members no document names any more are dropped.
  const file = join(DATA, 'members.provenance.json')
  let previous = {}
  try {
    previous = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // No previous file (first run) or an unreadable one: start clean.
  }
  const kept = Object.fromEntries(Object.entries(previous).filter(([id]) => seen.has(id)))
  await writeFile(file, `${JSON.stringify({ ...kept, ...provenance }, null, 2)}\n`, 'utf8')
}

const failures = counts.failed + failed
// A throttled or half-readable run is not a green run: the caller (a
// maintainer, or CI) has to be able to tell it apart from a clean one.
if (failures > 0) process.exitCode = 1

console.log(
  `enrich: ${String(targets.length)} documents, ${String(touched)} changed, `
  + `${String(counts.resolved)} members resolved, ${String(counts.unresolved)} without a registry entry`
  + `${counts.failed === 0 ? '' : `, ${String(counts.failed)} lookup(s) failed (rate limit or network)`}`
  + `${failed === 0 ? '' : `, ${String(failed)} document(s) unreadable`}`
  + `${WRITE ? '' : ' (dry run; pass --write)'}`,
)
