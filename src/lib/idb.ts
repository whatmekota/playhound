/**
 * Tiny IndexedDB wrapper for caching thumbnails and folder metadata.
 * Stores:
 *   "thumbs"    — key: filename, value: dataURL string
 *   "meta"      — key: string,   value: any
 *   "vidmeta"   — key: filename, value: VideoMeta (user editable overrides)
 *   "previews"  — key: name|size|mtime, value: PreviewRecord (scrub sprite sheets; a cache)
 *   "soundtracks" — key: name|size|mtime, value: SoundtrackRecord (beat analyses; a cache)
 */

// Storage identifier, not a brand string. Renaming it would orphan every
// user's playlists, video metadata and saved directory handles.
const DB_NAME = 'mwhoplayer'
const DB_VERSION = 6
let db: IDBDatabase | null = null

function openDB(): Promise<IDBDatabase> {
  if (db)
    return Promise.resolve(db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('thumbs'))
        d.createObjectStore('thumbs')
      if (!d.objectStoreNames.contains('meta'))
        d.createObjectStore('meta')
      if (!d.objectStoreNames.contains('handles'))
        d.createObjectStore('handles')
      if (!d.objectStoreNames.contains('playlists'))
        d.createObjectStore('playlists')
      if (!d.objectStoreNames.contains('vidmeta'))
        d.createObjectStore('vidmeta')
      if (!d.objectStoreNames.contains('summaries'))
        d.createObjectStore('summaries')
      // v5: scrub preview strips.
      if (!d.objectStoreNames.contains('previews'))
        d.createObjectStore('previews')
      // v6: whole-track soundtrack analyses.
      if (!d.objectStoreNames.contains('soundtracks'))
        d.createObjectStore('soundtracks')
    }
    req.onsuccess = () => {
      db = req.result
      // Another tab upgrading the schema waits on this connection; let it go
      // and reopen on the next call.
      db.onversionchange = () => {
        db?.close()
        db = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
}

function tx(store: string, mode: IDBTransactionMode) {
  return db!.transaction(store, mode).objectStore(store)
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  await openDB()
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readonly').get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbSet(store: string, key: string, value: unknown): Promise<void> {
  await openDB()
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export const thumbDb = {
  get: (key: string) => idbGet<string>('thumbs', key),
  set: (key: string, dataUrl: string) => idbSet('thumbs', key, dataUrl),
}

export const metaDb = {
  get: <T>(key: string) => idbGet<T>('meta', key),
  set: (key: string, value: unknown) => idbSet('meta', key, value),
}

export const handleDb = {
  get: (key: string) => idbGet<FileSystemDirectoryHandle>('handles', key),
  set: (key: string, value: FileSystemDirectoryHandle) => idbSet('handles', key, value),
  del: async (key: string) => {
    await openDB()
    return new Promise<void>((resolve, reject) => {
      const req = db!.transaction('handles', 'readwrite').objectStore('handles').delete(key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  },
}

export const playlistDb = {
  get: (key: string) => idbGet<any>('playlists', key),
  set: (key: string, value: unknown) => idbSet('playlists', key, value),
  del: async (key: string) => {
    await openDB()
    return new Promise<void>((resolve, reject) => {
      const req = db!.transaction('playlists', 'readwrite').objectStore('playlists').delete(key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  },
  getAll: async (): Promise<{ key: string, value: any }[]> => {
    await openDB()
    return new Promise((resolve, reject) => {
      const store = db!.transaction('playlists', 'readonly').objectStore('playlists')
      const keys: string[] = []
      const values: any[] = []
      store.getAllKeys().onsuccess = (e) => { (e.target as any).result.forEach((k: string) => keys.push(k)) }
      store.getAll().onsuccess = (e) => {
        (e.target as any).result.forEach((v: any) => values.push(v))
        resolve(keys.map((k, i) => ({ key: k, value: values[i] })))
      }
      store.getAll().onerror = () => reject(new Error('IndexedDB getAll failed'))
    })
  },
}

/** Per-video user-editable metadata (merged with script metadata as source of truth) */
export interface VideoMeta {
  /** User notes / description */
  notes?: string
  /** Tags array (merged from script metadata + user additions) */
  tags?: string[]
  /** Script creator from metadata */
  creator?: string
  /** Script date from metadata */
  date?: string
  /** Link to source (e.g. eroscripts) */
  url?: string
  /** User rating 1-5 */
  rating?: number
}

/**
 * Whole-store access, for backup and restore.
 *
 * `handles` is deliberately not exportable: it holds FileSystemDirectoryHandle
 * objects, which are neither serialisable nor valid outside the origin that
 * created them. Folders have to be re-picked after a move.
 */
export const BACKUP_STORES = ['meta', 'playlists', 'vidmeta', 'summaries'] as const
export type BackupStore = typeof BACKUP_STORES[number]

export async function exportStore(name: BackupStore): Promise<[string, unknown][]> {
  await openDB()
  return new Promise((resolve, reject) => {
    const store = db!.transaction(name, 'readonly').objectStore(name)
    const keysReq = store.getAllKeys()
    const valsReq = store.getAll()
    valsReq.onsuccess = () => {
      const keys = keysReq.result ?? []
      const vals = valsReq.result ?? []
      resolve(keys.map((k, i) => [String(k), vals[i]]))
    }
    valsReq.onerror = () => reject(new Error(`IndexedDB read failed: ${name}`))
  })
}

export async function importStore(name: BackupStore, records: [string, unknown][]): Promise<void> {
  await openDB()
  return new Promise((resolve, reject) => {
    const tr = db!.transaction(name, 'readwrite')
    const store = tr.objectStore(name)
    for (const [k, v] of records)
      store.put(v, k)
    tr.oncomplete = () => resolve()
    tr.onerror = () => reject(new Error(`IndexedDB write failed: ${name}`))
  })
}

export interface ScriptSummary {
  /** Mean speed in position-units per second, 0-1 positions. */
  meanSpeed: number
  /** Mean stroke cycles per minute. */
  meanSpm: number
  peakSpeed: number
  durationMs: number
  /** When this was computed, so a changed script can be re-analysed. */
  actionCount: number
}

/**
 * Cached shape summaries, so the auto-director can compare videos it has not
 * loaded. Keyed by video filename.
 */
export const summaryDb = {
  get: (key: string) => idbGet<ScriptSummary>('summaries', key),
  set: (key: string, value: ScriptSummary) => idbSet('summaries', key, value),
  async all(): Promise<Record<string, ScriptSummary>> {
    await openDB()
    return new Promise((resolve, reject) => {
      const store = db!.transaction('summaries', 'readonly').objectStore('summaries')
      const keysReq = store.getAllKeys()
      const valsReq = store.getAll()
      valsReq.onsuccess = () => {
        const out: Record<string, ScriptSummary> = {}
        const keys = keysReq.result ?? []
        const vals = valsReq.result ?? []
        keys.forEach((k, i) => {
          out[String(k)] = vals[i]
        })
        resolve(out)
      }
      valsReq.onerror = () => reject(new Error('IndexedDB getAll failed'))
    })
  },
}

export const videoMetaDb = {
  get: (filename: string) => idbGet<VideoMeta>('vidmeta', filename),
  set: (filename: string, value: VideoMeta) => idbSet('vidmeta', filename, value),
}

/** A scrub preview strip: frames packed into one JPEG sprite sheet. */
export interface PreviewRecord {
  /** Layout version, so a change to the format can ignore old entries. */
  v: number
  blob: Blob
  cols: number
  rows: number
  frameW: number
  frameH: number
  /** Seconds between frames; frame i shows (i + 0.5) × interval. */
  interval: number
  count: number
  /** Last time it was built or used (ms epoch), for pruning. */
  at: number
}

/**
 * Preview strips. A pure cache (rebuilt on demand), so not in BACKUP_STORES.
 * `prune` keeps the store from growing without bound on a large library.
 */
export const previewDb = {
  get: (key: string) => idbGet<PreviewRecord>('previews', key),
  set: (key: string, value: PreviewRecord) => idbSet('previews', key, value),
  async prune(keep: number): Promise<void> {
    await openDB()
    const store = db!.transaction('previews', 'readonly').objectStore('previews')
    const entries: { key: IDBValidKey, at: number }[] = await new Promise((resolve, reject) => {
      const out: { key: IDBValidKey, at: number }[] = []
      // A cursor over values hands back Blob handles, not their bytes, so this stays cheap.
      const req = store.openCursor()
      req.onsuccess = () => {
        const c = req.result
        if (!c)
          return resolve(out)
        out.push({ key: c.key, at: (c.value as PreviewRecord)?.at ?? 0 })
        c.continue()
      }
      req.onerror = () => reject(req.error)
    })
    if (entries.length <= keep)
      return
    entries.sort((a, b) => a.at - b.at)
    const tr = db!.transaction('previews', 'readwrite')
    for (const e of entries.slice(0, entries.length - keep))
      tr.objectStore('previews').delete(e.key)
    await new Promise<void>((resolve, reject) => {
      tr.oncomplete = () => resolve()
      tr.onerror = () => reject(tr.error)
    })
  },
}

/** A cached soundtrack analysis (see lib/beatTrack). */
export interface SoundtrackRecord {
  /** Analysis version it was made with; others are ignored and redone. */
  v: number
  /** The analysis itself, as plain arrays. */
  analysis: unknown
  /** When it was made (ms epoch). */
  at: number
}

/**
 * Soundtrack analyses. Slow to make (the whole audio track has to be
 * decoded) but small and always reproducible from the video, so a cache
 * rather than something to back up.
 */
export const soundtrackDb = {
  get: (key: string) => idbGet<SoundtrackRecord>('soundtracks', key),
  set: (key: string, value: SoundtrackRecord) => idbSet('soundtracks', key, value),
}
