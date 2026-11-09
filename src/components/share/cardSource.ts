import type { CardAxis, Pic } from './drawCard'
import type { Action } from '~/lib/funscriptAnalysis'
import type { CardChapter } from '~/lib/shareCard'
import type { VideoEntry } from '~/stores/libraryStore'
import type { ShareCardTarget } from '~/stores/uiStore'
import { AXIS_PRIORITY } from '~/lib/axisMap'
import { authorChapters, GAP_NAME } from '~/lib/chapters'
import { parseFunscriptContent } from '~/lib/funscriptParser'
import { creatorOf, titleFromName } from '~/lib/shareCard'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlayerStore } from '~/stores/playerStore'
import { sourceOf, useScriptStore } from '~/stores/scriptStore'
import { frameFromFile, picFromUrl } from './cardAssets'

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
  /** A frame for the background, fetched only when asked for. */
  frame: () => Promise<Pic | null>
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
    frame: async () => {
      const url = playback.grabFrame(1600, 0.92)
      return url ? picFromUrl(url) : null
    },
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
    video: entry.file,
    videoName: entry.name,
    frame: () => frameFromFile(entry.file, Math.max(1, (entry.duration ?? 60) * 0.35)),
  }
}
