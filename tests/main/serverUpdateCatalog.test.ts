import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveUpdateChannel } from '../../src/shared/updateChannel'

vi.mock('electron', () => ({ app: { getVersion: () => '3.1.0' } }))
vi.mock('../../src/main/api/plugin/device', () => ({
  default: { getDeviceIdPublic: () => 'update-check-device' }
}))
vi.mock('../../src/main/api/shared/database', () => ({
  default: { dbGet: () => null }
}))
vi.mock('../../src/main/utils/httpRequest', () => ({ httpRequest: vi.fn() }))

import { httpRequest } from '../../src/main/utils/httpRequest'
import {
  fetchLatestServerUpdate,
  fetchServerUpdateSources
} from '../../src/main/api/serverUpdateCatalog'

describe('update catalog device identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(httpRequest).mockResolvedValue({
      status: 200,
      statusMessage: 'OK',
      headers: {},
      data: { update: null, sources: [] }
    })
  })

  it('uses the same device ID for update checks and download sources', async () => {
    await fetchLatestServerUpdate()
    await fetchServerUpdateSources('3.2.0')
    const urls = vi.mocked(httpRequest).mock.calls.map(([url]) => new URL(url))
    expect(urls.map((url) => url.pathname)).toEqual([
      '/api/updates/latest',
      '/api/updates/downloads'
    ])
    for (const url of urls) {
      expect(url.searchParams.get('deviceId')).toBe('update-check-device')
      expect(url.searchParams.get('updateChannel')).toBe('stable')
    }
  })
})

describe('resolveUpdateChannel', () => {
  it('keeps regular releases on the stable channel by default', () => {
    expect(resolveUpdateChannel('3.1.0')).toBe('stable')
  })

  it('lets regular releases opt in to beta updates', () => {
    expect(resolveUpdateChannel('3.1.0', true)).toBe('beta')
  })

  it('keeps prerelease builds on the beta channel regardless of preference', () => {
    expect(resolveUpdateChannel('3.1.0-beta.2', false)).toBe('beta')
  })
})
