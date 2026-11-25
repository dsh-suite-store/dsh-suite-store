import { configDefaults, defineConfig } from 'vitest/config'

// Unit lane: fast, no network, no real pluginManager. Every spec drives a
// substitute (a recording fake runtime / a stub fetch), so a green run means
// the logic agrees with OUR model of the host. `tests/e2e-cycle.spec.ts` and
// the host specs cover the paths where that model was checked against the real
// host (see their own headers for which facts were measured).
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Spread the DEFAULTS rather than replacing them: `exclude` is not merged
    // with vitest's own list, so a one-entry array silently re-enabled
    // `dist/`, `coverage/` and friends as test sources.
    exclude: [...configDefaults.exclude],
    pool: 'forks',
    testTimeout: 20_000,
  },
})
