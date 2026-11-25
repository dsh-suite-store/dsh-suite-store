/**
 * The browser half of the exported log.
 *
 * The server can say what the store DID. It cannot say what the page looked
 * like, and the failures that are hardest to reproduce live exactly there: a
 * panel that rendered nothing, a plugin bundle that mounted twice, a browser
 * translation that replaced React's text nodes. Asking a non-developer to open
 * a console and paste an expression costs a day per question and is the step
 * where a report goes quiet.
 *
 * So the browser answers, in the artefact people already know how to produce.
 * Everything here is a FACT the reporter can hand over without judging it —
 * "portal containers: 2" is useful; "your bundle is double-loaded" would be a
 * guess printed in someone's face.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clientDiagnostics, loadCount, recordCrash, resetSelfCheck } from '../src/client/self-check.ts'

/**
 * A DOM just real enough for `clientDiagnostics`.
 *
 * A stub rather than a jsdom dependency: the module reads four things
 * (`documentElement`, `body`, two query selectors, `baseURI`) and this keeps the
 * suite free of a heavyweight environment for that.
 *
 * @param options.roots - how many store roots to report.
 * @returns the uninstall function.
 */
function stubDom(options: { roots?: number } = {}): () => void {
  const roots = options.roots ?? 1
  const documentElement = {
    classList: ['translated-ltr'],
    hasAttribute: () => false,
  }
  const stub = {
    body: { lastElementChild: null },
    documentElement,
    baseURI: 'http://127.0.0.1:3080/dsh/',
    querySelectorAll: (selector: string) => (
      selector.includes('root') ? Array.from({ length: roots }, () => ({})) : []
    ),
  }
  vi.stubGlobal('document', stub)
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:3080', pathname: '/dsh/' })
  vi.stubGlobal('navigator', { userAgent: 'test-agent' })
  return () => {
    vi.unstubAllGlobals()
  }
}

beforeEach(() => {
  resetSelfCheck()
})

afterEach(() => {
  resetSelfCheck()
  vi.unstubAllGlobals()
})

describe('loadCount', () => {
  it('counts one evaluation', () => {
    expect(loadCount()).toBe(1)
  })

  it('counts again when the module is evaluated a second time', () => {
    // Two React copies, two of every module singleton, two portal containers is
    // a specific hypothesis for "the buttons look present and do nothing": each
    // copy attaches delegated listeners to its own container.
    const again = (globalThis as { __dshSuiteStoreLoads?: number }).__dshSuiteStoreLoads ?? 0
    ;(globalThis as { __dshSuiteStoreLoads?: number }).__dshSuiteStoreLoads = again + 1
    expect(loadCount()).toBe(2)
  })
})

describe('clientDiagnostics', () => {
  it('reports the facts a report needs, without verdicts', () => {
    const restore = stubDom()
    try {
      const text = clientDiagnostics().join('\n')
      expect(text).toContain('client bundle evaluations: 1')
      expect(text).toContain('market roots in the document: 1')
      expect(text).toContain('document baseURI: http://127.0.0.1:3080/dsh/')
      expect(text).toContain('page translated by the browser: translated-ltr')
      expect(text).toContain('user agent: test-agent')
      // A verdict would read like "your bundle is broken"; a fact reads like this.
      expect(text).not.toMatch(/should be/iu)
    } finally {
      restore()
    }
  })

  it('includes a crash the boundary caught, because that is the first thing to read', () => {
    const restore = stubDom()
    try {
      recordCrash('boom', 'at StorePage', '2026-01-01T00:00:00.000Z')
      const text = clientDiagnostics().join('\n')
      expect(text).toContain('market UI crashed at: 2026-01-01T00:00:00.000Z')
      expect(text).toContain('market crash message: boom')
      expect(text).toContain('at StorePage')
    } finally {
      restore()
    }
  })

  it('says nothing about crashes when there were none', () => {
    const restore = stubDom()
    try {
      expect(clientDiagnostics().join('\n')).not.toContain('crashed')
    } finally {
      restore()
    }
  })

  it('works outside a browser by reporting nothing but a recorded crash', () => {
    // The module is also imported under Node (the error boundary's own tests).
    // There is no DOM to describe, but a crash the boundary caught is still a
    // fact, and it is the one line worth keeping.
    expect(clientDiagnostics()).toEqual([])
    recordCrash('boom', null, '2026-01-01T00:00:00.000Z')
    expect(clientDiagnostics().join('\n')).toContain('market crash message: boom')
  })
})
