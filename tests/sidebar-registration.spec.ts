/**
 * Both the `main` panel and the `sidebar.panellist` row must land on a cold
 * boot regardless of activation order.
 *
 * The live symptom: after a host restart the store's row was missing, and
 * toggling the page off and on brought it back. The desktop self-report gave
 * the actual cause:
 *
 *   "slot \"main\" is not declared (a parent entry's children table must
 *    declare it)"
 *
 * `main` and `sidebar.panellist` are children of `root`, declared by
 * `dsh-client-ui-layout` in its own `apply()`. Our fiber activates earlier in
 * the module graph, so a synchronous register throws and aborts the whole
 * mount — the sidebar row never even gets attempted. Toggling the page off
 * and on re-ran `apply()` after `root` existed.
 *
 * This spec pins the contract: registration is deferred, retried until both
 * slots are declared, never duplicated, and disposed on unload.
 */

import { describe, expect, it } from 'vitest'

/** A fake slots service: a child slot refuses registration until declared. */
function fakeSlots() {
  const declared = new Set<string>()
  const rows = new Map<string, Record<string, unknown>[]>()
  let registrations = 0

  return {
    get registrations(): number { return registrations },
    declare(key: string): void { declared.add(key) },
    entries(name: string): { options: Record<string, unknown> }[] {
      return (rows.get(name) ?? []).map((options) => ({ options }))
    },
    register(options: Record<string, unknown>): () => void {
      const key = String(options.name)
      if (!declared.has(key)) throw new Error(`slot '${key}' is not declared`)
      const list = rows.get(key) ?? []
      list.push(options)
      rows.set(key, list)
      registrations += 1
      return () => {
        rows.set(key, (rows.get(key) ?? []).filter((entry) => entry !== options))
      }
    },
  }
}

/** Mirrors the deferred pass in `mount()` so the retry policy is tested. */
function ensurePage(slots: ReturnType<typeof fakeSlots>, maxAttempts = 20) {
  const panelOptions = { name: 'main', key: 'dsh-suite-store' }
  const rowOptions = { name: 'sidebar.panellist', id: 'dsh-suite-store' }
  let offPanel: (() => void) | void
  let offRow: (() => void) | void
  let panelSettled = false
  let rowSettled = false
  let retired = false
  const keyed = (name: string, key: string): boolean =>
    slots.entries(name).some((entry) => entry.options.key === key)
  const rowLanded = (): boolean =>
    slots.entries('sidebar.panellist').some((entry) => entry.options.id === 'dsh-suite-store')

  const pass = (): void => {
    if (retired) return
    if (!panelSettled) {
      if (typeof offPanel === 'function') offPanel()
      offPanel = undefined
      if (keyed('main', 'dsh-suite-store')) panelSettled = true
      else {
        try {
          offPanel = slots.register(panelOptions)
          // A registry the host does not expose cannot be inspected, so a
          // successful register IS the settled answer — otherwise every retry
          // pass disposes and re-registers the panel, resetting live UI.
          panelSettled = slots.entries === undefined ? true : keyed('main', 'dsh-suite-store')
        } catch { /* parent not declared yet */ }
      }
    }
    if (!rowSettled) {
      if (rowLanded()) rowSettled = true
      else {
        if (typeof offRow === 'function') offRow()
        offRow = undefined
        try {
          offRow = slots.register(rowOptions)
          rowSettled = slots.entries === undefined ? true : rowLanded()
        } catch { /* parent not declared yet */ }
      }
    }
  }
  for (let attempt = 0; attempt <= maxAttempts && !retired && !(panelSettled && rowSettled); attempt += 1) pass()
  return {
    get settled(): boolean { return panelSettled && rowSettled },
    retire(): void {
      retired = true
      if (typeof offRow === 'function') offRow()
      if (typeof offPanel === 'function') offPanel()
    },
  }
}

describe('cold-boot panel and sidebar row', () => {
  it('lands both immediately when root is already declared', () => {
    const slots = fakeSlots()
    slots.declare('main')
    slots.declare('sidebar.panellist')
    const page = ensurePage(slots)
    expect(page.settled).toBe(true)
    expect(slots.registrations).toBe(2)
    expect(slots.entries('main')).toHaveLength(1)
    expect(slots.entries('sidebar.panellist')).toHaveLength(1)
  })

  it('survives a too-early first pass and lands once root is declared', () => {
    const slots = fakeSlots()
    let page = ensurePage(slots)
    expect(page.settled).toBe(false)
    expect(slots.registrations).toBe(0)

    slots.declare('main')
    slots.declare('sidebar.panellist')
    page = ensurePage(slots)
    expect(page.settled).toBe(true)
    expect(slots.registrations).toBe(2)
  })

  it('never registers a twin when another mount already owns both entries', () => {
    const slots = fakeSlots()
    slots.declare('main')
    slots.declare('sidebar.panellist')
    slots.register({ name: 'main', key: 'dsh-suite-store' })
    slots.register({ name: 'sidebar.panellist', id: 'dsh-suite-store' })
    const page = ensurePage(slots)
    expect(page.settled).toBe(true)
    expect(slots.registrations).toBe(2)
    expect(slots.entries('main')).toHaveLength(1)
    expect(slots.entries('sidebar.panellist')).toHaveLength(1)
  })

  it('retiring removes both entries', () => {
    const slots = fakeSlots()
    slots.declare('main')
    slots.declare('sidebar.panellist')
    const page = ensurePage(slots)
    page.retire()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
  })
})
