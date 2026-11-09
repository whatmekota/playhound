// Browser-native file & serial APIs — replaces the Electron preload bridge
import { AUDIO_EXTS, MEDIA_ACCEPT, VIDEO_EXTS } from './mediaFiles'

// ── File System Access API ────────────────────────────────────────────────────

export async function openVideoFile(): Promise<File | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [
          { description: 'Video files', accept: { 'video/*': VIDEO_EXTS.map(e => `.${e}`) } },
          { description: 'Audio files', accept: { 'audio/*': AUDIO_EXTS.map(e => `.${e}`) } },
        ],
        multiple: false,
      })
      return await handle.getFile()
    }
    catch {
      return null // user cancelled
    }
  }
  // Fallback: classic input
  return inputFilePicker(['video/*', 'audio/*', ...MEDIA_ACCEPT])
}

/** The handle each picked script came through: Save as… opens in its folder. */
const fileHandles = new WeakMap<File, FileSystemFileHandle>()

export function fileHandleOf(f: File): FileSystemFileHandle | null {
  return fileHandles.get(f) ?? null
}

export async function openScriptFiles(): Promise<File[]> {
  if ('showOpenFilePicker' in window) {
    try {
      const handles = await (window as any).showOpenFilePicker({
        types: [{ description: 'Funscript Files', accept: { 'application/json': ['.funscript'] } }],
        multiple: true,
      })
      return Promise.all(handles.map(async (h: FileSystemFileHandle) => {
        const f = await h.getFile()
        fileHandles.set(f, h)
        return f
      }))
    }
    catch {
      return []
    }
  }
  return inputFilePicker(['.funscript'], true)
}

/** Open an entire directory and return all files in it — alias for openFolderInput */
export const openDirectory = openFolderInput

/**
 * Open a folder picker and return both the files AND the directory handle
 * (handle can be stored in IDB and reused after refresh).
 */
export async function openFolderWithHandle(): Promise<{ files: File[], handle: FileSystemDirectoryHandle | null }> {
  if ('showDirectoryPicker' in window) {
    try {
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' })
      const files = await collectHandleFiles(dirHandle)
      return { files, handle: dirHandle }
    }
    catch {
      return { files: [], handle: null }
    }
  }
  const files = await webkitDirInput()
  return { files, handle: null }
}

/**
 * Re-open files from a persisted FileSystemDirectoryHandle.
 * The browser will prompt the user for permission once per session.
 * Returns null if permission is denied or API not available.
 */
export async function reopenFromHandle(handle: FileSystemDirectoryHandle): Promise<File[] | null> {
  if (!handle || !('queryPermission' in handle))
    return null
  try {
    let perm = await (handle as any).queryPermission({ mode: 'read' })
    if (perm !== 'granted') {
      perm = await (handle as any).requestPermission({ mode: 'read' })
    }
    if (perm !== 'granted')
      return null
    return collectHandleFiles(handle)
  }
  catch {
    return null
  }
}

/**
 * Open a folder picker.
 * Uses showDirectoryPicker() when available (Chrome/Edge 86+) — no scary "upload" dialog.
 * Falls back to webkitdirectory input only if the modern API is unavailable.
 */
export async function openFolderInput(): Promise<File[]> {
  const { files } = await openFolderWithHandle()
  return files
}

/**
 * Where each file sits, from the library folder down: "Videos/sub/clip.mp4".
 * A File read through a directory handle does not carry its path the way a
 * folder <input> does (webkitRelativePath), so the walk records it here.
 */
const filePaths = new WeakMap<File, string>()

/** A file's path from its library folder, or just its name when it came loose (a drop). */
export function filePath(f: File): string {
  return filePaths.get(f) || f.webkitRelativePath || f.name
}

/**
 * A file's path when it was read from a library folder's handle, the only
 * kind of file the app can write next to; null for anything else (a drop, a
 * folder <input>, a file made in memory).
 */
export function handlePathOf(f: File): string | null {
  return filePaths.get(f) ?? null
}

/** Record where a file sits in a library folder (a file written there, say). */
export function rememberPath(f: File, path: string) {
  filePaths.set(f, path)
}

/** Every file under a directory, recursively, each with its path recorded (see filePath). */
export async function collectHandleFiles(dirHandle: any, prefix: string = dirHandle.name): Promise<File[]> {
  const files: File[] = []
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      try {
        const f = await entry.getFile()
        filePaths.set(f, `${prefix}/${entry.name}`)
        files.push(f)
      }
      catch {}
    }
    else if (entry.kind === 'directory') {
      try {
        files.push(...await collectHandleFiles(entry, `${prefix}/${entry.name}`))
      }
      catch {}
    }
  }
  return files
}

/** The browser's folder picker alone. Null when cancelled or unavailable. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!('showDirectoryPicker' in window))
    return null
  try {
    return await (window as any).showDirectoryPicker({ mode: 'read' })
  }
  catch {
    return null
  }
}

function webkitDirInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    ;(input as any).webkitdirectory = true
    input.multiple = true
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.oncancel = () => resolve([])
    input.click()
  })
}

function inputFilePicker(accept: string[]): Promise<File | null>
function inputFilePicker(accept: string[], multiple: false): Promise<File | null>
function inputFilePicker(accept: string[], multiple: true): Promise<File[]>
function inputFilePicker(accept: string[], multiple = false): Promise<File | File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept.join(',')
    input.multiple = multiple
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      resolve(multiple ? files : (files[0] ?? null))
    }
    input.oncancel = () => resolve(null)
    input.click()
  })
}

// ── Settings via localStorage ─────────────────────────────────────────────────

export const storage = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }
    catch {
      return null
    }
  },
  set(key: string, value: unknown) {
    localStorage.setItem(key, JSON.stringify(value))
  },
  delete(key: string) {
    localStorage.removeItem(key)
  },
}

// ── Web Serial API ────────────────────────────────────────────────────────────

export const webSerial = {
  supported: 'serial' in navigator,

  async listPorts(): Promise<SerialPort[]> {
    if (!this.supported)
      return []
    return (navigator as any).serial.getPorts()
  },

  async requestPort(): Promise<SerialPort | null> {
    if (!this.supported)
      return null
    try {
      return await (navigator as any).serial.requestPort()
    }
    catch {
      return null
    }
  },
}

// ── Desktop shell (Electron) ──────────────────────────────────────────────────

export interface DesktopInfo {
  version: string
  port: number
  dev: boolean
  /** Node's process.platform: 'win32', 'darwin' or 'linux'. Absent in older builds. */
  platform?: string
  /** This machine's IPv4 addresses, physical adapters first. */
  lan: readonly { name: string, address: string }[]
  /**
   * Controls for the frameless main window, whose title bar the page draws
   * (TitleBar.vue). Null in any other desktop window.
   */
  window: DesktopWindow | null
  /** Discord Rich Presence, owned by the main process. Null in any other desktop window. */
  presence: DesktopPresence | null
  /** The app's own EroScripts session. Null in any other desktop window, and in older builds. */
  eroscripts?: DesktopEroScripts | null
  /** The desktop app's Bluetooth chooser. Absent in older builds. */
  bluetooth?: DesktopBluetooth
  /** The pop-out player's window. Main window only; absent in older builds. */
  popout?: DesktopPopout
  /** Updates from GitHub Releases. Main window only; absent in older builds. */
  updates?: DesktopUpdates
  /** fetch() from the main process, for plugins (desktop/netbridge.mjs). */
  net?: DesktopNet
  /** Plugins loaded from a folder (desktop/devplugins.mjs). Main window only; absent in older builds. */
  plugins?: DesktopPlugins
  /** Web views for plugins (desktop/webview.mjs). Main window only; absent in older builds. */
  web?: DesktopWeb
  /** Files on disk: their paths, and the Recycle Bin. Main window only; absent before 2.0.2. */
  files?: DesktopFiles
  /** TCode over UDP (desktop/tcodenet.mjs). Main window only; absent before 2.2. */
  tcode?: DesktopTcode
}

export interface DesktopTcode {
  udpOpen: (host: string, port: number) => Promise<{ id: number, address: string, error?: undefined } | { error: string, id?: undefined, address?: undefined }>
  udpSend: (id: number, text: string) => void
  udpClose: (id: number) => void
  onUdpError: (cb: (id: number, message: string) => void) => () => void
  onUdpMessage: (cb: (id: number, text: string) => void) => () => void
}

export interface DesktopFiles {
  pathOf: (file: File) => string
  trash: (paths: string[]) => Promise<{ failed: { path: string, error: string }[], error?: undefined } | { error: string, failed?: undefined }>
}

export interface DesktopWebRect { x: number, y: number, width: number, height: number, radius?: number }

/** What changed about a web view; any subset of WebViewState (src/plugins/types.ts). */
export type DesktopWebPatch = Record<string, unknown>

export interface DesktopWeb {
  create: () => Promise<{ id: number, error?: undefined } | { error: string, id?: undefined }>
  destroy: (id: number) => void
  layout: (id: number, rect: DesktopWebRect | null) => void
  nav: (id: number, action: 'load' | 'back' | 'forward' | 'reload' | 'stop' | 'zoom', arg?: string | number) => void
  panic: (on: boolean) => void
  /** Absent in builds before 2.0.2. */
  listen?: (id: number) => Promise<boolean>
  onState: (cb: (id: number, patch: DesktopWebPatch) => void) => () => void
  onKey: (cb: (key: 'Escape' | 'Backquote' | 'KeyK') => void) => () => void
  onActivity: (cb: () => void) => () => void
}

export interface DesktopPlugins {
  devFolders: () => Promise<string[]>
  pickDevFolder: () => Promise<string | null>
  readDevFolder: (folder: string) => Promise<{ files: { path: string, data: Uint8Array }[], error?: undefined } | { error: string, files?: undefined }>
  forgetDevFolder: (folder: string) => Promise<void>
  onDevChange: (cb: (folder: string) => void) => () => void
}

export type UpdateStatus = 'off' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'available' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** The running version. */
  current: string
  /** The new one, once known. */
  version: string | null
  /** Download progress, 0–100. */
  percent: number
  error: string | null
  /** The portable .exe: it can only say a new version is out. */
  portable: boolean
  /**
   * Updates by hand: it only says a new version is out (the portable .exe,
   * the unsigned macOS app, Linux outside an AppImage). Absent in older builds.
   */
  manual?: boolean
  /** Checks on its own (at startup and every few hours). */
  auto: boolean
  /** Where to download it by hand (manual). */
  url: string | null
}

export interface DesktopNetRequest {
  url: string
  method: string
  headers: [string, string][]
  body: Uint8Array | null
}

export interface DesktopNet {
  fetch: (req: DesktopNetRequest, on: {
    head: (status: number, statusText: string, headers: [string, string][]) => void
    chunk: (data: Uint8Array) => void
    end: () => void
    error: (message: string) => void
  }) => () => void
}

export interface DesktopUpdates {
  state: () => UpdateState
  onState: (cb: (s: UpdateState) => void) => () => void
  check: () => void
  /** Quit, install the downloaded update and start again. */
  install: () => void
  setAuto: (on: boolean) => void
}

export interface DesktopPopoutState {
  clickThrough: boolean
  /** The global key that toggles click-through, as the cheat sheet writes it; null if taken. */
  shortcut: string | null
}

/**
 * The pop-out player's window (see usePopout). The page opens it with
 * window.open; these act on the window the desktop app made for it.
 */
export interface DesktopPopout {
  set: (opts: {
    /** 0.2 – 1. */
    opacity?: number
    /** Mouse goes through to whatever is underneath. */
    clickThrough?: boolean
    /** Out of sight, for panic. */
    hidden?: boolean
    /** The video's width / height, to keep the window that shape. */
    aspect?: number
  }) => void
  /** Click-through changed from the global key; returns an unsubscribe. */
  onState: (cb: (s: DesktopPopoutState) => void) => () => void
}

export interface DesktopBluetooth {
  /**
   * Say what the next navigator.bluetooth.requestDevice() is for, just before
   * calling it, so the desktop app's chooser words itself right and picks
   * the device used last time for that.
   */
  expect: (kind: 'heart' | 'handy') => void
}

export interface DesktopEroScripts {
  status: () => Promise<{ signedIn: boolean } | null>
  login: () => Promise<void>
  logout: () => Promise<void>
  onChange: (cb: (s: { signedIn: boolean }) => void) => () => void
}

export type PresenceStatus = 'off' | 'connecting' | 'connected' | 'no-discord' | 'error'

/** What Rich Presence accepts; the main process sanitises it again. */
export interface PresenceActivity {
  /** 0 Playing, 2 Listening to, 3 Watching. */
  type?: 0 | 2 | 3
  details?: string
  state?: string
  startTimestamp?: number
  endTimestamp?: number
  largeImageKey?: string
  largeImageText?: string
  smallImageKey?: string
  smallImageText?: string
}

export interface DesktopPresence {
  /** Show `activity` for Discord application `clientId`, or clear (and disconnect) with null. */
  set: (clientId: string, activity: PresenceActivity | null) => void
  status: () => { status: PresenceStatus, detail?: string }
  onStatus: (cb: (s: { status: PresenceStatus, detail?: string }) => void) => () => void
}

export interface DesktopWindowState {
  maximized: boolean
  /** OS fullscreen, including the one HTML fullscreen (the video player's) puts the window in. */
  fullScreen: boolean
}

export interface DesktopWindow {
  /** The window's zoom (1 = 100%), for Settings → Appearance → Interface size. Absent in older builds. */
  setZoom?: (factor: number) => void
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  state: () => DesktopWindowState
  /** Called on every maximise / restore / fullscreen change; returns an unsubscribe. */
  onStateChange: (cb: (state: DesktopWindowState) => void) => () => void
}

/**
 * Set by the desktop app's preload (desktop/preload.cjs); null in a browser.
 * The desktop window always runs on localhost, so anything that hands a URL
 * to another device (the phone remote) should take its host from `lan`.
 */
export const desktop: DesktopInfo | null = (globalThis as any).playhoundDesktop ?? null
