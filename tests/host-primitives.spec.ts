/**
 * The host's UI primitives must be rendered as React elements, never called
 * as plain functions.
 *
 * A host Button/Checkbox/Tag is a real component and may use Hooks. Calling
 * it as `Host({...})` runs those hooks inside the store component's own
 * render. When a prop such as `loading` flips, a host component that changes
 * its hook count then throws "rendered fewer hooks than expected"; React
 * unmounts the whole tree and the main column goes blank with no way back.
 * That was the uninstall white-screen: the uninstall button is the only one
 * whose `loading` changes.
 *
 * The source-level assertion is the regression guard: a future edit that
 * returns to direct invocation fails here before it reaches a user.
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

/** A host primitive double whose render is observable. */
function HostDouble(props: Record<string, unknown>): ReactNode {
  void props
  return createElement('button', { type: 'button' }, 'ok')
}

describe('host primitives rendered as elements', () => {
  it('createElement defers invocation to React and carries the props', () => {
    const spy = vi.fn()
    const Wrapped = (props: Record<string, unknown>): ReactNode => {
      spy()
      return HostDouble(props)
    }
    const element = createElement(Wrapped, { loading: true, children: 'remove' })
    expect(element.type).toBe(Wrapped)
    expect(element.props).toMatchObject({ loading: true, children: 'remove' })
    // The decisive difference: React has not rendered it yet, so the host
    // component's hooks cannot run inside ours.
    expect(spy).not.toHaveBeenCalled()
  })

  it('ui.tsx renders every host primitive through createElement', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync(new URL('../src/client/ui.tsx', import.meta.url), 'utf8')
    for (const name of ['HostButton', 'HostCheckbox', 'HostInput', 'HostTag']) {
      expect(source).toContain(`createElement(${name}`)
    }
    // No direct invocation left: `return Host(...)` is the crash shape.
    expect(source).not.toMatch(/\breturn Host\w*\s*\(/)
  })
})
