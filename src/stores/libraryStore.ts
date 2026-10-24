import type { VideoMeta } from '~/lib/idb'
import type { ScriptInfo } from '~/lib/scriptSniff'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { AXIS_MAP } from '~/lib/axisMap'
import { openFolderWithHandle } from '~/lib/browserApi'
import { handleDb, metaDb } from '~/lib/idb'
import { sniffScript } from '~/lib/scriptSniff'

export interface ScriptMatch {
  file: File
  isAlt: boolean
  altName: string // e.g. "Bounce" extracted from "(Bounce)" or " Bounce" suffix
}

/** How the script type is classified — drives badge color in library */
export type ScriptType = 'none' | 'single' | 'multi' | 'merged'

export interface VideoEntry {
  file: File
  name: string
  basename: string
  hasScript: boolean
  /**
   * Number of *axes*, not files. A merged script is one file holding several,
   * and an alternate take is another file holding the same one, so counting
   * files gets both wrong.
   */
  scriptCount: number
  /** TCode channels available, once known. */
  channels?: string[]
  /** Alternate takes, e.g. "clip (bounce).funscript". Not extra axes. */
  altCount: number
  scriptFiles: File[]
  scriptMatches: ScriptMatch[]
  thumbnailUrl: string | null
  duration: number | null // seconds, populated on first thumbnail/metadata load
  scriptType: ScriptType
  scriptMeta?: VideoMeta
  userMeta?: VideoMeta
  starred: boolean
}

/**
 * Sniff a script, remembering the answer.
 *
 * Reading every script on every folder scan would be wasteful, and the answer
 * only changes when the file does — so it is keyed by name, size and mtime.
 */
async function cachedSniff(file: File): Promise<ScriptInfo> {
  const key = `sniff:${file.name}|${file.size}|${file.lastModified}`
  try {
    const hit = await metaDb.get<ScriptInfo>(key)
    if (hit?.channels)
      return hit
  }
  catch {
    // cache miss or unavailable storage — fall through and read the file
  }

  const info = await sniffScript(file)
  void metaDb.set(key, info)
  return info
}

export const useLibraryStore = defineStore('library', () => {
  const videos = ref<VideoEntry[]>([])
  const scanning = ref(false)
  const folderName = ref('')
  const totalFiles = ref(0)

  const hasVideos = computed(() => videos.value.length > 0)

  // Persist starred video names across sessions
  // Legacy storage key kept so existing data survives the rename.
  const STARS_KEY = 'ph:library.starred'
  const starredNames = new Set<string>(JSON.parse(localStorage.getItem(STARS_KEY) ?? '[]'))

  function toggleStar(entry: VideoEntry) {
    entry.starred = !entry.starred
    if (entry.starred)
      starredNames.add(entry.name)
    else starredNames.delete(entry.name)
    localStorage.setItem(STARS_KEY, JSON.stringify([...starredNames]))
  }

  /**
   * Process files from folder input in async batches so the UI never freezes.
   * Only File *handles* are stored — no file content is ever read here.
   */
  /**
   * Add loose files (a drag and drop) to what is already loaded instead of
   * replacing it: dropping one clip and its scripts used to swap a whole
   * restored library for that one video. Same-named entries are replaced.
   */
  async function addFiles(files: File[]) {
    if (!videos.value.length)
      return setFiles(files)
    const kept = videos.value
    const keptFolder = folderName.value
    await setFiles(files)
    const added = new Set(videos.value.map(v => v.name))
    videos.value = [...kept.filter(v => !added.has(v.name)), ...videos.value]
      .sort((a, b) => a.name.localeCompare(b.name))
    folderName.value = keptFolder
    totalFiles.value = videos.value.length
  }

  async function setFiles(files: File[]) {
    scanning.value = true
    totalFiles.value = files.length
    folderName.value = files[0]?.webkitRelativePath?.split('/')[0] ?? 'Folder'

    const videoExts = /\.(?:mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i

    // Build a name→File map for funscripts only (no content read)
    // Key: lowercase filename, Value: File handle
    const scriptMap = new Map<string, File>()
    for (const f of files) {
      if (f.name.toLowerCase().endsWith('.funscript')) {
        scriptMap.set(f.name.toLowerCase(), f)
      }
    }

    // Collect video files
    const videoFiles = files.filter(f => videoExts.test(f.name))

    // Build entries in chunks of 200 to yield to the event loop between chunks
    const CHUNK = 200
    const entries: VideoEntry[] = []

    for (let i = 0; i < videoFiles.length; i += CHUNK) {
      const chunk = videoFiles.slice(i, i + CHUNK)
      for (const f of chunk) {
        const basename = f.name.replace(/\.[^.]+$/, '').toLowerCase()
        const matches: ScriptMatch[] = []

        for (const [key, sf] of scriptMap) {
          if (!key.startsWith(basename))
            continue
          // Strip ".funscript" and the basename prefix to get the suffix
          const withoutExt = key.slice(0, -'.funscript'.length) // e.g. "video (bounce)" or "video.twist"
          const suffix = withoutExt.slice(basename.length).trim() // e.g. " (bounce)" or ".twist" or ""

          // Clean suffix: strip surrounding parens, dots, spaces, dashes → "bounce", "twist", "r0"
          const altName = suffix.replace(/^[\s\-_.(]+|[\s\-_.)]+$/g, '').trim()

          // A known axis key (twist, r0, surge, l1, etc.) → this is a primary axis script, NOT an alt
          const isAxisScript = altName.length > 0 && altName.toLowerCase() in AXIS_MAP
          const isAlt = suffix.length > 0 && !isAxisScript

          matches.push({ file: sf, isAlt, altName: isAlt ? altName : '' })
        }

        // Sort: primary (exact) first, then alts alphabetically
        matches.sort((a, b) => {
          if (a.isAlt !== b.isAlt)
            return a.isAlt ? 1 : -1
          return a.altName.localeCompare(b.altName)
        })

        // Alternate takes are the same axis done differently; they must not
        // inflate the axis count or push an entry into the multi-axis filter.
        const axisFiles = matches.filter(m => !m.isAlt)
        const altFiles = matches.filter(m => m.isAlt)

        entries.push({
          file: f,
          name: f.name,
          basename: f.name.replace(/\.[^.]+$/, ''),
          hasScript: matches.length > 0,
          scriptCount: axisFiles.length,
          altCount: altFiles.length,
          scriptFiles: matches.map(m => m.file),
          scriptMatches: matches,
          thumbnailUrl: null,
          duration: null,
          scriptType: matches.length === 0
            ? 'none'
            : axisFiles.length > 1 ? 'multi' : 'single',
          starred: starredNames.has(f.name),
        })
      }
      // Yield to browser between chunks
      await new Promise(r => setTimeout(r, 0))
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))
    videos.value = entries
    scanning.value = false

    // ── Post-scan: find merged multi-axis scripts ────────────────────────
    // One file can hold every axis, which filename matching cannot see. Only
    // entries that resolve to a single axis file are worth checking.
    const candidates = entries.filter(
      e => e.scriptType === 'single' && e.scriptMatches.some(m => !m.isAlt),
    )

    const SNIFF_BATCH = 24
    for (let i = 0; i < candidates.length; i += SNIFF_BATCH) {
      const batch = candidates.slice(i, i + SNIFF_BATCH)
      await Promise.all(batch.map(async (entry) => {
        const match = entry.scriptMatches.find(m => !m.isAlt)
        if (!match)
          return

        const info = await cachedSniff(match.file)
        entry.channels = info.channels
        if (info.merged) {
          entry.scriptType = 'merged'
          entry.scriptCount = info.channels.length
        }
      }))
      // Yield between batches so the library stays responsive while scanning.
      await new Promise(r => setTimeout(r, 0))
    }
  }

  function clear() {
    videos.value = []
    folderName.value = ''
    totalFiles.value = 0
  }

  // ── Folder lifecycle ──────────────────────────────────────────────────────
  // Lives here rather than in the library panel so the folder comes back at
  // startup whether or not that panel happens to be open.
  const HANDLE_KEY = 'lastDirHandle'
  const restoring = ref(false)
  /** A folder is remembered but the browser wants a click before reading it again. */
  const needsReconnect = ref(false)
  /** Name of the remembered folder, for the reconnect prompt. */
  const savedFolderName = ref('')
  const isWatching = ref(false)
  const watchNewCount = ref(0)
  /** Bumped after every completed scan, so views can react to a fresh library. */
  const loadedAt = ref(0)
  let watchTimer: ReturnType<typeof setInterval> | null = null
  let watchedHandle: FileSystemDirectoryHandle | null = null
  const WATCH_INTERVAL_MS = 30_000
  const VIDEO_EXTS = /\.(?:mp4|mkv|webm|avi|mov|m4v|wmv|flv)$/i

  async function loadFrom(files: File[], handle: FileSystemDirectoryHandle | null) {
    await setFiles(files)
    if (handle) {
      folderName.value = handle.name || folderName.value
      startWatching(handle)
    }
    needsReconnect.value = false
    loadedAt.value = Date.now()
  }

  /** Ask the user for a folder. Returns false when they cancel. */
  async function pickFolder(): Promise<boolean> {
    const { files, handle } = await openFolderWithHandle()
    if (!files.length)
      return false
    if (handle) {
      await handleDb.set(HANDLE_KEY, handle)
      savedFolderName.value = handle.name
    }
    await loadFrom(files, handle)
    return true
  }

  async function readHandle(handle: FileSystemDirectoryHandle, prompt: boolean): Promise<File[] | null> {
    const h = handle as any
    if (!h || !('queryPermission' in h))
      return null
    try {
      let perm = await h.queryPermission({ mode: 'read' })
      if (perm !== 'granted' && prompt)
        perm = await h.requestPermission({ mode: 'read' })
      if (perm !== 'granted')
        return null
      return await collectFiles(handle)
    }
    catch {
      return null
    }
  }

  /**
   * Bring back the last folder.
   *
   * Without a user gesture the browser will not show its permission prompt, so
   * a silent restore that comes back 'prompt' just flags `needsReconnect` and
   * leaves a one-click reconnect to the UI.
   */
  async function restoreFolder(opts: { prompt?: boolean } = {}): Promise<boolean> {
    if (hasVideos.value)
      return true
    let handle: FileSystemDirectoryHandle | undefined
    try {
      handle = await handleDb.get(HANDLE_KEY)
    }
    catch {
      return false
    }
    if (!handle)
      return false
    savedFolderName.value = handle.name
    restoring.value = true
    try {
      const files = await readHandle(handle, !!opts.prompt)
      if (!files) {
        needsReconnect.value = true
        return false
      }
      if (files.length)
        await loadFrom(files, handle)
      return files.length > 0
    }
    finally {
      restoring.value = false
    }
  }

  /** Must be called from a click: it may show the browser's permission prompt. */
  function reconnect() {
    return restoreFolder({ prompt: true })
  }

  async function forgetFolder() {
    stopWatching()
    await handleDb.del(HANDLE_KEY).catch(() => {})
    savedFolderName.value = ''
    needsReconnect.value = false
    clear()
  }

  async function rescan() {
    if (!watchedHandle)
      return
    const files = await readHandle(watchedHandle, false)
    if (files)
      await loadFrom(files, watchedHandle)
  }

  function startWatching(handle: FileSystemDirectoryHandle) {
    stopWatching()
    watchedHandle = handle
    isWatching.value = true
    watchNewCount.value = 0
    watchTimer = setInterval(async () => {
      const files = await readHandle(handle, false)
      if (!files)
        return
      const prevNames = new Set(videos.value.map(v => v.name))
      const fresh = files.filter(f => VIDEO_EXTS.test(f.name) && !prevNames.has(f.name))
      if (fresh.length) {
        watchNewCount.value += fresh.length
        await setFiles(files)
        loadedAt.value = Date.now()
      }
    }, WATCH_INTERVAL_MS)
  }

  function stopWatching() {
    isWatching.value = false
    watchNewCount.value = 0
    if (watchTimer) {
      clearInterval(watchTimer)
      watchTimer = null
    }
  }

  return {
    videos,
    scanning,
    folderName,
    totalFiles,
    hasVideos,
    restoring,
    needsReconnect,
    savedFolderName,
    isWatching,
    watchNewCount,
    loadedAt,
    setFiles,
    addFiles,
    clear,
    toggleStar,
    pickFolder,
    restoreFolder,
    reconnect,
    forgetFolder,
    rescan,
    startWatching,
    stopWatching,
  }
})

/** Every file under a directory handle, recursing into sub-folders. */
async function collectFiles(dirHandle: any): Promise<File[]> {
  const files: File[] = []
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      files.push(await entry.getFile())
    }
    else if (entry.kind === 'directory') {
      try {
        files.push(...await collectFiles(entry))
      }
      catch {}
    }
  }
  return files
}
