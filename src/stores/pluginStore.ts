import type { Access } from '~/plugins/manifest'
import type { Chord } from '~/plugins/shortcuts'
import type { SourceRelease } from '~/plugins/sources'
import type { LibraryVideo, LibraryVideoInfo, MotionControl, MotionFilter, MotionReadout, OverlayDef, PageDef, PanelDef, PlayerSnapshot, PluginContext, PluginManifest, PluginPermission, ScriptNow, SettingField, WebViewOptions } from '~/plugins/types'
import type { ScriptFile } from '~/stores/scriptStore'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import { useAnyDevice } from '~/composables/useAnyDevice'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { analyseActions, scriptAnalysisKey } from '~/composables/useScriptAnalysis'
import { axisOutput } from '~/composables/useTCode'
import { toast } from '~/composables/useToast'
import { desktop } from '~/lib/browserApi'
import { metaCredits } from '~/lib/chapterIndex'
import { effectiveMeta } from '~/lib/entryInfo'
import { sampleEnvelope } from '~/lib/funscriptAnalysis'
import { parseFunscriptContent } from '~/lib/funscriptParser'
import { handleDb, pluginDb, summaryDb, videoMetaDb } from '~/lib/idb'
import { KEYS } from '~/lib/persist'
import { intensityBand } from '~/lib/scriptIntensity'
import { createSteadyClock } from '~/lib/steadyClock'
import { manualTags, normalizeTags } from '~/lib/tags'
import { loadUserMeta } from '~/lib/thumbs'
import { canRead, folderSignature, readFolder } from '~/plugins/devFolder'
import { motionFilters } from '~/plugins/filters'
import { fingerprintOf, fingerprintSize } from '~/plugins/fingerprint'
import { accessOf, addedPermissions, allows, permissionError, readManifest } from '~/plugins/manifest'
import { pluginFetch } from '~/plugins/net'
import { axisKeyFor, cleanActions, snapshotOf } from '~/plugins/scripts'
import { chordId, chordOf, parseKbd, reservedBy } from '~/plugins/shortcuts'
import { addNewDefaults, DEFAULT_SOURCES, fetchRelease, newer, parseRepo } from '~/plugins/sources'
import { parseStage, stageOf } from '~/plugins/stage'
import { createWebview } from '~/plugins/webview'
import { stripCommonRoot, unzip } from '~/plugins/zip'
import { useDeviceStore } from '~/stores/deviceStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { usePlaylistStore } from '~/stores/playlistStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useStatsStore } from '~/stores/statsStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * Plugins: zips with a manifest and one ES module, installed from Settings →
 * Plugins and kept in IndexedDB. A switched-on plugin is imported from a
 * blob: URL and handed a PluginContext (src/plugins/types.ts). There is no
 * sandbox; the install screen says so, and lists what the plugin asks to do
 * (src/plugins/manifest.ts).
 *
 * In dev mode a plugin comes from a folder instead (Load from folder): it is
 * read into memory, never stored as a package, and reloaded when a file in
 * the folder changes.
 */

export interface StoredPackage {
  manifest: PluginManifest
  files: Record<string, Blob>
  installedAt: number
  size: number
  /** The GitHub repository it was installed from, if it came from a source. */
  source?: string
}

/** One source as last checked. */
export interface SourceState {
  repo: string
  status: 'idle' | 'checking' | 'ok' | 'error'
  error: string
  release: SourceRelease | null
}

/** Sources are looked at on their own once a day at most (and whenever the Plugins page opens). */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000

export interface PluginInfo {
  manifest: PluginManifest
  installedAt: number
  size: number
  source: string | null
  enabled: boolean
  status: 'off' | 'loading' | 'on' | 'error'
  error: string | null
  fields: SettingField[] | null
  panel: PanelDef | null
  /** Its page on the main stage. */
  page: PageDef | null
  /** Its layer over the video. */
  overlay: OverlayDef | null
  /** Its commands in the palette. */
  commands: PluginCommand[]
  values: Record<string, unknown>
  /**
   * Loaded from a folder (dev mode): where from, and why the last reload
   * failed (the version before keeps running). Null for an installed plugin.
   */
  dev: { label: string, error: string | null } | null
}

export interface PluginCommand {
  id: string
  title: string
  hint?: string
  icon?: string
  kbd: Chord | null
  run: () => void | Promise<void>
}

/** A package waiting for the user to say yes: a first install, or an update that asks for more. */
export interface PendingInstall {
  manifest: PluginManifest
  /** The installed version it would replace. */
  was: PluginManifest | null
  access: Access
  /** What it asks for that the installed version didn't have (everything, on a first install). */
  added: PluginPermission[]
}

/** Where a dev plugin is read from. */
type DevSource = { kind: 'desktop', folder: string } | { kind: 'browser', handle: FileSystemDirectoryHandle }

/** Browser dev folders, kept so they come back after a reload (as long as the browser still lets them be read). */
const DEV_HANDLES_KEY = 'plugins.dev'
/** How often a browser dev folder is looked at for changes. */
const DEV_POLL_MS = 1000

interface Running {
  urls: string[]
  cleanups: (() => void)[]
  deactivate: (() => void) | null
  settingsListeners: Set<(v: Record<string, unknown>) => void>
}

const MIME: Record<string, string> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  css: 'text/css',
  html: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
}
const mimeOf = (path: string) => MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** Read a plugin zip into a package, or throw with a message fit for the user. */
export async function readPackage(file: Blob | ArrayBuffer | Uint8Array): Promise<StoredPackage> {
  const bytes = file instanceof Uint8Array || file instanceof ArrayBuffer ? file : await file.arrayBuffer()
  return packageFrom(stripCommonRoot(await unzip(bytes)), 'the zip')
}

/** A package from its files (a zip's, or a dev folder's), or throw saying what is wrong. */
export function packageFrom(entries: { path: string, data: Uint8Array }[], where: string): StoredPackage {
  const manifestEntry = entries.find(e => e.path === 'manifest.json')
  if (!manifestEntry)
    throw new Error(`No manifest.json in ${where}`)
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(manifestEntry.data))
  }
  catch {
    throw new Error('manifest.json is not valid JSON')
  }
  const manifest = readManifest(raw)
  if (!entries.some(e => e.path === manifest.main))
    throw new Error(`${manifest.main} (the plugin's code) is not in ${where}`)
  const files: Record<string, Blob> = {}
  let size = 0
  for (const e of entries) {
    files[e.path] = new Blob([e.data as BlobPart], { type: mimeOf(e.path) })
    size += e.data.byteLength
  }
  return { manifest, files, installedAt: Date.now(), size }
}

function defaults(fields: SettingField[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields ?? []) {
    if (f.type !== 'heading' && f.default !== undefined)
      out[f.key] = f.default
  }
  return out
}

type LibraryStore = ReturnType<typeof useLibraryStore>

/** The string if it is an http(s) URL, trimmed; else null. */
const httpUrl = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null)

// ─── library.info / tag / setSource ──────────────────────────────────────────
/** Saved info, and the script's own metadata read from its file (the first one that has some). */
export async function videoInfo(library: LibraryStore, videoId: string): Promise<LibraryVideoInfo | null> {
  const v = library.videos.find(x => x.name === videoId)
  if (!v)
    return null
  const saved = await videoMetaDb.get(v.name).catch(() => undefined)
  let scriptUrl: string | null = null
  let creator: string | null = null
  let scriptTags: string[] = []
  for (const f of v.scriptFiles) {
    try {
      const meta = JSON.parse(await f.text())?.metadata
      const credits = metaCredits(meta)
      scriptUrl = httpUrl(meta?.topic_url) ?? httpUrl(meta?.url) ?? httpUrl(meta?.script_url)
      creator = credits.creator
      scriptTags = credits.tags
      if (scriptUrl || creator || scriptTags.length)
        break
    }
    catch {}
  }
  return {
    tags: normalizeTags(saved?.tags ?? v.userMeta?.tags ?? scriptTags),
    sourceUrl: httpUrl(saved?.url) ?? httpUrl(v.userMeta?.url) ?? scriptUrl,
    creator,
    scriptFiles: v.scriptFiles.map(f => f.name),
  }
}

export async function tagVideo(library: LibraryStore, videoId: string, change: { add?: string[], remove?: string[] }): Promise<string[] | null> {
  const v = library.videos.find(x => x.name === videoId)
  if (!v)
    return null
  const add = normalizeTags(Array.isArray(change?.add) ? change.add : [])
  const remove = normalizeTags(Array.isArray(change?.remove) ? change.remove : [])
  await library.editTags([v], add, remove)
  return manualTags(v)
}

export async function setVideoSource(library: LibraryStore, videoId: string, url: string | null): Promise<boolean> {
  const v = library.videos.find(x => x.name === videoId)
  if (!v)
    return false
  const clean = url === null ? null : httpUrl(url)
  if (url !== null && !clean)
    throw new TypeError('library.setSource takes an http(s) URL, or null')
  const stored = await videoMetaDb.get(v.name).catch(() => undefined)
  const meta = { ...(v.scriptMeta ?? {}), ...(stored ?? v.userMeta ?? {}) }
  if (clean)
    meta.url = clean
  else
    delete meta.url
  await videoMetaDb.set(v.name, meta)
  v.userMeta = meta
  return true
}

export const usePluginStore = defineStore('plugins', () => {
  const plugins = ref<PluginInfo[]>([])
  const enabledIds = useLocalStorage<string[]>(KEYS.pluginsEnabled.key, [])
  /** Which plugin's panel the Plugins drawer shows. */
  const activePanel = ref<string | null>(null)
  /** A plugin whose settings were asked for; Settings → Plugins opens its card. */
  const focusSettings = ref<string | null>(null)
  const ready = ref(false)
  /** The installed plugins are listed and the switched-on ones have started. */
  const loaded = ref(false)
  const running = new Map<string, Running>()
  /** The plugin holding the stroke generator, and what it was before. */
  const motionHolder = shallowRef<{ id: string, release: () => void } | null>(null)
  /** Each plugin's motion filter as it set it, so an old remover can't take out a newer one. */
  const filterOf = new Map<string, MotionFilter>()
  /** Dev plugins' packages, read from their folders; never stored. */
  const devPackages = new Map<string, StoredPackage>()

  const find = (id: string) => plugins.value.find(p => p.manifest.id === id)

  // Filters chain in the order the plugins are listed.
  watch(() => plugins.value.map(p => p.manifest.id), ids => motionFilters.setOrder(ids), { immediate: true })

  function sortPlugins() {
    plugins.value.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  }

  async function start() {
    if (ready.value)
      return
    ready.value = true
    let keys: string[] = []
    try {
      keys = await pluginDb.keys('pkg:')
    }
    catch (err) {
      console.error('[plugins] could not list installed plugins', err)
    }
    for (const key of keys) {
      const pkg = await pluginDb.get<StoredPackage>(key)
      if (!pkg)
        continue
      plugins.value.push(await infoFor(pkg))
    }
    sortPlugins()
    // Folders loaded last time come back before anything starts, so a dev
    // copy stands in for an installed one from the outset.
    await restoreDev()
    for (const p of plugins.value) {
      if (p.enabled)
        await activate(p.manifest.id)
    }
    loaded.value = true
    void checkDaily().catch(() => {})
  }

  async function infoFor(pkg: StoredPackage): Promise<PluginInfo> {
    const id = pkg.manifest.id
    const values = (await pluginDb.get<Record<string, unknown>>(`settings:${id}`)) ?? {}
    return {
      manifest: pkg.manifest,
      installedAt: pkg.installedAt,
      size: pkg.size,
      source: pkg.source ?? null,
      enabled: enabledIds.value.includes(id),
      status: 'off',
      error: null,
      fields: null,
      panel: null,
      page: null,
      overlay: null,
      commands: [],
      values,
      dev: null,
    }
  }

  /** Put an info in the list, in place of the one with its id if there is one. */
  function upsert(info: PluginInfo) {
    const was = find(info.manifest.id)
    if (was) {
      plugins.value.splice(plugins.value.indexOf(was), 1, info)
    }
    else {
      plugins.value.push(info)
      sortPlugins()
    }
  }

  // ─── Install, with the user's yes ─────────────────────────────────────────

  /** What waits for the user's yes, shown by the install dialog. */
  const pendingInstall = shallowRef<PendingInstall | null>(null)
  let answerPending: ((ok: boolean) => void) | null = null

  /** The install dialog's answer. */
  function answerInstall(ok: boolean) {
    const answer = answerPending
    answerPending = null
    pendingInstall.value = null
    answer?.(ok)
  }

  /**
   * Install (or update) from a zip. A first install, and an update that asks
   * for more than the installed version had, wait for the user to agree in
   * the install dialog; null if they don't.
   */
  async function install(file: Blob | Uint8Array, source?: string): Promise<PluginInfo | null> {
    const pkg = await readPackage(file)
    const id = pkg.manifest.id
    const was = find(id)
    if (was?.dev)
      throw new Error(`${was.manifest.name} is loaded from a folder right now. Remove that first.`)
    const access = accessOf(pkg.manifest)
    const added = addedPermissions(was ? accessOf(was.manifest) : null, access)
    if (!was || added.length) {
      // A dialog already up is answered no: one question at a time.
      answerInstall(false)
      const ok = await new Promise<boolean>((resolve) => {
        answerPending = resolve
        pendingInstall.value = { manifest: pkg.manifest, was: was?.manifest ?? null, access, added }
      })
      if (!ok)
        return null
    }
    const now = find(id)
    if (now?.dev)
      throw new Error(`${now.manifest.name} is loaded from a folder right now. Remove that first.`)
    // Remember where it came from: a source keeps updating it; a manual zip of
    // the same plugin keeps the source it had.
    pkg.source = source ?? (now?.source || undefined)
    if (now)
      deactivate(id)
    await pluginDb.set(`pkg:${id}`, pkg)
    const info = await infoFor(pkg)
    if (now)
      info.enabled = now.enabled
    upsert(info)
    if (info.enabled)
      await activate(id)
    return find(id)!
  }

  async function remove(id: string, keepData = false) {
    deactivate(id)
    plugins.value = plugins.value.filter(p => p.manifest.id !== id)
    enabledIds.value = enabledIds.value.filter(x => x !== id)
    if (activePanel.value === id)
      activePanel.value = null
    await pluginDb.del(`pkg:${id}`)
    if (!keepData) {
      await pluginDb.del(`settings:${id}`)
      for (const k of await pluginDb.keys(`data:${id}:`))
        await pluginDb.del(k)
    }
  }

  async function setEnabled(id: string, on: boolean) {
    const p = find(id)
    if (!p)
      return
    p.enabled = on
    enabledIds.value = on ? [...new Set([...enabledIds.value, id])] : enabledIds.value.filter(x => x !== id)
    if (on)
      await activate(id)
    else
      deactivate(id)
  }

  async function setValue(id: string, key: string, value: unknown) {
    const p = find(id)
    if (!p)
      return
    p.values = { ...p.values, [key]: value }
    await pluginDb.set(`settings:${id}`, JSON.parse(JSON.stringify(p.values)))
    const r = running.get(id)
    for (const fn of r?.settingsListeners ?? []) {
      try {
        fn({ ...defaults(p.fields), ...p.values })
      }
      catch (err) {
        console.error(`[plugin ${id}] settings listener failed`, err)
      }
    }
  }

  async function activate(id: string) {
    const p = find(id)
    if (!p || running.has(id))
      return
    // A dev copy is in memory; an installed one in the database.
    const pkg = devPackages.get(id) ?? await pluginDb.get<StoredPackage>(`pkg:${id}`)
    if (!pkg) {
      p.status = 'error'
      p.error = 'Package missing; install it again'
      return
    }
    p.status = 'loading'
    p.error = null
    const urls = new Map<string, string>()
    for (const [path, blob] of Object.entries(pkg.files))
      urls.set(path, URL.createObjectURL(blob))
    const r: Running = { urls: [...urls.values()], cleanups: [], deactivate: null, settingsListeners: new Set() }
    running.set(id, r)
    try {
      const mod = await import(/* @vite-ignore */ urls.get(pkg.manifest.main ?? 'index.js')!)
      const activateFn = mod.default ?? mod.activate
      if (typeof activateFn !== 'function')
        throw new Error('The module has no default export (activate)')
      const out = await activateFn(makeContext(p, r, urls))
      if (running.get(id) !== r)
        return
      if (typeof out === 'function')
        r.deactivate = out
      else if (out && typeof out.deactivate === 'function')
        r.deactivate = () => out.deactivate()
      p.status = 'on'
    }
    catch (err) {
      console.error(`[plugin ${id}] failed to start`, err)
      if (running.get(id) !== r)
        return
      // A dev plugin keeps its page's place on the stage: the next save may well fix it.
      deactivate(id, { keepStage: !!p.dev })
      p.status = 'error'
      p.error = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * Switch a plugin off and undo what it set up. `keepStage` leaves its page
   * on the stage, for a reload that will put it back in a moment.
   */
  function deactivate(id: string, opts: { keepStage?: boolean } = {}) {
    const r = running.get(id)
    const p = find(id)
    if (p) {
      p.status = 'off'
      p.fields = null
      p.panel = null
      p.page = null
      p.overlay = null
      p.commands = []
    }
    // Its page can't stay on the stage without it.
    const ui = useUiStore()
    if (!opts.keepStage && ui.view === 'plugin' && ui.pluginView === id)
      ui.openView(ui.previousView === 'plugin' ? 'player' : ui.previousView)
    if (!r)
      return
    running.delete(id)
    try {
      r.deactivate?.()
    }
    catch (err) {
      console.error(`[plugin ${id}] deactivate failed`, err)
    }
    for (const c of r.cleanups.splice(0).reverse()) {
      try {
        c()
      }
      catch {}
    }
    if (motionHolder.value?.id === id)
      motionHolder.value.release()
    for (const u of r.urls)
      URL.revokeObjectURL(u)
  }

  // ─── Commands and their shortcuts ─────────────────────────────────────────

  /** The plugin (by name) whose command has this chord, other than `except`. */
  function shortcutOwner(c: Chord, except: { plugin: string, command: string }): string | null {
    const want = chordId(c)
    for (const p of plugins.value) {
      for (const cmd of p.commands) {
        if (cmd.kbd && chordId(cmd.kbd) === want && !(p.manifest.id === except.plugin && cmd.id === except.command))
          return p.manifest.name
      }
    }
    return null
  }

  /** Run a plugin's command, saying so if it fails. */
  function runCommand(p: PluginInfo, cmd: PluginCommand) {
    const fail = (err: unknown) => {
      console.error(`[plugin ${p.manifest.id}] command ${cmd.id} failed`, err)
      toast.error(`${cmd.title} failed`, { detail: `${p.manifest.name}: ${err instanceof Error ? err.message : String(err)}` })
    }
    try {
      const out = cmd.run()
      if (out instanceof Promise)
        out.catch(fail)
    }
    catch (err) {
      fail(err)
    }
  }

  /** A key press that is a plugin's shortcut runs its command; true if it was one. */
  function runShortcut(e: KeyboardEvent): boolean {
    const want = chordId(chordOf(e))
    for (const p of plugins.value) {
      if (p.status !== 'on')
        continue
      const cmd = p.commands.find(c => c.kbd && chordId(c.kbd) === want)
      if (cmd) {
        // Held down, the key repeats: once is enough.
        if (!e.repeat)
          runCommand(p, cmd)
        return true
      }
    }
    return false
  }

  // ─── Video fingerprints ───────────────────────────────────────────────────

  const fingerprints = new Map<string, Promise<string | null>>()
  /** A file's fingerprint, worked out once per file version and kept in the database. */
  function fingerprintFile(file: File): Promise<string | null> {
    const key = `fp:${file.name}|${file.size}|${file.lastModified}`
    let hit = fingerprints.get(key)
    if (!hit) {
      hit = (async () => {
        try {
          const kept = await pluginDb.get<string>(key)
          if (kept)
            return kept
        }
        catch {}
        try {
          const fp = await fingerprintOf(file)
          void pluginDb.set(key, fp).catch(() => {})
          return fp
        }
        catch (err) {
          console.warn('[plugins] could not fingerprint', file.name, err)
          return null
        }
      })()
      fingerprints.set(key, hit)
    }
    return hit
  }

  // ─── Dev mode: plugins loaded from a folder ───────────────────────────────

  const devSources = new Map<string, DevSource>()
  /** Browser folders: what they held when last read, to see a save. */
  const devSignatures = new Map<string, string>()
  /** Folders remembered from before that didn't load, with why; they can be tried again or forgotten. */
  const devFailed = ref<{ key: string, label: string, error: string }[]>([])
  const devFailedSources = new Map<string, DevSource>()
  let devFailedSeq = 0
  const reloading = new Set<string>()

  const devLabel = (src: DevSource) => (src.kind === 'desktop' ? src.folder : src.handle.name)

  async function readDev(src: DevSource): Promise<{ pkg: StoredPackage, signature: string | null }> {
    if (src.kind === 'desktop') {
      const res = await desktop!.plugins!.readDevFolder(src.folder)
      if (res.error !== undefined)
        throw new Error(res.error)
      return { pkg: packageFrom(res.files, 'the folder'), signature: null }
    }
    const { files, signature } = await readFolder(src.handle)
    return { pkg: packageFrom(files, 'the folder'), signature }
  }

  async function sameSource(a: DevSource, b: DevSource): Promise<boolean> {
    if (a.kind === 'desktop' && b.kind === 'desktop')
      return a.folder === b.folder
    if (a.kind === 'browser' && b.kind === 'browser')
      return a.handle.isSameEntry(b.handle)
    return false
  }

  /** Read a folder's plugin and put it in the list, in place of an installed one with its id. */
  async function loadDev(src: DevSource, opts: { enable: boolean, activateNow: boolean }): Promise<PluginInfo> {
    const { pkg, signature } = await readDev(src)
    const id = pkg.manifest.id
    const other = devSources.get(id)
    if (other && !(await sameSource(other, src)))
      throw new Error(`Another folder already has the plugin "${id}" loaded`)
    deactivate(id, { keepStage: true })
    devSources.set(id, src)
    devPackages.set(id, pkg)
    if (signature !== null)
      devSignatures.set(id, signature)
    const info = await infoFor(pkg)
    info.dev = { label: devLabel(src), error: null }
    if (opts.enable && !info.enabled) {
      info.enabled = true
      enabledIds.value = [...new Set([...enabledIds.value, id])]
    }
    upsert(info)
    if (src.kind === 'browser')
      pollDev()
    if (info.enabled && opts.activateNow)
      await activate(id)
    return find(id)!
  }

  /**
   * Settings → Plugins → Load from folder. In the desktop app the main
   * process reads and watches the folder; in a browser it is picked with the
   * File System Access API and looked at once a second. Null if cancelled.
   */
  async function loadFromFolder(): Promise<PluginInfo | null> {
    if (desktop?.plugins) {
      const folder = await desktop.plugins.pickDevFolder()
      if (!folder)
        return null
      try {
        return await loadDev({ kind: 'desktop', folder }, { enable: true, activateNow: true })
      }
      catch (err) {
        // Not a plugin (or not one that reads): don't bring it back next time.
        void desktop.plugins.forgetDevFolder(folder)
        throw err
      }
    }
    if (!('showDirectoryPicker' in window))
      throw new Error('This browser can\'t open folders. Use Chrome or Edge, or the desktop app.')
    let handle: FileSystemDirectoryHandle
    try {
      handle = await (window as any).showDirectoryPicker({ id: 'playhound-plugin-dev', mode: 'read' })
    }
    catch {
      return null
    }
    const info = await loadDev({ kind: 'browser', handle }, { enable: true, activateNow: true })
    await rememberHandle(handle)
    return info
  }

  async function rememberHandle(handle: FileSystemDirectoryHandle) {
    try {
      const list = (await handleDb.getList(DEV_HANDLES_KEY)) ?? []
      for (const h of list) {
        if (await h.isSameEntry(handle))
          return
      }
      await handleDb.setList(DEV_HANDLES_KEY, [...list, handle])
    }
    catch {}
  }

  async function forgetSource(src: DevSource) {
    if (src.kind === 'desktop') {
      await desktop?.plugins?.forgetDevFolder(src.folder)
      return
    }
    try {
      const list = (await handleDb.getList(DEV_HANDLES_KEY)) ?? []
      const keep: FileSystemDirectoryHandle[] = []
      for (const h of list) {
        if (!(await h.isSameEntry(src.handle)))
          keep.push(h)
      }
      await handleDb.setList(DEV_HANDLES_KEY, keep)
    }
    catch {}
  }

  /** At startup: the folders loaded last time, without asking for anything. */
  async function restoreDev() {
    const sources: DevSource[] = []
    try {
      if (desktop?.plugins) {
        for (const folder of await desktop.plugins.devFolders())
          sources.push({ kind: 'desktop', folder })
      }
      else {
        for (const handle of (await handleDb.getList(DEV_HANDLES_KEY)) ?? [])
          sources.push({ kind: 'browser', handle })
      }
    }
    catch {}
    for (const src of sources) {
      try {
        // A browser hands a folder back only after a click, unless it was told to keep it.
        if (src.kind === 'browser' && !(await canRead(src.handle)))
          throw new Error('playhound needs your permission to read it again')
        await loadDev(src, { enable: false, activateNow: false })
      }
      catch (err) {
        const key = `dev${++devFailedSeq}`
        devFailedSources.set(key, src)
        devFailed.value = [...devFailed.value, { key, label: devLabel(src), error: err instanceof Error ? err.message : String(err) }]
      }
    }
  }

  /** Try a remembered folder again (from a click, so a browser can ask for permission). */
  async function retryDev(key: string): Promise<PluginInfo> {
    const src = devFailedSources.get(key)
    if (!src)
      throw new Error('That folder is gone from the list')
    if (src.kind === 'browser' && !(await canRead(src.handle, true)))
      throw new Error('playhound wasn\'t allowed to read the folder')
    const info = await loadDev(src, { enable: false, activateNow: true })
    devFailedSources.delete(key)
    devFailed.value = devFailed.value.filter(f => f.key !== key)
    return info
  }

  async function forgetFailedDev(key: string) {
    const src = devFailedSources.get(key)
    devFailedSources.delete(key)
    devFailed.value = devFailed.value.filter(f => f.key !== key)
    if (src)
      await forgetSource(src)
  }

  /**
   * Read a dev plugin's folder again and restart it. If the folder doesn't
   * make a plugin right now (a build half written, a typo in the manifest),
   * the version running stays and the card says why.
   */
  async function reloadDev(id: string) {
    const src = devSources.get(id)
    const p = find(id)
    if (!src || !p?.dev || reloading.has(id))
      return
    reloading.add(id)
    try {
      let next: { pkg: StoredPackage, signature: string | null }
      try {
        next = await readDev(src)
        if (next.pkg.manifest.id !== id)
          throw new Error(`The id in manifest.json changed to "${next.pkg.manifest.id}": remove this one and load the folder again`)
      }
      catch (err) {
        p.dev = { ...p.dev, error: err instanceof Error ? err.message : String(err) }
        return
      }
      deactivate(id, { keepStage: true })
      devPackages.set(id, next.pkg)
      if (next.signature !== null)
        devSignatures.set(id, next.signature)
      p.manifest = next.pkg.manifest
      p.size = next.pkg.size
      p.dev = { ...p.dev, error: null }
      if (p.enabled)
        await activate(id)
    }
    finally {
      reloading.delete(id)
    }
  }

  /** Take a dev plugin out: an installed copy with the same id comes back. Its settings and data stay. */
  async function unloadDev(id: string) {
    const src = devSources.get(id)
    deactivate(id)
    devSources.delete(id)
    devPackages.delete(id)
    devSignatures.delete(id)
    if (src)
      await forgetSource(src)
    const installed = await pluginDb.get<StoredPackage>(`pkg:${id}`)
    if (installed) {
      const info = await infoFor(installed)
      upsert(info)
      if (info.enabled)
        await activate(id)
    }
    else {
      plugins.value = plugins.value.filter(p => p.manifest.id !== id)
      if (activePanel.value === id)
        activePanel.value = null
    }
  }

  // Desktop: the main process watches the folders and says when one changed.
  desktop?.plugins?.onDevChange((folder) => {
    for (const [id, src] of devSources) {
      if (src.kind === 'desktop' && src.folder === folder)
        void reloadDev(id)
    }
  })

  // Browser: no watching, so each folder is looked at once a second while any is loaded.
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let polling = false
  function pollDev() {
    if (pollTimer)
      return
    pollTimer = setInterval(async () => {
      const browserIds = [...devSources].filter(([, s]) => s.kind === 'browser')
      if (!browserIds.length) {
        clearInterval(pollTimer!)
        pollTimer = null
        return
      }
      if (polling)
        return
      polling = true
      try {
        for (const [id, src] of browserIds) {
          if (src.kind !== 'browser' || reloading.has(id))
            continue
          let sig: string
          try {
            sig = await folderSignature(src.handle)
          }
          catch (err) {
            const p = find(id)
            if (p?.dev)
              p.dev = { ...p.dev, error: `Can't read the folder: ${err instanceof Error ? err.message : String(err)}` }
            continue
          }
          if (sig !== devSignatures.get(id)) {
            // Noted first, so a folder that doesn't make a plugin right now
            // isn't read again every second until the next save.
            devSignatures.set(id, sig)
            await reloadDev(id)
          }
        }
      }
      finally {
        polling = false
      }
    }, DEV_POLL_MS)
  }

  // ─── The context ──────────────────────────────────────────────────────────

  function makeContext(info: PluginInfo, r: Running, urls: Map<string, string>): PluginContext {
    const id = info.manifest.id
    const manifestName = info.manifest.name
    const ui = useUiStore()
    const player = usePlayerStore()
    const scripts = useScriptStore()
    const motion = useMotionStore()
    const safety = useSafetyStore()
    const anyDevice = useAnyDevice()
    const self = () => find(id) ?? info
    const later = (fn: () => void) => {
      r.cleanups.push(fn)
      return () => {
        const i = r.cleanups.indexOf(fn)
        if (i >= 0)
          r.cleanups.splice(i, 1)
        fn()
      }
    }

    // What it asked for. A call outside that throws, naming the permission
    // it would need, so the author sees at once what to add to the manifest.
    const access = accessOf(info.manifest)
    const gate = <A extends unknown[], R>(p: PluginPermission, call: string, fn: (...a: A) => R) => (...a: A): R => {
      if (!allows(access, p))
        throw permissionError(manifestName, p, call)
      return fn(...a)
    }

    const snapshot = (): PlayerSnapshot => ({
      playing: player.isPlaying,
      title: player.videoPath ? player.videoPath.split(/[\\/]/).pop() ?? player.videoPath : null,
      time: player.currentTime,
      duration: player.videoDuration,
      hasScript: scripts.hasScripts,
      rate: player.playbackSpeed,
    })

    // ─── Library and playback ──────────────────────────────────────────────
    const library = useLibraryStore()
    const playback = usePlaybackStore()
    const statsStore = useStatsStore()
    const playlistStore = usePlaylistStore()
    const director = useAutoDirector()

    async function listLibrary(): Promise<LibraryVideo[]> {
      // Saved info (tags, source links) is read lazily for the cards; a plugin wants it all.
      await loadUserMeta(library.videos).catch(() => {})
      let sums: Record<string, { meanSpeed: number, meanSpm: number, peakSpeed: number }> = {}
      try {
        sums = await summaryDb.all()
      }
      catch {}
      const inLists = new Map<string, string[]>()
      for (const pl of playlistStore.playlists) {
        for (const e of pl.entries)
          inLists.set(e.videoName, [...(inLists.get(e.videoName) ?? []), pl.name])
      }
      return library.videos.map((v) => {
        const st = statsStore.stats[v.name]
        const sum = v.hasScript ? sums[v.name] : undefined
        return {
          id: v.name,
          title: v.basename,
          path: v.path,
          durationS: v.duration,
          hasScript: v.hasScript,
          starred: v.starred,
          intensity: sum ? { band: intensityBand(sum.meanSpeed), meanSpm: Math.round(sum.meanSpm), meanSpeed: sum.meanSpeed, peakSpeed: sum.peakSpeed } : null,
          playlists: inLists.get(v.name) ?? [],
          plays: st?.totalPlays ?? 0,
          finishes: st?.finishEvents.length ?? 0,
          watchedMin: Math.round((st?.totalWatchedMs ?? 0) / 60000),
          lastPlayedAt: st?.lastPlayedAt || null,
          tags: manualTags(v),
          sourceUrl: httpUrl(effectiveMeta(v).url),
        }
      })
    }

    async function analyseLibrary(ids: string[]) {
      const want = new Set(ids)
      for (const v of library.videos) {
        if (!want.has(v.name) || !v.hasScript)
          continue
        try {
          await director.summarise(v)
        }
        catch {}
      }
    }

    /** The primary script around the playhead, and what comes in the next minute. */
    function scriptNow(): ScriptNow | null {
      const s = scripts.primaryScript ?? scripts.activeScripts[0]
      if (!s || !s.parsed.actions.length)
        return null
      const a = analyseActions(s.parsed.actions, scriptAnalysisKey(s))
      const t = player.currentTime * 1000 + (s.offsetMs ?? 0)
      const cur = sampleEnvelope(a.envelope, t)
      if (!cur)
        return null
      const top = a.peakSpeed || 1
      const level = Math.min(1, cur.speed / top)
      let next: ScriptNow['next'] = null
      for (let dt = 3000; dt <= 60_000; dt += 1000) {
        const s2 = sampleEnvelope(a.envelope, t + dt)
        if (!s2)
          break
        const l2 = Math.min(1, s2.speed / top)
        if (level < 0.6 && l2 >= Math.max(0.6, level + 0.25)) {
          next = { inS: Math.round(dt / 1000), kind: 'harder', spm: Math.round(s2.spm), level: l2 }
          break
        }
        if (level >= 0.6 && l2 <= level - 0.35) {
          next = { inS: Math.round(dt / 1000), kind: 'easier', spm: Math.round(s2.spm), level: l2 }
          break
        }
      }
      return { spm: Math.round(cur.spm), level, next, endsInS: Math.max(0, Math.round((a.durationMs - t) / 1000)) }
    }

    const readout = (): MotionReadout => ({
      spm: motion.currentSpm,
      depth: motion.currentDepth,
      // What was last sent to the stroke axis: the generator's or a script's, whichever drives it.
      pos: axisOutput.L0 ?? motion.currentPos,
      maxSpm: motion.maxSpm,
      device: anyDevice.value,
    })

    function takeMotion(): MotionControl | null {
      if (safety.panicked)
        return null
      motionHolder.value?.release()
      const before = {
        source: motion.source,
        enabled: motion.enabled,
        manualMode: motion.manualMode,
        manualSpm: motion.manualSpm,
        manualDepth: motion.manualDepth,
        center: motion.center,
        shape: motion.shape,
      }
      let active = true
      motion.source = 'manual'
      motion.manualMode = 'oscillate'
      motion.manualSpm = 0
      motion.enabled = true
      // Someone else picked a source: the plugin has lost it, nothing to restore.
      const stopWatch = watch(() => motion.source, (s) => {
        if (s !== 'manual')
          finish(false)
      })
      function finish(restore: boolean) {
        if (!active)
          return
        active = false
        stopWatch()
        if (motionHolder.value?.id === id)
          motionHolder.value = null
        if (restore) {
          motion.manualSpm = before.manualSpm
          motion.manualDepth = before.manualDepth
          motion.center = before.center
          motion.shape = before.shape
          motion.manualMode = before.manualMode
          motion.source = before.source
          // The settings go back, but the generator stays off: when a plugin
          // lets go, nothing may carry on moving by itself (a session that
          // ended, a plugin switched off). Starting it again is the user's call.
          motion.enabled = false
        }
      }
      motionHolder.value = { id, release: () => finish(true) }
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
      return {
        get active() {
          return active
        },
        set(t) {
          if (!active || safety.panicked)
            return
          if (typeof t.spm === 'number' && Number.isFinite(t.spm))
            motion.manualSpm = clamp(t.spm, 0, motion.maxSpm)
          if (typeof t.depth === 'number' && Number.isFinite(t.depth))
            motion.manualDepth = clamp(t.depth, 0, 1)
          if (typeof t.center === 'number' && Number.isFinite(t.center))
            motion.center = clamp(t.center, 0, 1)
          if (t.shape === 'sine' || t.shape === 'ease' || t.shape === 'pulse' || t.shape === 'saw' || t.shape === 'sharp')
            motion.shape = t.shape
          if (!motion.enabled)
            motion.enabled = true
        },
        hold() {
          if (active)
            motion.manualSpm = 0
        },
        release: () => finish(true),
      }
    }

    // ─── Scripts ───────────────────────────────────────────────────────────
    const device = useDeviceStore()
    const videoName = () => (player.videoPath ? player.videoPath.split(/[\\/]/).pop() ?? player.videoPath : null)

    function loadScript(s: { actions: { at: number, pos: number }[], axis?: string, name?: string }): boolean {
      if (!s || typeof s !== 'object')
        throw new TypeError('scripts.load takes { actions, axis?, name? }')
      const key = axisKeyFor(s.axis)
      if (!key)
        throw new Error(`scripts.load: there is no axis "${String(s.axis)}" (try L0, R0, V0, or twist, roll, vib…)`)
      if (!player.videoPath)
        return false
      const actions = cleanActions(s.actions)
      if (!actions.length)
        return false
      const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `${manifestName}.funscript`
      // Through the same parser as a file, so it is shaped exactly like one.
      const axis = parseFunscriptContent(JSON.stringify({ version: '1.0', actions }), name, '', key).axes[0]
      const file: ScriptFile = {
        path: `plugin:${id}/${name}`,
        filename: name,
        channel: axis.channel,
        axisKey: axis.axisKey,
        label: axis.label,
        enabled: true,
        isAlt: false,
        altName: '',
        offsetMs: 0,
        parsed: axis,
      }
      scripts.setScripts([...scripts.scripts.filter(x => x.channel !== axis.channel), file])
      // As a loaded file does: the axis it drives is switched on.
      const cfg = device.axisConfigs[axis.channel]
      if (cfg)
        cfg.enabled = true
      return true
    }

    // ─── Motion filter ─────────────────────────────────────────────────────
    function setFilter(fn: MotionFilter): () => void {
      if (typeof fn !== 'function')
        throw new TypeError('motion.filter takes a function (pos, { axis, t }) => pos')
      motionFilters.set(id, fn)
      filterOf.set(id, fn)
      // A remover for this filter only: one set after it stays.
      return later(() => {
        if (filterOf.get(id) === fn) {
          filterOf.delete(id)
          motionFilters.remove(id)
        }
      })
    }

    // ─── Clock and fingerprints ────────────────────────────────────────────
    const steady = createSteadyClock()
    function clockNow(): number {
      const v = document.querySelector<HTMLVideoElement>('video[data-ph-main]')
      if (!v || !player.videoUrl)
        return player.currentTime
      const running = !v.paused && !v.seeking && v.readyState >= 3
      return steady.read(v.currentTime * 1000, performance.now(), v.playbackRate, running) / 1000
    }

    async function fingerprint(videoId: string): Promise<string | null> {
      const v = library.videos.find(x => x.name === videoId)
      return v ? fingerprintFile(v.file) : null
    }

    async function playFingerprint(fp: string): Promise<boolean> {
      const size = fingerprintSize(fp)
      if (size === null)
        return false
      // Only files of the same size can match, and those are few: no need to read the rest.
      for (const v of library.videos.filter(x => x.file.size === size)) {
        if (await fingerprintFile(v.file) === fp) {
          await playback.play(v, [v], manifestName)
          return true
        }
      }
      return false
    }

    // ─── Commands ──────────────────────────────────────────────────────────
    function registerCommand(def: Parameters<PluginContext['commands']['register']>[0]): boolean {
      if (!def || typeof def.id !== 'string' || !def.id || typeof def.title !== 'string' || typeof def.run !== 'function')
        throw new TypeError('commands.register takes { id, title, run, hint?, icon?, kbd? }')
      let kbd: Chord | null = null
      let ok = true
      if (def.kbd !== undefined && def.kbd !== null && def.kbd !== '') {
        const c = parseKbd(def.kbd)
        const taken = c && (reservedBy(c) ?? shortcutOwner(c, { plugin: id, command: def.id }))
        if (!c)
          console.warn(`[plugin ${id}] "${String(def.kbd)}" is not a shortcut a plugin can have (a letter, digit or F1–F12, with Ctrl, Alt or Shift); "${def.title}" has none`)
        else if (taken)
          console.warn(`[plugin ${id}] ${String(def.kbd)} is already taken by ${taken}; "${def.title}" has no shortcut`)
        else
          kbd = c
        ok = !!kbd
      }
      const cmd: PluginCommand = {
        id: def.id,
        title: def.title,
        hint: typeof def.hint === 'string' ? def.hint : undefined,
        icon: typeof def.icon === 'string' ? def.icon : undefined,
        kbd,
        run: def.run,
      }
      self().commands = markRaw([...self().commands.filter(c => c.id !== def.id), cmd])
      return ok
    }

    return Object.freeze({
      manifest: Object.freeze({ ...info.manifest, ...(info.manifest.permissions ? { permissions: [...info.manifest.permissions] } : {}) }),
      settings: {
        get: <T>(key: string) => ({ ...defaults(self().fields), ...self().values })[key] as T,
        all: () => ({ ...defaults(self().fields), ...self().values }),
        set: (key: string, value: unknown) => void setValue(id, key, value),
        onChange(fn) {
          r.settingsListeners.add(fn)
          return later(() => r.settingsListeners.delete(fn))
        },
      },
      storage: {
        get: <T>(key: string) => pluginDb.get<T>(`data:${id}:${key}`),
        set: (key: string, value: unknown) => pluginDb.set(`data:${id}:${key}`, value),
        del: (key: string) => pluginDb.del(`data:${id}:${key}`),
      },
      ui: {
        settings(fields) {
          self().fields = markRaw([...fields])
        },
        panel(def) {
          self().panel = markRaw({ ...def })
          if (!activePanel.value)
            activePanel.value = id
        },
        openPanel() {
          activePanel.value = id
          ui.openInspector('plugins')
        },
        page: gate('stage', 'ui.page', (def: PageDef) => {
          self().page = markRaw({ ...def })
        }),
        openPage: gate('stage', 'ui.openPage', () => {
          if (self().page)
            ui.openPluginView(id)
        }),
        stage: () => stageOf(ui.view, ui.pluginView),
        showStage: gate('stage', 'ui.showStage', (view: Parameters<PluginContext['ui']['showStage']>[0]) => {
          const target = parseStage(view)
          if (!target)
            return false
          if ('plugin' in target) {
            if (!find(target.plugin)?.page || find(target.plugin)?.status !== 'on')
              return false
            ui.openPluginView(target.plugin)
          }
          else {
            ui.openView(target.view)
          }
          return true
        }),
        onStageChange(fn) {
          const stop = watch(() => stageOf(ui.view, ui.pluginView), (v) => {
            try {
              fn(v)
            }
            catch (err) {
              console.error(`[plugin ${id}] onStageChange failed`, err)
            }
          })
          return later(stop)
        },
        overlay: gate('stage', 'ui.overlay', (def: OverlayDef) => {
          if (!def || typeof def.mount !== 'function')
            throw new TypeError('ui.overlay takes { mount(el), interactive? }')
          const mine = markRaw({ mount: def.mount, interactive: !!def.interactive })
          self().overlay = mine
          // A remover for this layer only: one set after it stays.
          return later(() => {
            if (self().overlay === mine)
              self().overlay = null
          })
        }),
        openSettings() {
          focusSettings.value = id
          ui.settingsSection = 'plugins'
          ui.settingsOpen = true
        },
        style(css) {
          const el = document.createElement('style')
          el.dataset.plugin = id
          el.textContent = String(css)
          document.head.appendChild(el)
          later(() => el.remove())
        },
        toast(text, opts = {}) {
          const o = { detail: opts.detail }
          if (opts.tone === 'success')
            toast.success(String(text), o)
          else if (opts.tone === 'error')
            toast.error(String(text), o)
          else
            toast(String(text), o)
        },
      },
      commands: {
        register: registerCommand,
        unregister(cid: string) {
          self().commands = markRaw(self().commands.filter(c => c.id !== cid))
        },
      },
      library: {
        list: gate('library', 'library.list', listLibrary),
        analyse: gate('library', 'library.analyse', analyseLibrary),
        onChange: gate('library', 'library.onChange', (fn: () => void) => {
          const stop = watch(() => library.loadedAt, () => fn())
          return later(stop)
        }),
        fingerprint: gate('library', 'library.fingerprint', fingerprint),
        info: gate('library', 'library.info', (id: string) => videoInfo(library, id)),
        tag: gate('library-edit', 'library.tag', (id: string, change: { add?: string[], remove?: string[] }) => tagVideo(library, id, change)),
        setSource: gate('library-edit', 'library.setSource', (id: string, url: string | null) => setVideoSource(library, id, url)),
      },
      playback: {
        play: gate('playback', 'playback.play', async (videoId: string) => {
          const entry = library.videos.find(v => v.name === videoId)
          if (!entry)
            return false
          // On its own: when it ends, nothing else starts by itself.
          await playback.play(entry, [entry], manifestName)
          return true
        }),
        pause: gate('playback', 'playback.pause', () => playback.pause()),
        resume: gate('playback', 'playback.resume', () => playback.resume()),
        playFingerprint: gate('playback', 'playback.playFingerprint', playFingerprint),
        onEnded: gate('player', 'playback.onEnded', (fn: (id: string | null) => void) => {
          // A video that ran to its end: the playhead reached the duration while playing.
          let wasNearEnd = false
          const stop = watch(() => [player.currentTime, player.isPlaying, player.videoPath] as const, ([t, playing, path], old) => {
            const dur = player.videoDuration
            const near = !!dur && t >= dur - 0.6
            if (old && path !== old[2]) {
              wasNearEnd = false
              return
            }
            if (near && !wasNearEnd && (playing || old?.[1])) {
              wasNearEnd = true
              fn(path ? path.split(/[\\/]/).pop() ?? path : null)
            }
            else if (!near) {
              wasNearEnd = false
            }
          })
          return later(stop)
        }),
      },
      player: {
        state: gate('player', 'player.state', snapshot),
        script: gate('player', 'player.script', scriptNow),
        frame: gate('player', 'player.frame', (o: { maxWidth?: number, quality?: number } = {}) => playback.grabFrame(Math.max(64, Math.min(1280, o.maxWidth ?? 512)), Math.max(0.3, Math.min(0.95, o.quality ?? 0.72)))),
        onChange: gate('player', 'player.onChange', (fn: (s: PlayerSnapshot) => void) => {
          // What plays and whether it plays; not every tick of the clock.
          const stop = watch(() => [player.isPlaying, player.videoPath, player.videoDuration, scripts.hasScripts, player.playbackSpeed], () => fn(snapshot()))
          return later(stop)
        }),
        clock: gate('player', 'player.clock', clockNow),
        seek: gate('playback', 'player.seek', (t: number) => {
          if (!player.videoUrl || typeof t !== 'number' || !Number.isFinite(t))
            return false
          playback.seek(t)
          return true
        }),
        setRate: gate('playback', 'player.setRate', (rate: number) => {
          if (typeof rate === 'number' && Number.isFinite(rate))
            playback.setSpeed(rate)
        }),
      },
      scripts: {
        current: gate('scripts', 'scripts.current', () => snapshotOf(scripts.scripts, videoName())),
        load: gate('scripts', 'scripts.load', loadScript),
        onChange: gate('scripts', 'scripts.onChange', (fn: (s: ReturnType<typeof snapshotOf>) => void) => {
          const stop = watch(() => scripts.scripts.map(s => [s.filename, s.channel, s.enabled, s.offsetMs, s.parsed.actions]), () => {
            try {
              fn(snapshotOf(scripts.scripts, videoName()))
            }
            catch (err) {
              console.error(`[plugin ${id}] scripts.onChange failed`, err)
            }
          })
          return later(stop)
        }),
      },
      motion: {
        take: gate('device', 'motion.take', takeMotion),
        readout,
        filter: gate('device', 'motion.filter', setFilter),
      },
      safety: {
        panicked: () => safety.panicked,
        onPanic(fn) {
          const stop = watch(() => safety.panicked, (on) => {
            if (on)
              fn()
          })
          return later(stop)
        },
      },
      net: { fetch: gate('network', 'net.fetch', pluginFetch) },
      webview: {
        available: !!desktop?.web,
        create: gate('web', 'webview.create', (opts?: WebViewOptions) => {
          const view = createWebview(id, opts)
          // Its pages close with it.
          later(() => view.destroy())
          return view
        }),
      },
      asset: (path: string) => urls.get(path.replace(/^\.?\//, '')) ?? null,
      // eslint-disable-next-line no-console
      log: (...args: unknown[]) => console.log(`[plugin ${id}]`, ...args),
    } satisfies PluginContext)
  }

  // Panic releases whatever a plugin holds, before its own onPanic runs.
  const safety = useSafetyStore()
  watch(() => safety.panicked, (on) => {
    if (on)
      motionHolder.value?.release()
  }, { flush: 'sync' })

  // ─── Sources (the plugin store) ───────────────────────────────────────────

  const sourceList = useLocalStorage<string[]>(KEYS.pluginSources.key, [...DEFAULT_SOURCES])
  // New official plugins join the list of someone who already has one, once.
  {
    const hadList = localStorage.getItem(KEYS.pluginSources.key) !== null
    let seen: string[] | null = null
    try {
      seen = JSON.parse(localStorage.getItem(KEYS.pluginDefaultsSeen.key) ?? 'null')
    }
    catch {}
    const r = addNewDefaults(sourceList.value, hadList ? (Array.isArray(seen) ? seen : null) : [...DEFAULT_SOURCES])
    if (r.list.length !== sourceList.value.length)
      sourceList.value = r.list
    localStorage.setItem(KEYS.pluginDefaultsSeen.key, JSON.stringify(r.seen))
  }
  const checkedAt = useLocalStorage<number>(KEYS.pluginsChecked.key, 0)
  const sources = ref<Record<string, SourceState>>({})

  /** A source's entry: the reactive one, so the page sees each change. */
  function sourceFor(repo: string): SourceState {
    if (!sources.value[repo])
      sources.value[repo] = { repo, status: 'idle', error: '', release: null }
    return sources.value[repo]
  }

  /** The installed plugin a source's release is (by manifest id, or by where it was installed from). */
  function installedFrom(s: SourceState): PluginInfo | undefined {
    const id = s.release?.manifest?.id
    return plugins.value.find(p => (id && p.manifest.id === id) || p.source === s.repo)
  }

  /** A newer release than the installed one. */
  function updateFor(s: SourceState): SourceRelease | null {
    const p = installedFrom(s)
    return p && s.release && newer(s.release.version, p.manifest.version) ? s.release : null
  }

  async function checkSources() {
    checkedAt.value = Date.now()
    await Promise.all(sourceList.value.map(async (repo) => {
      const s = sourceFor(repo)
      s.status = 'checking'
      s.error = ''
      try {
        s.release = await fetchRelease(pluginFetch, repo)
        s.status = 'ok'
      }
      catch (err) {
        s.status = 'error'
        s.error = err instanceof Error ? err.message : String(err)
      }
    }))
  }

  /** Add a source: "owner/repo" or a GitHub URL. Returns the repo, or throws why not. */
  async function addSource(input: string): Promise<string> {
    const repo = parseRepo(input)
    if (!repo)
      throw new Error('That isn\'t a GitHub repository (owner/repo or a github.com link)')
    if (!sourceList.value.some(r => r.toLowerCase() === repo.toLowerCase()))
      sourceList.value = [...sourceList.value, repo]
    const s = sourceFor(repo)
    s.status = 'checking'
    try {
      s.release = await fetchRelease(pluginFetch, repo)
      s.status = 'ok'
    }
    catch (err) {
      s.status = 'error'
      s.error = err instanceof Error ? err.message : String(err)
    }
    return repo
  }

  function removeSource(repo: string) {
    sourceList.value = sourceList.value.filter(r => r !== repo)
    delete sources.value[repo]
  }

  /** Download a source's latest release and install it (or update the installed one); null if the user said no. */
  async function installFromSource(repo: string): Promise<PluginInfo | null> {
    const s = sourceFor(repo)
    const rel = s.release ?? await fetchRelease(pluginFetch, repo)
    s.release = rel
    const res = await pluginFetch(rel.zipUrl)
    if (!res.ok)
      throw new Error(`Download failed: ${res.status}`)
    return install(new Uint8Array(await res.arrayBuffer()), repo)
  }

  /** At startup: look at the sources once a day, and say if something can be updated. */
  async function checkDaily() {
    if (Date.now() - checkedAt.value < CHECK_EVERY_MS)
      return
    await checkSources()
    const ups = Object.values(sources.value).map(s => ({ s, rel: updateFor(s) })).filter(x => x.rel)
    if (ups.length) {
      const ui = useUiStore()
      toast(ups.length === 1 ? `${installedFrom(ups[0].s)?.manifest.name ?? ups[0].s.repo} ${ups[0].rel!.version} is out` : `${ups.length} plugin updates are out`, {
        icon: 'i-carbon-application',
        action: { label: 'Plugins', run: () => {
          ui.settingsSection = 'plugins'
          ui.settingsOpen = true
        } },
        duration: 8000,
      })
    }
  }

  /** Plugins that are on and have a panel, in the order they're listed. */
  const panels = computed(() => plugins.value.filter(p => p.panel && p.status === 'on'))
  /** The panel the Plugins drawer shows: the chosen one, else the first. */
  const shownPanel = computed(() => panels.value.find(p => p.manifest.id === activePanel.value) ?? panels.value[0] ?? null)

  /** Plugins that are on and have a stage page, in the order they're listed. */
  const pages = computed(() => plugins.value.filter(p => p.page && p.status === 'on'))

  /** Plugins that are on and draw over the video. */
  const overlays = computed(() => plugins.value.filter(p => p.overlay && p.status === 'on'))

  /** Plugins that are on and have commands, with them. */
  const commandGroups = computed(() => plugins.value.filter(p => p.status === 'on' && p.commands.length))

  return {
    plugins,
    panels,
    shownPanel,
    pages,
    overlays,
    commandGroups,
    activePanel,
    focusSettings,
    ready,
    loaded,
    start,
    install,
    pendingInstall,
    answerInstall,
    remove,
    setEnabled,
    setValue,
    motionHolder,
    runCommand,
    runShortcut,
    loadFromFolder,
    reloadDev,
    unloadDev,
    devFailed,
    retryDev,
    forgetFailedDev,
    sourceList,
    sources,
    checkSources,
    addSource,
    removeSource,
    installFromSource,
    installedFrom,
    updateFor,
    checkDaily,
  }
})
