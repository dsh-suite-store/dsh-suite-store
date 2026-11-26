/**
 * Resolve suite members against the curated awesome-dsh-plugin index.
 *
 * The browser never receives the 15 MB upstream document. It asks this
 * server-side index for a small, ranked projection, and installed plugins are
 * included only when their host identity maps back to a curated entry.
 */

import type { Transport } from '../catalog/transport.ts'
import type { LocalizedText } from '../catalog/types.ts'
import type { InstalledEntry } from '../install/host.ts'
import { fileFromTarball } from '../catalog/tarball.ts'

/** One selectable member from the curated index. */
export interface CuratedMember {
  /** Canonical submission reference: `owner/name` or `owner/name#subpath`. */
  key: string
  owner: string
  name: string
  npm: string | null
  version: string | null
  url: string
  description?: LocalizedText
}

interface IndexedMember extends CuratedMember {
  foldedKey: string
  foldedNpm: string | null
  foldedBase: string
}

interface LoadedIndex {
  members: IndexedMember[]
  byRepo: Map<string, IndexedMember[]>
  byRepoBase: Map<string, IndexedMember[]>
  byNpm: Map<string, IndexedMember>
}

interface RegistryMetadata {
  version: string
  tarball: string
}

export interface CuratedIndexOptions {
  transport: Transport
  /** Ordered npm registries carrying the dsh-plugin-catalog package. */
  registries?: readonly string[]
  /** Ordered raw JSON fallbacks. Supplying only this disables package delivery. */
  sources?: readonly string[]
  ttlMs?: number
  now?: () => number
  timeoutMs?: number
  totalTimeoutMs?: number
  maxBytes?: number
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_TOTAL_TIMEOUT_MS = 45_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const PACKAGE_NAME = 'dsh-plugin-catalog'
const PACKAGE_FILE = 'package/plugins.json'
const METADATA_MAX_BYTES = 1024 * 1024
const TARBALL_MAX_BYTES = 12 * 1024 * 1024
const DEFAULT_REGISTRIES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
] as const
const DEFAULT_SOURCES = [
  'https://awesome-dsh-plugin.com/plugins.json',
  'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json',
] as const

const GIT_PREFIXES = [
  'git+https://github.com/',
  'git+http://github.com/',
  'git+ssh://git@github.com/',
  'git@github.com:',
  'https://github.com/',
  'http://github.com/',
  'github:',
  'git:',
] as const

const trim = (value: string): string => value.trim()

function localized(value: unknown): LocalizedText | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const en = typeof record['en'] === 'string' ? record['en'].trim() : ''
  const zh = typeof record['zh'] === 'string' ? record['zh'].trim() : ''
  if (en === '' && zh === '') return undefined
  return { en: en === '' ? zh : en, zh: zh === '' ? en : zh }
}

function repoBase(key: string): string {
  const hash = key.indexOf('#')
  return hash === -1 ? key : key.slice(0, hash)
}

function project(entry: Record<string, unknown>): CuratedMember | undefined {
  const owner = typeof entry['owner'] === 'string' ? entry['owner'].trim() : ''
  const name = typeof entry['name'] === 'string' ? entry['name'].trim() : ''
  if (owner === '' || name === '') return undefined
  const key = `${owner}/${name}`
  const npm = typeof entry['npm'] === 'string' && entry['npm'].trim() !== '' ? entry['npm'].trim() : null
  const version = typeof entry['version'] === 'string' && entry['version'].trim() !== '' ? entry['version'].trim() : null
  const url = typeof entry['url'] === 'string' && entry['url'].trim() !== ''
    ? entry['url'].trim()
    : `https://github.com/${repoBase(key)}`
  const description = localized(entry['description'])
  return {
    key,
    owner,
    name,
    npm,
    version,
    url,
    ...(description === undefined ? {} : { description }),
  }
}

function push(map: Map<string, IndexedMember[]>, key: string, member: IndexedMember): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [member])
  else if (!list.some((item) => item.key === member.key)) list.push(member)
}

function build(raw: unknown): LoadedIndex {
  const source = typeof raw === 'object' && raw !== null
    ? (raw as { plugins?: unknown }).plugins ?? raw
    : raw
  if (!Array.isArray(source)) throw new Error('plugin index is not an array')

  const members: IndexedMember[] = []
  const byRepo = new Map<string, IndexedMember[]>()
  const byRepoBase = new Map<string, IndexedMember[]>()
  const byNpm = new Map<string, IndexedMember>()
  const seen = new Set<string>()
  for (const item of source) {
    if (typeof item !== 'object' || item === null) continue
    const member = project(item as Record<string, unknown>)
    if (member === undefined) continue
    const foldedKey = member.key.toLowerCase()
    if (seen.has(foldedKey)) continue
    seen.add(foldedKey)
    const indexed: IndexedMember = {
      ...member,
      foldedKey,
      foldedNpm: member.npm?.toLowerCase() ?? null,
      foldedBase: repoBase(member.key).toLowerCase(),
    }
    members.push(indexed)
    push(byRepo, foldedKey, indexed)
    push(byRepoBase, indexed.foldedBase, indexed)
    if (indexed.foldedNpm !== null && !byNpm.has(indexed.foldedNpm)) {
      byNpm.set(indexed.foldedNpm, indexed)
    }
  }
  return { members, byRepo, byRepoBase, byNpm }
}

interface HostReference {
  /** Package or repository pair with its version removed. */
  base: string
  /** Monorepo suffix, including `#`. */
  suffix: string
  npm: boolean
}

function hostReference(id: string): HostReference {
  let value = trim(id)
  let npm = false
  if (/^npm:/iu.test(value)) {
    npm = true
    value = value.slice('npm:'.length)
  } else {
    for (const prefix of GIT_PREFIXES) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length)
        break
      }
    }
  }
  value = value.replace(/\/+$/u, '').replace(/\.git$/iu, '')
  const hash = value.indexOf('#')
  const suffix = hash === -1 ? '' : value.slice(hash)
  const withoutSuffix = hash === -1 ? value : value.slice(0, hash)
  const at = withoutSuffix.lastIndexOf('@')
  const base = at > 0 ? withoutSuffix.slice(0, at) : withoutSuffix
  return { base, suffix, npm: npm || base.startsWith('@') || !base.includes('/') }
}

function score(member: IndexedMember, query: string): number {
  if (member.foldedKey === query || member.foldedNpm === query) return 0
  if (member.foldedKey.startsWith(query)) return 1
  if (member.name.toLowerCase().startsWith(query)) return 2
  if (member.foldedNpm?.startsWith(query) === true) return 3
  if (member.foldedKey.includes(query)) return 4
  if (member.description?.en.toLowerCase().includes(query) === true) return 5
  if (member.description?.zh.toLowerCase().includes(query) === true) return 5
  return Number.POSITIVE_INFINITY
}

function publicMember(member: IndexedMember): CuratedMember {
  const { foldedKey: _foldedKey, foldedNpm: _foldedNpm, foldedBase: _foldedBase, ...visible } = member
  return visible
}

/** A cached, searchable projection of the curated plugin index. */
export class CuratedIndex {
  private readonly transport: Transport
  private readonly registries: readonly string[]
  private readonly sources: readonly string[]
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly totalTimeoutMs: number
  private readonly maxBytes: number
  private cached: { at: number; index: LoadedIndex; version?: string } | undefined
  private inflight: Promise<LoadedIndex> | undefined
  private lastFailure: { at: number; error: Error } | undefined

  constructor(options: CuratedIndexOptions) {
    this.transport = options.transport
    this.registries = options.registries ?? (options.sources === undefined ? DEFAULT_REGISTRIES : [])
    this.sources = options.sources ?? DEFAULT_SOURCES
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /** Search curated members by owner/repo, npm name, or description. */
  async search(query: string, limit = 20): Promise<CuratedMember[]> {
    const folded = query.trim().toLowerCase()
    if (folded === '') return []
    const index = await this.load()
    const capped = Math.max(1, Math.min(50, Math.trunc(limit)))
    return index.members
      .map((member) => ({ member, rank: score(member, folded) }))
      .filter((row) => Number.isFinite(row.rank))
      .sort((left, right) => left.rank - right.rank || left.member.foldedKey.localeCompare(right.member.foldedKey))
      .slice(0, capped)
      .map((row) => publicMember(row.member))
  }

  /**
   * Map host inventory ids to their curated entries.
   *
   * Both npm package identities and git install references are accepted. A
   * repository with multiple indexed monorepo subpackages returns every
   * candidate so the reader can choose the exact `#subpath`.
   */
  async matchInstalled(installed: readonly InstalledEntry[]): Promise<CuratedMember[]> {
    if (installed.length === 0) return []
    const index = await this.load()
    const found = new Map<string, IndexedMember>()
    const add = (member: IndexedMember | undefined): void => {
      if (member !== undefined) found.set(member.foldedKey, member)
    }
    for (const entry of installed) {
      const ref = hostReference(entry.id)
      const base = ref.base.toLowerCase()
      const suffix = ref.suffix.toLowerCase()
      if (ref.npm) add(index.byNpm.get(base))
      add(index.byRepo.get(`${base}${suffix}`)?.[0])
      if (suffix !== '') add(index.byRepo.get(`${base}${suffix}`)?.[0])
      for (const member of index.byRepoBase.get(base) ?? []) add(member)
      if (base.startsWith('@')) {
        const unscoped = base.slice(1)
        add(index.byRepo.get(`${unscoped}${suffix}`)?.[0])
        for (const member of index.byRepoBase.get(unscoped) ?? []) add(member)
      }
    }
    return [...found.values()]
      .sort((left, right) => left.foldedKey.localeCompare(right.foldedKey))
      .map(publicMember)
  }

  private async load(): Promise<LoadedIndex> {
    if (this.cached !== undefined && this.now() - this.cached.at < this.ttlMs) return this.cached.index
    if (this.lastFailure !== undefined && this.now() - this.lastFailure.at < 15_000) throw this.lastFailure.error
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.fetchIndex().then(({ index, version }) => {
      this.cached = { at: this.now(), index, ...(version === undefined ? {} : { version }) }
      this.lastFailure = undefined
      return index
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.lastFailure = { at: this.now(), error: failure }
      throw failure
    }).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /**
   * Prefer the compact npm tarball: about 6 MB compressed instead of the
   * 16–24 MB raw JSON, and every China mirror already carries it.
   */
  private async fetchIndex(): Promise<{ index: LoadedIndex; version?: string }> {
    const failures: string[] = []
    const started = this.now()
    const remaining = (): number => Math.max(1, this.totalTimeoutMs - (this.now() - started))
    const timeout = (): number => Math.min(this.timeoutMs, remaining())

    // Metadata is tiny. Racing every registry lets a global npm user and a
    // mainland npm-mirror user each choose the fastest live route without
    // waiting for the other region's host to time out.
    const metadataTimeout = Math.min(8_000, timeout())
    const attempts = this.registries.map((registry, index) =>
      this.fetchRegistryMetadata(registry, metadataTimeout).then(
        (metadata) => ({ index, registry, metadata }),
        (error: unknown) => {
          throw new Error(`${registry}: ${error instanceof Error ? error.message : String(error)}`)
        },
      ))
    const pending = new Set(attempts)
    while (pending.size > 0 && remaining() > 1) {
      let winner: { index: number; registry: string; metadata: RegistryMetadata }
      try {
        winner = await Promise.any([...pending])
      } catch (error) {
        if (error instanceof AggregateError) failures.push(...error.errors.map(String))
        else failures.push(error instanceof Error ? error.message : String(error))
        break
      }
      pending.delete(attempts[winner.index]!)
      try {
        const answer = await this.fetchPackage(winner.registry, winner.metadata, timeout())
        if (answer !== undefined) return answer
      } catch (error) {
        failures.push(`${winner.registry}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    for (const source of this.sources) {
      try {
        const response = await this.transport.get(source, {
          timeoutMs: timeout(),
          maxBytes: this.maxBytes,
          headers: { accept: 'application/json' },
        })
        if (response.status !== 200) {
          failures.push(`${source}: HTTP ${String(response.status)}`)
          continue
        }
        const parsed = JSON.parse(response.body.toString('utf8')) as unknown
        const index = build(parsed)
        if (index.members.length === 0) {
          failures.push(`${source}: parsed zero plugins`)
          continue
        }
        return { index }
      } catch (error) {
        failures.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`could not read the curated plugin index\n  ${failures.join('\n  ')}`)
  }

  private async fetchRegistryMetadata(registry: string, timeoutMs: number): Promise<RegistryMetadata> {
    const base = registry.replace(/\/+$/u, '')
    const metadataUrl = `${base}/${encodeURIComponent(PACKAGE_NAME)}/latest`
    const response = await this.transport.get(metadataUrl, {
      timeoutMs,
      maxBytes: METADATA_MAX_BYTES,
      headers: { accept: 'application/json' },
    })
    if (response.status !== 200) throw new Error(`metadata HTTP ${String(response.status)}`)
    const metadata = JSON.parse(response.body.toString('utf8')) as {
      version?: unknown
      dist?: { tarball?: unknown }
    }
    const version = typeof metadata.version === 'string' ? metadata.version : undefined
    const tarball = typeof metadata.dist?.tarball === 'string' ? metadata.dist.tarball : undefined
    if (version === undefined || tarball === undefined) throw new Error('metadata names no version or tarball')
    return { version, tarball }
  }

  private async fetchPackage(
    registry: string,
    metadata: RegistryMetadata,
    timeoutMs: number,
  ): Promise<{ index: LoadedIndex; version: string } | undefined> {
    if (this.cached?.version === metadata.version) return { index: this.cached.index, version: metadata.version }
    const response = await this.transport.get(metadata.tarball, {
      timeoutMs,
      maxBytes: TARBALL_MAX_BYTES,
      headers: { accept: 'application/octet-stream' },
    })
    if (response.status !== 200) throw new Error(`tarball HTTP ${String(response.status)}`)
    const body = fileFromTarball(response.body, PACKAGE_FILE)
    if (body === undefined) throw new Error(`package carries no ${PACKAGE_FILE}`)
    const index = build(JSON.parse(body.toString('utf8')) as unknown)
    if (index.members.length === 0) throw new Error('package parsed zero plugins')
    return { index, version: metadata.version }
  }
}