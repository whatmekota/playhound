/**
 * The chapter index: every scripted video in the library cut into chapters,
 * each with how hard it goes, kept in IndexedDB so a programme can build a
 * highlight reel out of videos it has never loaded.
 *
 * A record also keeps what the reel planner needs to cut cleanly without the
 * script in memory: the script's stroke bottoms and pauses (places where the
 * device is low or still, so a switch to another clip does not lurch it) and
 * a coarse speed curve (so a long chapter can be trimmed to its best part).
 *
 * Building is lazy and polite, like the scrub previews: one script per idle
 * slice, never while a video is loading, cancellable, and every result is
 * cached by the script file's name, size and mtime — a changed script is
 * simply indexed again.
 *
 * `indexScript` is pure and tested; the rest is a small background queue.
 */
import type { ChapterKind } from './chapters'
import type { Action } from './funscriptAnalysis'
import { reactive, ref } from 'vue'
import { authorChapters, buildChapters } from './chapters'
import { detectPeaks } from './funscriptAnalysis'
import { parseFunscriptContent } from './funscriptParser'
import { chapterIndexDb } from './idb'
import { meanSpeedToIntensity } from './scriptIntensity'
import { whenIdle } from './thumbs'

/** Bump when the record shape or the analysis changes; older records are redone. */
export const INDEX_FORMAT = 1
/** Resolution of the stored speed curve. */
export const CURVE_MS = 5000
/** A gap between two actions at least this long is a pause: the device is still. */
const PAUSE_MS = 1200
/** Stroke bottoms shallower than this are wobble, not somewhere to cut. */
const TROUGH_PROMINENCE = 0.1

export interface IndexedChapter {
  /** ms */
  start: number
  /** ms */
  end: number
  /** 0–1 on the library calibration (`meanSpeedToIntensity`). */
  intensity: number
  /** Mean movement, position-units per second. */
  speed: number
  spm: number
  kind: ChapterKind
  name: string
  source: 'auto' | 'author'
}

export interface ChapterIndexRecord {
  v: number
  /** The video's file name, the library's key for an entry. */
  video: string
  /** Length of the script (or the video, when known), ms. */
  durationMs: number
  chapters: IndexedChapter[]
  /** Safe cut points, ms, sorted: stroke bottoms and the start of pauses. */
  cuts: number[]
  /** Mean movement per second in CURVE_MS slices, units/s. */
  curve: number[]
  /** From the script's metadata, when it says. */
  creator: string | null
  tags: string[]
  /** When it was built, ms epoch. */
  at: number
}

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places

/** Movement per second in `binMs` slices. */
export function speedCurve(actions: Action[], binMs: number, durationMs: number): number[] {
  const bins = Math.max(1, Math.ceil(durationMs / binMs))
  const out = Array.from<number>({ length: bins }).fill(0)
  for (let i = 0; i < actions.length - 1; i++) {
    const a = actions[i]
    const b = actions[i + 1]
    const d = Math.abs(b.pos - a.pos)
    if (!d)
      continue
    const t0 = Math.max(0, a.at)
    const t1 = Math.max(t0, b.at)
    if (t1 === t0) {
      const k = Math.min(bins - 1, Math.floor(t0 / binMs))
      out[k] += d
      continue
    }
    const last = Math.min(bins - 1, Math.floor((t1 - 1) / binMs))
    for (let k = Math.floor(t0 / binMs); k <= last; k++) {
      const s = Math.max(t0, k * binMs)
      const e = Math.min(t1, (k + 1) * binMs)
      if (e > s)
        out[k] += d * (e - s) / (t1 - t0)
    }
  }
  return out.map(v => round(v / (binMs / 1000)))
}

/**
 * Where a cut is kind to the device: the bottom of each stroke, and the start
 * of every pause. Cutting from one clip's stroke bottom into another's means
 * both sides are low, so the switch is a short move rather than a lurch.
 */
export function cutPoints(actions: Action[]): number[] {
  const troughs = detectPeaks(actions.map(a => ({ at: a.at, pos: 1 - a.pos })), TROUGH_PROMINENCE).map(p => Math.round(p.at))
  const pauses: number[] = []
  for (let i = 0; i < actions.length - 1; i++) {
    if (actions[i + 1].at - actions[i].at >= PAUSE_MS)
      pauses.push(Math.round(actions[i].at))
  }
  const all = [...troughs, ...pauses].sort((a, b) => a - b)
  return all.filter((v, i) => i === 0 || v - all[i - 1] >= 50)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null
}

/** Creator and tags from a funscript `metadata` block, in either of the spellings in the wild. */
export function metaCredits(metadata: unknown): { creator: string | null, tags: string[] } {
  const m = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>
  const rawTags = Array.isArray(m.tags) ? m.tags : Array.isArray(m.topic_tags) ? m.topic_tags : []
  return {
    creator: str(m.creator) ?? str(m.topic_creator) ?? str(m.script_author),
    tags: [...new Set(rawTags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim().toLowerCase()))].slice(0, 24),
  }
}

/**
 * Everything the index keeps about one script: author chapters when it has
 * them, detected ones otherwise, each rated on the library calibration.
 */
export function indexScript(
  actions: Action[],
  metadata: unknown = null,
  durationMs = 0,
): Omit<ChapterIndexRecord, 'v' | 'video' | 'at'> {
  const length = Math.max(durationMs, actions.length ? actions[actions.length - 1].at : 0)
  const peaks = detectPeaks(actions)
  let chapters = authorChapters(actions, metadata, { durationMs: length, peaks })
  if (!chapters.length)
    chapters = buildChapters(actions, { durationMs: length, peaks })
  const credits = metaCredits(metadata)
  return {
    durationMs: Math.round(length),
    chapters: chapters.map(c => ({
      start: Math.round(c.start),
      end: Math.round(c.end),
      intensity: round(meanSpeedToIntensity(c.avgSpeed)),
      speed: round(c.avgSpeed),
      spm: Math.round(c.avgSpm),
      kind: c.kind,
      name: c.name,
      source: c.source,
    })),
    cuts: cutPoints(actions),
    curve: speedCurve(actions, CURVE_MS, length),
    ...credits,
  }
}

// ─── The index ────────────────────────────────────────────────────────────────

/** What the index needs from a library video. A VideoEntry adapts to it. */
export interface IndexSource {
  /** The video's file name. */
  name: string
  /** Its main script. */
  script: File
  /** Video length in seconds, when known. */
  duration?: number | null
}

export function indexKey(script: File): string {
  return `${script.name}|${script.size}|${script.lastModified}`
}

const records = new Map<string, ChapterIndexRecord>()
/** Bumped as records arrive (in batches), so computed pools recompute. */
export const indexRevision = ref(0)
export const indexState = reactive({
  /** The cache has been read from disk. */
  loaded: false,
  running: false,
  done: 0,
  total: 0,
  /** Scripts that could not be read or had nothing to cut. */
  failed: 0,
})

let loading: Promise<void> | null = null
let cancelled = false
const unusable = new Set<string>()

/** Read every cached record into memory once. */
export function loadIndex(): Promise<void> {
  loading ??= chapterIndexDb.all()
    .then((all) => {
      for (const [k, v] of all) {
        const r = v as ChapterIndexRecord | undefined
        if (r && r.v === INDEX_FORMAT && Array.isArray(r.chapters))
          records.set(k, r)
      }
    })
    .catch(() => {})
    .finally(() => {
      indexState.loaded = true
      indexRevision.value++
    })
  return loading
}

export function indexRecord(script: File | null | undefined): ChapterIndexRecord | null {
  return script ? records.get(indexKey(script)) ?? null : null
}

export function isIndexed(script: File): boolean {
  const k = indexKey(script)
  return records.has(k) || unusable.has(k)
}

/** Index one script now. Null when it cannot be read or has no shape. */
export async function indexOne(src: IndexSource): Promise<ChapterIndexRecord | null> {
  const key = indexKey(src.script)
  const hit = records.get(key)
  if (hit)
    return hit
  try {
    const parsed = parseFunscriptContent(await src.script.text(), src.script.name, src.name)
    const axis = parsed.axes.find(a => a.channel === 'L0') ?? parsed.axes[0]
    if (!axis || axis.actions.length < 8) {
      unusable.add(key)
      return null
    }
    const rec: ChapterIndexRecord = {
      v: INDEX_FORMAT,
      video: src.name,
      at: Date.now(),
      ...indexScript(axis.actions, parsed.rawMetadata ?? null, (src.duration ?? 0) * 1000),
    }
    records.set(key, rec)
    void chapterIndexDb.set(key, rec).catch(() => {})
    return rec
  }
  catch {
    unusable.add(key)
    return null
  }
}

/**
 * Index everything in `sources` that is not indexed yet, one script per idle
 * slice. `busy` is asked before each one; while it says yes (a video is
 * loading) the build waits. Resolves when done or cancelled.
 */
export async function buildIndex(sources: IndexSource[], busy: () => boolean = () => false): Promise<void> {
  await loadIndex()
  if (indexState.running)
    return
  const todo = sources.filter(s => !isIndexed(s.script))
  // Done counts what is already there, so progress reads "312 / 631 videos".
  indexState.total = sources.length
  indexState.done = sources.length - todo.length
  if (!todo.length)
    return
  indexState.running = true
  cancelled = false
  let sinceBump = 0
  try {
    for (const src of todo) {
      if (cancelled)
        break
      await whenIdle(1000)
      // Never compete with a video that is loading.
      for (let waited = 0; busy() && !isCancelled() && waited < 150; waited++)
        await new Promise(r => setTimeout(r, 400))
      if (cancelled)
        break
      const rec = await indexOne(src)
      if (!rec)
        indexState.failed++
      indexState.done++
      // Recomputing pools after every script would cost more than indexing it.
      if (++sinceBump >= 20) {
        sinceBump = 0
        indexRevision.value++
      }
    }
  }
  finally {
    indexState.running = false
    indexRevision.value++
  }
}

export function cancelIndex() {
  cancelled = true
}

function isCancelled() {
  return cancelled
}

/** Forget everything (for a rebuild). */
export async function clearIndex() {
  cancelIndex()
  records.clear()
  unusable.clear()
  indexState.done = 0
  indexState.failed = 0
  indexRevision.value++
  await chapterIndexDb.clear().catch(() => {})
}
