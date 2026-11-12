// The library's folders as the desktop app sees them: watched for changes,
// and a file in one shown in the system's file manager.
//
// The page holds folder handles, which never say where they are on disk (and
// a File read through one has no path either). But every permission check on
// a folder handle comes through the session with the folder's path
// (desktop/devices.mjs passes them here), so this side knows each folder the
// user gave the page. The page names its folders (the handle's name and a
// file inside), and they are matched against those. Only those folders are
// watched, and only files inside them are ever shown.
//
// No Electron import here: `shell` is passed in, so the tests load this as is.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** Changes are sent once things have been quiet this long… */
const QUIET_MS = 700
/** …or this long after the first, whichever comes first. */
const MAX_WAIT_MS = 4000
/** More than this at once: the page reads the folder again instead (null). */
const MAX_PATHS = 1000

/** Whether `target` is `root` itself or somewhere under it. */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string' || !root || !target)
    return false
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

const sameName = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase())

/**
 * Which of the `known` folders the page means by a handle called `name`
 * holding the file `probe` ('/'-separated, relative to it; '' when the folder
 * is empty). '' when none fits.
 */
export function findFolder(known, name, probe, exists = p => fs.existsSync(p)) {
  if (typeof name !== 'string' || !name)
    return ''
  const named = [...known].filter(dir => sameName(path.basename(dir) || dir, name))
  if (typeof probe === 'string' && probe && !probe.split('/').includes('..')) {
    const hit = named.find(dir => exists(path.join(dir, ...probe.split('/'))))
    if (hit)
      return hit
  }
  // An empty folder can only go by its name, and only when that is unambiguous.
  return !probe && named.length === 1 ? named[0] : ''
}

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {(event: Electron.IpcMainInvokeEvent) => boolean} o.allowed  Main window only.
 * @param {() => Electron.BrowserWindow | null} o.window
 * @param {{ showItemInFolder: (p: string) => void }} o.shell
 * @param {typeof fs.watch} [o.watch]  For the tests.
 */
export function setupLibraryFiles({ ipcMain, allowed, window, shell, watch = fs.watch }) {
  /** Every folder the page has been given, as the session reported it. */
  const known = new Set()
  /** The library folders on disk, in the page's order; '' for one not found. */
  let roots = []
  /** Root → its watcher. */
  const watchers = new Map()
  /** Root → paths changed under it since the last send (null: too many to list). */
  const pending = new Map()
  let timer = null
  let firstAt = 0

  function send() {
    clearTimeout(timer)
    timer = null
    firstAt = 0
    const win = window()
    for (const [root, set] of pending) {
      if (win && !win.isDestroyed())
        win.webContents.send('ph:files:changed', root, set ? [...set] : null)
    }
    pending.clear()
  }

  function queue(root, file) {
    if (!pending.has(root))
      pending.set(root, new Set())
    const set = pending.get(root)
    if (set) {
      // No name (some platforms, some events): the folder as a whole.
      if (!file || set.size >= MAX_PATHS)
        pending.set(root, null)
      else
        set.add(String(file).replace(/\\/g, '/'))
    }
    const now = Date.now()
    firstAt ||= now
    clearTimeout(timer)
    timer = setTimeout(send, Math.min(QUIET_MS, Math.max(0, firstAt + MAX_WAIT_MS - now)))
  }

  function unwatchAll() {
    for (const w of watchers.values())
      w.close()
    watchers.clear()
  }

  function watchRoot(root) {
    try {
      const w = watch(root, { recursive: true }, (_type, file) => queue(root, file))
      w.on('error', () => {
        w.close()
        watchers.delete(root)
        // Whatever was missed: the page reads the folder again.
        queue(root, null)
      })
      watchers.set(root, w)
      return true
    }
    catch (err) {
      console.warn('[library] cannot watch', root, err?.message)
      return false
    }
  }

  /**
   * The library's folders, each as { name, probe } (see findFolder), and
   * whether to watch them. Resolves { paths, watched }, in the same order:
   * where each is ('' when it could not be found) and whether it is watched.
   */
  ipcMain.handle('ph:files:roots', (event, list, on) => {
    if (!allowed(event) || !Array.isArray(list))
      return { paths: [], watched: [] }
    roots = list.slice(0, 64).map(r => findFolder(known, r?.name, r?.probe))
    unwatchAll()
    pending.clear()
    return { paths: roots, watched: roots.map(r => !!r && !!on && (watchers.has(r) || watchRoot(r))) }
  })

  /** Where folders are on disk, by name and a file in them, without watching or remembering them (the Organizer's folder). */
  ipcMain.handle('ph:files:locate', (event, list) => {
    if (!allowed(event) || !Array.isArray(list))
      return []
    return list.slice(0, 64).map(r => findFolder(known, r?.name, r?.probe) || '')
  })

  /** Show a file in Explorer / Finder, if it is in a library folder and still there. */
  ipcMain.handle('ph:files:reveal', (event, target) => {
    if (!allowed(event) || typeof target !== 'string' || !path.isAbsolute(target))
      return false
    const full = path.resolve(target)
    if (!roots.some(r => r && isInside(r, full)))
      return false
    try {
      fs.statSync(full)
    }
    catch {
      return false
    }
    shell.showItemInFolder(full)
    return true
  })

  return {
    /** A folder the page was given: picked by the user, or restored from last time. */
    folder(p) {
      if (typeof p === 'string' && path.isAbsolute(p))
        known.add(path.resolve(p))
    },
    /** The window went away or reloaded: stop watching until the page says again. */
    reset() {
      unwatchAll()
      pending.clear()
      clearTimeout(timer)
      timer = null
      roots = []
    },
  }
}
