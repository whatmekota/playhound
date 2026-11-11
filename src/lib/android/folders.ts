import type { PluginListenerHandle } from '@capacitor/core'
import type { NativeFileInfo } from './nativeFile'
import { registerPlugin } from '@capacitor/core'
import { rememberPath } from '../browserApi'
import { AUDIO_EXTS, VIDEO_EXTS } from '../mediaFiles'
import { getMediaBase, installObjectUrls, NativeFile, setMediaBase } from './nativeFile'

/**
 * Library folders in the Android app, through the Folders plugin
 * (android/app/src/main/java/…/folders/FoldersPlugin.kt): Android's folder
 * picker, a fast recursive listing, and the media server that streams the
 * files. The library store sees an AndroidTree where the browser has a
 * FileSystemDirectoryHandle, and the NativeFiles it lists where the browser
 * has Files, so pairing, tags and the rest work as they are.
 */

interface TreeInfo {
  uri: string
  name: string
  read: boolean
  write: boolean
}

interface FoundFile extends NativeFileInfo {
  /** From the folder's label down: "Videos/sub/clip.mp4". */
  path: string
}

interface PhFoldersPlugin {
  pick: () => Promise<TreeInfo | { cancelled: true }>
  trees: () => Promise<{ trees: TreeInfo[] }>
  forget: (o: { uri: string }) => Promise<void>
  scan: (o: { uri: string, id: string, label: string, extensions: string[] }) => Promise<{ count: number, failedDirs: number, ms: number }>
  server: () => Promise<{ base: string }>
  readText: (o: { uri: string }) => Promise<{ text: string }>
  addListener: (event: 'scanBatch', cb: (e: { id: string, files: FoundFile[] }) => void) => Promise<PluginListenerHandle>
}

export const PhFolders = registerPlugin<PhFoldersPlugin>('PhFolders')

// Library files are NativeFiles from here on; make object URLs of them stream.
installObjectUrls()

/** What a scan lists: what the library can use. Everything else stays on the phone unread. */
export const LIBRARY_EXTS: readonly string[] = [...VIDEO_EXTS, ...AUDIO_EXTS, 'funscript', 'srt', 'vtt', 'ass', 'ssa']

let serverStart: Promise<void> | null = null

/** Start the media server (once) and learn its address. */
export function ensureMediaServer(): Promise<void> {
  if (getMediaBase())
    return Promise.resolve()
  serverStart ??= PhFolders.server()
    .then(({ base }) => setMediaBase(base))
    .catch((err) => {
      serverStart = null
      throw err
    })
  return serverStart
}

/**
 * A picked folder, standing in for a FileSystemDirectoryHandle in the library
 * store: the parts of that interface the store uses. Only its fields are own
 * properties, so IndexedDB keeps it (as a plain object; see reviveTree).
 */
export class AndroidTree {
  readonly kind = 'directory'
  readonly androidTree = true

  constructor(readonly uri: string, readonly name: string) {}

  /**
   * Read access is the persisted grant from the folder picker. Writing (saving
   * scripts and downloads next to the videos) is not done yet, so it is
   * reported as refused and the app offers its other ways of saving.
   */
  async queryPermission(opts: { mode?: 'read' | 'readwrite' } = {}): Promise<PermissionState> {
    if (opts.mode === 'readwrite')
      return 'denied'
    try {
      const { trees } = await PhFolders.trees()
      return trees.some(t => t.uri === this.uri && t.read) ? 'granted' : 'denied'
    }
    catch {
      return 'denied'
    }
  }

  /** There is no prompt to show: a folder whose grant is gone has to be picked again. */
  requestPermission(opts: { mode?: 'read' | 'readwrite' } = {}): Promise<PermissionState> {
    return this.queryPermission(opts)
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return !!other && (other as AndroidTree).uri === this.uri
  }

  async getDirectoryHandle(): Promise<never> {
    throw new DOMException('Saving into library folders is not in the Android app yet', 'NotAllowedError')
  }

  async getFileHandle(): Promise<never> {
    throw new DOMException('Saving into library folders is not in the Android app yet', 'NotAllowedError')
  }

  /** Every file the library can use, its path starting at `label`. browserApi.collectHandleFiles calls this. */
  collectFiles(label: string = this.name): Promise<File[]> {
    return scanTree(this, label)
  }
}

/** An AndroidTree again, from what IndexedDB kept of one; anything else is passed through. */
export function reviveTree<T>(saved: T): T | AndroidTree {
  const s = saved as any
  return s && s.androidTree && typeof s.uri === 'string' ? new AndroidTree(s.uri, s.name || 'Folder') : saved
}

export function isAndroidTree(h: unknown): h is AndroidTree {
  return h instanceof AndroidTree
}

/** Android's folder picker. Null when cancelled. */
export async function pickTree(): Promise<AndroidTree | null> {
  const r = await PhFolders.pick()
  if ('cancelled' in r)
    return null
  return new AndroidTree(r.uri, r.name)
}

/** Let go of a folder's grant (Android keeps a limited number of them). */
export async function releaseTree(tree: AndroidTree) {
  try {
    await PhFolders.forget({ uri: tree.uri })
  }
  catch {}
}

let scanSeq = 0

/** List a folder: NativeFiles, each with its path recorded for browserApi.filePath. */
export async function scanTree(tree: AndroidTree, label: string): Promise<File[]> {
  await ensureMediaServer()
  const id = `${Date.now().toString(36)}-${++scanSeq}`
  const files: File[] = []
  const sub = await PhFolders.addListener('scanBatch', (e) => {
    if (e.id !== id)
      return
    for (const f of e.files) {
      const nf = new NativeFile(f)
      rememberPath(nf, f.path)
      files.push(nf)
    }
  })
  try {
    const r = await PhFolders.scan({ uri: tree.uri, id, label, extensions: [...LIBRARY_EXTS] })
    // Seen in chrome://inspect, for judging a slow share.
    console.warn(`[folders] ${tree.name}: ${r.count} files in ${r.ms} ms${r.failedDirs ? `, ${r.failedDirs} folder(s) unreadable` : ''}`)
  }
  finally {
    await sub.remove()
  }
  return files
}
