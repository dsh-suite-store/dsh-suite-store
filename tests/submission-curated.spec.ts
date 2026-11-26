import { describe, expect, it, vi } from 'vitest'

import type { Transport, TransportResponse } from '../src/catalog/transport.ts'
import { CuratedIndex } from '../src/submission/curated.ts'

const INDEX = {
  plugins: [
    {
      owner: 'Alice',
      name: 'alpha',
      url: 'https://github.com/Alice/alpha',
      npm: '@alice/alpha',
      version: '2.0.0',
      description: { en: 'Alpha plugin', zh: '阿尔法插件' },
    },
    {
      owner: 'acme',
      name: 'beta#packages/beta',
      url: 'https://github.com/acme/beta/tree/main/packages/beta',
      npm: null,
      version: null,
      description: { en: 'Monorepo beta', zh: '单仓测试版' },
    },
    {
      owner: 'other',
      name: 'alphabet',
      url: 'https://github.com/other/alphabet',
      npm: 'alphabet',
      version: '1.0.0',
    },
  ],
}

function response(body: unknown, status = 200): TransportResponse {
  return {
    status,
    headers: {},
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function transportOf(...answers: Array<TransportResponse | Error>): Transport & { calls: number } {
  let call = 0
  return {
    calls: 0,
    async get() {
      this.calls += 1
      const answer = answers[Math.min(call, answers.length - 1)] ?? answers[0]!
      call += 1
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

describe('curated index search', () => {
  it('ranks exact and key matches before loose description matches', async () => {
    const index = new CuratedIndex({ transport: transportOf(response(INDEX)), sources: ['https://example.test/plugins.json'] })
    const hits = await index.search('alpha')
    expect(hits.map((hit) => hit.key)).toEqual(['Alice/alpha', 'other/alphabet'])
    expect(hits[0]).toMatchObject({ npm: '@alice/alpha', version: '2.0.0' })
  })

  it('searches npm names and returns the full monorepo reference', async () => {
    const index = new CuratedIndex({ transport: transportOf(response(INDEX)), sources: ['https://example.test/plugins.json'] })
    expect((await index.search('@alice/alpha'))[0]?.key).toBe('Alice/alpha')
    expect((await index.search('packages/beta'))[0]?.key).toBe('acme/beta#packages/beta')
  })
})

describe('installed plugin matching', () => {
  it('matches npm, git and case-folded references only against curated entries', async () => {
    const index = new CuratedIndex({ transport: transportOf(response(INDEX)), sources: ['https://example.test/plugins.json'] })
    const matches = await index.matchInstalled([
      { id: '@alice/alpha' },
      { id: 'github:acme/beta#packages/beta' },
      { id: 'not/in-index' },
    ])
    expect(matches.map((member) => member.key).sort()).toEqual([
      'Alice/alpha',
      'acme/beta#packages/beta',
    ])
  })

  it('deduplicates the same curated member reported under several host ids', async () => {
    const index = new CuratedIndex({ transport: transportOf(response(INDEX)), sources: ['https://example.test/plugins.json'] })
    const matches = await index.matchInstalled([
      { id: 'npm:@alice/alpha@2.0.0' },
      { id: '@alice/alpha' },
    ])
    expect(matches).toHaveLength(1)
  })
})

describe('curated index caching', () => {
  it('reuses one download inside the TTL and refreshes after it', async () => {
    let now = 1_000
    const transport = transportOf(response(INDEX))
    const index = new CuratedIndex({
      transport,
      sources: ['https://example.test/plugins.json'],
      ttlMs: 1_800_000,
      now: () => now,
    })
    await index.search('alpha')
    await index.search('beta')
    expect(transport.calls).toBe(1)
    now += 1_800_001
    await index.search('alpha')
    expect(transport.calls).toBe(2)
  })

  it('falls through to the next source when the first one fails', async () => {
    const transport = transportOf(new Error('offline'), response(INDEX))
    const index = new CuratedIndex({
      transport,
      sources: ['https://bad.test/plugins.json', 'https://good.test/plugins.json'],
    })
    expect((await index.search('alpha'))[0]?.key).toBe('Alice/alpha')
    expect(transport.calls).toBe(2)
  })
})