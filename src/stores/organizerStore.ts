import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { walkDirectory, type FsEntry } from '~/lib/fsWalk'
import { renameEntry, sanitizeFilename, extOf } from '~/lib/fsRename'
import { handleDb } from '~/lib/idb'

export type PairStatus = 'matched' | 'video-only' | 'script-only'

export interface OrgPair {
  key: string
  dir: string
  basename: string
  video: FsEntry | null
  scripts: FsEntry[]
  status: PairStatus
}

const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i
const SCRIPT_EXT = /\.funscript$/i
const HANDLE_KEY = 'organizerDirHandle'
const LIBRARY_HANDLE_KEY = 'lastDirHandle'

function buildPairs(entries: FsEntry[]): OrgPair[] {
  const byDir = new Map<string, FsEntry[]>()
  for (const e of entries) {
    if (!VIDEO_EXT.test(e.name) && !SCRIPT_EXT.test(e.name)) continue
    const list = byDir.get(e.dirRelPath) ?? []
    list.push(e)
    byDir.set(e.dirRelPath, list)
  }

  const result: OrgPair[] = []
  for (const [dir, list] of byDir) {
    const videos = list.filter(e => VIDEO_EXT.test(e.name))
    const scripts = list.filter(e => SCRIPT_EXT.test(e.name))
    const usedScripts = new Set<FsEntry>()

    for (const v of videos) {
      const base = v.name.slice(0, v.name.length - extOf(v.name).length).toLowerCase()
      const matched = scripts.filter(s => {
        if (usedScripts.has(s)) return false
        const sBase = s.name.slice(0, s.name.length - extOf(s.name).length).toLowerCase()
        if (sBase === base) return true
        if (!sBase.startsWith(base)) return false
        // Only treat as a match if what follows the video's basename looks like a
        // separator-prefixed suffix (alt-axis tag), not an unrelated longer name.
        return /^[\s\-_.(]/.test(sBase.slice(base.length))
      })
      matched.forEach(s => usedScripts.add(s))
      result.push({
        key: `${dir}/${v.name}`,
        dir,
        basename: v.name.slice(0, v.name.length - extOf(v.name).length),
        video: v,
        scripts: matched,
        status: matched.length ? 'matched' : 'video-only',
      })
    }

    for (const s of scripts) {
      if (usedScripts.has(s)) continue
      result.push({
        key: `${dir}/${s.name}`,
        dir,
        basename: s.name.slice(0, s.name.length - extOf(s.name).length),
        video: null,
        scripts: [s],
        status: 'script-only',
      })
    }
  }

  result.sort((a, b) => a.dir.localeCompare(b.dir) || a.basename.localeCompare(b.basename, undefined, { sensitivity: 'base' }))
  return result
}

export const useOrganizerStore = defineStore('organizer', () => {
  const rootHandle = ref<FileSystemDirectoryHandle | null>(null)
  const rootName = ref('')
  const scanning = ref(false)
  const restoring = ref(false)
  const writable = ref(false)
  const error = ref<string | null>(null)
  const pairs = ref<OrgPair[]>([])
  const renamingKey = ref<string | null>(null)

  const hasRoot = computed(() => rootHandle.value !== null)
  const missingScriptCount = computed(() => pairs.value.filter(p => p.status === 'video-only').length)
  const orphanScriptCount = computed(() => pairs.value.filter(p => p.status === 'script-only').length)
  const matchedCount = computed(() => pairs.value.filter(p => p.status === 'matched').length)

  async function requestReadWrite(handle: FileSystemDirectoryHandle): Promise<boolean> {
    try {
      let perm = await (handle as any).queryPermission({ mode: 'readwrite' })
      if (perm !== 'granted') perm = await (handle as any).requestPermission({ mode: 'readwrite' })
      return perm === 'granted'
    } catch {
      return false
    }
  }

  async function setRoot(handle: FileSystemDirectoryHandle) {
    rootHandle.value = handle
    rootName.value = handle.name
    writable.value = await requestReadWrite(handle)
    await rescan()
  }

  async function openFolder(): Promise<boolean> {
    if (!('showDirectoryPicker' in window)) {
      error.value = 'File System Access API not supported in this browser'
      return false
    }
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      await handleDb.set(HANDLE_KEY, handle)
      await setRoot(handle)
      return true
    } catch {
      return false // user cancelled
    }
  }

  async function useLibraryFolder(): Promise<boolean> {
    const handle = await handleDb.get(LIBRARY_HANDLE_KEY)
    if (!handle) return false
    await handleDb.set(HANDLE_KEY, handle)
    await setRoot(handle)
    return true
  }

  async function restoreFolder(): Promise<boolean> {
    const handle = await handleDb.get(HANDLE_KEY)
    if (!handle) return false
    restoring.value = true
    try {
      await setRoot(handle)
      return true
    } finally {
      restoring.value = false
    }
  }

  async function retryPermission() {
    if (!rootHandle.value) return
    writable.value = await requestReadWrite(rootHandle.value)
  }

  async function rescan() {
    if (!rootHandle.value) return
    scanning.value = true
    error.value = null
    try {
      const entries = await walkDirectory(rootHandle.value)
      pairs.value = buildPairs(entries)
    } catch (e: any) {
      error.value = e?.message ?? 'Scan failed'
    } finally {
      scanning.value = false
    }
  }

  function clear() {
    rootHandle.value = null
    rootName.value = ''
    pairs.value = []
    writable.value = false
  }

  /** Rename a video + all of its matched scripts together, preserving each script's alt-axis suffix. */
  async function renamePair(pair: OrgPair, newBasenameRaw: string) {
    const newBasename = sanitizeFilename(newBasenameRaw)
    if (!newBasename || newBasename === pair.basename) return
    if (!writable.value) { error.value = 'No write permission — click "Enable editing"'; return }

    renamingKey.value = pair.key
    error.value = null
    const oldBasename = pair.basename
    try {
      if (pair.video) {
        const ext = extOf(pair.video.name)
        pair.video = await renameEntry(pair.video, newBasename + ext)
      }
      for (let i = 0; i < pair.scripts.length; i++) {
        const s = pair.scripts[i]
        const ext = extOf(s.name)
        const sBaseNoExt = s.name.slice(0, s.name.length - ext.length)
        const suffix = sBaseNoExt.slice(oldBasename.length) // preserves " (Bounce)" etc.
        pair.scripts[i] = await renameEntry(s, newBasename + suffix + ext)
      }
      pair.basename = newBasename
      pair.key = `${pair.dir}/${newBasename}`
    } catch (e: any) {
      error.value = `Rename failed: ${e?.message ?? e}`
      await rescan() // resync in case of partial rename
    } finally {
      renamingKey.value = null
    }
  }

  /** Rename a single file (e.g. an orphan script, or one alt-axis script within a pair) without touching its siblings. */
  async function renameSingle(pair: OrgPair, entry: FsEntry, newNameRaw: string) {
    const newName = sanitizeFilename(newNameRaw)
    if (!newName || newName === entry.name) return
    if (!writable.value) { error.value = 'No write permission — click "Enable editing"'; return }

    renamingKey.value = pair.key
    error.value = null
    try {
      const updated = await renameEntry(entry, newName)
      if (pair.video === entry) pair.video = updated
      const idx = pair.scripts.indexOf(entry)
      if (idx !== -1) pair.scripts[idx] = updated
    } catch (e: any) {
      error.value = `Rename failed: ${e?.message ?? e}`
      await rescan()
    } finally {
      renamingKey.value = null
    }
  }

  /** Bulk find/replace basenames across a set of pairs. Returns how many were actually renamed. */
  async function bulkRename(scope: OrgPair[], find: string, replace: string, useRegex: boolean): Promise<number> {
    if (!find) return 0
    let re: RegExp
    try {
      re = useRegex ? new RegExp(find, 'g') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    } catch {
      error.value = 'Invalid regular expression'
      return 0
    }
    let count = 0
    for (const p of scope) {
      const newBase = p.basename.replace(re, replace)
      if (newBase !== p.basename) {
        await renamePair(p, newBase)
        count++
      }
    }
    return count
  }

  return {
    rootHandle, rootName, scanning, restoring, writable, error, pairs, renamingKey,
    hasRoot, missingScriptCount, orphanScriptCount, matchedCount,
    openFolder, useLibraryFolder, restoreFolder, retryPermission, rescan, clear,
    renamePair, renameSingle, bulkRename,
  }
})
