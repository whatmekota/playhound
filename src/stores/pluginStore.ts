import type { VideoEntry } from './libraryStore'
import type { Access } from '~/plugins/manifest'
import type { Chord } from '~/plugins/shortcuts'
import type { SourceRelease } from '~/plugins/sources'
import type { ExternalPlayback, ExternalPlaybackOptions, HttpHandler, LibrarySourceDef, LibrarySourceHandle, LibraryVideo, LibraryVideoInfo, MotionControl, MotionFilter, MotionReadout, OverlayDef, PageDef, PanelDef, PictureRect, PlayerSnapshot, PluginContext, PluginManifest, PluginPermission, ScriptNow, SettingField, WebViewOptions } from '~/plugins/types'
import type { ScriptFile } from '~/stores/scriptStore'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import { useAnyDevice } from '~/composables/useAnyDevice'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { generatorStroke } from '~/composables/useMotionEngine'
import { analyseActions, scriptAnalysisKey } from '~/composables/useScriptAnalysis'
import { axisOutput } from '~/composables/useTCode'
import { toast } from '~/composables/useToast'
import { AXIS_MAP, extractSuffix } from '~/lib/axisMap'
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
import { aliasesOf, baseUrl, baseUrls, serve as serveHttp, servingAvailable, shareFile, unserve, unshareAll } from '~/plugins/http'
import { accessOf, addedPermissions, allows, permissionError, readManifest } from '~/plugins/manifest'
import { pluginFetch } from '~/plugins/net'
import { cleanProvidedList, entryOf } from '~/plugins/provider'
import { remoteScriptMatches } from '~/plugins/remoteScripts'
import { axisKeyFor, cleanActions, snapshotOf } from '~/plugins/scripts'
import { clampLimit, DEFAULT_PLUGIN_INTENSITY_MAX, pluginTarget, rampStep } from '~/plugins/session'
import { chordId, chordOf, parseKbd, reservedBy } from '~/plugins/shortcuts'
import { openSocket, socketsAvailable } from '~/plugins/socket'
import { addNewDefaults, DEFAULT_SOURCES, fetchRelease, newer, parseRepo, SourceError } from '~/plugins/sources'
import { parseStage, stageOf } from '~/plugins/stage'
import { loadReleases, saveReleases } from '~/plugins/storeCache'
import { createWebview } from '~/plugins/webview'
import { stripCommonRoot, unzip } from '~/plugins/zip'
import { useDeviceStore } from '~/stores/deviceStore'
import { useLibraryStore } from '~/stores/libraryStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { usePlaylistStore } from '~/stores/playlistStore'
import { useQueueStore } from '~/stores/queueStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useScriptStore } from '~/stores/scriptStore'
import { useSessionControlStore } from '~/stores/sessionControlStore'
import { useStatsStore } from '~/stores/statsStore'
import { useThemeStore } from '~/stores/themeStore'
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
  /** The latest release as last seen; kept through a failed check, and between runs. */
  release: SourceRelease | null
  /** When it was last checked (ms epoch), 0 if never. */
  checkedAt: number
}

/** Sources are looked at on their own once a day at most. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
/** Opening the Plugins page checks them again if it's been this long; Check now always does. */
const PAGE_CHECK_MS = 10 * 60 * 1000

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
  /** A tab of Settings → Plugins to open on ("updates", from the update notice). */
  const focusTab = ref<'discover' | 'installed' | 'updates' | null>(null)
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

  // ─── Session control: the user's limit, and one ramp at a time ────────────
  /** Settings → Plugins: the highest intensity a plugin may set (ctx.session.intensity.set). */
  const intensityMax = useLocalStorage<number>(KEYS.pluginIntensityMax.key, DEFAULT_PLUGIN_INTENSITY_MAX)
  /** The knob moving toward what a plugin asked for, until it gets there or someone else turns it. */
  let ramp: { timer: ReturnType<typeof setInterval>, owner: string } | null = null
  /**
   * Where the knob was before each plugin first moved it, for restore(); and
   * the value that plugin last wrote to it (each step of its ramp), so a turn
   * by the user in between (the knob is theirs then) cancels the restore,
   * while a knob caught halfway along the plugin's own ramp does not.
   * `restoring`: the mark stays until the knob is back, so a set() during
   * that ramp doesn't take the halfway level for the user's.
   */
  const knobBefore = new Map<string, { level: number, left: number, restoring?: boolean }>()
  /** The knob is where this plugin last left it: nobody else has turned it since. */
  function stillPlugins(owner: string, level: number): boolean {
    const mark = knobBefore.get(owner)
    return !!mark && Math.abs(level - mark.left) <= 0.004
  }

  function stopRamp() {
    if (ramp)
      clearInterval(ramp.timer)
    ramp = null
  }

  /**
   * Move the knob toward `want` for a plugin, within the user's limit, a
   * step every 100 ms. The user turning it (or panic) stops the move where
   * it is: the knob is theirs. Returns where it will stop.
   */
  function rampIntensity(owner: string, name: string, want: unknown, ceiling?: number, restoring = false): number {
    const control = useSessionControlStore()
    const safety = useSafetyStore()
    const target = pluginTarget(want, ceiling ?? clampLimit(intensityMax.value))
    if (target === null)
      throw new TypeError('session.intensity.set takes a number, 0.1–1')
    if (!stillPlugins(owner, control.intensityScale))
      knobBefore.set(owner, { level: control.intensityScale, left: control.intensityScale })
    const mark = knobBefore.get(owner)!
    mark.restoring = restoring
    if (safety.panicked) {
      // Nothing moves in a panic, so lowering is safe, and at once; raising waits for the user.
      if (target < control.intensityScale) {
        stopRamp()
        control.setIntensityScale(target)
        mark.left = control.intensityScale
      }
      return control.intensityScale
    }
    stopRamp()
    let pos = control.intensityScale
    let shown = pos
    let at = performance.now()
    const timer = setInterval(() => {
      // Someone else moved it (the user, panic): leave it there.
      if (safety.panicked || Math.abs(control.intensityScale - shown) > 0.004) {
        stopRamp()
        return
      }
      const now = performance.now()
      pos = rampStep(pos, target, now - at)
      at = now
      control.setIntensityScale(pos)
      shown = control.intensityScale
      mark.left = shown
      if (pos === target) {
        stopRamp()
        // Back where the user had it: nothing left to restore.
        if (mark.restoring && knobBefore.get(owner) === mark)
          knobBefore.delete(owner)
      }
    }, 100)
    ramp = { timer, owner }
    if (Math.abs(target - control.intensityScale) >= 0.01) {
      const capped = typeof want === 'number' && want > target + 0.001 && target >= clampLimit(intensityMax.value)
      toast(`${name}: intensity to ${Math.round(target * 100)}%`, {
        icon: 'i-carbon-meter-alt',
        key: 'plugin-intensity',
        detail: capped ? `Held to your limit for plugins (Settings → Plugins)` : `From ${Math.round(control.intensityScale * 100)}%, a little at a time`,
      })
    }
    return target
  }

  // Panic stops a plugin's move at once (the next step would notice, but not before it).
  watch(() => useSafetyStore().panicked, (on) => {
    if (on)
      stopRamp()
  }, { flush: 'sync' })

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
    void loadSourceCache().then(checkDaily).catch(() => {})
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
    // A move it started stops where it is.
    if (ramp?.owner === id)
      stopRamp()
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
    const themeStore = useThemeStore()
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
    /** Reading the session: what the player shows anyway (`player`), or `session`. */
    const gateRead = <A extends unknown[], R>(call: string, fn: (...a: A) => R) => (...a: A): R => {
      if (!allows(access, 'player') && !allows(access, 'session'))
        throw new Error(`${manifestName} can't use ${call}: its manifest doesn't ask for the "player" or the "session" permission`)
      return fn(...a)
    }

    const snapshot = (): PlayerSnapshot => ({
      playing: player.isPlaying,
      title: player.videoPath ? player.videoPath.split(/[\\/]/).pop() ?? player.videoPath : null,
      time: player.currentTime,
      duration: player.videoDuration,
      hasScript: scripts.hasScripts,
      rate: player.playbackSpeed,
      width: player.videoWidth,
      height: player.videoHeight,
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

    const readout = (): MotionReadout => {
      // The generator's own stroke, when it is the one moving (not a script).
      const g = scripts.hasScripts && player.isPlaying ? null : generatorStroke()
      return {
        spm: motion.currentSpm,
        depth: motion.currentDepth,
        // What was last sent to the stroke axis: the generator's or a script's, whichever drives it.
        pos: axisOutput.L0 ?? motion.currentPos,
        maxSpm: motion.maxSpm,
        device: anyDevice.value,
        phase: g ? g.phase : null,
        nextStrokeInMs: g ? Math.round((1 - g.phase) * 60_000 / g.spm) : null,
        scriptDriving: scripts.hasScripts && player.isPlaying,
      }
    }

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

    /** A plugin's script as a loaded file's; null with no usable actions. Throws for an unknown axis. */
    function scriptFileOf(s: { actions: { at: number, pos: number }[], axis?: string, name?: string }, call: string): ScriptFile | null {
      if (!s || typeof s !== 'object')
        throw new TypeError(`${call} takes { actions, axis?, name? }`)
      const key = axisKeyFor(s.axis)
      if (!key)
        throw new Error(`${call}: there is no axis "${String(s.axis)}" (try L0, R0, V0, or twist, roll, vib…)`)
      const actions = cleanActions(s.actions)
      if (!actions.length)
        return null
      const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `${manifestName}.funscript`
      // Through the same parser as a file, so it is shaped exactly like one.
      const axis = parseFunscriptContent(JSON.stringify({ version: '1.0', actions }), name, '', key).axes[0]
      return {
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
    }

    function loadScript(s: { actions: { at: number, pos: number }[], axis?: string, name?: string }): boolean {
      if (!s || typeof s !== 'object')
        throw new TypeError('scripts.load takes { actions, axis?, name? }')
      if (!axisKeyFor(s.axis))
        throw new Error(`scripts.load: there is no axis "${String(s.axis)}" (try L0, R0, V0, or twist, roll, vib…)`)
      if (!player.videoPath)
        return false
      const file = scriptFileOf(s, 'scripts.load')
      if (!file)
        return false
      const axis = file.parsed
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
      // Playing in another app: its clock, steadied already.
      if (playback.external)
        return playback.external.media.currentTime
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

    /** The library video with this fingerprint, or null. */
    async function entryByFingerprint(fp: string): Promise<VideoEntry | null> {
      const size = fingerprintSize(fp)
      if (size === null)
        return null
      // Only files of the same size can match, and those are few: no need to read the rest.
      for (const v of library.videos.filter(x => !x.remote && x.file.size === size)) {
        if (await fingerprintFile(v.file) === fp)
          return v
      }
      return null
    }

    async function playFingerprint(fp: string): Promise<boolean> {
      const v = await entryByFingerprint(fp)
      if (!v)
        return false
      await playback.play(v, [v], manifestName)
      return true
    }

    // ─── Playing in another app ────────────────────────────────────────────
    async function playExternal(opts: ExternalPlaybackOptions): Promise<ExternalPlayback | null> {
      if (!opts || typeof opts !== 'object' || typeof opts.label !== 'string' || !opts.label.trim())
        throw new TypeError('playback.external takes { label, video?, fingerprint?, title?, scripts?, duration?, onCommand? }')
      if (opts.onCommand !== undefined && typeof opts.onCommand !== 'function')
        throw new TypeError('playback.external: onCommand must be a function')
      let entry: VideoEntry | null = null
      if (typeof opts.video === 'string' && opts.video)
        entry = library.videos.find(v => v.name === opts.video) ?? null
      else if (typeof opts.fingerprint === 'string' && opts.fingerprint)
        entry = await entryByFingerprint(opts.fingerprint)
      const given = Array.isArray(opts.scripts) ? opts.scripts.map(s => scriptFileOf(s, 'playback.external')).filter((f): f is ScriptFile => !!f) : []
      // Nothing to play to its clock: no library video and no scripts.
      if (!entry && !given.length)
        return null
      const onCommand = opts.onCommand
      const s = await playback.playExternal({
        owner: id,
        label: opts.label.trim().slice(0, 40),
        entry,
        title: typeof opts.title === 'string' ? opts.title.slice(0, 200) : undefined,
        // One per axis: the last wins, as with scripts.load.
        scripts: given.length ? [...new Map(given.map(f => [f.channel, f])).values()] : undefined,
        duration: typeof opts.duration === 'number' && Number.isFinite(opts.duration) ? opts.duration : undefined,
        onCommand: onCommand
          ? (c) => {
              try {
                onCommand(c)
              }
              catch (err) {
                console.error(`[plugin ${id}] external onCommand failed`, err)
              }
            }
          : undefined,
      })
      if (!s)
        return null
      // Switched off, it stops being followed.
      const drop = later(() => {
        if (playback.external === s)
          playback.endExternal('ended')
      })
      s.onEnd(() => drop())
      return {
        update(x) {
          if (!x || typeof x !== 'object' || typeof x.time !== 'number' || !Number.isFinite(x.time))
            throw new TypeError('update takes { time (seconds), playing, rate?, duration? }')
          s.update({ time: x.time, playing: !!x.playing, rate: x.rate, duration: x.duration })
        },
        end() {
          if (playback.external === s)
            playback.endExternal('ended')
        },
        onEnd(fn) {
          return later(s.onEnd((reason) => {
            try {
              fn(reason)
            }
            catch (err) {
              console.error(`[plugin ${id}] external onEnd failed`, err)
            }
          }))
        },
        get active() {
          return !s.ended
        },
      }
    }

    // ─── Library sources ───────────────────────────────────────────────────
    const queue = useQueueStore()
    let source: { removed: boolean } | null = null

    async function provide(def: LibrarySourceDef): Promise<LibrarySourceHandle> {
      if (!def || typeof def !== 'object' || typeof def.label !== 'string' || !def.label.trim() || typeof def.videos !== 'function')
        throw new TypeError('library.provide takes { label, videos(), scripts?(id) }')
      if (def.scripts !== undefined && typeof def.scripts !== 'function')
        throw new TypeError('library.provide: scripts must be a function (id) => [{ axis, actions }]')
      const label = def.label.trim().slice(0, 40)
      // One source per plugin: a new one replaces the last.
      if (source)
        source.removed = true
      const mine = { removed: false }
      source = mine
      let problems: string[] = []
      const loaderFor = (vid: string) => def.scripts
        ? async () => (await def.scripts!(vid) ?? [])
          .map(s => ({ axis: axisKeyFor(s?.axis), actions: cleanActions(s?.actions) }))
          .filter((s): s is { axis: string, actions: { at: number, pos: number }[] } => !!s.axis && s.actions.length > 0)
        : undefined

      async function refresh(): Promise<number> {
        if (mine.removed || running.get(id) !== r)
          return 0
        const { videos, errors } = cleanProvidedList(await def.videos(), { loader: !!def.scripts })
        problems = errors
        if (errors.length)
          console.warn(`[plugin ${id}] library.provide: ${errors.length} left out`, errors.slice(0, 10))
        if (mine.removed || running.get(id) !== r)
          return 0
        library.provide(id, videos.map(v => entryOf(v, id, label, { loader: v.scripts.length ? undefined : loaderFor(v.id) })))
        return videos.length
      }
      function remove() {
        mine.removed = true
        library.unprovide(id)
        // What it added that is still waiting in the queue goes too.
        for (const q of queue.upcoming) {
          if (q.entry.remote?.owner === id)
            queue.remove(q.uid)
        }
      }
      later(remove)
      await refresh()
      return {
        refresh,
        remove,
        get problems() {
          return [...problems]
        },
      }
    }

    // ─── Sharing on the network ────────────────────────────────────────────
    let sharing = false
    /** Undo its sharing when it is switched off, from the first time it shares. */
    function shares() {
      if (!sharing) {
        sharing = true
        later(() => void unshareAll(id))
      }
    }
    let servedUrl: string | null = null

    async function serve(handler: HttpHandler, opts: { rootAliases?: string[] } = {}): Promise<string | null> {
      shares()
      servedUrl = await serveHttp(id, handler, Array.isArray(opts?.rootAliases) ? opts.rootAliases : [])
      return servedUrl
    }

    /** The library entry by id, as it is now (a rescan makes new ones). */
    const entryNamed = (name: string) => library.videos.find(v => v.name === name) ?? null

    async function mediaUrl(videoId: string): Promise<string | null> {
      const entry = entryNamed(videoId)
      if (!entry)
        return null
      // From another app: its own address, when it needs nothing to play.
      if (entry.remote)
        return entry.remote.headers ? null : entry.remote.url
      shares()
      return shareFile(id, `video:${entry.name}`, () => (entryNamed(entry.name) ?? entry).file, entry.name)
    }

    /** One axis of a video's scripts as a .funscript of its own (a merged script's too). */
    async function axisScript(entry: VideoEntry, channel: string): Promise<Blob | null> {
      const matches = entry.remote ? await remoteScriptMatches(entry) : entry.scriptMatches
      for (const m of matches.filter(x => !x.isAlt)) {
        const suffix = m.suffix ?? extractSuffix(entry.name, m.file.name)
        try {
          const text = await m.file.text()
          const parsed = parseFunscriptContent(text, m.file.name, entry.name, suffix)
          const axis = parsed.axes.find(a => a.channel === channel)
          if (!axis)
            continue
          const out = {
            version: '1.0',
            inverted: false,
            range: 100,
            ...(parsed.rawMetadata ? { metadata: parsed.rawMetadata } : {}),
            actions: axis.actions.map(a => ({ at: Math.round(a.at), pos: Math.round(a.pos * 100) })),
          }
          return new Blob([JSON.stringify(out)], { type: 'application/json' })
        }
        catch {}
      }
      return null
    }

    async function scriptUrl(videoId: string, axisName?: string): Promise<string | null> {
      const entry = entryNamed(videoId)
      const key = axisKeyFor(axisName)
      if (!key)
        throw new Error(`library.scriptUrl: there is no axis "${String(axisName)}" (try L0, R0, V0, or twist, roll, vib…)`)
      if (!entry)
        return null
      const channel = AXIS_MAP[key].channel
      // Only an axis it has gets a link.
      if (!await axisScript(entry, channel))
        return null
      shares()
      const base = entry.basename.replace(/[\\/:*?"<>|]/g, '_')
      const name = key === 'default' ? `${base}.funscript` : `${base}.${key}.funscript`
      return shareFile(id, `script:${entry.name}:${channel}`, async () => {
        const now = entryNamed(entry.name) ?? entry
        return (await axisScript(now, channel)) ?? new Blob(['{"actions":[]}'], { type: 'application/json' })
      }, name)
    }

    // ─── Session ───────────────────────────────────────────────────────────
    const control = useSessionControlStore()

    function pluginEdge() {
      control.edge('plugin', {
        videoTime: player.videoUrl ? player.currentTime : null,
        videoName: videoName(),
      })
      toast(`${manifestName} called an edge`, { icon: 'i-carbon-temperature-hot', key: `plugin-edge-${id}` })
    }

    // ─── Commands ──────────────────────────────────────────────────────────
    function registerCommand(def: Parameters<PluginContext['commands']['register']>[0]): boolean {
      if (!def || typeof def.id !== 'string' || !def.id || typeof def.title !== 'string' || typeof def.run !== 'function')
        throw new TypeError('commands.register takes { id, title, run, hint?, icon?, kbd? }')
      let kbd: Chord | null = null
      let ok = true
      // One key, or several to try in order: the first free one wins.
      const wanted = (Array.isArray(def.kbd) ? def.kbd : [def.kbd]).filter(k => k !== undefined && k !== null && k !== '')
      if (wanted.length) {
        const why: string[] = []
        for (const k of wanted) {
          const c = parseKbd(k)
          const taken = c && (reservedBy(c) ?? shortcutOwner(c, { plugin: id, command: def.id }))
          if (!c) {
            why.push(`"${String(k)}" is not a shortcut a plugin can have (a letter, digit or F1–F12, with Ctrl, Alt or Shift)`)
          }
          else if (taken) {
            why.push(`${String(k)} is already taken by ${taken}`)
          }
          else {
            kbd = c
            break
          }
        }
        if (!kbd)
          console.warn(`[plugin ${id}] ${why.join('; ')}; "${def.title}" has no shortcut`)
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
        theme: () => themeStore.current,
        onThemeChange(fn) {
          // After the DOM has the new theme, so its CSS variables read the new colours.
          const stop = watch(() => themeStore.current, (t) => {
            try {
              fn(t)
            }
            catch (err) {
              console.error(`[plugin ${id}] onThemeChange failed`, err)
            }
          }, { flush: 'post' })
          return later(stop)
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
        keyFree(k: string) {
          const c = parseKbd(k)
          if (!c || reservedBy(c))
            return false
          // Another plugin's command holding it; its own can be moved.
          const want = chordId(c)
          return !plugins.value.some(p => p.manifest.id !== id && p.commands.some(cmd => cmd.kbd && chordId(cmd.kbd) === want))
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
        provide: gate('library-source', 'library.provide', provide),
        mediaUrl: gate('serve', 'library.mediaUrl', gate('library', 'library.mediaUrl', mediaUrl)),
        scriptUrl: gate('serve', 'library.scriptUrl', gate('library', 'library.scriptUrl', scriptUrl)),
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
        next: gate('playback', 'playback.next', () => playback.next()),
        previous: gate('playback', 'playback.previous', () => playback.prev()),
        external: gate('external', 'playback.external', playExternal),
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
          const stop = watch(() => [player.isPlaying, player.videoPath, player.videoDuration, scripts.hasScripts, player.playbackSpeed, player.videoWidth, player.videoHeight], () => fn(snapshot()))
          return later(stop)
        }),
        clock: gate('player', 'player.clock', clockNow),
        picture: gate('player', 'player.picture', (): PictureRect | null => (player.pictureRect ? { ...player.pictureRect } : null)),
        onPicture: gate('player', 'player.onPicture', (fn: (r: PictureRect | null) => void) => {
          const stop = watch(() => player.pictureRect, r => fn(r ? { ...r } : null))
          return later(stop)
        }),
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
        onResume(fn) {
          const stop = watch(() => safety.panicked, (on, was) => {
            if (!on && was)
              fn()
          })
          return later(stop)
        },
      },
      net: {
        fetch: gate('network', 'net.fetch', pluginFetch),
        socketAvailable: socketsAvailable(),
        socket: gate('socket', 'net.socket', async (o: { host: string, port: number }) => {
          const sock = await openSocket(o)
          // Closed with the plugin; once closed, nothing to do then.
          const drop = later(() => sock.close())
          sock.onClose(() => drop())
          return sock
        }),
      },
      http: {
        available: servingAvailable(),
        serve: gate('serve', 'http.serve', serve),
        url: () => (servedUrl && baseUrl() ? servedUrl : null),
        urls: () => (servedUrl ? baseUrls().map(b => `${b}/plugins/${id}/`) : []),
        rootAliases: () => aliasesOf(id),
        stop: gate('serve', 'http.stop', () => {
          servedUrl = null
          void unserve(id)
        }),
      },
      session: {
        edge: gate('session', 'session.edge', pluginEdge),
        endEdge: gate('session', 'session.endEdge', () => {
          if (!safety.panicked && control.phase !== 'idle')
            control.release()
        }),
        edgeState: gateRead('session.edgeState', () => ({ phase: control.phase, remainingSec: control.remainingSec, holdBack: control.holdBack, effective: control.effectiveIntensity })),
        onEdge: gateRead('session.onEdge', (fn: (e: { at: number, videoTime: number | null, byPlugin: boolean }) => void) => {
          let seen = control.edges.length
          const stop = watch(() => control.edges.length, (n) => {
            for (const e of control.edges.slice(n < seen ? 0 : seen, n)) {
              try {
                fn({ at: e.at, videoTime: e.videoTime, byPlugin: e.source === 'plugin' })
              }
              catch (err) {
                console.error(`[plugin ${id}] session.onEdge failed`, err)
              }
            }
            seen = n
          })
          return later(stop)
        }),
        onFinish: gateRead('session.onFinish', (fn: (e: { at: number, videoTime: number | null }) => void) => {
          const stop = watch(() => control.lastFinish, (f) => {
            if (!f)
              return
            try {
              fn({ at: f.at, videoTime: f.videoTime })
            }
            catch (err) {
              console.error(`[plugin ${id}] session.onFinish failed`, err)
            }
          })
          return later(stop)
        }),
        intensity: {
          get: gateRead('session.intensity.get', () => control.intensityScale),
          set: gate('session', 'session.intensity.set', (level: number) => rampIntensity(id, manifestName, level)),
          restore: gate('session', 'session.intensity.restore', (): number | null => {
            const mark = knobBefore.get(id)
            // Never moved it, or the user turned it since: it is theirs, leave it.
            if (!mark || !stillPlugins(id, control.intensityScale)) {
              knobBefore.delete(id)
              return null
            }
            if (Math.abs(control.intensityScale - mark.level) <= 0.004) {
              knobBefore.delete(id)
              return mark.level
            }
            return rampIntensity(id, manifestName, mark.level, Math.max(mark.level, clampLimit(intensityMax.value)), true)
          }),
          max: gateRead('session.intensity.max', () => clampLimit(intensityMax.value)),
          onChange: gateRead('session.intensity.onChange', (fn: (level: number) => void) => {
            const stop = watch(() => control.intensityScale, (v) => {
              try {
                fn(v)
              }
              catch (err) {
                console.error(`[plugin ${id}] session.intensity.onChange failed`, err)
              }
            })
            return later(stop)
          }),
        },
      },
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

  /**
   * The context a plugin with this manifest would get, without a package to
   * run: for tests of what the API lets through. `stop` switches it off.
   */
  function contextFor(manifest: PluginManifest): { ctx: PluginContext, stop: () => void } {
    const id = manifest.id
    deactivate(id)
    plugins.value = plugins.value.filter(p => p.manifest.id !== id)
    plugins.value.push({ manifest, installedAt: 0, size: 0, source: null, enabled: true, status: 'on', error: null, fields: null, panel: null, page: null, overlay: null, commands: [], values: {}, dev: null })
    const r: Running = { urls: [], cleanups: [], deactivate: null, settingsListeners: new Set() }
    running.set(id, r)
    return { ctx: makeContext(find(id)!, r, new Map()), stop: () => deactivate(id) }
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
      sources.value[repo] = { repo, status: 'idle', error: '', release: null, checkedAt: 0 }
    return sources.value[repo]
  }

  // The releases as last checked come back from the cache, so the store
  // opens with them (and shows them offline) while a check runs.
  let cacheLoad: Promise<void> | null = null
  function loadSourceCache(): Promise<void> {
    cacheLoad ??= loadReleases().then((kept) => {
      for (const repo of sourceList.value) {
        const k = kept[repo]
        const s = sourceFor(repo)
        if (k && !s.checkedAt) {
          s.release = k.release
          s.error = k.error
          s.status = k.error ? 'error' : k.release ? 'ok' : 'idle'
          s.checkedAt = k.checkedAt
        }
      }
    })
    return cacheLoad
  }
  function keepSources() {
    const all: Record<string, { release: SourceRelease | null, error: string, checkedAt: number }> = {}
    for (const repo of sourceList.value) {
      const s = sources.value[repo]
      if (s?.checkedAt)
        all[repo] = { release: s.release, error: s.error, checkedAt: s.checkedAt }
    }
    void saveReleases(all)
  }

  /** Check one source. A failed check keeps the release seen before, and says why. */
  async function checkOne(repo: string) {
    const s = sourceFor(repo)
    s.status = 'checking'
    try {
      s.release = await fetchRelease(pluginFetch, repo)
      s.error = ''
      s.status = 'ok'
    }
    catch (err) {
      s.status = 'error'
      s.error = err instanceof Error ? err.message : String(err)
      // Gone or no longer a plugin: nothing to offer.
      if (err instanceof SourceError && (err.kind === 'not-found' || err.kind === 'no-release' || err.kind === 'no-zip'))
        s.release = null
    }
    s.checkedAt = Date.now()
  }

  /** The Plugins page opened: what was kept shows at once, and a check runs if the last one is a while ago. */
  async function refreshSources() {
    await loadSourceCache()
    if (Date.now() - checkedAt.value >= PAGE_CHECK_MS || sourceList.value.some(r => !sources.value[r]?.checkedAt))
      await checkSources()
  }

  /** Whether a check is running. */
  const checking = computed(() => sourceList.value.some(r => sources.value[r]?.status === 'checking'))

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
    await loadSourceCache()
    await Promise.all(sourceList.value.map(checkOne))
    keepSources()
  }

  /**
   * Follow a repository: "owner/repo" or a GitHub link. It's checked first:
   * one that isn't there, or has no release with a plugin zip, isn't added,
   * and the error says which. When GitHub can't be asked right now it's added
   * anyway and checked again later. Returns the repo as followed.
   */
  async function addSource(input: string): Promise<string> {
    if (!input.trim())
      throw new Error('Paste a GitHub repository: owner/repo, or its github.com link')
    const repo = parseRepo(input)
    if (!repo)
      throw new Error('That isn\'t a GitHub repository. Paste owner/repo (like whatmekota/playmate) or its github.com link.')
    const have = sourceList.value.find(r => r.toLowerCase() === repo.toLowerCase())
    if (have)
      return have
    const s: SourceState = { repo, status: 'checking', error: '', release: null, checkedAt: 0 }
    try {
      s.release = await fetchRelease(pluginFetch, repo)
      s.status = 'ok'
    }
    catch (err) {
      if (!(err instanceof SourceError) || err.kind === 'not-found' || err.kind === 'no-release' || err.kind === 'no-zip' || err.kind === 'other')
        throw err
      s.status = 'error'
      s.error = err.message
    }
    s.checkedAt = Date.now()
    sources.value[repo] = s
    sourceList.value = [...sourceList.value, repo]
    keepSources()
    return repo
  }

  function removeSource(repo: string) {
    sourceList.value = sourceList.value.filter(r => r !== repo)
    delete sources.value[repo]
    keepSources()
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
          focusTab.value = 'updates'
          ui.settingsSection = 'plugins'
          ui.settingsOpen = true
        } },
        duration: 8000,
      })
    }
  }

  /** A file of an installed (or dev) plugin's package, for the store's icon and screenshots. */
  async function pluginFile(id: string, path: string): Promise<Blob | null> {
    const pkg = devPackages.get(id) ?? await pluginDb.get<StoredPackage>(`pkg:${id}`).catch(() => undefined)
    return pkg?.files[path.replace(/^\.?\//, '')] ?? null
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
    focusTab,
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
    intensityMax,
    contextFor,
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
    refreshSources,
    checking,
    checkedAt,
    pluginFile,
    addSource,
    removeSource,
    installFromSource,
    installedFrom,
    updateFor,
    checkDaily,
  }
})
