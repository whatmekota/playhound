/**
 * Tiny IndexedDB wrapper for caching thumbnails and folder metadata.
 * Stores:
 *   "thumbs"    — key: filename, value: dataURL string
 *   "meta"      — key: string,   value: any
 *   "vidmeta"   — key: filename, value: VideoMeta (user editable overrides)
 */

// Storage identifier, not a brand string. Renaming it would orphan every
// user's playlists, video metadata and saved directory handles.
const DB_NAME = 'mwhoplayer'
const DB_VERSION = 3
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
    }
    req.onsuccess = () => { db = req.result; resolve(db) }
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

export const videoMetaDb = {
  get: (filename: string) => idbGet<VideoMeta>('vidmeta', filename),
  set: (filename: string, value: VideoMeta) => idbSet('vidmeta', filename, value),
}
