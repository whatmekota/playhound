/**
 * Subtitles: finding them next to a video, reading them, and turning them
 * into WebVTT for a <track>.
 *
 * SRT is what people actually have, and it comes in every state: a BOM,
 * Windows line endings, periods instead of commas, cue numbers missing or
 * run together, ASS override tags like {\an8} left in by a converter. The
 * parser takes all of it. WebVTT files go through the same parser, so what
 * reaches the <track> is always clean WebVTT written here. ASS/SSA is cut
 * down to its dialogue as plain text: no styling, no positioning.
 */

export interface Cue {
  /** Seconds. */
  start: number
  end: number
  /** May hold <i>, <b> and <u>; lines split by \n. */
  text: string
}

export const SUBTITLE_EXT = /\.(?:srt|vtt|ass|ssa)$/i

export function isSubtitleName(name: string) {
  return SUBTITLE_EXT.test(name)
}

// ─── Reading the bytes ───────────────────────────────────────────────────────

/**
 * Text from a subtitle file's bytes. Most are UTF-8, but older SRTs are often
 * in the system code page, which a strict UTF-8 read rejects; Windows-1252
 * is the likeliest one for the Latin scripts those files are usually in.
 */
export function decodeSubtitle(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes[0] === 0xFF && bytes[1] === 0xFE)
    return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xFE && bytes[1] === 0xFF)
    return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const TS = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.:](\d{1,3}))?`
const TIMING = new RegExp(String.raw`^\s*${TS}\s*-+>\s*${TS}`)

function seconds(h: string | undefined, m: string, s: string, frac: string | undefined) {
  // "1,5" is half a second, not five milliseconds.
  const f = frac ? Number(`0.${frac}`) : 0
  return (Number(h ?? 0) * 3600) + Number(m) * 60 + Number(s) + f
}

/** Cleans one cue's text: what a <track> can show, and nothing it cannot. */
export function cleanCueText(raw: string): string {
  return raw
    // ASS override blocks some converters leave in: {\an8}, {\i1}, {\pos(…)}.
    .replace(/\{\\[^}]*\}/g, '')
    // <font color=…> wraps text in a lot of fan-made SRTs; the text stays.
    .replace(/<\/?font[^>]*>/gi, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * SRT and WebVTT, leniently. Cues are found by their timing line, so missing
 * numbers, missing blank lines and stray headers do not matter.
 */
export function parseSrt(text: string): Cue[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const cues: Cue[] = []
  let i = 0
  while (i < lines.length) {
    const m = TIMING.exec(lines[i])
    if (!m) {
      i++
      continue
    }
    const start = seconds(m[1], m[2], m[3], m[4])
    const end = seconds(m[5], m[6], m[7], m[8])
    i++
    const body: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !TIMING.test(lines[i])) {
      body.push(lines[i])
      i++
    }
    // Run-together cues: the next cue's number got read as this one's text.
    if (i < lines.length && TIMING.test(lines[i]) && body.length && /^\d+$/.test(body.at(-1)!.trim()))
      body.pop()
    const t = cleanCueText(body.join('\n'))
    if (t && end > start)
      cues.push({ start, end, text: t })
  }
  return cues.sort((a, b) => a.start - b.start)
}

function assTime(v: string): number | null {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(v)
  return m ? seconds(m[1], m[2], m[3], m[4]) : null
}

/**
 * ASS/SSA dialogue as plain text. Override blocks are dropped, \N becomes a
 * line break, and vector drawings (\p1…) are skipped: their "text" is path
 * commands. Effects stacked as copies of one line collapse to one cue.
 */
export function parseAss(text: string): Cue[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let inEvents = false
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  const cues: Cue[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('[')) {
      inEvents = t.toLowerCase() === '[events]'
      continue
    }
    if (!inEvents)
      continue
    const colon = t.indexOf(':')
    if (colon < 0)
      continue
    const kind = t.slice(0, colon).trim().toLowerCase()
    const rest = t.slice(colon + 1).trim()
    if (kind === 'format') {
      fields = rest.split(',').map(f => f.trim().toLowerCase())
      continue
    }
    if (kind !== 'dialogue')
      continue
    // Text is always last and may itself hold commas.
    const parts = rest.split(',')
    const values = [...parts.slice(0, fields.length - 1), parts.slice(fields.length - 1).join(',')]
    const get = (f: string) => values[fields.indexOf(f)] ?? ''
    const start = assTime(get('start'))
    const end = assTime(get('end'))
    const raw = get('text')
    if (start === null || end === null || end <= start || /\{[^}]*\\p[1-9]/.test(raw))
      continue
    const body = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\h/g, ' ')
    const clean = cleanCueText(body)
    const key = `${start}|${end}|${clean}`
    if (!clean || seen.has(key))
      continue
    seen.add(key)
    cues.push({ start, end, text: clean })
  }
  return cues.sort((a, b) => a.start - b.start)
}

/** Any supported file's cues. */
export function parseSubtitle(text: string, fileName = ''): Cue[] {
  if (/\.(?:ass|ssa)$/i.test(fileName) || /^\s*\[Script Info\]/i.test(text))
    return parseAss(text)
  return parseSrt(text)
}

// ─── WebVTT out ──────────────────────────────────────────────────────────────

function vttTime(t: number) {
  const ms = Math.round(t * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`
}

/**
 * A tag: "<" then a letter, digit or "/" (so "1 < 2" stays text). Split
 * with it, the odd parts are the tags.
 */
const TAG = /(<\/?[a-z\d][^<>]*>)/i
const KEEP_TAG = /^<\/?[ibu]>$/i

/** Escapes what WebVTT would read as markup, keeping <i>, <b> and <u>. */
function vttText(text: string) {
  return text
    .split(TAG)
    .map((part, i) => {
      if (i % 2)
        return KEEP_TAG.test(part) ? part.toLowerCase() : ''
      return part.replace(/&(?!(?:amp|lt|gt|nbsp|lrm|rlm);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    })
    .join('')
    // "-->" ends a cue's timing line; inside text it is not allowed.
    .replace(/--&gt;/g, '→')
}

export function toVtt(cues: Cue[]): string {
  const blocks = cues.map(c => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${vttText(c.text)}`)
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

// ─── Showing a cue ───────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '‎', rlm: '‏' }

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A cue's WebVTT text as safe HTML for the overlay: <i>, <b> and <u> stay
 * (classes dropped), every other tag goes, the rest is escaped. Subtitle
 * files come from anywhere, so nothing in them reaches the page as markup.
 */
export function cueHtml(text: string): string {
  return text
    .split(TAG)
    .map((part, i) => {
      if (i % 2) {
        const m = /^<(\/?)([ibu])(?:[.\s][^>]*)?>$/i.exec(part)
        return m ? `<${m[1]}${m[2].toLowerCase()}>` : ''
      }
      return escapeHtml(part.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, e: string) => ENTITIES[e]))
    })
    .join('')
}

// ─── Finding them next to a video ────────────────────────────────────────────

interface Lang { code: string, name: string, aliases: string[] }

/** Languages subtitle files are commonly tagged with, by every name they go by. */
const LANGS: Lang[] = [
  ['en', 'English', 'eng english'],
  ['ja', 'Japanese', 'jpn jap japanese'],
  ['zh', 'Chinese', 'chi zho chs cht chinese'],
  ['ko', 'Korean', 'kor korean'],
  ['es', 'Spanish', 'spa spanish espanol español'],
  ['fr', 'French', 'fre fra french francais français'],
  ['de', 'German', 'ger deu german deutsch'],
  ['it', 'Italian', 'ita italian italiano'],
  ['pt', 'Portuguese', 'por portuguese portugues português'],
  ['ru', 'Russian', 'rus russian'],
  ['uk', 'Ukrainian', 'ukr ukrainian'],
  ['pl', 'Polish', 'pol polish polski'],
  ['nl', 'Dutch', 'dut nld dutch nederlands'],
  ['sv', 'Swedish', 'swe swedish'],
  ['no', 'Norwegian', 'nor nob nno norwegian'],
  ['da', 'Danish', 'dan danish'],
  ['fi', 'Finnish', 'fin finnish'],
  ['cs', 'Czech', 'cze ces czech'],
  ['hu', 'Hungarian', 'hun hungarian'],
  ['ro', 'Romanian', 'rum ron romanian'],
  ['el', 'Greek', 'gre ell greek'],
  ['tr', 'Turkish', 'tur turkish'],
  ['ar', 'Arabic', 'ara arabic'],
  ['he', 'Hebrew', 'heb hebrew'],
  ['hi', 'Hindi', 'hin hindi'],
  ['th', 'Thai', 'tha thai'],
  ['vi', 'Vietnamese', 'vie vietnamese'],
  ['id', 'Indonesian', 'ind indonesian'],
].map(([code, name, aliases]) => ({ code, name, aliases: aliases.split(' ') }))

const LANG_BY_TAG = new Map<string, Lang>()
for (const l of LANGS) {
  LANG_BY_TAG.set(l.code, l)
  for (const a of l.aliases)
    LANG_BY_TAG.set(a, l)
}

/** Tags that describe the track rather than its language. */
const FLAGS = new Set(['forced', 'sdh', 'cc', 'default', 'full', 'signs', 'songs', 'hearing'])

export interface SubtitleName {
  /** Everything after the video's name, e.g. "en.forced"; '' for none. */
  tag: string
  /** A two-letter code when the tag names a language. */
  lang: string | null
  /** "forced", "sdh"… */
  flags: string[]
}

/** The longest run of tag segments a subtitle name may add to the video's. */
const MAX_TAGS = 3
const SEGMENT = /^[\p{L}\p{N}_-]{1,24}$/u

function stemOf(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

/**
 * What a subtitle file's name adds to the name of the video it sits next to:
 * nothing, or a language and flags ("clip.en.srt", "clip.eng.forced.vtt").
 */
export function readTag(tag: string): SubtitleName {
  const parts = tag ? tag.split('.') : []
  let lang: string | null = null
  const flags: string[] = []
  for (const p of parts) {
    const k = p.toLowerCase()
    if (FLAGS.has(k)) {
      flags.push(k)
      continue
    }
    const l = LANG_BY_TAG.get(k) ?? LANG_BY_TAG.get(k.split(/[-_]/)[0])
    if (l && !lang)
      lang = l.code
  }
  return { tag, lang, flags }
}

/** "English", "English (forced)", or the file's name when the tag says nothing. */
export function subtitleLabel(name: SubtitleName, fileName: string): string {
  const lang = name.lang ? LANG_BY_TAG.get(name.lang)?.name ?? name.lang : null
  if (lang)
    return name.flags.length ? `${lang} (${name.flags.join(', ')})` : lang
  return fileName
}

export interface SubtitlePair<T> {
  /** Index into the videos given. */
  video: number
  file: T
  name: SubtitleName
}

/**
 * Which video each subtitle file belongs to, among files in one folder.
 *
 * A subtitle belongs to the video whose name it starts with, followed by at
 * most a few dot-separated tags. When two videos qualify ("clip" and
 * "clip.part2" both prefix "clip.part2.en.srt"), the longer name wins.
 */
export function pairSubtitles<T extends { name: string }>(videoNames: string[], subs: T[]): SubtitlePair<T>[] {
  const byStem = new Map<string, number>()
  videoNames.forEach((n, i) => byStem.set(stemOf(n).toLowerCase(), i))
  const out: SubtitlePair<T>[] = []
  for (const file of subs) {
    if (!isSubtitleName(file.name))
      continue
    const stem = stemOf(file.name)
    const segs = stem.split('.')
    for (let cut = 0; cut <= MAX_TAGS && cut < segs.length; cut++) {
      const tagParts = segs.slice(segs.length - cut)
      if (cut && !SEGMENT.test(tagParts[0]))
        break
      const base = segs.slice(0, segs.length - cut).join('.').toLowerCase()
      const v = byStem.get(base)
      if (v !== undefined) {
        out.push({ video: v, file, name: readTag(tagParts.join('.')) })
        break
      }
    }
  }
  return out
}

// ─── Choosing one ────────────────────────────────────────────────────────────

export interface TrackChoice {
  id: string
  lang: string | null
  flags?: string[]
}

/**
 * The track to show when a video loads: the preferred language when there is
 * one (a full track before a forced-only one), else the first.
 */
export function pickTrack<T extends TrackChoice>(tracks: T[], lang: string | null): T | null {
  if (!tracks.length)
    return null
  if (lang) {
    const same = tracks.filter(t => t.lang === lang)
    if (same.length)
      return same.find(t => !t.flags?.includes('forced')) ?? same[0]
  }
  return tracks[0]
}

/** Untagged first (it is usually the main one), then by label. */
export function sortTracks<T extends { lang: string | null, label: string }>(tracks: T[]): T[] {
  return [...tracks].sort((a, b) => (a.lang === null ? 0 : 1) - (b.lang === null ? 0 : 1) || a.label.localeCompare(b.label))
}
