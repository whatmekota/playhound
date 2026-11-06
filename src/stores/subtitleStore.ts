import type { SubtitleName } from '~/lib/subtitles'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { toast } from '~/composables/useToast'
import { KEYS } from '~/lib/persist'
import { decodeSubtitle, pairSubtitles, parseSubtitle, pickTrack, readTag, sortTracks, subtitleLabel, toVtt } from '~/lib/subtitles'

/** A subtitle file found next to a video. */
export interface SubtitleMatch {
  file: File
  name: SubtitleName
  label: string
}

export interface SubTrack {
  id: string
  label: string
  lang: string | null
  flags: string[]
  fileName: string
  /** WebVTT as a blob URL, for the <track>. */
  url: string
  cueCount: number
}

export interface SubtitlePrefs {
  /** Show subtitles when a video has them. */
  enabled: boolean
  /** The language last picked, tried first on the next video. */
  lang: string | null
  /** Text size, 1 = normal. */
  size: number
  /** Opacity of the box behind the text, 0–1. */
  background: number
  /** Raised from the bottom, in percent of the picture's height. */
  raise: number
}

export const SUBTITLE_DEFAULTS: SubtitlePrefs = { enabled: true, lang: null, size: 1, background: 0.55, raise: 0 }

let seq = 0

/**
 * The playing video's subtitle tracks and which one shows.
 *
 * Tracks are read once per video, converted to WebVTT and handed to the
 * player as <track> elements; the player draws the active one itself so
 * the style settings apply, and so it shows in the pop-out and VR views too.
 */
export const useSubtitleStore = defineStore('subtitles', () => {
  const prefs = useLocalStorage<SubtitlePrefs>(KEYS.subtitles.key, { ...SUBTITLE_DEFAULTS }, { mergeDefaults: true })
  const tracks = shallowRef<SubTrack[]>([])
  const activeId = ref<string | null>(null)
  const active = computed(() => tracks.value.find(t => t.id === activeId.value) ?? null)
  let loadToken = 0

  function drop() {
    for (const t of tracks.value)
      URL.revokeObjectURL(t.url)
    tracks.value = []
    activeId.value = null
  }

  async function read(file: File, name: SubtitleName, label: string): Promise<SubTrack | null> {
    const cues = parseSubtitle(decodeSubtitle(await file.arrayBuffer()), file.name)
    if (!cues.length)
      return null
    return {
      id: `sub${++seq}`,
      label,
      lang: name.lang,
      flags: name.flags,
      fileName: file.name,
      url: URL.createObjectURL(new Blob([toVtt(cues)], { type: 'text/vtt' })),
      cueCount: cues.length,
    }
  }

  /** A new video: its subtitles, or none (a stream, a file with nothing beside it). */
  async function load(matches: SubtitleMatch[] = []) {
    const token = ++loadToken
    drop()
    if (!matches.length)
      return
    // An unreadable file just means one track fewer.
    const results = await Promise.all(matches.map(m => read(m.file, m.name, m.label).catch(() => null)))
    const found = results.filter((t): t is SubTrack => !!t)
    if (token !== loadToken) {
      found.forEach(t => URL.revokeObjectURL(t.url))
      return
    }
    tracks.value = sortTracks(found)
    activeId.value = prefs.value.enabled ? pickTrack(tracks.value, prefs.value.lang)?.id ?? null : null
  }

  function clear() {
    ++loadToken
    drop()
  }

  /** A file dropped on the player: added to this video's tracks and shown. */
  async function addFile(file: File, videoName: string | null) {
    const name = pairSubtitles(videoName ? [videoName] : [], [file])[0]?.name
      ?? readTag(file.name.replace(/\.[^.]+$/, '').split('.').slice(1).join('.'))
    let label = subtitleLabel(name, file.name)
    if (tracks.value.some(t => t.label === label))
      label = file.name
    let track: SubTrack | null = null
    try {
      track = await read(file, name, label)
    }
    catch {}
    if (!track) {
      toast.warn('No subtitles in that file', { detail: file.name, icon: 'i-carbon-closed-caption' })
      return
    }
    tracks.value = [...tracks.value, track]
    select(track.id)
    toast.success('Subtitles added', { detail: label, icon: 'i-carbon-closed-caption', key: 'subs' })
  }

  /** Show a track, or none (null). Remembered for the next video. */
  function select(id: string | null) {
    const t = tracks.value.find(x => x.id === id) ?? null
    activeId.value = t?.id ?? null
    prefs.value.enabled = !!t
    // An untagged track says nothing about language, so the preference stays.
    if (t?.lang)
      prefs.value.lang = t.lang
  }

  /** On with the preferred track, or off. False when there is nothing to show. */
  function toggle(): boolean {
    if (!tracks.value.length)
      return false
    select(activeId.value ? null : pickTrack(tracks.value, prefs.value.lang)?.id ?? null)
    return true
  }

  /** Off, then each track in turn. */
  function cycle(): boolean {
    if (!tracks.value.length)
      return false
    const order = [null, ...tracks.value.map(t => t.id)]
    select(order[(order.indexOf(activeId.value) + 1) % order.length])
    return true
  }

  return { prefs, tracks, activeId, active, load, clear, addFile, select, toggle, cycle }
})
