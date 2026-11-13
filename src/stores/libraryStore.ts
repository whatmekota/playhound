import type { SubtitleMatch } from './subtitleStore'
import type { VideoMeta } from '~/lib/idb'
import type { ScriptInfo } from '~/lib/scriptSniff'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, toRaw, watch } from 'vue'
import { toast } from '~/composables/useToast'
import { canPickDirectory, collectHandleFiles, desktop, filePath, handlePathOf, openFolderWithHandle, pickDirectory, readPath, rememberPath } from '~/lib/browserApi'
import { canWrite } from '~/lib/funscriptSave'
import { handleDb, metaDb, videoMetaDb } from '~/lib/idb'
import { applyChanges, baseName, diffPaths, diskPathOf, isLibraryName, keepUnchanged, listPaths, MAX_CHANGES, normaliseChanges, POLL_MS } from '~/lib/libraryWatch'
import { isAudioName, isListed, matchScripts, scriptMapOf } from '~/lib/mediaFiles'
import { KEYS } from '~/lib/persist'
import { isAndroidApp } from '~/lib/platform'
import { sniffScript } from '~/lib/scriptSniff'
import { isSubtitleName, pairSubtitles, subtitleLabel } from '~/lib/subtitles'
import { editTagList, normalizeTags } from '~/lib/tags'
import { whenIdle } from '~/lib/thumbs'
import { usePlayerStore } from './playerStore'

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
  /** The picture's size in pixels, once read from the file (with its duration); absent before. */
  width?: number
  height?: number
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
  /**
   * A video a plugin added from another app (src/plugins/provider.ts): it is
   * streamed, not read from a file, and `file` is an empty stand-in.
   */
  remote?: RemoteSource
}

/** Where a plugin-provided video streams from and its scripts come from. */
export interface RemoteSource {
  /** The plugin that added it. */
  owner: string
  /** The source's name, shown as its badge and used as its folder ("Stash"). */
  label: string
  /** Its id at the source. */
  id: string
  url: string
  kind: 'file' | 'hls'
  /** Sent with the stream (through the local proxy) and with script requests. */
  headers?: Record<string, string>
  /** Script URLs, per axis (a funscript suffix: "default", "twist"…). */
  scripts: { axis: string, url: string }[]
  /** The plugin's own way to get the scripts, when it has one. */
  loader?: () => Promise<{ axis: string, actions: { at: number, pos: number }[] }[]>
  chapters: { name: string, start: number, end?: number }[]
  sourceUrl: string | null
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
  /** The videos in the library's folders (and dropped files). */
  const local = ref<VideoEntry[]>([])
  /** Videos plugins add from other apps, per plugin (src/plugins/provider.ts). */
  const provided = ref<Record<string, VideoEntry[]>>({})
  /** Everything in the library: the folders' videos, then what plugins add. */
  const videos = computed<VideoEntry[]>({
    get: () => {
      const extra = Object.values(provided.value)
      return extra.length ? [...local.value, ...extra.flat()] : local.value
    },
    set: (v) => {
      local.value = v
    },
  })
  const scanning = ref(false)
  /** Bumped after every completed scan (and when plugins add or take videos), so views can react to a fresh library. */
  const loadedAt = ref(0)
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
   * A video's file was renamed (the Organizer): its saved info (tags, source
   * link, script tweaks) and its star are kept by file name, so they move to
   * the new one. Saved info already under the new name is left as it is.
   */
  async function renameVideoData(oldName: string, newName: string) {
    if (!oldName || !newName || oldName === newName)
      return
    try {
      const meta = await videoMetaDb.get(oldName)
      if (meta && !(await videoMetaDb.get(newName))) {
        await videoMetaDb.set(newName, meta)
        await videoMetaDb.del(oldName)
      }
    }
    catch {}
    if (starredNames.delete(oldName)) {
      starredNames.add(newName)
      localStorage.setItem(STARS_KEY, JSON.stringify([...starredNames]))
    }
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
      const becameVr = !before.includes('vr') && after.includes('vr')
      e.userMeta = meta
      // Tagged VR: its thumbnail is made again from one eye when next shown.
      if (becameVr && !e.remote)
        e.thumbnailUrl = null
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
    if (!local.value.length)
      return setFiles(files)
    const kept = local.value
    const keptFolder = folderName.value
    await setFiles(files)
    const added = new Set(local.value.map(v => v.name))
    local.value = [...kept.filter(v => !added.has(v.name)), ...local.value]
      .sort((a, b) => a.name.localeCompare(b.name))
    folderName.value = keptFolder
    totalFiles.value = local.value.length
  }

  async function setFiles(files: File[]) {
    scanning.value = true
    totalFiles.value = files.length
    folderName.value = files[0]?.webkitRelativePath?.split('/')[0] ?? 'Folder'

    // Funscripts by lower-cased name (no content read).
    const scriptMap = scriptMapOf(files)

    // Every video, and audio files that have a script (see mediaFiles.ts).
    const videoFiles = files.filter(f => isListed(f.name, scriptMap))

    // What the library already knew of each file, so reading a folder again
    // keeps it (length, picture size, saved info, the merged-script check)
    // instead of looking it all up again for every video.
    const known = new Map<File, VideoEntry>()
    for (const e of toRaw(local.value)) {
      const raw = toRaw(e)
      if (!raw.remote)
        known.set(raw.file, raw)
    }

    // Build entries in chunks of 200 to yield to the event loop between chunks
    const CHUNK = 200
    const entries: VideoEntry[] = []

    for (let i = 0; i < videoFiles.length; i += CHUNK) {
      const chunk = videoFiles.slice(i, i + CHUNK)
      for (const f of chunk) {
        const matches = matchScripts(f.name, scriptMap)
        const was = known.get(f)
        if (was && was.scriptMatches.length === matches.length && was.scriptMatches.every((m, k) => m.file === matches[k].file)) {
          was.subtitles = undefined
          entries.push(was)
          continue
        }

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
      e => e.scriptType === 'single' && !e.channels && e.scriptMatches.some(m => !m.isAlt),
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
    local.value = []
    folderName.value = ''
    totalFiles.value = 0
  }

  // ── Videos from other apps (plugins) ──────────────────────────────────────
  /**
   * Put a plugin's videos in the library, in place of what it added before.
   * Starred ones keep their star, and anything the library knew of an entry
   * with the same name (its duration, its scripts once fetched) carries over.
   */
  function provide(owner: string, entries: VideoEntry[]) {
    const before = new Map((provided.value[owner] ?? []).map(e => [e.name, e]))
    for (const e of entries) {
      e.starred = starredNames.has(e.name)
      const was = before.get(e.name)
      if (was) {
        e.duration ??= was.duration
        e.thumbnailUrl ??= was.thumbnailUrl
        e.userMeta ??= was.userMeta
        if (was.remote?.url === e.remote?.url && was.scriptMatches.length) {
          e.scriptMatches = was.scriptMatches
          e.scriptFiles = was.scriptFiles
          e.channels = was.channels
        }
      }
    }
    provided.value = { ...provided.value, [owner]: entries }
    loadedAt.value = Date.now()
  }

  /** Take a plugin's videos out of the library (it was switched off). */
  function unprovide(owner: string) {
    if (!(owner in provided.value))
      return
    const { [owner]: _gone, ...rest } = provided.value
    provided.value = rest
    loadedAt.value = Date.now()
  }

  /** The other apps videos come from, by the name they show as ("Stash"), in the order added. */
  const sources = computed(() => [...new Set(Object.values(provided.value).flatMap(list => list.slice(0, 1).map(e => e.remote!.label)))])

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
  /** Watching the folders for new videos: the switch, remembered. */
  const watchOn = useLocalStorage<boolean>(KEYS.libraryWatch.key, true)
  /** Watching right now (the switch is on and there is a folder to watch). */
  const isWatching = ref(false)
  /** The desktop app hears about changes from the system rather than looking. */
  const watchNative = ref(false)
  const watchNewCount = ref(0)
  let pollTimer: ReturnType<typeof setInterval> | null = null
  /** One per folder; null for one opened without a handle (a browser without the folder API). */
  let roots: (FileSystemDirectoryHandle | null)[] = []
  let rootFiles: (File[] | null)[] = []
  /** Per folder, where it is on disk (desktop app only); null when not known. */
  const rootPaths = ref<(string | null)[]>([])
  /** Per folder, whether the desktop app watches it. */
  let nativeWatched: boolean[] = []
  /** What the desktop app was last told, so it is not told twice. */
  let syncedRoots: typeof roots | null = null
  let syncedWatching = false

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
        return revive(list)
      const one = await handleDb.get(HANDLE_KEY)
      return one ? revive([one]) : []
    }
    catch {
      return []
    }
  }

  /** IndexedDB keeps an Android folder as a plain object; make it one again. */
  async function revive(list: FileSystemDirectoryHandle[]): Promise<FileSystemDirectoryHandle[]> {
    if (!isAndroidApp)
      return list
    const { reviveTree } = await import('~/lib/android/folders')
    return list.map(h => reviveTree(h) as unknown as FileSystemDirectoryHandle)
  }

  /**
   * In the Android app, let go of the grants on folders taken out of the
   * library, except one that is (picked again) still in it.
   */
  async function release(handles: (FileSystemDirectoryHandle | null)[], keep: FileSystemDirectoryHandle | null = null) {
    if (!isAndroidApp)
      return
    const { isAndroidTree, releaseTree } = await import('~/lib/android/folders')
    for (const h of handles) {
      if (isAndroidTree(h) && !(isAndroidTree(keep) && keep.uri === h.uri))
        await releaseTree(h)
    }
  }

  /**
   * In the Android app a folder is listed natively, which takes a while on a
   * network share and fails outright when the folder is gone: show both.
   */
  async function nativeStep(run: () => Promise<boolean>): Promise<boolean> {
    if (!isAndroidApp)
      return run()
    scanning.value = true
    try {
      return await run()
    }
    catch (err) {
      toast.error('Could not read that folder', { detail: (err as Error)?.message ?? String(err) })
      return false
    }
    finally {
      scanning.value = false
    }
  }

  /** Build the library from every folder read so far. */
  async function rebuild() {
    folderLoaded.value = rootFiles.map(f => !!f)
    await setFiles(rootFiles.flatMap(f => f ?? []))
    folderName.value = describe(folders.value)
    needsReconnect.value = rootFiles.some(f => !f)
    loadedAt.value = Date.now()
    if (roots.some(Boolean) && watchOn.value)
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
      const read = h ? await readHandle(h, prompt, labels[i]) : rootFiles[i] ?? null
      // Reading the same folders again (Rescan): files that did not change
      // stay the very same File, so their entries are kept as they are.
      const had = handles === roots && labels[i] === folders.value[i] ? rootFiles[i] : null
      files.push(read && had && read !== had ? keepUnchanged(had, read, filePath) : read)
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
  function pickFolder(): Promise<boolean> {
    return nativeStep(pickFolderNow)
  }

  async function pickFolderNow(): Promise<boolean> {
    const { files, handle } = await openFolderWithHandle()
    if (!files.length)
      return false
    void release(roots, handle)
    roots = [handle]
    rootFiles = [files]
    folders.value = labelsFor([handle?.name ?? files[0]?.webkitRelativePath?.split('/')[0] ?? 'Folder'])
    savedFolderName.value = folders.value[0]
    await saveRoots()
    await rebuild()
    return true
  }

  /** Add another folder to the library. Returns false when cancelled or already there. */
  function addFolder(): Promise<boolean> {
    return nativeStep(addFolderNow)
  }

  async function addFolderNow(): Promise<boolean> {
    if (!roots.length)
      return pickFolderNow()
    let handle: FileSystemDirectoryHandle | null = null
    let files: File[]
    if (canPickDirectory()) {
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
    void release([roots[index]])
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
    if (roots.length === 1 || !canPickDirectory())
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
    void release([roots[index]], handle)
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
    void release(roots)
    roots = []
    rootFiles = []
    stopWatching()
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
    swapMany(new Map([[old, fresh]]))
  }

  async function rescan() {
    if (!roots.some(Boolean))
      return
    await loadRoots(roots, false)
  }

  // ── Watching ──────────────────────────────────────────────────────────────
  // See lib/libraryWatch.ts. The desktop app is told by the system which
  // paths changed and looks only at those; a browser lists names now and
  // then while nothing plays. Either way, a video playing never waits on it.
  const player = usePlayerStore()
  /** Changes are taken one batch at a time, in order. */
  let chain: Promise<void> = Promise.resolve()
  /** Folders to read whole again once nothing is playing. */
  const fullPending = new Set<number>()
  let polling = false

  function queueRefresh(i: number, rels: string[] | null, polled = false): Promise<void> {
    chain = chain.then(() => refresh(i, rels, polled)).catch(err => console.warn('[library] watching:', err))
    return chain
  }

  /**
   * Tell the desktop app which folders the library is made of, and whether
   * to watch them; it says where each is on disk (for Show in folder). It is
   * only told again when the folders change or watching is switched.
   */
  async function syncDesktop() {
    const api = desktop?.files
    if (!api?.roots) {
      nativeWatched = []
      rootPaths.value = []
    }
    else if (syncedRoots !== roots || syncedWatching !== isWatching.value) {
      syncedRoots = roots
      syncedWatching = isWatching.value
      // Each folder by its name and a file in it, which tells two folders of the same name apart.
      const named = roots.map((h, i) => {
        const f = rootFiles[i]?.[0]
        return { name: h?.name ?? '', probe: f ? filePath(f).split('/').slice(1).join('/') : '' }
      })
      try {
        const res = await api.roots(named, isWatching.value)
        rootPaths.value = res.paths.map(p => p || null)
        nativeWatched = res.watched
      }
      catch {
        rootPaths.value = []
        nativeWatched = []
      }
    }
    watchNative.value = isWatching.value && roots.some((r, i) => !!r && !!nativeWatched[i])
    schedulePoll()
  }

  /** Look now and then at the folders nobody tells us about. */
  function schedulePoll() {
    const needed = isWatching.value && roots.some((r, i) => !!r && !nativeWatched[i])
    if (needed && !pollTimer) {
      pollTimer = setInterval(() => void poll(), POLL_MS)
    }
    else if (!needed && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** The folders nobody tells us about: what came and went. Never while playing. */
  async function poll() {
    if (polling || player.isPlaying)
      return
    polling = true
    try {
      for (let i = 0; i < roots.length; i++) {
        if (roots[i] && !nativeWatched[i] && !player.isPlaying)
          await queueRefresh(i, null, true)
      }
    }
    finally {
      polling = false
    }
  }

  /**
   * What came and went in folder `i`, by listing its names (no file is read)
   * and comparing them with what it had. `polled`: give up when a video
   * starts; otherwise (the desktop app missed some changes) just go gently.
   */
  async function namesChanged(i: number, polled: boolean): Promise<string[] | null> {
    const root = roots[i]!
    const label = folders.value[i]
    const listed = await listPaths(root, label, async () => {
      await whenIdle(250)
      return isWatching.value && roots[i] === root && !(polled && player.isPlaying)
    })
    if (!listed)
      return null
    const { added, removed } = diffPaths((rootFiles[i] ?? []).map(filePath), listed)
    return [...added, ...removed].filter(p => isLibraryName(baseName(p))).map(p => p.slice(label.length + 1))
  }

  /**
   * Look again at what is at these paths in folder `i`. Null: no list (the
   * browser's poll, or more changes than the system could report), so find
   * what came and went first.
   */
  async function refresh(i: number, rels: string[] | null, polled = false) {
    const root = roots[i]
    const old = rootFiles[i]
    const label = folders.value[i]
    if (!root || !old || !isWatching.value)
      return
    rels ??= await namesChanged(i, polled)
    if (!rels?.length || roots[i] !== root || rootFiles[i] !== old)
      return
    let next: File[]
    if (rels.length > MAX_CHANGES) {
      // Too many to go through one at a time: read the folder whole, which
      // is heavy, so not while a video plays.
      if (player.isPlaying) {
        fullPending.add(i)
        return
      }
      fullPending.delete(i)
      const files = await readHandle(root, false, label)
      if (!files || roots[i] !== root)
        return
      next = files
    }
    else {
      const changes: { path: string, files: File[] }[] = []
      for (const rel of normaliseChanges(rels))
        changes.push({ path: `${label}/${rel}`, files: await readPath(root, label, rel) })
      if (roots[i] !== root)
        return
      next = applyChanges(old, filePath, changes)
    }
    await adoptFiles(i, old, next)
  }

  /**
   * Folder `i` now holds `next`. When the same files are there and only some
   * were rewritten (a download still arriving, a script saved elsewhere),
   * each entry takes its new File where it stands; when files came or went,
   * the library is built again (which keeps what it knew of the rest).
   */
  async function adoptFiles(i: number, old: File[], next: File[]) {
    // A file reported changed that is not (a create comes with a write or two).
    next = keepUnchanged(old, next, filePath)
    const byPath = (list: File[]) => new Map(list.filter(f => isLibraryName(f.name)).map(f => [filePath(f), f]))
    const a = byPath(old)
    const b = byPath(next)
    rootFiles = rootFiles.map((list, k) => (k === i ? next : list))
    const rewritten = new Map<File, File>()
    let same = a.size === b.size
    if (same) {
      for (const [p, f] of b) {
        const was = a.get(p)
        if (!was) {
          same = false
          break
        }
        if (was !== f)
          rewritten.set(was, f)
      }
    }
    if (same) {
      swapMany(rewritten)
      return
    }
    const before = new Set(local.value.map(v => v.name))
    await setFiles(rootFiles.flatMap(f => f ?? []))
    folderName.value = describe(folders.value)
    watchNewCount.value += local.value.filter(v => !before.has(v.name)).length
    loadedAt.value = Date.now()
  }

  /**
   * Library files were rewritten on disk (old → new File): every entry
   * holding an old one gets the new one. One pass over the plain entries;
   * only the entries that change are touched through Vue.
   */
  function swapMany(swaps: Map<File, File>) {
    if (!swaps.size)
      return
    const live = local.value
    const raw = toRaw(live)
    for (let k = 0; k < raw.length; k++) {
      const e = toRaw(raw[k])
      const fileHit = swaps.get(e.file)
      const scriptHit = e.scriptFiles.some(f => swaps.has(f))
      const subHit = !!e.subtitles?.some(s => swaps.has(s.file))
      if (!fileHit && !scriptHit && !subHit)
        continue
      const v = live[k]
      if (fileHit)
        v.file = fileHit
      if (scriptHit) {
        v.scriptFiles = e.scriptFiles.map(f => swaps.get(f) ?? f)
        v.scriptMatches = e.scriptMatches.map(m => (swaps.has(m.file) ? { ...m, file: swaps.get(m.file)! } : m))
      }
      if (subHit)
        v.subtitles = e.subtitles!.map(s => (swaps.has(s.file) ? { ...s, file: swaps.get(s.file)! } : s))
    }
  }

  // The desktop app's word that something changed in a folder.
  desktop?.files?.onChange?.((root, paths) => {
    const i = rootPaths.value.findIndex(p => !!p && p.toLowerCase() === root.toLowerCase())
    if (i >= 0 && isWatching.value)
      void queueRefresh(i, paths)
  })

  // A whole folder waits for the video to stop.
  watch(() => player.isPlaying, (playing) => {
    if (!playing) {
      for (const i of [...fullPending])
        void queueRefresh(i, null)
    }
  })

  /** Start watching the folders (the switch decides whether rebuild() does). */
  function startWatching() {
    // Not in the Android app: every look is a listing over the folder
    // provider (a network share, maybe). Rescan by hand there instead.
    if (isAndroidApp)
      return
    if (!isWatching.value)
      watchNewCount.value = 0
    isWatching.value = true
    void syncDesktop()
  }

  function stopWatching() {
    isWatching.value = false
    watchNewCount.value = 0
    fullPending.clear()
    void syncDesktop()
  }

  /** The switch: on or off, and remembered for next time. */
  function setWatching(on: boolean) {
    watchOn.value = on
    if (on && roots.some(Boolean))
      startWatching()
    else
      stopWatching()
  }

  /** Whether Show in folder can find this video: one from a library folder, in the desktop app. */
  function canReveal(entry: VideoEntry | null | undefined): boolean {
    if (!entry || entry.remote || !entry.folder || !desktop?.files?.reveal)
      return false
    return !!rootPaths.value[folders.value.indexOf(entry.folder)]
  }

  /** Show the video's file in Explorer / Finder. Resolves whether it could. */
  async function reveal(entry: VideoEntry): Promise<boolean> {
    const root = rootPaths.value[folders.value.indexOf(entry.folder)]
    if (!root || !canReveal(entry))
      return false
    try {
      return await desktop!.files!.reveal!(diskPathOf(root, entry.path))
    }
    catch {
      return false
    }
  }

  return {
    videos,
    renameVideoData,
    provided,
    sources,
    provide,
    unprovide,
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
    watchOn,
    watchNative,
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
    setWatching,
    canReveal,
    reveal,
  }
})
