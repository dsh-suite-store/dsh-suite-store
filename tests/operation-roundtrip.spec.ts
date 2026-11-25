/**
 * Every member state must survive a save/load round trip.
 *
 * `needs-restart` was missing from the parser's whitelist, so a member that was
 * disabled and queued for removal vanished from the record on the next read:
 * the user was told "restart to finish", restarted, and the row was simply
 * gone with no way to confirm anything had happened.
 *
 * Written as a loop over ALL states rather than a spot check for the one that
 * broke, so adding a state without teaching the parser about it fails here
 * instead of in production.
 */
import { describe, expect, it } from 'vitest'

import { parseOperation, type MemberState, type OperationRecord } from '../src/install/operation.ts'

/** Every MemberState, kept as a literal list on purpose: a `switch` that the
 * compiler checks would follow the type and could not go stale. */
const ALL_MEMBER_STATES: MemberState[] = [
  'pending',
  'running',
  'ok',
  'skipped',
  'skipped-build-denied',
  'needs-restart',
  'failed',
]

function recordWith(state: MemberState): OperationRecord {
  return {
    opId: 'op-1',
    kind: 'uninstall',
    bundleId: 'b',
    bundleVersion: '1.0.0',
    status: 'done',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    members: [{ key: 'alpha', id: 'npm:alpha', name: 'alpha', state }],
  } as unknown as OperationRecord
}

describe('an operation record survives a save/load round trip', () => {
  for (const state of ALL_MEMBER_STATES) {
    it(`keeps a member in state ${state}`, () => {
      const parsed = parseOperation(JSON.parse(JSON.stringify(recordWith(state))))
      expect(parsed?.members.map((member) => member.state)).toEqual([state])
    })
  }

  it('keeps a needs-restart member next to an ok one', () => {
    // The shape from the review: two members, one of them queued for removal.
    // Before the fix the record came back with one member and no explanation.
    const record = {
      ...recordWith('needs-restart'),
      members: [
        { key: 'alpha', id: 'npm:alpha', name: 'alpha', state: 'needs-restart' },
        { key: 'beta', id: 'npm:beta', name: 'beta', state: 'ok' },
      ],
    }
    const parsed = parseOperation(JSON.parse(JSON.stringify(record)))
    expect(parsed?.members.map((member) => member.state)).toEqual(['needs-restart', 'ok'])
  })
})
