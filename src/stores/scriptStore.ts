import type { FunscriptAction, ParsedAxis } from '~/lib/funscriptParser'
import type { SavedTweaks, ScriptTweaks } from '~/lib/scriptTweaks'
import { defineStore } from 'pinia'
import { computed, markRaw, ref, toRaw, watch } from 'vue'
import { videoMetaDb } from '~/lib/idb'
import { applyTweaks, DEFAULT_TWEAKS, isDefaultTweaks, normaliseTweaks, repeats, shapeIsIdentity } from '~/lib/scriptTweaks'
import { usePlayerStore } from '~/stores/playerStore'

export interface ScriptFile {
  path: string
  filename: string
  channel: string
  axisKey: string
  label: string
  enabled: boolean
  isAlt: boolean
  altName: string
  offsetMs: number
  /**
   * What plays: `source` with this video's tweaks applied. Everything that
   * drives a device, draws the script or hands it to a plugin reads this.
   */
  parsed: ParsedAxis
  /**
   * The axis as written, or as edited in the script editor: what Save
   * writes. Set by the store when missing (the same object as `parsed`
   * until a tweak or an edit makes them differ).
   */
  source?: ParsedAxis
  /** The file it was read from, for saving back. Absent for plugin and generated scripts. */
  file?: File
  /** Where Save writes when it is not next to `file` (after Save as). */
  handle?: FileSystemFileHandle
  /** Edited and not saved yet. */
  edited?: boolean
}

/** Every new version of a script gets a number, so caches keyed on it know it changed. */
let revSeq = 0
export const nextRev = () => ++revSeq

/**
 * Scripts are replaced whole, never changed in place, so their points are
 * kept out of Vue's reach: with every point reactive, each reader of a
 * 60k-point script walked 60k proxies, and every edit took half a second.
 * Swapping `parsed` or `source` for a new object is still seen.
 */
const frozen = (a: ParsedAxis): ParsedAxis => markRaw(toRaw(a))

export function sourceOf(s: ScriptFile): ParsedAxis {
  return s.source ?? s.parsed
}

export const useScriptStore = defineStore('script', () => {
  const scripts = ref<ScriptFile[]>([])
  const autoDetected = ref(false)

  const activeScripts = computed(() => scripts.value.filter(s => s.enabled))
  const hasScripts = computed(() => scripts.value.length > 0)
  const primaryScript = computed(() =>
    scripts.value.find(s => s.channel === 'L0' && s.enabled && !s.isAlt)
    ?? scripts.value.find(s => s.channel === 'L0' && s.enabled)
    ?? activeScripts.value[0] ?? null,
  )

  // ─── Tweaks ─────────────────────────────────────────────────────────────
  /** The video (file name) the tweaks belong to; they are saved under it. */
  const tweakVideo = ref<string | null>(null)
  /** This video's tweaks, by channel. Channels with nothing set are absent. */
  const tweaks = ref<Record<string, ScriptTweaks>>({})

  function tweaksFor(channel: string): ScriptTweaks {
    return tweaks.value[channel] ?? { ...DEFAULT_TWEAKS }
  }

  const isTweaked = (channel: string) => !!tweaks.value[channel] && !isDefaultTweaks(tweaks.value[channel])
  const anyTweaked = computed(() => scripts.value.some(s => isTweaked(s.channel)))
  const anyEdited = computed(() => scripts.value.some(s => s.edited))

  /**
   * The video's length, ms, once the player knows it (0 before): a repeated
   * stretch fills up to it. Read from the player rather than handed in, so
   * it follows wherever the length comes from (a file, a stream, a headset).
   */
  const player = usePlayerStore()
  const videoMs = computed(() => {
    const d = player.videoDuration
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0
  })

  /**
   * The take of `channel` whose script others play: the one playing, else
   * the main one. Null when the channel is not loaded.
   */
  function takeOf(channel: string, list: ScriptFile[]): ScriptFile | null {
    const takes = list.filter(x => x.channel === channel)
    return takes.find(x => x.enabled) ?? takes.find(x => !x.isAlt) ?? takes[0] ?? null
  }

  /**
   * What an axis's tweaks are applied to: another loaded axis's script when
   * it plays one, else its own. Always the other's script as written (or as
   * edited), never what that axis plays, so two axes playing each other's
   * scripts swap them instead of going round in a loop. An axis that is not
   * loaded on this video leaves this one on its own script.
   */
  function inputOf(s: ScriptFile, t: ScriptTweaks, list: ScriptFile[]): readonly FunscriptAction[] {
    const other = t.plays && t.plays !== s.channel ? takeOf(t.plays, list) : null
    return toRaw(sourceOf(other ?? s)).actions
  }

  /** What plays for `s` under `t`: a new axis, so caches keyed on its version see the change. */
  function shaped(s: ScriptFile, t: ScriptTweaks, list: ScriptFile[]): ParsedAxis {
    const src = toRaw(sourceOf(s))
    const actions = applyTweaks(inputOf(s, t, list), t, {
      videoMs: videoMs.value,
      // Humanising plays the same every time for this video and axis.
      seed: `${tweakVideo.value ?? ''}\u0000${s.channel}`,
    }) as FunscriptAction[]
    return frozen({
      ...src,
      actions,
      duration: actions.length ? actions[actions.length - 1].at : 0,
      rev: nextRev(),
    })
  }

  /** Recompute what plays from the source and the tweaks. Keeps `parsed` as is when nothing changes it. */
  function applyTo(s: ScriptFile) {
    s.source ??= frozen(s.parsed)
    const src = toRaw(s.source)
    const t = tweaks.value[s.channel]
    s.offsetMs = t?.offsetMs ?? 0
    if (!t || shapeIsIdentity(t)) {
      if (toRaw(s.parsed) !== src)
        s.parsed = src
      return
    }
    s.parsed = shaped(s, t, scripts.value)
  }

  /** The axes that play `channel`'s script follow it when what it says, or which take plays, changes. */
  function refollow(channel: string) {
    scripts.value.filter(s => s.channel !== channel && tweaks.value[s.channel]?.plays === channel).forEach(applyTo)
  }

  function prepare(list: ScriptFile[]) {
    for (const s of list) {
      s.parsed = frozen(s.parsed)
      s.source = s.source ? frozen(s.source) : s.parsed
    }
    // Every source first, so an axis playing another's script finds it in the new list.
    for (const s of list) {
      // Through the same rules as a change, so a new list plays tweaked from the start.
      const t = tweaks.value[s.channel]
      s.offsetMs = t?.offsetMs ?? s.offsetMs ?? 0
      if (t && !shapeIsIdentity(t))
        s.parsed = shaped(s, t, list)
    }
    return list
  }

  // The length arrives after the scripts (when the video's metadata loads):
  // a repeated stretch then reaches the real end. Going back to 0 is a new
  // video on its way, whose scripts are prepared afresh.
  watch(videoMs, (ms) => {
    if (ms)
      scripts.value.filter(s => repeats(tweaks.value[s.channel])).forEach(applyTo)
  })
  /**
   * A repeated stretch is waiting for that length: what plays until then is
   * a first go that ends with the script. A device that takes the whole
   * script at once (the Handy over WiFi) waits for the real one rather than
   * upload twice.
   */
  const awaitingLength = computed(() => !videoMs.value && scripts.value.some(s => repeats(tweaks.value[s.channel])))

  // One pending write per video: switching videos must not drop the last one's.
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Write this video's tweaks into its saved info, a moment after the last change. */
  function persist() {
    const video = tweakVideo.value
    if (!video)
      return
    const snapshot: SavedTweaks = {}
    for (const [ch, t] of Object.entries(tweaks.value)) {
      if (!isDefaultTweaks(t))
        snapshot[ch] = { ...t }
    }
    clearTimeout(saveTimers.get(video))
    saveTimers.set(video, setTimeout(async () => {
      saveTimers.delete(video)
      try {
        const stored = (await videoMetaDb.get(video)) ?? {}
        const next = { ...stored, scriptTweaks: Object.keys(snapshot).length ? snapshot : undefined }
        if (!next.scriptTweaks)
          delete next.scriptTweaks
        await videoMetaDb.set(video, next)
      }
      catch (err) {
        console.warn('Could not save script tweaks', err)
      }
    }, 300))
  }

  function setTweaks(channel: string, patch: Partial<ScriptTweaks>) {
    const next = normaliseTweaks({ ...tweaksFor(channel), ...patch }, channel)
    if (isDefaultTweaks(next)) {
      const { [channel]: _gone, ...rest } = tweaks.value
      tweaks.value = rest
    }
    else {
      tweaks.value = { ...tweaks.value, [channel]: next }
    }
    scripts.value.filter(s => s.channel === channel).forEach(applyTo)
    persist()
  }

  /** Back to the script as written: one channel, or every one. */
  function resetTweaks(channel?: string) {
    if (channel)
      return setTweaks(channel, DEFAULT_TWEAKS)
    tweaks.value = {}
    scripts.value.forEach(applyTo)
    persist()
  }

  /**
   * Switch to the tweaks saved for `video`, before its scripts are set, so
   * they play tweaked from the first moment (the Handy uploads once, not
   * twice). Scripts already loaded are re-applied unless `reapply` is false
   * (they are the last video's, about to be replaced).
   */
  async function useTweaksFor(video: string | null, reapply = true) {
    tweakVideo.value = video
    let loaded: Record<string, ScriptTweaks> = {}
    if (video) {
      try {
        const saved = (await videoMetaDb.get(video))?.scriptTweaks
        if (saved && typeof saved === 'object') {
          for (const [ch, t] of Object.entries(saved)) {
            const n = normaliseTweaks(t, ch)
            if (!isDefaultTweaks(n))
              loaded[ch] = n
          }
        }
      }
      catch {
        loaded = {}
      }
    }
    // A newer video took over while this one was being read.
    if (tweakVideo.value !== video)
      return
    tweaks.value = loaded
    if (reapply)
      scripts.value.forEach(applyTo)
  }

  // Offsets are changed in several places (the dock, the Scripts inspector)
  // by writing `offsetMs`; they belong to the video's tweaks, so follow them
  // there, and keep every take of an axis on the same offset.
  watch(() => scripts.value.map(s => s.offsetMs), () => {
    const seen = new Set<string>()
    for (const s of scripts.value) {
      if (seen.has(s.channel))
        continue
      const want = tweaks.value[s.channel]?.offsetMs ?? 0
      const changed = scripts.value.find(x => x.channel === s.channel && x.offsetMs !== want)
      if (changed) {
        seen.add(s.channel)
        setTweaks(s.channel, { offsetMs: changed.offsetMs })
      }
    }
  })

  // ─── Edits ──────────────────────────────────────────────────────────────
  /**
   * Replace what an axis says (the script editor). The tweaks are applied on
   * top as usual, so the device plays the edit at once.
   */
  function setSourceActions(s: ScriptFile, actions: FunscriptAction[], edited = true) {
    const src = toRaw(sourceOf(s))
    s.source = frozen({ ...src, actions, duration: actions.length ? actions[actions.length - 1].at : 0, rev: nextRev() })
    s.edited = edited
    applyTo(s)
    refollow(s.channel)
  }

  // ─── Loading ────────────────────────────────────────────────────────────
  function setScripts(newScripts: ScriptFile[]) {
    scripts.value = prepare(newScripts)
    autoDetected.value = false
  }

  function setAutoDetected(newScripts: ScriptFile[]) {
    scripts.value = prepare(newScripts)
    autoDetected.value = true
  }

  function toggleScript(path: string, channel: string) {
    const s = scripts.value.find(x => x.path === path && x.channel === channel)
    if (!s)
      return
    if (!s.enabled) {
      scripts.value
        .filter(x => x.channel === channel && !(x.path === path && x.channel === channel))
        .forEach((x) => { x.enabled = false })
    }
    s.enabled = !s.enabled
    refollow(channel)
  }

  function clearScripts() {
    scripts.value = []
    autoDetected.value = false
  }

  return {
    scripts,
    awaitingLength,
    autoDetected,
    activeScripts,
    hasScripts,
    primaryScript,
    tweakVideo,
    tweaks,
    anyTweaked,
    anyEdited,
    tweaksFor,
    isTweaked,
    setTweaks,
    resetTweaks,
    useTweaksFor,
    setSourceActions,
    setScripts,
    setAutoDetected,
    toggleScript,
    clearScripts,
  }
})
