import process from 'node:process'
import { app, session } from 'electron'
import electronUpdater from 'electron-updater'
import { newer } from './version.mjs'

/**
 * Updates from GitHub Releases.
 *
 * The installed app (NSIS) uses electron-updater: it reads latest.yml from the
 * newest release, downloads the installer in the background (only the changed
 * blocks, from the .blockmap, when it can), checks its sha512 and installs it
 * on the next quit or when the user says restart. The portable .exe cannot
 * replace itself, so it only reads latest.yml and says a new version is out.
 *
 * Unsigned builds update fine: electron-updater checks a signature only when
 * the running app is signed, and its downloads carry no mark of the web, so
 * SmartScreen does not ask again.
 *
 * State goes to the page as { status, current, version, percent, error,
 * portable, auto, url }:
 *   off          not a packaged build (dev), nothing to update
 *   idle         not checked yet
 *   checking     asking GitHub
 *   none         up to date
 *   downloading  a new version is coming down (percent)
 *   ready        downloaded; installs on quit, or now on restart
 *   available    portable: a new version is out, download it by hand (url)
 *   error        the last check or download failed (error)
 */

const { autoUpdater } = electronUpdater

const REPO = 'whatmekota/playhound'
const RELEASES = `https://github.com/${REPO}/releases/latest`
const LATEST_YML = `https://github.com/${REPO}/releases/latest/download/latest.yml`
/** electron-updater's own network session (see its electronHttpExecutor). */
export const UPDATER_SESSION = 'electron-updater'
const FIRST_CHECK_MS = 20_000
const CHECK_EVERY_MS = 6 * 60 * 60_000

/**
 * @param {object} o
 * @param {(state: object) => void} o.send    hand the state to the page
 * @param {() => boolean} o.getAuto           whether to check on its own
 * @param {(on: boolean) => void} o.setAuto   remember that
 */
export function createUpdater({ send, getAuto, setAuto }) {
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR
  // For trying the updater against a local server: a folder URL holding
  // latest.yml and the installer. Never set in a real install.
  const testFeed = process.env.PH_UPDATE_URL || ''
  const active = app.isPackaged || !!testFeed
  let state = {
    status: active ? 'idle' : 'off',
    current: app.getVersion(),
    version: null,
    percent: 0,
    error: null,
    portable,
    auto: getAuto(),
    url: null,
  }
  let timer = null
  let lastSent = 0

  function set(patch, force = true) {
    state = { ...state, ...patch }
    const now = Date.now()
    // Progress comes many times a second; the page needs a few.
    if (force || now - lastSent > 500) {
      lastSent = now
      send(state)
    }
  }

  function short(err) {
    const msg = String(err?.message ?? err ?? 'Unknown error')
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_PROXY|net::/i.test(msg))
      return 'Could not reach GitHub. Check the connection, or set a proxy in Settings → Network.'
    if (/latest\.yml|404/i.test(msg))
      return 'The newest release has no update information yet.'
    return msg.split('\n')[0].slice(0, 200)
  }

  if (active && !portable) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.disableWebInstaller = true
    autoUpdater.logger = {
      // eslint-disable-next-line no-console -- the main process log is the terminal
      info: m => console.log('[update]', m),
      warn: m => console.warn('[update]', m),
      error: m => console.error('[update]', m),
      debug: () => {},
    }
    if (testFeed) {
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
    }
    autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
    autoUpdater.on('update-not-available', () => set({ status: 'none' }))
    autoUpdater.on('update-available', info => set({ status: 'downloading', version: info?.version ?? null, percent: 0 }))
    autoUpdater.on('download-progress', p => set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }, false))
    autoUpdater.on('update-downloaded', info => set({ status: 'ready', version: info?.version ?? state.version, percent: 100 }))
    autoUpdater.on('error', err => set({ status: 'error', error: short(err) }))
  }

  /** Portable: read the version from latest.yml and say so; downloading is the user's. */
  async function checkPortable() {
    set({ status: 'checking', error: null })
    try {
      const res = await session.fromPartition(UPDATER_SESSION, { cache: false }).fetch(testFeed ? `${testFeed.replace(/\/$/, '')}/latest.yml` : LATEST_YML)
      if (!res.ok)
        throw new Error(`latest.yml: HTTP ${res.status}`)
      const version = /^version:\s*['"]?([^\s'"]+)/m.exec(await res.text())?.[1]
      if (!version)
        throw new Error('latest.yml has no version')
      if (newer(version, state.current))
        set({ status: 'available', version, url: RELEASES })
      else
        set({ status: 'none' })
    }
    catch (err) {
      set({ status: 'error', error: short(err) })
    }
  }

  function check() {
    if (!active || state.status === 'checking' || state.status === 'downloading' || state.status === 'ready')
      return
    if (portable) {
      void checkPortable()
      return
    }
    autoUpdater.checkForUpdates().catch(err => set({ status: 'error', error: short(err) }))
  }

  function schedule() {
    clearTimeout(timer)
    clearInterval(timer)
    timer = null
    if (!active || !state.auto)
      return
    timer = setTimeout(() => {
      check()
      timer = setInterval(check, CHECK_EVERY_MS)
    }, FIRST_CHECK_MS)
  }

  return {
    state: () => state,
    check,
    /** Quit and install now; the installer runs silently and starts the app again. */
    install() {
      if (state.status === 'ready' && !portable)
        autoUpdater.quitAndInstall(true, true)
    },
    setAuto(on) {
      setAuto(!!on)
      set({ auto: !!on })
      schedule()
    },
    start: schedule,
  }
}
