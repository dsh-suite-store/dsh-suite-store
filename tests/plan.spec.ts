/**
 * Behavioural specs for the install planner.
 *
 * The planner is pure: it turns "this bundle, these already-installed plugins,
 * these known exemptions" into the exact list of steps the runtime will
 * execute. Keeping it pure is what makes the dangerous half of the plugin
 * testable at all — the executor's only remaining job is to run the plan and
 * unwind it on failure.
 */

import { describe, expect, it } from 'vitest'
import { parseBundleDetail } from '../src/catalog/types.ts'
import {
  InstallPlanError,
  buildInstallPlan,
  memberSpecId,
  sameIdentity,
  type InstalledMember,
} from '../src/install/plan.ts'

const rawDetail = {
  format: 1,
  id: 'fin-analyst-workstation',
  owner: 'someuser',
  version: '1.2.0',
  readme: { zh: '说明', en: 'readme' },
  capabilities: [],
  members: [
    {
      key: 'memory',
      id: 'npm:@scope/dsh-memory',
      name: '@scope/dsh-memory',
      version: '0.6.11',
      pinned: true,
      spec: 'npm:@scope/dsh-memory@0.6.11',
      reason: { zh: '记忆', en: 'memory' },
    },
    {
      key: 'log',
      id: 'git:someone/dsh-log#packages/log',
      name: 'someone/dsh-log',
      version: null,
      pinned: false,
      spec: 'git:someone/dsh-log#packages/log',
      reason: { zh: '汇报', en: 'worklog' },
    },
  ],
}

const detail = parseBundleDetail(rawDetail)

/** What the host says is already installed, keyed by the id the plan compares. */
function installed(...ids: string[]): InstalledMember[] {
  return ids.map((id) => ({ id }));
}

describe('buildInstallPlan', () => {
  it('plans every member in the order the author declared', () => {
    const plan = buildInstallPlan({ detail, installed: [], approvedBuilds: [] })
    expect(plan.steps.map((step) => step.spec)).toEqual([
      'npm:@scope/dsh-memory@0.6.11',
      'git:someone/dsh-log#packages/log',
    ])
  })

  it('skips a member that is already installed at the same version', () => {
    // Re-installing over a good copy costs a download and a few seconds of
    // "installing" that the user did not ask for; it also risks a remove step
    // that fails halfway.
    const plan = buildInstallPlan({ detail, installed: installed('npm:@scope/dsh-memory@0.6.11'), approvedBuilds: [] })
    expect(plan.steps.map((step) => step.spec)).toEqual(['git:someone/dsh-log#packages/log'])
    expect(plan.skipped).toEqual([{ key: 'memory', reason: 'already-installed' }])
  })

  it('still installs a member whose installed version differs', () => {
    const plan = buildInstallPlan({ detail, installed: installed('npm:@scope/dsh-memory@0.5.0'), approvedBuilds: [] })
    expect(plan.steps).toHaveLength(2)
  })

  it('treats a floating (unpinned) member as satisfied by any installed version', () => {
    // D18: an unpinned member means "whatever the registry says". If the user
    // already has one, re-resolving it would silently upgrade them.
    // The fixture spells the host's git identity with a dash instead of a
    // slash, and it is still the same plugin: only the trailing repo segment
    // and the subdirectory matter for matching.
    const plan = buildInstallPlan({
      detail,
      installed: installed('git:someone/dsh-log'),
      approvedBuilds: [],
    })
    expect(plan.steps.map((step) => step.spec)).toEqual(['npm:@scope/dsh-memory@0.6.11'])
  })

  it('refuses when every member is already installed — there is nothing to do', () => {
    expect(() =>
      buildInstallPlan({
        detail,
        installed: installed('npm:@scope/dsh-memory@0.6.11', 'git:someone/dsh-log'),
        approvedBuilds: [],
      }),
    ).toThrow(InstallPlanError)
  })

  it('threads the build approvals for members that need them', () => {
    // A member whose install script needs approval must carry it in the step;
    // the host rejects the install otherwise, and the failure arrives AFTER
    // the previous members were already installed.
    const plan = buildInstallPlan({
      detail,
      installed: [],
      approvedBuilds: ['@scope/dsh-memory'],
    })
    expect(plan.steps[0].approvedBuilds).toEqual(['@scope/dsh-memory'])
    expect(plan.steps[1].approvedBuilds).toEqual([])
  })

  it('plans nothing when the bundle has no members', () => {
    expect(() => buildInstallPlan({ detail: { ...detail, members: [] }, installed: [], approvedBuilds: [] }))
      .toThrow(/no members/u)
  })
})

describe('memberSpecId', () => {
  it('is the spec, because that is the identity the host reports back', () => {
    expect(memberSpecId(detail.members[0])).toBe('npm:@scope/dsh-memory@0.6.11')
  })

  it('collapses a git spec to a stable id the host also reports', () => {
    // The host reports git installs as `owner/repo` plus a subdirectory, not
    // as the spec string with a `git:` prefix.
    expect(memberSpecId(detail.members[1])).toBe('someone/dsh-log')
  })
})

describe('sameIdentity — git host spellings', () => {
  it('matches a catalog git id against the bare package name the host reports', () => {
    // dsh-perlica-ding is declared as `git:117BS/dsh-perlica-ding` in the
    // catalog but the host reports it as the package name `dsh-perlica-ding`.
    // Missing this left git members unrecognised: the store showed 0 installed
    // for a bundle whose member was present, and uninstall preview omitted it.
    expect(sameIdentity('git:117BS/dsh-perlica-ding', 'dsh-perlica-ding')).toBe(true)
  })

  it('matches the github: / git+https spellings and a subdirectory fragment', () => {
    expect(sameIdentity('git:someone/dsh-log#packages/log', 'github:someone/dsh-log')).toBe(true)
    expect(sameIdentity('git:someone/dsh-log', 'git+https://github.com/someone/dsh-log.git')).toBe(true)
    expect(sameIdentity('git:someone/dsh-log', 'someone/dsh-log')).toBe(true)
  })

  it('folds owner case for git ids', () => {
    expect(sameIdentity('git:zhaiyateng/dsh-design-skills', 'github:ZhaiYaTeng/dsh-design-skills')).toBe(true)
  })

  it('does not fold ordinary package names by last path segment', () => {
    // Only git identities get the repo-basename fold. Two registry packages
    // whose names merely share a tail must stay distinct.
    expect(sameIdentity('npm:team-a/dsh-tools', 'team-b/dsh-tools')).toBe(false)
  })

  it('matches the store-side catalog identity forms for a git member', () => {
    const catalogId = 'git:117BS/dsh-perlica-ding'
    const hostId = 'dsh-perlica-ding'
    // store.ts builds these two identity lists for isPresent(); at least one
    // pair must compare equal now.
    const catalogIdentities = [catalogId, '117BS/dsh-perlica-ding']
    const hostIdentities = [hostId, 'github:117BS/dsh-perlica-ding']
    expect(
      catalogIdentities.some((a) => hostIdentities.some((b) => sameIdentity(a, b))),
    ).toBe(true)
  })
})
