import type { SubtitleMatch } from './subtitleStore'
import type { VideoMeta } from '~/lib/idb'
import type { ScriptInfo } from '~/lib/scriptSniff'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { collectHandleFiles, filePath, handlePathOf, openFolderWithHandle, pickDirectory, rememberPath } from '~/lib/browserApi'
import { canWrite } from '~/lib/funscriptSave'
import { handleDb, metaDb, videoMetaDb } from '~/lib/idb'
import { isAudioName, isListed, matchScripts, scriptMapOf } from '~/lib/mediaFiles'
import { sniffScript } from '~/lib/scriptSniff'
import { isSubtitleName, pairSubtitles, subtitleLabel } from '~/lib/subtitles'
import { editTagList, normalizeTags } from '~/lib/tags'

export interface ScriptMatch {
  file: File
  isAlt: boolean
  altName: string // e.g. "Bounce" extracted from "(Bounce)" or " Bounce" suffix
  /** Axis suffix decided by the caller, when the video's name cannot tell it. */
  suffix?: string
}

/** How the script type is classified — drives badge color in library */
export type ScriptType = 'none' | 'single' | 'multi' | 'merged'

export interface VideoEntry {
  /**
   * 'audio' for an audio file with a script (ASMR, JOI audio, music). Absent
   * for a video, so older code and saved data need nothing new.
   */
  kind?: 'audio'
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
  /** From its library folder down: "Videos/sub/clip.mp4". Just the name for a dropped file. */
  path: string
  /** The library folder it came from, as listed in `folders`; '' for a dropped file. */
  folder: string
  scriptMeta?: VideoMeta
  userMeta?: VideoMeta
  starred: boolean
  /** Subtitle files in the same folder named after it ("clip.srt", "clip.en.vtt"). */
  subtitles?: SubtitleMatch[]
}

/** "Videos/sub" for "Videos/sub/clip.mp4"; '' for a file with no folder. */
function dirOf(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/**
 * Subtitles for each entry. Unlike scripts, which pair by name anywhere in the
 * library, subtitles pair only within a folder: "intro.srt" is too common a
 * name to hand to every "intro.mp4" there is.
 */
function attachSubtitles(entries: VideoEntry[], files: File[]) {
  const subsByDir = new Map<string, File[]>()
  for (const f of files) {
    if (!isSubtitleName(f.name))
      continue
    const d = dirOf(filePath(f))
    const list = subsByDir.get(d)
    if (list)
      list.push(f)
    else
      subsByDir.set(d, [f])
  }
  if (!subsByDir.size)
    return
  const videosByDir = new Map<string, VideoEntry[]>()
  for (const e of entries) {
    const d = dirOf(e.path)
    if (!subsByDir.has(d))
      continue
    const list = videosByDir.get(d)
    if (list)
      list.push(e)
    else
      videosByDir.set(d, [e])
  }
  for (const [d, videos] of videosByDir) {
    for (const p of pairSubtitles(videos.map(v => v.name), subsByDir.get(d)!)) {
      const v = videos[p.video]
      ;(v.subtitles ??= []).push({ file: p.file, name: p.name, label: subtitleLabel(p.name, p.file.name) })
    }
  }
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
   * Add and remove tags on any number of videos. Tags go into each video's
   * saved info (the `vidmeta` store, keyed by file name like stars and stats),
   * which every scan reads back, so they outlive rescans the way stars do.
   * Returns how many videos actually changed.
   */
  async function editTags(entries: VideoEntry[], add: string[], remove: string[] = []): Promise<number> {
    let changed = 0
    for (const e of entries) {
      let stored: VideoMeta | undefined
      try {
        stored = await videoMetaDb.get(e.name)
      }
      catch {}
      // The same merge the info dialog starts from: the script's own
      // metadata, overridden by whatever was saved.
      const meta: VideoMeta = { ...(e.scriptMeta ?? {}), ...(stored ?? e.userMeta ?? {}) }
      const before = normalizeTags(meta.tags)
      const after = editTagList(before, add, remove)
      if (after.length === before.length && after.every((t, i) => t === before[i]))
        continue
      meta.tags = after
      await videoMetaDb.set(e.name, meta)
      e.userMeta = meta
      changed++
    }
    return changed
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

    // Funscripts by lower-cased name (no content read).
    const scriptMap = scriptMapOf(files)

    // Every video, and audio files that have a script (see mediaFiles.ts).
    const videoFiles = files.filter(f => isListed(f.name, scriptMap))

    // Build entries in chunks of 200 to yield to the event loop between chunks
    const CHUNK = 200
    const entries: VideoEntry[] = []

    for (let i = 0; i < videoFiles.length; i += CHUNK) {
      const chunk = videoFiles.slice(i, i + CHUNK)
      for (const f of chunk) {
        const matches = matchScripts(f.name, scriptMap)

        // Alternate takes are the same axis done differently; they must not
        // inflate the axis count or push an entry into the multi-axis filter.
        const axisFiles = matches.filter(m => !m.isAlt)
        const altFiles = matches.filter(m => m.isAlt)

        const path = filePath(f)
        entries.push({
          ...(isAudioName(f.name) ? { kind: 'audio' as const } : {}),
          file: f,
          path,
          folder: path.includes('/') ? path.slice(0, path.indexOf('/')) : '',
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

    attachSubtitles(entries, files)
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
  // Lives here rather than in the library panel so the folders come back at
  // startup whether or not that panel happens to be open.
  //
  // A library is one or more folders: a collection split across drives has
  // no single parent to open. Each folder's files are kept apart (`rootFiles`)
  // so adding or removing one does not mean reading the others again.
  /** The first folder, under its pre-multi-folder key, kept for older code paths. */
  const HANDLE_KEY = 'lastDirHandle'
  const FOLDERS_KEY = 'libraryFolders'
  const restoring = ref(false)
  /** A folder is remembered but the browser wants a click before reading it again. */
  const needsReconnect = ref(false)
  /** Names of the remembered folders, for the reconnect prompt. */
  const savedFolderName = ref('')
  /** The library's folders, as shown (a repeated name gets a number). */
  const folders = ref<string[]>([])
  /** Per folder in `folders`: read this session (false: waiting on a reconnect). */
  const folderLoaded = ref<boolean[]>([])
  const isWatching = ref(false)
  const watchNewCount = ref(0)
  /** Bumped after every completed scan, so views can react to a fresh library. */
  const loadedAt = ref(0)
  let watchTimer: ReturnType<typeof setInterval> | null = null
  /** One per folder; null for one opened without a handle (a browser without the folder API). */
  let roots: (FileSystemDirectoryHandle | null)[] = []
  let rootFiles: (File[] | null)[] = []
  const WATCH_INTERVAL_MS = 30_000

  /** "Videos", "Videos (2)": the label each folder's paths start with. */
  function labelsFor(names: string[]) {
    const seen = new Map<string, number>()
    return names.map((n) => {
      const name = n || 'Folder'
      const k = (seen.get(name) ?? 0) + 1
      seen.set(name, k)
      return k > 1 ? `${name} (${k})` : name
    })
  }

  function describe(labels: string[]) {
    return labels.length > 1 ? `${labels.length} folders` : labels[0] ?? ''
  }

  async function saveRoots() {
    const handles = roots.filter((h): h is FileSystemDirectoryHandle => !!h)
    try {
      if (handles.length) {
        await handleDb.setList(FOLDERS_KEY, handles)
        await handleDb.set(HANDLE_KEY, handles[0])
      }
      else {
        await handleDb.del(FOLDERS_KEY)
        await handleDb.del(HANDLE_KEY)
      }
    }
    catch {}
  }

  async function savedRoots(): Promise<FileSystemDirectoryHandle[]> {
    try {
      const list = await handleDb.getList(FOLDERS_KEY)
      if (Array.isArray(list) && list.length)
        return list
      const one = await handleDb.get(HANDLE_KEY)
      return one ? [one] : []
    }
    catch {
      return []
    }
  }

  /** Build the library from every folder read so far. */
  async function rebuild() {
    folderLoaded.value = rootFiles.map(f => !!f)
    await setFiles(rootFiles.flatMap(f => f ?? []))
    folderName.value = describe(folders.value)
    needsReconnect.value = rootFiles.some(f => !f)
    loadedAt.value = Date.now()
    if (roots.some(Boolean))
      startWatching()
    else
      stopWatching()
  }

  /** Read `handles` afresh and make them the library. */
  async function loadRoots(handles: (FileSystemDirectoryHandle | null)[], prompt: boolean): Promise<boolean> {
    const labels = labelsFor(handles.map(h => h?.name ?? ''))
    const files: (File[] | null)[] = []
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]
      files.push(h ? await readHandle(h, prompt, labels[i]) : rootFiles[i] ?? null)
    }
    roots = handles
    rootFiles = files
    folders.value = labels
    folderLoaded.value = files.map(f => !!f)
    savedFolderName.value = labels.join(', ')
    if (files.every(f => !f)) {
      needsReconnect.value = true
      return false
    }
    await rebuild()
    return files.some(f => f && f.length)
  }

  /** Ask the user for a folder and make it the whole library. Returns false when they cancel. */
  async function pickFolder(): Promise<boolean> {
    const { files, handle } = await openFolderWithHandle()
    if (!files.length)
      return false
    roots = [handle]
    rootFiles = [files]
    folders.value = labelsFor([handle?.name ?? files[0]?.webkitRelativePath?.split('/')[0] ?? 'Folder'])
    savedFolderName.value = folders.value[0]
    await saveRoots()
    await rebuild()
    return true
  }

  /** Add another folder to the library. Returns false when cancelled or already there. */
  async function addFolder(): Promise<boolean> {
    if (!roots.length)
      return pickFolder()
    let handle: FileSystemDirectoryHandle | null = null
    let files: File[]
    if ('showDirectoryPicker' in window) {
      handle = await pickDirectory()
      if (!handle)
        return false
      for (const r of roots) {
        if (r && await (r as any).isSameEntry?.(handle))
          return false
      }
      files = []
    }
    else {
      files = (await openFolderWithHandle()).files
      if (!files.length)
        return false
    }
    const labels = labelsFor([...roots.map(r => r?.name ?? ''), handle?.name ?? files[0]?.webkitRelativePath?.split('/')[0] ?? ''])
    if (handle)
      files = await collectHandleFiles(handle, labels.at(-1))
    roots = [...roots, handle]
    rootFiles = [...rootFiles, files]
    folders.value = labels
    savedFolderName.value = labels.join(', ')
    await saveRoots()
    await rebuild()
    return true
  }

  /** Take one folder out of the library (the files stay where they are). */
  async function removeFolder(index: number) {
    if (index < 0 || index >= roots.length)
      return
    if (roots.length === 1)
      return forgetFolder()
    roots = roots.filter((_, i) => i !== index)
    rootFiles = rootFiles.filter((_, i) => i !== index)
    folders.value = folders.value.filter((_, i) => i !== index)
    savedFolderName.value = folders.value.join(', ')
    await saveRoots()
    await rebuild()
  }

  /**
   * Put another folder in place of the one at `index`, keeping its spot in the
   * list. Returns false when cancelled or when that folder is already in.
   */
  async function replaceFolder(index: number): Promise<boolean> {
    if (index < 0 || index >= roots.length)
      return false
    if (roots.length === 1 || !('showDirectoryPicker' in window))
      return roots.length === 1 ? pickFolder() : false
    const handle = await pickDirectory()
    if (!handle)
      return false
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i]
      if (r && await (r as any).isSameEntry?.(handle))
        return i === index
    }
    const names = roots.map(r => r?.name ?? '')
    names[index] = handle.name
    const labels = labelsFor(names)
    // A renumbered label moves every path under that folder, so re-read the
    // ones whose label changed; the rest keep their files.
    const files: (File[] | null)[] = []
    for (let i = 0; i < roots.length; i++) {
      if (i === index)
        files.push(await collectHandleFiles(handle, labels[i]))
      else if (labels[i] !== folders.value[i] && roots[i])
        files.push(await readHandle(roots[i]!, false, labels[i]))
      else
        files.push(rootFiles[i])
    }
    roots = roots.map((r, i) => (i === index ? handle : r))
    rootFiles = files
    folders.value = labels
    savedFolderName.value = labels.join(', ')
    await saveRoots()
    await rebuild()
    return true
  }

  async function readHandle(handle: FileSystemDirectoryHandle, prompt: boolean, prefix?: string): Promise<File[] | null> {
    const h = handle as any
    if (!h || !('queryPermission' in h))
      return null
    try {
      let perm = await h.queryPermission({ mode: 'read' })
      if (perm !== 'granted' && prompt)
        perm = await h.requestPermission({ mode: 'read' })
      if (perm !== 'granted')
        return null
      return await collectHandleFiles(handle, prefix ?? handle.name)
    }
    catch {
      return null
    }
  }

  /**
   * Bring back the last folders.
   *
   * Without a user gesture the browser will not show its permission prompt, so
   * a silent restore that comes back 'prompt' just flags `needsReconnect` and
   * leaves a one-click reconnect to the UI. Folders that do read load at once.
   */
  async function restoreFolder(opts: { prompt?: boolean } = {}): Promise<boolean> {
    if (hasVideos.value && !needsReconnect.value)
      return true
    const handles = roots.length && roots.every(Boolean) ? roots as FileSystemDirectoryHandle[] : await savedRoots()
    if (!handles.length)
      return false
    savedFolderName.value = labelsFor(handles.map(h => h.name)).join(', ')
    restoring.value = true
    try {
      return await loadRoots(handles, !!opts.prompt)
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
    roots = []
    rootFiles = []
    folders.value = []
    folderLoaded.value = []
    await saveRoots()
    savedFolderName.value = ''
    needsReconnect.value = false
    clear()
  }

  /**
   * The (first) library folder, writable, for saving downloads into. Must be
   * called from a click: the first time it shows the browser's permission
   * prompt. Null without a folder, or when the user says no.
   */
  async function writableFolder(): Promise<FileSystemDirectoryHandle | null> {
    let handle: FileSystemDirectoryHandle | null | undefined = roots.find(Boolean)
    if (!handle)
      handle = (await savedRoots())[0]
    const h = handle as any
    if (!h || !('queryPermission' in h))
      return null
    try {
      let perm = await h.queryPermission({ mode: 'readwrite' })
      if (perm !== 'granted')
        perm = await h.requestPermission({ mode: 'readwrite' })
      return perm === 'granted' ? handle! : null
    }
    catch {
      return null
    }
  }

  /**
   * The folder a library file sits in ("Videos/sub/clip.mp4" → Videos/sub), as
   * a handle; with no path, the first library folder. With `write`, read-write:
   * call it from a click then, as the first time it shows the browser's prompt.
   * Null for a dropped file, a folder opened without a handle, or a refusal.
   */
  async function folderHandleFor(path: string | null, write = false): Promise<FileSystemDirectoryHandle | null> {
    const parts = path ? path.split('/') : []
    const i = path ? folders.value.indexOf(parts[0]) : roots.findIndex(Boolean)
    const root = i >= 0 ? roots[i] : null
    if (!root || (write && !await canWrite(root)))
      return null
    let dir = root
    try {
      for (const p of parts.slice(1, -1))
        dir = await dir.getDirectoryHandle(p)
    }
    catch {
      return null
    }
    return dir
  }

  /**
   * The folder a library file sits in, writable, for saving next to it.
   * Must be called from a click: the first time it shows the browser's
   * permission prompt. Null for a file that did not come from a library
   * folder, or when the user says no. With `write` false it only needs to
   * be readable (a place for a save dialog to start), and never asks.
   */
  async function writableDirOf(f: File, write = true): Promise<FileSystemDirectoryHandle | null> {
    const path = handlePathOf(f)
    if (!path)
      return null
    const parts = path.split('/')
    const root = roots[folders.value.indexOf(parts[0])] as any
    if (!root || !('queryPermission' in root))
      return null
    try {
      let perm = await root.queryPermission({ mode: write ? 'readwrite' : 'read' })
      if (perm !== 'granted' && write)
        perm = await root.requestPermission({ mode: 'readwrite' })
      if (perm !== 'granted')
        return null
      let dir: FileSystemDirectoryHandle = root
      for (const seg of parts.slice(1, -1))
        dir = await dir.getDirectoryHandle(seg)
      return dir
    }
    catch {
      return null
    }
  }

  /**
   * A library file was rewritten: put the new File in place of the old one.
   * A File read through a handle can no longer be read once the file on disk
   * changes, so every entry still holding the old one would fail to load its
   * script next time.
   */
  function swapFile(old: File, fresh: File) {
    const path = handlePathOf(old)
    if (path)
      rememberPath(fresh, path)
    rootFiles = rootFiles.map(list => (list?.includes(old) ? list.map(f => (f === old ? fresh : f)) : list))
    for (const v of videos.value) {
      if (!v.scriptFiles.includes(old))
        continue
      v.scriptFiles = v.scriptFiles.map(f => (f === old ? fresh : f))
      v.scriptMatches = v.scriptMatches.map(m => (m.file === old ? { ...m, file: fresh } : m))
    }
  }

  async function rescan() {
    if (!roots.some(Boolean))
      return
    await loadRoots(roots, false)
  }

  /** Look for new videos in every folder now and then. */
  function startWatching() {
    stopWatching()
    isWatching.value = true
    watchNewCount.value = 0
    watchTimer = setInterval(async () => {
      const prevNames = new Set(videos.value.map(v => v.name))
      let fresh = 0
      const next = [...rootFiles]
      for (let i = 0; i < roots.length; i++) {
        const h = roots[i]
        if (!h)
          continue
        const files = await readHandle(h, false, folders.value[i])
        if (!files)
          continue
        // An audio file counts once it has a script: a stray song is not new to the library.
        const scripts = scriptMapOf(files)
        const added = files.filter(f => !prevNames.has(f.name) && isListed(f.name, scripts)).length
        if (added) {
          fresh += added
          next[i] = files
        }
      }
      if (fresh) {
        watchNewCount.value += fresh
        rootFiles = next
        await setFiles(rootFiles.flatMap(f => f ?? []))
        folderName.value = describe(folders.value)
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
    folders,
    folderLoaded,
    isWatching,
    watchNewCount,
    loadedAt,
    setFiles,
    addFiles,
    clear,
    toggleStar,
    editTags,
    pickFolder,
    addFolder,
    removeFolder,
    replaceFolder,
    restoreFolder,
    reconnect,
    forgetFolder,
    rescan,
    writableFolder,
    folderHandleFor,
    writableDirOf,
    swapFile,
    startWatching,
    stopWatching,
  }
})
