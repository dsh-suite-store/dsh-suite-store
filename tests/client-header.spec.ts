import { describe, expect, it } from 'vitest'

import {
  STORE_REPOSITORY_URL,
  pluginIdentity,
  pluginVersionLabel,
} from '../src/client/store-data.ts'

describe('store header metadata', () => {
  it('identifies the plugin by display name and package name', () => {
    expect(pluginIdentity('zh')).toBe('dsh-suite-store')
    expect(pluginIdentity('en')).toBe('dsh-suite-store')
  })

  it('renders a known package version and omits an unknown one', () => {
    expect(pluginVersionLabel('1.2.3')).toBe('v1.2.3')
    expect(pluginVersionLabel(undefined)).toBeUndefined()
  })

  it('links to the canonical GitHub repository', () => {
    expect(STORE_REPOSITORY_URL).toBe('https://github.com/dsh-suite-store/dsh-suite-store')
  })
})
