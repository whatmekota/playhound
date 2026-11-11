import type { FrameMedia } from './cardFrames'
import type { CardAxis, Pic } from './drawCard'
import type { Action } from '~/lib/funscriptAnalysis'
import type { PreviewSource } from '~/lib/previews'
import type { CardChapter } from '~/lib/shareCard'
import type { VideoEntry } from '~/stores/libraryStore'
import type { ShareCardTarget } from '~/stores/uiStore'
import { proxiedStream } from '~/composables/useStreams'
import { isNativeMediaUrl } from '~/lib/android/nativeFile'
import { AXIS_PRIORITY } from '~/lib/axisMap'
import { authorChapters, GAP_NAME } from '~/lib/chapters'
import { parseFunscriptContent } from '~/lib/funscriptParser'
import { isAudioName } from '~/lib/mediaFiles'
import { creatorOf, titleFromName } from '~/lib/shareCard'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { sourceOf, useScriptStore } from '~/stores/scriptStore'
import { picFromUrl } from './cardAssets'

/**
 * Everything a share card is made from, gathered for one target: the scripts
 * loaded now (as written or as edited, not as tweaked for this machine), or
 * a library video's scripts read from disk.
 */
export interface CardSource {
  title: string
  creator: string
  durationMs: number
  axes: CardAxis[]
  chapters: CardChapter[]
  /** The video file, for a frame and for saving next to it. */
  video: File | null
  /** The video's file name: what the PNG is named after. */
  videoName: string
  /** Where frames can be read from, opened only when the dialog wants them; null when they cannot. */
  media: () => Promise<FrameMedia | null>
  /** The picture showing in the player now: what the card uses when `media` gives nothing. */
  playerFrame: (() => Promise<Pic | null>) | null
  /** Where the player is, in seconds, when this is what it plays; else null. */
  startSec: number | null
  /** The library's scrub previews for it, when it has a file to make them from. */
  preview: PreviewSource | null
}

/** A local file's frames, through an object URL of its own. */
function fileMedia(file: File, name: string): FrameMedia {
  const url = URL.createObjectURL(file)
  // In the Android app a library file streams from the media server, another origin.
  return { url, name, cross: isNativeMediaUrl(url), release: () => URL.revokeObjectURL(url) }
}

/** A plugin-provided video's frames: from its stream, through the proxy when it needs headers. HLS has none to give. */
async function remoteMedia(entry: VideoEntry): Promise<FrameMedia | null> {
  const r = entry.remote
  if (!r || r.kind !== 'file')
    return null
  try {
    const url = r.headers ? await proxiedStream(r.url, r.headers, r.kind) : r.url
    return { url, name: entry.name, cross: true }
  }
  catch {
    return null
  }
}

interface RawAxis { channel: string, label: string, actions: Action[] }

/** One axis per channel, in the device's order, the stroke first. */
function orderAxes(list: RawAxis[]): CardAxis[] {
  const seen = new Set<string>()
  const out = list.filter((a) => {
    if (seen.has(a.channel) || a.actions.length < 2)
      return false
    seen.add(a.channel)
    return true
  })
  const rank = (c: string) => {
    const i = AXIS_PRIORITY.indexOf(c)
    return i < 0 ? AXIS_PRIORITY.length : i
  }
  return out.sort((a, b) => rank(a.channel) - rank(b.channel)).map(a => ({ name: a.label.toLowerCase(), actions: a.actions }))
}

function chaptersOf(axes: CardAxis[], metadata: unknown, durationMs: number): CardChapter[] {
  const main = axes[0]
  if (!main)
    return []
  return authorChapters(main.actions, metadata, { durationMs })
    .filter(c => c.name && c.name !== GAP_NAME)
    .map(c => ({ name: c.name, start: c.start, end: c.end }))
}

async function metadataOf(file: File | undefined): Promise<Record<string, unknown> | null> {
  if (!file)
    return null
  try {
    const raw = JSON.parse(await file.text())
    return raw && typeof raw.metadata === 'object' ? raw.metadata : null
  }
  catch {
    return null
  }
}

export async function loadCardSource(target: ShareCardTarget): Promise<CardSource | null> {
  return target.kind === 'entry' ? fromEntry(target.entry) : fromLoaded()
}

async function fromLoaded(): Promise<CardSource | null> {
  const scripts = useScriptStore()
  const playback = usePlaybackStore()
  const player = usePlayerStore()
  const active = scripts.activeScripts
  if (!active.length)
    return null
  const axes = orderAxes(active.map((s) => {
    const src = sourceOf(s)
    return { channel: s.channel, label: src.label || s.label, actions: src.actions }
  }))
  const main = active.find(s => s.channel === 'L0') ?? active[0]
  const metadata = playback.scriptMetadata ?? await metadataOf(main.file)
  const durationMs = (player.videoDuration || 0) * 1000
  const video = playback.currentFile
  const videoName = playback.currentEntry?.name ?? video?.name ?? main.filename
  return {
    title: titleFromName(videoName),
    creator: creatorOf(metadata),
    durationMs,
    axes,
    chapters: chaptersOf(axes, metadata, durationMs),
    video,
    videoName,
    media: async () => {
      if (video)
        return fileMedia(video, videoName)
      const entry = playback.currentEntry
      if (entry?.remote)
        return remoteMedia(entry)
      // A stream: the same address in an element of our own, if it is a plain file.
      const url = player.videoUrl
      if (!url || player.videoKind !== 'file' || player.audioOnly)
        return null
      return { url, name: videoName, cross: !url.startsWith('blob:') && !url.startsWith(location.origin) }
    },
    playerFrame: async () => {
      const url = playback.grabFrame(1600, 0.92)
      return url ? picFromUrl(url) : null
    },
    startSec: player.currentTime > 0 ? player.currentTime : null,
    preview: video && playback.currentEntry && !playback.currentEntry.remote ? playback.currentEntry : null,
  }
}

async function fromEntry(entry: VideoEntry): Promise<CardSource | null> {
  const matches = entry.scriptMatches.filter(m => !m.isAlt)
  const raw: RawAxis[] = []
  let metadata: Record<string, unknown> | null = null
  for (const m of matches.length ? matches : entry.scriptMatches.slice(0, 1)) {
    try {
      const text = await m.file.text()
      const parsed = parseFunscriptContent(text, m.file.name, entry.name, m.suffix)
      for (const a of parsed.axes)
        raw.push({ channel: a.channel, label: a.label, actions: a.actions })
      // The main script's metadata names the creator and the chapters.
      const j = JSON.parse(text)
      if (j && typeof j.metadata === 'object' && (!metadata || parsed.axes.some(a => a.channel === 'L0')))
        metadata = j.metadata
    }
    catch {}
  }
  const axes = orderAxes(raw)
  if (!axes.length)
    return null
  const durationMs = (entry.duration ?? 0) * 1000
  return {
    title: titleFromName(entry.name),
    creator: creatorOf(metadata),
    durationMs,
    axes,
    chapters: chaptersOf(axes, metadata, durationMs),
    video: entry.remote ? null : entry.file,
    videoName: entry.name,
    media: async () => {
      if (entry.kind === 'audio' || isAudioName(entry.name))
        return null
      return entry.remote ? remoteMedia(entry) : fileMedia(entry.file, entry.name)
    },
    playerFrame: null,
    startSec: null,
    preview: entry.remote || entry.kind === 'audio' ? null : entry,
  }
}
