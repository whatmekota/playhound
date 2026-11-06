// Plugin dev mode: a plugin loaded straight from a folder on disk, reloaded
// whenever a file in it changes.
//
// The page can only name folders the user picked here, through the folder
// dialog: the list lives in desktop-state.json (so the plugins come back after
// a restart), and a read or watch of anything else is refused. Files are sent
// to the page whole; it imports the main module from a blob: URL, as it does
// for an installed zip.

import fs from 'node:fs'
import path from 'node:path'

/** Folders skipped while reading and watching: dependencies and VCS, which a plugin never loads at run time. */
const SKIP = new Set(['node_modules', '.git'])
const MAX_FILES = 2000
const MAX_BYTES = 64 * 1024 * 1024
const DEBOUNCE_MS = 250

const skipped = rel => rel.split(/[\\/]/).some(part => SKIP.has(part) || (part.startsWith('.') && part !== '.'))

/** Every file under `root`, as { path: 'a/b.js', data: Uint8Array }; throws past the limits. */
async function readFolder(root) {
  const out = []
  let bytes = 0
  async function walk(dir, rel) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (skipped(e.name))
        continue
      // Links are not followed: a folder link could lead anywhere on the disk.
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), r)
      }
      else if (e.isFile()) {
        if (out.length >= MAX_FILES)
          throw new Error(`more than ${MAX_FILES} files in the folder`)
        const data = await fs.promises.readFile(path.join(dir, e.name))
        bytes += data.byteLength
        if (bytes > MAX_BYTES)
          throw new Error('more than 64 MB in the folder')
        // A copy with its own buffer: IPC sends a view's whole buffer, which may be shared.
        out.push({ path: r, data: new Uint8Array(data) })
      }
    }
  }
  await walk(root, '')
  return out
}

/**
 * @param {object} o
 * @param {Electron.IpcMain} o.ipcMain
 * @param {(event: Electron.IpcMainInvokeEvent) => boolean} o.allowed  only the main window
 * @param {() => Electron.BrowserWindow | null} o.window
 * @param {Electron.Dialog} o.dialog
 * @param {{ devPlugins?: string[] }} o.state
 * @param {() => void} o.save
 */
export function setupDevPlugins({ ipcMain, allowed, window, dialog, state, save }) {
  const folders = () => (Array.isArray(state.devPlugins) ? state.devPlugins.filter(p => typeof p === 'string') : [])
  const known = p => typeof p === 'string' && folders().includes(p)
  /** Folder → its watcher. */
  const watchers = new Map()

  function watch(folder) {
    if (watchers.has(folder))
      return
    let timer = null
    try {
      const w = fs.watch(folder, { recursive: true }, (_type, file) => {
        if (file && skipped(String(file)))
          return
        // A save often lands as several events (write, rename, chmod): one reload.
        clearTimeout(timer)
        timer = setTimeout(() => {
          const win = window()
          if (win && !win.isDestroyed())
            win.webContents.send('ph:plugins:dev:changed', folder)
        }, DEBOUNCE_MS)
      })
      w.on('error', () => unwatch(folder))
      watchers.set(folder, w)
    }
    catch (err) {
      console.warn('[dev plugins] cannot watch', folder, err?.message)
    }
  }

  function unwatch(folder) {
    watchers.get(folder)?.close()
    watchers.delete(folder)
  }

  ipcMain.handle('ph:plugins:dev:list', event => (allowed(event) ? folders() : []))

  ipcMain.handle('ph:plugins:dev:pick', async (event) => {
    const win = window()
    if (!allowed(event) || !win)
      return null
    const res = await dialog.showOpenDialog(win, { title: 'Load a plugin from a folder', properties: ['openDirectory'] })
    const folder = res.canceled ? null : res.filePaths[0]
    if (!folder)
      return null
    if (!known(folder)) {
      state.devPlugins = [...folders(), folder]
      save()
    }
    return folder
  })

  ipcMain.handle('ph:plugins:dev:read', async (event, folder) => {
    if (!allowed(event) || !known(folder))
      return { error: 'That folder was not picked in this app' }
    try {
      const files = await readFolder(folder)
      watch(folder)
      return { files }
    }
    catch (err) {
      return { error: err?.code === 'ENOENT' ? 'The folder is gone' : String(err?.message ?? err) }
    }
  })

  ipcMain.handle('ph:plugins:dev:forget', (event, folder) => {
    if (!allowed(event))
      return
    unwatch(folder)
    state.devPlugins = folders().filter(p => p !== folder)
    save()
  })
}
