import type { PostScript } from '~/lib/postScripts'
import type { StreamSource } from '~/lib/streamHosts'
import { reactive } from 'vue'
import { handleDb } from '~/lib/idb'
import { baseNameFor, downloadNames, videoExtFor, withCopyNumber } from '~/lib/postDownload'
import { useLibraryStore } from '~/stores/libraryStore'

/**
 * Save a video from a post, and its scripts, under one name.
 *
 * Into the library folder when there is one, so the pair shows up there with
 * its scripts matched; otherwise into a folder picked once and remembered.
 * The video streams through the local proxy straight to disk, so a 4K file
 * never sits in memory; cancelling or failing removes what was written.
 */

export interface DownloadJob {
  title: string
  folder: string
  phase: 'scripts' | 'video' | 'done' | 'error'
  received: number
  total: number | null
  error?: string
  cancel: () => void
}

/** Running and finished downloads, by the key the caller gives (one per video link). */
export const downloads = reactive(new Map<string, DownloadJob>())

const DOWNLOADS_KEY = 'downloadsDir'

async function writable(handle: any): Promise<boolean> {
  try {
    let perm = await handle.queryPermission({ mode: 'readwrite' })
    if (perm !== 'granted')
      perm = await handle.requestPermission({ mode: 'readwrite' })
    return perm === 'granted'
  }
  catch {
    return false
  }
}

/** Where to save: the library folder, else the remembered one, else ask. Call from a click. */
async function targetFolder(): Promise<{ dir: FileSystemDirectoryHandle, library: boolean }> {
  const lib = await useLibraryStore().writableFolder()
  if (lib)
    return { dir: lib, library: true }
  const saved = await handleDb.get(DOWNLOADS_KEY).catch(() => undefined) as FileSystemDirectoryHandle | undefined
  if (saved && await writable(saved))
    return { dir: saved, library: false }
  const pick = (window as any).showDirectoryPicker
  if (!pick)
    throw new Error('Saving to a folder needs the desktop app, Chrome or Edge')
  const dir: FileSystemDirectoryHandle = await pick({ id: 'playhound-downloads', mode: 'readwrite' })
  await handleDb.set(DOWNLOADS_KEY, dir).catch(() => {})
  return { dir, library: false }
}

async function exists(dir: FileSystemDirectoryHandle, name: string) {
  try {
    await dir.getFileHandle(name)
    return true
  }
  catch {
    return false
  }
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob) {
  const handle = await dir.getFileHandle(name, { create: true })
  const w = await (handle as any).createWritable()
  await w.write(data)
  await w.close()
}

export interface DownloadRequest {
  key: string
  /** The video's title: the name everything is saved under. */
  title: string
  source: StreamSource
  scripts: PostScript[]
  /** Fetch the post's scripts, in the order of `scripts`. */
  fetchScripts: () => Promise<File[]>
}

/** Start a download. Resolves when it is done, failed or cancelled; never throws. */
export async function downloadPost(req: DownloadRequest): Promise<DownloadJob> {
  const abort = new AbortController()
  const job = reactive<DownloadJob>({
    title: req.title,
    folder: '',
    phase: 'scripts',
    received: 0,
    total: req.source.size ?? null,
    cancel: () => abort.abort(),
  }) as DownloadJob
  downloads.set(req.key, job)

  const written: string[] = []
  let dir: FileSystemDirectoryHandle | null = null
  try {
    // First, while the click still counts as one: the folder and its permission.
    const target = await targetFolder()
    dir = target.dir
    job.folder = dir.name

    const files = req.scripts.length ? await req.fetchScripts() : []
    if (abort.signal.aborted)
      throw new DOMException('Cancelled', 'AbortError')

    job.phase = 'video'
    const res = await fetch(req.source.url, { signal: abort.signal })
    if (!res.ok || !res.body)
      throw new Error(`The video answered HTTP ${res.status}`)
    const length = Number(res.headers.get('content-length'))
    if (length > 0)
      job.total = length

    const base = baseNameFor(req.title)
    const first = downloadNames(base, videoExtFor(req.title, res.headers.get('content-type')), req.scripts)
    let names = first
    for (let n = 2; await exists(dir, names.video) || (await Promise.all(names.scripts.map(s => exists(dir!, s.saveAs)))).some(Boolean); n++)
      names = withCopyNumber(first, base, n)

    for (const [i, s] of names.scripts.entries()) {
      await writeFile(dir, s.saveAs, files[i])
      written.push(s.saveAs)
    }

    const handle = await dir.getFileHandle(names.video, { create: true })
    written.push(names.video)
    const out = await (handle as any).createWritable()
    // Count bytes as they pass, but only tell Vue a few times a second.
    let received = 0
    let shownAt = 0
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        received += chunk.byteLength
        const now = performance.now()
        if (now - shownAt > 250) {
          shownAt = now
          job.received = received
        }
        ctl.enqueue(chunk)
      },
    })
    await res.body.pipeThrough(counter).pipeTo(out, { signal: abort.signal })
    job.received = received
    job.phase = 'done'
    if (target.library)
      void useLibraryStore().rescan()
  }
  catch (e: any) {
    job.phase = 'error'
    job.error = e?.name === 'AbortError' ? 'Cancelled' : (e?.message ?? 'The download failed')
    // Leave nothing half-written behind.
    for (const name of written)
      await dir?.removeEntry(name).catch(() => {})
  }
  return job
}
