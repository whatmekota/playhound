import type { PluginListenerHandle } from '@capacitor/core'
import type { NativeFileInfo } from './nativeFile'
import { registerPlugin } from '@capacitor/core'
import { rememberPath } from '../browserApi'
import { AUDIO_EXTS, VIDEO_EXTS } from '../mediaFiles'
import { getMediaBase, installObjectUrls, NativeBlob, NativeFile, setMediaBase } from './nativeFile'

/**
 * Library folders in the Android app, through the Folders plugin
 * (android/app/src/main/java/…/folders/FoldersPlugin.kt): Android's folder
 * picker, a fast recursive listing, the media server that streams the
 * files, and writing into them (AndroidFolder, AndroidWritable). The
 * library store sees an AndroidTree where the browser has a
 * FileSystemDirectoryHandle, and the NativeFiles it lists where the browser
 * has Files, so pairing, tags, saving next to a video and the Organizer's
 * renames work as they are.
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
  list: (o: { tree: string, doc: string | null }) => Promise<{ entries: Entry[] }>
  child: (o: { tree: string, doc: string | null, name: string }) => Promise<Entry | { missing: true }>
  stat: (o: { uri: string }) => Promise<Entry>
  create: (o: { tree: string, doc: string | null, name: string, dir: boolean }) => Promise<Entry>
  rename: (o: { uri: string, name: string }) => Promise<Entry>
  remove: (o: { uri: string }) => Promise<void>
  beginWrite: (o: { uri: string }) => Promise<{ id: string, url: string }>
  endWrite: (o: { id: string }) => Promise<Entry & { written: number }>
  abortWrite: (o: { id: string }) => Promise<void>
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

/** A file or folder in a picked folder, as the plugin answers it. */
interface Entry {
  uri: string
  name: string
  dir: boolean
  size: number
  modified: number
  mime: string
}

/** Bytes gathered before they go to the server in one PUT. */
const WRITE_CHUNK = 8 * 1024 * 1024

const notFound = (name: string) => new DOMException(`"${name}" is not in that folder`, 'NotFoundError')

/** Whether the app holds this tree's grant, for reading or also writing. */
async function grant(treeUri: string, mode: 'read' | 'readwrite' | undefined): Promise<PermissionState> {
  try {
    const { trees } = await PhFolders.trees()
    const t = trees.find(x => x.uri === treeUri)
    return t && t.read && (mode !== 'readwrite' || t.write) ? 'granted' : 'denied'
  }
  catch {
    return 'denied'
  }
}

/**
 * A folder in a picked tree, standing in for a FileSystemDirectoryHandle:
 * the parts of that interface the app uses (looking up, making and removing
 * entries, listing them), over the Folders plugin. AndroidTree is the picked
 * folder itself; AndroidDir any folder under it.
 */
abstract class AndroidFolder {
  readonly kind = 'directory' as const
  abstract readonly name: string
  /** The picked tree's URI. */
  abstract get treeUri(): string
  /** This folder's document URI; null for the tree's own folder. */
  abstract get docUri(): string | null

  private get at() {
    return { tree: this.treeUri, doc: this.docUri }
  }

  /** There is no prompt to show: a folder whose grant is gone has to be picked again. */
  queryPermission(opts: { mode?: 'read' | 'readwrite' } = {}): Promise<PermissionState> {
    return grant(this.treeUri, opts.mode)
  }

  requestPermission(opts: { mode?: 'read' | 'readwrite' } = {}): Promise<PermissionState> {
    return this.queryPermission(opts)
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    const o = other as AndroidFolder | null
    return !!o && o.kind === 'directory' && typeof (o as any).treeUri === 'string' && o.treeUri === this.treeUri && o.docUri === this.docUri
  }

  private handleFor(e: Entry): AndroidDir | AndroidFileHandle {
    return e.dir ? new AndroidDir(this.treeUri, e.uri, e.name) : new AndroidFileHandle(e.uri, e.name, this)
  }

  private async lookup(name: string, create: boolean, dir: boolean): Promise<Entry> {
    if (create) {
      return PhFolders.create({ ...this.at, name, dir }).catch((err) => {
        throw err?.code === 'TYPE_MISMATCH' ? new DOMException(err.message, 'TypeMismatchError') : new DOMException(err?.message ?? 'Could not make it', 'NotAllowedError')
      })
    }
    const e = await PhFolders.child({ ...this.at, name })
    if ('missing' in e)
      throw notFound(name)
    if (e.dir !== dir)
      throw new DOMException(`"${name}" is a ${e.dir ? 'folder' : 'file'}`, 'TypeMismatchError')
    return e
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<AndroidDir> {
    return this.handleFor(await this.lookup(name, !!opts.create, true)) as AndroidDir
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<AndroidFileHandle> {
    return this.handleFor(await this.lookup(name, !!opts.create, false)) as AndroidFileHandle
  }

  /** Files only: a folder is never deleted from the app. */
  async removeEntry(name: string): Promise<void> {
    const e = await PhFolders.child({ ...this.at, name })
    if ('missing' in e)
      throw notFound(name)
    if (e.dir)
      throw new DOMException('Folders are not deleted from the app', 'InvalidModificationError')
    await PhFolders.remove({ uri: e.uri })
  }

  async* entries(): AsyncGenerator<[string, AndroidDir | AndroidFileHandle]> {
    const { entries } = await PhFolders.list(this.at)
    for (const e of entries)
      yield [e.name, this.handleFor(e)]
  }

  async* values(): AsyncGenerator<AndroidDir | AndroidFileHandle> {
    for await (const [, h] of this.entries())
      yield h
  }

  async* keys(): AsyncGenerator<string> {
    const { entries } = await PhFolders.list(this.at)
    for (const e of entries)
      yield e.name
  }

  [Symbol.asyncIterator]() {
    return this.entries()
  }
}

/**
 * A picked folder, standing in for a FileSystemDirectoryHandle in the library
 * store. Only its fields are own properties, so IndexedDB keeps it (as a
 * plain object; see reviveTree). Reading is the folder picker's persisted
 * grant; writing too when Android gave it (the picker asks for both).
 */
export class AndroidTree extends AndroidFolder {
  readonly androidTree = true

  constructor(readonly uri: string, readonly name: string) {
    super()
  }

  get treeUri() {
    return this.uri
  }

  get docUri() {
    return null
  }

  /** Every file the library can use, its path starting at `label`. browserApi.collectHandleFiles calls this. */
  collectFiles(label: string = this.name): Promise<File[]> {
    return scanTree(this, label)
  }
}

/** A folder somewhere under a picked one. */
export class AndroidDir extends AndroidFolder {
  constructor(private readonly tree: string, private readonly doc: string, readonly name: string) {
    super()
  }

  get treeUri() {
    return this.tree
  }

  get docUri() {
    return this.doc
  }
}

/** A file in a picked folder, standing in for a FileSystemFileHandle. */
export class AndroidFileHandle {
  readonly kind = 'file' as const

  constructor(public uri: string, public name: string, readonly parent: AndroidFolder) {}

  queryPermission(opts: { mode?: 'read' | 'readwrite' } = {}) {
    return this.parent.queryPermission(opts)
  }

  requestPermission(opts: { mode?: 'read' | 'readwrite' } = {}) {
    return this.parent.queryPermission(opts)
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return !!other && (other as AndroidFileHandle).kind === 'file' && (other as AndroidFileHandle).uri === this.uri
  }

  /** The file as it is now. */
  async getFile(): Promise<File> {
    await ensureMediaServer()
    const e = await PhFolders.stat({ uri: this.uri }).catch(() => {
      throw notFound(this.name)
    })
    return new NativeFile({ uri: this.uri, name: e.name || this.name, size: e.size, modified: e.modified, mime: e.mime })
  }

  /** Written from empty, as the browser's is; it takes effect as it goes, not on close. */
  async createWritable(): Promise<AndroidWritable> {
    return new AndroidWritable(this.uri)
  }

  /** Rename in place (moving to another folder is not supported). */
  async move(a: unknown, b?: string): Promise<void> {
    const name = typeof a === 'string' ? a : b
    if (typeof name !== 'string' || (typeof a !== 'string' && !(await this.parent.isSameEntry(a))))
      throw new DOMException('Only renaming in place is supported here', 'NotSupportedError')
    const e = await PhFolders.rename({ uri: this.uri, name })
    this.uri = e.uri
    this.name = e.name || name
  }

  async remove(): Promise<void> {
    await PhFolders.remove({ uri: this.uri })
  }
}

/** One piece of what a writable is handed, as something a Blob can hold. */
export async function blobPart(chunk: unknown): Promise<BlobPart> {
  // A library file's Blob is empty in itself: its bytes are on the server.
  if (chunk instanceof NativeFile || chunk instanceof NativeBlob)
    return chunk.arrayBuffer()
  if (chunk instanceof Blob || typeof chunk === 'string' || chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk))
    return chunk as BlobPart
  const c = chunk as { type?: string, data?: unknown, position?: number } | null
  if (c && c.type === 'write' && c.position == null)
    return blobPart(c.data)
  throw new DOMException('Only writing straight through is supported here (no seek or truncate)', 'NotSupportedError')
}

function sizeOf(p: BlobPart): number {
  if (typeof p === 'string')
    return new TextEncoder().encode(p).byteLength
  if (p instanceof Blob)
    return p.size
  return (p as ArrayBuffer | ArrayBufferView).byteLength
}

/**
 * What createWritable() answers: a WritableStream (so pipeTo works) with
 * write() of its own, as FileSystemWritableFileStream has. Bytes are
 * gathered and PUT to the media server in pieces of a few MB (FoldersPlugin
 * beginWrite, WriteSessions.kt); closing ends the file there.
 */
export class AndroidWritable extends WritableStream<unknown> {
  constructor(uri: string) {
    let session: { id: string, url: string } | null = null
    let parts: BlobPart[] = []
    let gathered = 0
    const open = async () => (session ??= await PhFolders.beginWrite({ uri }))
    const flush = async () => {
      if (!gathered)
        return
      const s = await open()
      const body = new Blob(parts)
      parts = []
      gathered = 0
      const res = await fetch(s.url, { method: 'PUT', body })
      if (!res.ok)
        throw new DOMException(await res.text().catch(() => `Could not write (${res.status})`), 'InvalidStateError')
    }
    super({
      async write(chunk) {
        const part = await blobPart(chunk)
        parts.push(part)
        gathered += sizeOf(part)
        if (gathered >= WRITE_CHUNK)
          await flush()
      },
      async close() {
        // Even with nothing written: the file ends up empty, as asked.
        const s = await open()
        await flush()
        await PhFolders.endWrite({ id: s.id })
      },
      async abort() {
        if (session)
          await PhFolders.abortWrite({ id: session.id }).catch(() => {})
      },
    })
  }

  async write(data: unknown): Promise<void> {
    const w = this.getWriter()
    try {
      await w.write(data)
    }
    finally {
      w.releaseLock()
    }
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
