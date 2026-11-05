import type { SourceRelease } from '~/plugins/sources'
import type { LibraryVideo, MotionControl, MotionReadout, PanelDef, PlayerSnapshot, PluginContext, PluginManifest, ScriptNow, SettingField } from '~/plugins/types'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef, watch } from 'vue'
import { useAnyDevice } from '~/composables/useAnyDevice'
import { useAutoDirector } from '~/composables/useAutoDirector'
import { analyseActions, analysisKey } from '~/composables/useScriptAnalysis'
import { axisOutput } from '~/composables/useTCode'
import { toast } from '~/composables/useToast'
import { sampleEnvelope } from '~/lib/funscriptAnalysis'
import { pluginDb, summaryDb } from '~/lib/idb'
import { KEYS } from '~/lib/persist'
import { intensityBand } from '~/lib/scriptIntensity'
import { pluginFetch } from '~/plugins/net'
import { DEFAULT_SOURCES, fetchRelease, newer, parseRepo } from '~/plugins/sources'
import { stripCommonRoot, unzip } from '~/plugins/zip'
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
 * sandbox; the install screen says so.
 */

interface StoredPackage {
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
  values: Record<string, unknown>
}

interface Running {
  urls: string[]
  cleanups: (() => void)[]
  deactivate: (() => void) | null
  settingsListeners: Set<(v: Record<string, unknown>) => void>
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
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
  const entries = stripCommonRoot(await unzip(bytes))
  const manifestEntry = entries.find(e => e.path === 'manifest.json')
  if (!manifestEntry)
    throw new Error('No manifest.json in the zip')
  let manifest: PluginManifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data))
  }
  catch {
    throw new Error('manifest.json is not valid JSON')
  }
  if (!manifest || typeof manifest !== 'object')
    throw new Error('manifest.json is not an object')
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id))
    throw new Error('manifest.json: "id" must be lower-case letters, digits and dashes')
  if (typeof manifest.name !== 'string' || !manifest.name.trim())
    throw new Error('manifest.json: "name" is missing')
  if (typeof manifest.version !== 'string' || !manifest.version.trim())
    throw new Error('manifest.json: "version" is missing')
  const main = manifest.main ?? 'index.js'
  if (!entries.some(e => e.path === main))
    throw new Error(`${main} (the plugin's code) is not in the zip`)
  const files: Record<string, Blob> = {}
  let size = 0
  for (const e of entries) {
    files[e.path] = new Blob([e.data as BlobPart], { type: mimeOf(e.path) })
    size += e.data.byteLength
  }
  return {
    manifest: {
      id: manifest.id,
      name: manifest.name.trim(),
      version: manifest.version.trim(),
      description: typeof manifest.description === 'string' ? manifest.description : undefined,
      author: typeof manifest.author === 'string' ? manifest.author : undefined,
      main,
    },
    files,
    installedAt: Date.now(),
    size,
  }
}

function defaults(fields: SettingField[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields ?? []) {
    if (f.type !== 'heading' && f.default !== undefined)
      out[f.key] = f.default
  }
  return out
}

export const usePluginStore = defineStore('plugins', () => {
  const plugins = ref<PluginInfo[]>([])
  const enabledIds = useLocalStorage<string[]>(KEYS.pluginsEnabled.key, [])
  /** Which plugin's panel the Plugins drawer shows. */
  const activePanel = ref<string | null>(null)
  /** A plugin whose settings were asked for; Settings → Plugins opens its card. */
  const focusSettings = ref<string | null>(null)
  const ready = ref(false)
  const running = new Map<string, Running>()
  /** The plugin holding the stroke generator, and what it was before. */
  const motionHolder = shallowRef<{ id: string, release: () => void } | null>(null)

  const find = (id: string) => plugins.value.find(p => p.manifest.id === id)

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
    plugins.value.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
    for (const p of plugins.value) {
      if (p.enabled)
        await activate(p.manifest.id)
    }
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
      values,
    }
  }

  /** Install (or update) from a zip. Returns the plugin's name. */
  async function install(file: Blob | Uint8Array, source?: string): Promise<PluginInfo> {
    const pkg = await readPackage(file)
    const id = pkg.manifest.id
    const was = find(id)
    // Remember where it came from: a source keeps updating it; a manual zip of
    // the same plugin keeps the source it had.
    pkg.source = source ?? (was?.source || undefined)
    if (was)
      deactivate(id)
    await pluginDb.set(`pkg:${id}`, pkg)
    const info = await infoFor(pkg)
    if (was) {
      info.enabled = was.enabled
      plugins.value.splice(plugins.value.indexOf(was), 1, info)
    }
    else {
      plugins.value.push(info)
      plugins.value.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
    }
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
    const pkg = await pluginDb.get<StoredPackage>(`pkg:${id}`)
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
      if (!running.has(id))
        return
      if (typeof out === 'function')
        r.deactivate = out
      else if (out && typeof out.deactivate === 'function')
        r.deactivate = () => out.deactivate()
      p.status = 'on'
    }
    catch (err) {
      console.error(`[plugin ${id}] failed to start`, err)
      deactivate(id)
      p.status = 'error'
      p.error = err instanceof Error ? err.message : String(err)
    }
  }

  function deactivate(id: string) {
    const r = running.get(id)
    const p = find(id)
    if (p) {
      p.status = 'off'
      p.fields = null
      p.panel = null
    }
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

    const snapshot = (): PlayerSnapshot => ({
      playing: player.isPlaying,
      title: player.videoPath ? player.videoPath.split(/[\\/]/).pop() ?? player.videoPath : null,
      time: player.currentTime,
      duration: player.videoDuration,
      hasScript: scripts.hasScripts,
    })

    // ─── Library and playback ──────────────────────────────────────────────
    const library = useLibraryStore()
    const playback = usePlaybackStore()
    const statsStore = useStatsStore()
    const playlistStore = usePlaylistStore()
    const director = useAutoDirector()

    async function listLibrary(): Promise<LibraryVideo[]> {
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
      const a = analyseActions(s.parsed.actions, analysisKey(s.filename, s.channel, s.parsed.actions.length))
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

    return Object.freeze({
      manifest: Object.freeze({ ...info.manifest }),
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
      library: {
        list: listLibrary,
        analyse: analyseLibrary,
        onChange(fn) {
          const stop = watch(() => library.loadedAt, () => fn())
          return later(stop)
        },
      },
      playback: {
        async play(videoId: string) {
          const entry = library.videos.find(v => v.name === videoId)
          if (!entry)
            return false
          // On its own: when it ends, nothing else starts by itself.
          await playback.play(entry, [entry], manifestName)
          return true
        },
        pause: () => playback.pause(),
        resume: () => playback.resume(),
        onEnded(fn) {
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
        },
      },
      player: {
        state: snapshot,
        script: scriptNow,
        frame: (o = {}) => playback.grabFrame(Math.max(64, Math.min(1280, o.maxWidth ?? 512)), Math.max(0.3, Math.min(0.95, o.quality ?? 0.72))),
        onChange(fn) {
          // What plays and whether it plays; not every tick of the clock.
          const stop = watch(() => [player.isPlaying, player.videoPath, player.videoDuration, scripts.hasScripts], () => fn(snapshot()))
          return later(stop)
        },
      },
      motion: {
        take: takeMotion,
        readout,
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
      net: { fetch: pluginFetch },
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

  /** Download a source's latest release and install it (or update the installed one). */
  async function installFromSource(repo: string): Promise<PluginInfo> {
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

  return { plugins, panels, shownPanel, activePanel, focusSettings, ready, start, install, remove, setEnabled, setValue, motionHolder, sourceList, sources, checkSources, addSource, removeSource, installFromSource, installedFrom, updateFor, checkDaily }
})
