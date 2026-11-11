import type { PluginListenerHandle } from '@capacitor/core'
import type { DesktopUpdates, UpdateState } from '../browserApi'
import { newer } from '../../plugins/storeMeta'
import { KEYS } from '../persist'
import { appInfo, PhApp } from './app'
import { nativeFetch } from './net'

/**
 * Updates for the Android app, from GitHub Releases, in the shape of the
 * desktop app's (DesktopUpdates), so useUpdates, Settings → Updates and the
 * banner work the same.
 *
 * A release carries the APK as an asset named `playhound-<version>-android.apk`
 * (androidApkName; `pnpm mobile:release` builds it under that name). On
 * launch and once a day the newest release with such an asset is looked
 * for; if it is newer than this app, its notes are shown with "Update",
 * which downloads it into the app's cache with progress (checked against
 * the SHA-256 GitHub lists) and opens Android's installer. Android refuses
 * an APK signed with another key than the installed app: a debug build is
 * told to install by hand instead.
 */

export const REPO = 'whatmekota/playhound'
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=10`
const DAY_MS = 24 * 60 * 60 * 1000

/** The asset a release's Android APK goes by. */
export function androidApkName(version: string): string {
  return `playhound-${version.replace(/^v/, '')}-android.apk`
}

export interface GhAsset {
  name: string
  browser_download_url: string
  size: number
  /** "sha256:…", on releases since mid-2025. */
  digest?: string | null
}

export interface GhRelease {
  tag_name: string
  name?: string | null
  body?: string | null
  html_url: string
  draft?: boolean
  prerelease?: boolean
  assets: GhAsset[]
}

export interface AndroidRelease {
  version: string
  notes: string
  page: string
  apk: { name: string, url: string, size: number, sha256: string | null }
}

/** The newest stable release with an Android APK, if it is newer than `current`. */
export function pickAndroidRelease(releases: GhRelease[], current: string): AndroidRelease | null {
  let best: AndroidRelease | null = null
  for (const r of releases) {
    if (r.draft || r.prerelease)
      continue
    const version = r.tag_name.replace(/^v/, '')
    const apk = r.assets.find(a => a.name === androidApkName(version))
    if (!apk || (best && !newer(version, best.version)))
      continue
    best = {
      version,
      notes: r.body ?? '',
      page: r.html_url,
      apk: { name: apk.name, url: apk.browser_download_url, size: apk.size, sha256: apk.digest?.startsWith('sha256:') ? apk.digest.slice(7) : null },
    }
  }
  return best && newer(best.version, current) ? best : null
}

interface Saved {
  auto: boolean
  lastCheck: number
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEYS.androidUpdates.key) ?? '{}')
    return { auto: v.auto !== false, lastCheck: Number(v.lastCheck) || 0 }
  }
  catch {
    return { auto: true, lastCheck: 0 }
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(KEYS.androidUpdates.key, JSON.stringify(s))
  }
  catch {}
}

/** The Android updater, as DesktopUpdates; `start` begins the launch and daily checks. */
export function createAndroidUpdates(current: string): DesktopUpdates & { start: () => void } {
  const saved = load()
  let release: AndroidRelease | null = null
  let downloaded: string | null = null
  let debug = false
  let busy = false
  let state: UpdateState = { status: 'idle', current, version: null, percent: 0, error: null, portable: false, manual: false, auto: saved.auto, url: null, notes: null }
  const listeners = new Set<(s: UpdateState) => void>()
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch }
    listeners.forEach(fn => fn(state))
  }

  async function check() {
    if (busy)
      return
    busy = true
    set({ status: 'checking', error: null })
    try {
      debug = (await appInfo().catch(() => null))?.debug ?? false
      const res = await nativeFetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } })
      if (!res.ok)
        throw new Error(`GitHub answered ${res.status}`)
      release = pickAndroidRelease(await res.json(), current)
      saved.lastCheck = Date.now()
      save(saved)
      if (!release) {
        set({ status: 'none', version: null, notes: null, url: null })
        return
      }
      // A debug build is signed with another key: Android would refuse the
      // update, so it is offered by hand (uninstall, then install it).
      set({ status: 'available', version: release.version, notes: release.notes, url: release.page, manual: debug, percent: 0 })
    }
    catch (err) {
      set({ status: 'error', error: (err as Error)?.message ?? 'Could not check for updates' })
    }
    finally {
      busy = false
    }
  }

  async function download(): Promise<string | null> {
    if (!release)
      return null
    let sub: PluginListenerHandle | null = null
    set({ status: 'downloading', percent: 0, error: null })
    try {
      const total = release.apk.size
      sub = await PhApp.addListener('updateProgress', (e) => {
        const of = e.total > 0 ? e.total : total
        set({ percent: of > 0 ? Math.min(100, Math.round((e.received / of) * 100)) : 0 })
      })
      const r = await PhApp.downloadUpdate({ url: release.apk.url, name: release.apk.name, sha256: release.apk.sha256 })
      downloaded = r.path
      set({ status: 'ready', percent: 100 })
      return r.path
    }
    catch (err) {
      set({ status: 'error', error: (err as Error)?.message ?? 'The download failed' })
      return null
    }
    finally {
      await sub?.remove()
    }
  }

  /** "Update": download if need be, then Android's installer. */
  async function install() {
    if (busy || state.manual)
      return
    busy = true
    try {
      const path = downloaded ?? await download()
      if (!path)
        return
      const r = await PhApp.installUpdate({ path })
      if (r.needsPermission)
        set({ error: 'Allow playhound to install apps in the screen that opened, then tap Update again.' })
    }
    catch (err) {
      set({ error: (err as Error)?.message ?? 'The installer did not open' })
    }
    finally {
      busy = false
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  return {
    state: () => state,
    onState(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    check: () => void check(),
    install: () => void install(),
    setAuto(on) {
      saved.auto = on
      save(saved)
      set({ auto: on })
    },
    start() {
      if (timer)
        return
      // On launch (once the app has settled), then daily while it stays open.
      setTimeout(() => {
        if (saved.auto)
          void check()
      }, 8000)
      timer = setInterval(() => {
        if (saved.auto && Date.now() - saved.lastCheck >= DAY_MS)
          void check()
      }, 60 * 60 * 1000)
    },
  }
}
