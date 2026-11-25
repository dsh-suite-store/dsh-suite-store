/**
 * The modal's focus-order rule.
 *
 * `aria-modal="true"` is a promise that the rest of the page is inert. A
 * keyboard user pressing Tab at the last focusable control inside the sheet
 * must wrap to the first, not walk into the grid behind the backdrop.
 *
 * Kept as a pure function rather than inside the key handler: this project has
 * no DOM test renderer, so a component-level assertion would be a string match
 * on JSX. The RULE is the part that can be wrong in a way a reader would notice,
 * and that is what the test drives.
 */

/** Where Tab from `active` should land. */
export type TabDestination = 'first' | 'last' | null

/**
 * @param options.active - currently focused element, or the sheet itself.
 * @param options.first - first tabbable control inside the sheet.
 * @param options.last - last tabbable control inside the sheet.
 * @param options.backwards - whether Shift was held.
 * @param options.sheetFocused - whether focus is on the sheet container itself.
 * @returns which control to jump to, or null when the browser's native order
 *   is already correct.
 */
export function wrapTab(options: {
  active: unknown
  first: unknown
  last: unknown
  backwards: boolean
  sheetFocused: boolean
}): TabDestination {
  const { active, first, last, backwards, sheetFocused } = options
  if (backwards && (active === first || sheetFocused)) return 'last'
  if (!backwards && active === last) return 'first'
  return null
}
