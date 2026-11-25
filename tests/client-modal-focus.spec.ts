/**
 * The modal's focus-order rule, exercised through the function the key handler
 * actually calls.
 */

import { describe, expect, it } from 'vitest'

import { wrapTab } from '../src/client/modal-focus.ts'

describe('wrapTab', () => {
  const first = { name: 'close' }
  const last = { name: 'uninstall' }
  const middle = { name: 'install' }

  it('wraps from the last control to the first on Tab', () => {
    expect(wrapTab({ active: last, first, last, backwards: false, sheetFocused: false })).toBe('first')
  })

  it('wraps from the first control to the last on Shift+Tab', () => {
    expect(wrapTab({ active: first, first, last, backwards: true, sheetFocused: false })).toBe('last')
  })

  it('wraps from the sheet itself to the last on Shift+Tab', () => {
    // The sheet is focused on open; Shift+Tab must not fall through to whatever
    // was focused before the modal opened.
    expect(wrapTab({ active: null, first, last, backwards: true, sheetFocused: true })).toBe('last')
  })

  it('leaves native order alone in the middle of the sheet', () => {
    expect(wrapTab({ active: middle, first, last, backwards: false, sheetFocused: false })).toBeNull()
    expect(wrapTab({ active: middle, first, last, backwards: true, sheetFocused: false })).toBeNull()
  })

  it('leaves Tab from the sheet alone so it reaches the first control', () => {
    expect(wrapTab({ active: null, first, last, backwards: false, sheetFocused: true })).toBeNull()
  })
})
