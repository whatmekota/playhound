import type { GhRelease } from '~/lib/android/updater'
import { describe, expect, it } from 'vitest'
import { androidApkName, pickAndroidRelease } from '~/lib/android/updater'

function release(tag: string, opts: Partial<GhRelease> & { apk?: boolean } = {}): GhRelease {
  const v = tag.replace(/^v/, '')
  return {
    tag_name: tag,
    body: `Notes for ${v}`,
    html_url: `https://github.com/whatmekota/playhound/releases/tag/${tag}`,
    assets: [
      { name: `playhound-${v}-setup.exe`, browser_download_url: 'https://x/setup.exe', size: 1 },
      ...(opts.apk === false ? [] : [{ name: `playhound-${v}-android.apk`, browser_download_url: `https://x/${v}.apk`, size: 9_000_000, digest: 'sha256:abc' }]),
    ],
    ...opts,
  }
}

describe('the Android updater', () => {
  it('names the APK asset after the version', () => {
    expect(androidApkName('2.3.0')).toBe('playhound-2.3.0-android.apk')
    expect(androidApkName('v2.3.0')).toBe('playhound-2.3.0-android.apk')
  })

  it('picks the newest stable release that has an APK', () => {
    const got = pickAndroidRelease([
      release('v2.4.0-beta.1', { prerelease: true }),
      release('v2.3.1', { apk: false }),
      release('v2.3.0'),
      release('v2.2.0'),
    ], '2.2.0')
    expect(got?.version).toBe('2.3.0')
    expect(got?.apk).toEqual({ name: 'playhound-2.3.0-android.apk', url: 'https://x/2.3.0.apk', size: 9_000_000, sha256: 'abc' })
    expect(got?.notes).toBe('Notes for 2.3.0')
  })

  it('offers nothing when this app is as new or newer', () => {
    expect(pickAndroidRelease([release('v2.2.0')], '2.2.0')).toBeNull()
    expect(pickAndroidRelease([release('v2.2.0')], '2.3.0')).toBeNull()
    expect(pickAndroidRelease([release('v2.5.0', { draft: true })], '2.2.0')).toBeNull()
  })
})

describe('plugins in the Android app', () => {
  it('refuses the ones that need a desktop-only part', async () => {
    const { desktopOnlyReason } = await import('~/plugins/manifest')
    expect(desktopOnlyReason(['player', 'serve'], true)).toMatch(/^This plugin needs the desktop app/)
    expect(desktopOnlyReason(['player', 'network'], true)).toBeNull()
    expect(desktopOnlyReason(['web'], false)).toBeNull()
    expect(desktopOnlyReason(undefined, true)).toBeNull()
  })
})
