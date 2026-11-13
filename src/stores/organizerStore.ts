import type { FsEntry } from '~/lib/fsWalk'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { desktop, pickDirectory } from '~/lib/browserApi'
import { extOf, renameEntry, sanitizeFilename } from '~/lib/fsRename'
import { walkDirectory } from '~/lib/fsWalk'
import { handleDb } from '~/lib/idb'
import { diskPathOf } from '~/lib/libraryWatch'
import { isAudioName, isMediaName } from '~/lib/mediaFiles'
import { isAndroidApp } from '~/lib/platform'
import { isSubtitleName, pairSubtitles } from '~/lib/subtitles'
import { carryVideoData } from './videoRename'

export type PairStatus = 'matched' | 'video-only' | 'script-only'

export interface OrgPair {
  key: string
  dir: string
  basename: string
  video: FsEntry | null
  scripts: FsEntry[]
  /** Subtitle files named after the video; renamed along with it. */
  subtitles: FsEntry[]
  status: PairStatus
  /** Last change on disk, ms: the video's, or the newest script's when there is no video. */
  modified: number
  /** Bytes: the video's, or the scripts' together. */
  size: number
}

/** When a pair last changed, and how big it is: the video speaks for it when there is one. */
function stats(video: FsEntry | null, scripts: FsEntry[]) {
  if (video)
    return { modified: video.file.lastModified, size: video.file.size }
  return {
    modified: Math.max(0, ...scripts.map(s => s.file.lastModified)),
    size: scripts.reduce((n, s) => n + s.file.size, 0),
  }
}

/** A pair's key: its folder and the name of the file that leads it. */
export const pairKey = (dir: string, video: FsEntry | null, scripts: FsEntry[]) => `${dir}/${video?.name ?? scripts[0]?.name ?? ''}`

const SCRIPT_EXT = /\.funscript$/i
const HANDLE_KEY = 'organizerDirHandle'
const LIBRARY_HANDLE_KEY = 'lastDirHandle'

export function buildPairs(entries: FsEntry[]): OrgPair[] {
  const byDir = new Map<string, FsEntry[]>()
  for (const e of entries) {
    if (!isMediaName(e.name) && !SCRIPT_EXT.test(e.name) && !isSubtitleName(e.name))
      continue
    const list = byDir.get(e.dirRelPath) ?? []
    list.push(e)
    byDir.set(e.dirRelPath, list)
  }

  const result: OrgPair[] = []
  for (const [dir, list] of byDir) {
    // Videos first, so a video and an audio file of the same name leave the
    // scripts to the video; audio files then pair like videos do.
    const videos = list.filter(e => isMediaName(e.name))
      .sort((a, b) => Number(isAudioName(a.name)) - Number(isAudioName(b.name)))
    const scripts = list.filter(e => SCRIPT_EXT.test(e.name))
    const usedScripts = new Set<FsEntry>()
    // Subtitles left without a video are not listed: the organizer is about
    // videos and scripts, and a stray .srt is not something to fix here.
    const subsFor = new Map<FsEntry, FsEntry[]>()
    for (const p of pairSubtitles(videos.map(v => v.name), list.filter(e => isSubtitleName(e.name))))
      subsFor.set(videos[p.video], [...(subsFor.get(videos[p.video]) ?? []), p.file])

    for (const v of videos) {
      const base = v.name.slice(0, v.name.length - extOf(v.name).length).toLowerCase()
      const matched = scripts.filter((s) => {
        if (usedScripts.has(s))
          return false
        const sBase = s.name.slice(0, s.name.length - extOf(s.name).length).toLowerCase()
        if (sBase === base)
          return true
        if (!sBase.startsWith(base))
          return false
        // Only treat as a match if what follows the video's basename looks like a
        // separator-prefixed suffix (alt-axis tag), not an unrelated longer name.
        return /^[\s\-_.(]/.test(sBase.slice(base.length))
      })
      // An audio file with no script is just a song: not the organizer's business.
      if (!matched.length && isAudioName(v.name))
        continue
      matched.forEach(s => usedScripts.add(s))
      result.push({
        key: pairKey(dir, v, matched),
        dir,
        basename: v.name.slice(0, v.name.length - extOf(v.name).length),
        video: v,
        scripts: matched,
        subtitles: subsFor.get(v) ?? [],
        status: matched.length ? 'matched' : 'video-only',
        ...stats(v, matched),
      })
    }

    for (const s of scripts) {
      if (usedScripts.has(s))
        continue
      result.push({
        key: pairKey(dir, null, [s]),
        dir,
        basename: s.name.slice(0, s.name.length - extOf(s.name).length),
        video: null,
        scripts: [s],
        subtitles: [],
        status: 'script-only',
        ...stats(null, [s]),
      })
    }
  }

  result.sort((a, b) => a.dir.localeCompare(b.dir) || a.basename.localeCompare(b.basename, undefined, { sensitivity: 'base' }))
  return result
}

export const useOrganizerStore = defineStore('organizer', () => {
  const rootHandle = ref<FileSystemDirectoryHandle | null>(null)
  /** Where the folder is on disk (desktop app), for the Recycle Bin; null when unknown. */
  let rootDisk: string | null = null
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
      if (perm !== 'granted')
        perm = await (handle as any).requestPermission({ mode: 'readwrite' })
      return perm === 'granted'
    }
    catch {
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
    if (isAndroidApp) {
      // Android's folder picker (it asks for writing too).
      const handle = await pickDirectory()
      if (!handle)
        return false
      await handleDb.set(HANDLE_KEY, handle)
      await setRoot(handle)
      return true
    }
    if (!('showDirectoryPicker' in window)) {
      error.value = 'File System Access API not supported in this browser'
      return false
    }
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
      await handleDb.set(HANDLE_KEY, handle)
      await setRoot(handle)
      return true
    }
    catch {
      return false // user cancelled
    }
  }

  /** A folder kept in IndexedDB; in the Android app, made an Android folder again. */
  async function savedHandle(key: string): Promise<FileSystemDirectoryHandle | undefined> {
    const h = await handleDb.get(key)
    if (!h || !isAndroidApp)
      return h
    const { reviveTree } = await import('~/lib/android/folders')
    return reviveTree(h) as unknown as FileSystemDirectoryHandle
  }

  async function useLibraryFolder(): Promise<boolean> {
    const handle = await savedHandle(LIBRARY_HANDLE_KEY)
    if (!handle)
      return false
    await handleDb.set(HANDLE_KEY, handle)
    await setRoot(handle)
    return true
  }

  async function restoreFolder(): Promise<boolean> {
    const handle = await savedHandle(HANDLE_KEY)
    if (!handle)
      return false
    restoring.value = true
    try {
      await setRoot(handle)
      return true
    }
    finally {
      restoring.value = false
    }
  }

  async function retryPermission() {
    if (!rootHandle.value)
      return
    writable.value = await requestReadWrite(rootHandle.value)
  }

  async function rescan() {
    if (!rootHandle.value)
      return
    scanning.value = true
    error.value = null
    try {
      const entries = await walkDirectory(rootHandle.value)
      pairs.value = buildPairs(entries)
      rootDisk = null
      const locate = desktop?.files?.locate
      if (locate && entries.length) {
        // The folder by its name and a file in it, as the library finds its own.
        const found = await locate([{ name: rootHandle.value.name, probe: entries[0].relPath }]).catch(() => [''])
        rootDisk = found[0] || null
      }
    }
    catch (e: any) {
      error.value = e?.message ?? 'Scan failed'
    }
    finally {
      scanning.value = false
    }
  }

  function clear() {
    rootHandle.value = null
    rootName.value = ''
    pairs.value = []
    writable.value = false
  }

  /**
   * Rename a video with all of its matched scripts and subtitles, keeping
   * each script's alt-axis suffix and each subtitle's language tag.
   */
  async function renamePair(pair: OrgPair, newBasenameRaw: string) {
    const newBasename = sanitizeFilename(newBasenameRaw)
    if (!newBasename || newBasename === pair.basename)
      return
    if (!writable.value) { error.value = 'No write permission — click "Enable editing"'; return }

    renamingKey.value = pair.key
    error.value = null
    const oldBasename = pair.basename
    try {
      if (pair.video) {
        const ext = extOf(pair.video.name)
        const was = pair.video.name
        pair.video = await renameEntry(pair.video, newBasename + ext)
        // Its tags, source link, star, stats… are kept by file name.
        await carryVideoData(was, pair.video.name)
      }
      for (let i = 0; i < pair.scripts.length; i++) {
        const s = pair.scripts[i]
        const ext = extOf(s.name)
        const sBaseNoExt = s.name.slice(0, s.name.length - ext.length)
        const suffix = sBaseNoExt.slice(oldBasename.length) // preserves " (Bounce)" etc.
        pair.scripts[i] = await renameEntry(s, newBasename + suffix + ext)
      }
      for (let i = 0; i < pair.subtitles.length; i++) {
        const s = pair.subtitles[i]
        const ext = extOf(s.name)
        const tag = s.name.slice(oldBasename.length, s.name.length - ext.length) // ".en", ".eng.forced" or ""
        pair.subtitles[i] = await renameEntry(s, newBasename + tag + ext)
      }
      pair.basename = newBasename
      pair.key = pairKey(pair.dir, pair.video, pair.scripts)
    }
    catch (e: any) {
      error.value = `Rename failed: ${e?.message ?? e}`
      await rescan() // resync in case of partial rename
    }
    finally {
      renamingKey.value = null
    }
  }

  /** Rename a single file (e.g. an orphan script, or one alt-axis script within a pair) without touching its siblings. */
  async function renameSingle(pair: OrgPair, entry: FsEntry, newNameRaw: string) {
    const newName = sanitizeFilename(newNameRaw)
    if (!newName || newName === entry.name)
      return
    if (!writable.value) { error.value = 'No write permission — click "Enable editing"'; return }

    renamingKey.value = pair.key
    error.value = null
    try {
      const updated = await renameEntry(entry, newName)
      if (pair.video === entry) {
        pair.video = updated
        await carryVideoData(entry.name, updated.name)
      }
      const idx = pair.scripts.indexOf(entry)
      if (idx !== -1)
        pair.scripts[idx] = updated
    }
    catch (e: any) {
      error.value = `Rename failed: ${e?.message ?? e}`
      await rescan()
    }
    finally {
      renamingKey.value = null
    }
  }

  /** Where each file is on disk, when every one of them has a known path (the desktop app). */
  function pathsOf(entries: FsEntry[]): string[] | null {
    const files = desktop?.files
    if (!files)
      return null
    // A File read through a folder handle has no path in Electron 44, so build
    // it from where the folder is on disk.
    const paths = entries.map(e => files.pathOf(e.file) || (rootDisk && rootHandle.value ? diskPathOf(rootDisk, `${rootHandle.value.name}/${e.relPath}`) : ''))
    return paths.every(Boolean) ? paths : null
  }

  /** Whether deleting these goes to the Recycle Bin (true) or is for good (false). */
  function deletesToBin(entries: FsEntry[]): boolean {
    return pathsOf(entries) !== null
  }

  /**
   * Delete files: to the Recycle Bin / Trash when the desktop app knows where
   * they are, otherwise straight off the disk (the browser has no bin to
   * offer). The folder is read again afterwards.
   */
  async function deleteEntries(entries: FsEntry[]): Promise<{ ok: number, failed: { name: string, error: string }[], toBin: boolean }> {
    const failed: { name: string, error: string }[] = []
    if (!writable.value)
      return { ok: 0, failed: entries.map(e => ({ name: e.name, error: 'No write permission' })), toBin: false }
    const paths = pathsOf(entries)
    if (paths) {
      const res = await desktop!.files!.trash(paths)
      if (res.error !== undefined) {
        failed.push(...entries.map(e => ({ name: e.name, error: res.error! })))
      }
      else {
        for (const f of res.failed) {
          const e = entries[paths.indexOf(f.path)]
          failed.push({ name: e?.name ?? f.path, error: f.error })
        }
      }
    }
    else {
      for (const e of entries) {
        try {
          await e.dirHandle.removeEntry(e.name)
        }
        catch (err: any) {
          failed.push({ name: e.name, error: err?.message ?? String(err) })
        }
      }
    }
    await rescan()
    return { ok: entries.length - failed.length, failed, toBin: !!paths }
  }

  /** Bulk find/replace basenames across a set of pairs. Returns how many were actually renamed. */
  async function bulkRename(scope: OrgPair[], find: string, replace: string, useRegex: boolean): Promise<number> {
    if (!find)
      return 0
    let re: RegExp
    try {
      re = useRegex ? new RegExp(find, 'g') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    }
    catch {
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
    rootHandle,
    rootName,
    scanning,
    restoring,
    writable,
    error,
    pairs,
    renamingKey,
    hasRoot,
    missingScriptCount,
    orphanScriptCount,
    matchedCount,
    openFolder,
    useLibraryFolder,
    restoreFolder,
    retryPermission,
    rescan,
    clear,
    renamePair,
    renameSingle,
    bulkRename,
    deletesToBin,
    deleteEntries,
  }
})
