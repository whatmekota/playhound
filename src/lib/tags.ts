/**
 * Library tags: the ones you add, and the ones worked out from the video and
 * its script.
 *
 * Manual tags live in each video's saved info (the `vidmeta` store, keyed by
 * file name like stars and stats), so a rescan finds them again. Tags from a
 * script's own metadata count as manual: they can be removed like any other.
 * Automatic tags are never stored; they are derived again whenever they are
 * asked for, so they follow the script when it changes.
 *
 * Tags are case-insensitive: everything is trimmed and lower-cased on the
 * way in, and lists are deduplicated, so "VR", " vr" and "vr" are one tag.
 *
 * Vue-free so it is unit tested directly.
 */
import type { ScriptSummary } from './idb'
import type { VideoEntry } from '~/stores/libraryStore'
import { BANDS, intensityBand, speedUnits } from './scriptIntensity'
import { guessVrFormat, looksSbs } from './vrFormat'

export const MAX_TAG_LENGTH = 40

/** One tag as stored and compared: lower case, single spaces, no commas or quotes. */
export function normalizeTag(raw: string): string {
  return raw
    .replace(/[",\s]+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .slice(0, MAX_TAG_LENGTH)
    .trim()
}

/** Normalised and deduplicated, first spelling first. Anything that is not a string is dropped. */
export function normalizeTags(list: readonly unknown[] | null | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list ?? []) {
    if (typeof raw !== 'string')
      continue
    const t = normalizeTag(raw)
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** What someone typed into a tag box: commas separate tags. */
export function splitTagInput(text: string): string[] {
  return normalizeTags(text.split(','))
}

/** `tags` with `add` added and `remove` taken out. */
export function editTagList(tags: readonly unknown[] | undefined, add: readonly string[] = [], remove: readonly string[] = []): string[] {
  const gone = new Set(normalizeTags(remove))
  return normalizeTags([...(tags ?? []), ...add]).filter(t => !gone.has(t))
}

type TagSource = Pick<VideoEntry, 'scriptMeta' | 'userMeta'>

/** The tags someone gave a video (or its script's metadata did). Saved info wins over the script's. */
export function manualTags(entry: TagSource): string[] {
  return normalizeTags(entry.userMeta?.tags ?? entry.scriptMeta?.tags)
}

// ─── Automatic tags ─────────────────────────────────────────────────────────

export type AutoTagGroup = 'intensity' | 'pace' | 'length' | 'script' | 'format'

export interface AutoTagDef {
  tag: string
  group: AutoTagGroup
  /** What it means, for a tooltip. */
  hint: string
  /**
   * Worth a spot on a library card. Intensity, multi-axis and no script
   * already have their own marks there (the meter, the axis badge, the
   * "No script" line), so repeating them as tags would only crowd it.
   */
  onCard: boolean
}

/**
 * Stroke-rate edges, in strokes a minute averaged over the whole script.
 * Calibrated on a real library of ~700 scripts: the bottom fifth sits under
 * 100 and the top quarter over 180, with the median near 130.
 */
export const PACE_SLOW_SPM = 100
export const PACE_FAST_SPM = 180

/** Length edges in seconds. */
export const SHORT_SECS = 5 * 60
export const LONG_SECS = 20 * 60

const band = (key: string) => BANDS.find(b => b.key === key)!

export const AUTO_TAGS: readonly AutoTagDef[] = [
  { tag: 'gentle', group: 'intensity', hint: `Average speed under ${speedUnits(band('gentle').max)} units/s`, onCard: false },
  { tag: 'medium', group: 'intensity', hint: `Average speed ${speedUnits(band('medium').min)} to ${speedUnits(band('medium').max)} units/s`, onCard: false },
  { tag: 'intense', group: 'intensity', hint: `Average speed over ${speedUnits(band('intense').min)} units/s`, onCard: false },
  { tag: 'slow', group: 'pace', hint: `Under ${PACE_SLOW_SPM} strokes a minute on average`, onCard: true },
  { tag: 'fast', group: 'pace', hint: `${PACE_FAST_SPM} or more strokes a minute on average`, onCard: true },
  { tag: 'short', group: 'length', hint: `Under ${SHORT_SECS / 60} minutes`, onCard: true },
  { tag: 'long', group: 'length', hint: `${LONG_SECS / 60} minutes or more`, onCard: true },
  { tag: 'multi-axis', group: 'script', hint: 'Scripts for more than one axis', onCard: false },
  { tag: 'unscripted', group: 'script', hint: 'No script found next to the video', onCard: false },
  { tag: 'vr', group: 'format', hint: 'The file or folder name says VR', onCard: true },
  { tag: 'audio', group: 'format', hint: 'An audio file with a script, no picture', onCard: false },
]

const AUTO_BY_TAG = new Map(AUTO_TAGS.map(d => [d.tag, d]))

export function autoTagDef(tag: string): AutoTagDef | undefined {
  return AUTO_BY_TAG.get(tag)
}

/** Tags that can only be known once the script has been analysed. */
export function needsSummary(tag: string): boolean {
  const g = AUTO_BY_TAG.get(tag)?.group
  return g === 'intensity' || g === 'pace'
}

/** VR by name: a studio's format marker (`_180_LR`, `MKX200`), or "VR" as a word in the file or folder name. */
export function looksVr(entry: Pick<VideoEntry, 'name' | 'path'>): boolean {
  if (guessVrFormat(entry.name))
    return true
  return /(?:^|[^a-z0-9])vr(?:[^a-z0-9]|$)/i.test(entry.path || entry.name)
}

/**
 * A VR video: its name says so (looksVr), someone tagged it "vr" (a whole
 * folder at once from the library's selection), or its picture is side by
 * side once its size is known.
 */
export function isVrVideo(entry: Pick<VideoEntry, 'name' | 'path' | 'kind' | 'width' | 'height' | 'scriptMeta' | 'userMeta'>): boolean {
  if (entry.kind === 'audio')
    return false
  if (looksVr(entry) || manualTags(entry).includes('vr'))
    return true
  return !!(entry.width && entry.height && looksSbs(entry.name, entry.width, entry.height))
}

type AutoSource = Pick<VideoEntry, 'name' | 'path' | 'hasScript' | 'scriptCount' | 'scriptType' | 'duration' | 'kind'>

/**
 * The automatic tags for one video, in AUTO_TAGS order. `summary` is its
 * script analysis, when there is one yet; without it the intensity and pace
 * tags are simply missing rather than guessed.
 */
export function autoTags(entry: AutoSource, summary?: ScriptSummary | null): string[] {
  const out: string[] = []
  const s = entry.hasScript ? summary : null
  if (s) {
    out.push(intensityBand(s.meanSpeed))
    if (s.meanSpm < PACE_SLOW_SPM)
      out.push('slow')
    else if (s.meanSpm >= PACE_FAST_SPM)
      out.push('fast')
  }
  // The video's own length once known; until then the script's is close enough.
  const secs = entry.duration ?? (s ? s.durationMs / 1000 : null)
  if (secs && secs > 0) {
    if (secs < SHORT_SECS)
      out.push('short')
    else if (secs >= LONG_SECS)
      out.push('long')
  }
  if (entry.hasScript && (entry.scriptCount > 1 || entry.scriptType === 'merged'))
    out.push('multi-axis')
  if (!entry.hasScript)
    out.push('unscripted')
  if (entry.kind === 'audio')
    out.push('audio')
  else if (looksVr(entry))
    out.push('vr')
  return out
}

export type SummaryLookup = (name: string) => ScriptSummary | null | undefined

export function summaryFor(entry: Pick<VideoEntry, 'name' | 'hasScript'>, summaryOf?: SummaryLookup): ScriptSummary | null {
  return entry.hasScript && summaryOf ? summaryOf(entry.name) ?? null : null
}

/** Every tag a video has, manual and automatic, for matching. */
export function tagSet(entry: TagSource & AutoSource, summary?: ScriptSummary | null): Set<string> {
  return new Set([...manualTags(entry), ...autoTags(entry, summary)])
}

export interface ShownTag {
  tag: string
  auto: boolean
}

/**
 * Tags to show for one video: manual first, then the automatic ones it does
 * not already have by hand. `onCardOnly` keeps to the automatic tags a card
 * has no other mark for.
 */
export function shownTags(
  entry: TagSource & AutoSource,
  summary: ScriptSummary | null | undefined,
  opts: { auto: boolean, onCardOnly?: boolean },
): ShownTag[] {
  const manual = manualTags(entry)
  const out: ShownTag[] = manual.map(tag => ({ tag, auto: false }))
  if (!opts.auto)
    return out
  for (const tag of autoTags(entry, summary)) {
    if (manual.includes(tag))
      continue
    if (opts.onCardOnly && !AUTO_BY_TAG.get(tag)?.onCard)
      continue
    out.push({ tag, auto: true })
  }
  return out
}

export interface TagCount {
  tag: string
  count: number
  /** Only ever automatic here: nobody has added it by hand. */
  auto: boolean
}

/**
 * Every tag in the library with how many videos have it: manual tags by
 * count, then the automatic ones in their fixed order.
 */
export function tagCounts(videos: readonly (TagSource & AutoSource)[], opts: { auto: boolean, summaryOf?: SummaryLookup }): TagCount[] {
  const manual = new Map<string, number>()
  const auto = new Map<string, number>()
  for (const v of videos) {
    const own = manualTags(v)
    for (const t of own)
      manual.set(t, (manual.get(t) ?? 0) + 1)
    if (!opts.auto)
      continue
    for (const t of autoTags(v, summaryFor(v, opts.summaryOf))) {
      if (!own.includes(t))
        auto.set(t, (auto.get(t) ?? 0) + 1)
    }
  }
  const out: TagCount[] = [...manual]
    .map(([tag, count]) => ({ tag, count: count + (auto.get(tag) ?? 0), auto: false }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  for (const d of AUTO_TAGS) {
    const n = auto.get(d.tag)
    if (n && !manual.has(d.tag))
      out.push({ tag: d.tag, count: n, auto: true })
  }
  return out
}

// ─── Search syntax ──────────────────────────────────────────────────────────

export interface ParsedSearch {
  /** What is left to match against names, creators and tags; trimmed and lower-cased. */
  text: string
  /** `tag:name`: must have every one of these. */
  include: string[]
  /** `-tag:name`: must have none of these. */
  exclude: string[]
}

// `tag:` or `-tag:` at a word start, then a quoted name (for one with a
// space) or a bare word. An unclosed quote runs to the end, so typing
// `tag:"no sc` already narrows the list.
const TAG_TOKEN = /(^|\s)(-?)tag:(?:"([^"]*)"?|(\S*))/gi
// `type:audio` and `type:video`, said the way people search for a kind of
// file. Audio is the automatic `audio` tag, so a video is anything without it.
const TYPE_TOKEN = /(^|\s)(-?)type:(\S*)/gi

/** Pull `tag:name`, `-tag:name` and `type:audio|video` out of a search box's text. */
export function parseSearch(raw: string): ParsedSearch {
  const include: string[] = []
  const exclude: string[] = []
  const rest = raw.replace(TAG_TOKEN, (_m, lead: string, neg: string, quoted?: string, bare?: string) => {
    const t = normalizeTag(quoted ?? bare ?? '')
    if (t)
      (neg ? exclude : include).push(t)
    return lead
  }).replace(TYPE_TOKEN, (m, lead: string, neg: string, kind: string) => {
    const k = kind.toLowerCase()
    if (k !== 'audio' && k !== 'video') {
      return k ? m : lead
      // "-type:video" is audio; "-type:audio" is video.
    }((k === 'audio') === !neg ? include : exclude).push('audio')
    return lead
  })
  return {
    text: rest.replace(/\s+/g, ' ').trim().toLowerCase(),
    include: normalizeTags(include),
    exclude: normalizeTags(exclude),
  }
}

/** A tag as a search token, quoted when it has a space. */
export function tagToken(tag: string, exclude = false): string {
  return `${exclude ? '-' : ''}tag:${tag.includes(' ') ? `"${tag}"` : tag}`
}

// ─── Tags from a forum post ─────────────────────────────────────────────────

/**
 * Forum tags that name the hardware a script was made for. They say nothing
 * about the video, and every device here plays every script anyway.
 */
const DEVICE_TAGS = new Set([
  'handy',
  'the-handy',
  'thehandy',
  'handy-2',
  'osr',
  'osr2',
  'osr2+',
  'osr2-plus',
  'sr6',
  'sr1',
  'ssr1',
  'tcode',
  't-code',
  'keon',
  'kiiroo',
  'kiiroo-keon',
  'launch',
  'fleshlight-launch',
  'autoblow',
  'lovense',
  'vorze',
])

/** The forum's length buckets (`len-10-25`): the automatic short / long come from the real duration instead. */
const LENGTH_TAG = /^len-/

/** A post's tags (names or `{ name }` objects) as library tags, minus device and length tags. */
export function postTags(list: readonly unknown[] | null | undefined): string[] {
  const names = (list ?? []).map(t => (t && typeof t === 'object' ? (t as { name?: unknown }).name : t))
  return normalizeTags(names).filter(t => !DEVICE_TAGS.has(t) && !LENGTH_TAG.test(t))
}
