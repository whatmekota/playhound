import { AXIS_MAP } from '~/lib/axisMap'

/**
 * Which of a post's scripts go with which of its videos, and on which axis.
 *
 * Locally, scripts are matched to a video by file name. A post breaks that:
 * the video comes from a file host under whatever name the uploader gave it,
 * and most of the time it shares nothing with the scripts' names. Being in the
 * same post is the match. What is left to work out is the axis of each script,
 * judged against its siblings rather than the video, and, when one post holds
 * several videos, which set of scripts belongs to which.
 */

export interface PostScript {
  filename: string
  /** Base name shared by one video's scripts. */
  base: string
  /** Axis suffix for the parser: 'default' is the stroke script. */
  suffix: string
}

const AXIS_WORDS = Object.keys(AXIS_MAP).filter(k => k !== 'default')
// `Song.roll`, `Song_twist`, `Song - R1`, `Song (pitch)`, `Song [L0]`
const AXIS_TAIL = new RegExp(`^(.*?)(?:[\\s._\\-]+[([]?|[([])(${AXIS_WORDS.join('|')})[)\\]]?$`, 'i')

const stem = (filename: string) => filename.replace(/\.funscript$/i, '').trim()

/** Group a post's scripts by video and give each its axis. */
export function classifyPostScripts(filenames: string[]): PostScript[] {
  const stems = filenames.map(stem)
  return filenames.map((filename, i) => {
    const s = stems[i]
    // A sibling whose whole name starts this one is the base: `Song` and
    // `Song.alt`. Longest wins, so `Song.v2` beats `Song` for `Song.v2.roll`.
    let base = ''
    for (const other of stems) {
      if (other !== s && other.length > base.length && s.toLowerCase().startsWith(`${other.toLowerCase()}.`))
        base = other
    }
    if (base)
      return { filename, base, suffix: s.slice(base.length + 1) }
    const m = AXIS_TAIL.exec(s)
    if (m && m[1].trim())
      return { filename, base: m[1].trim(), suffix: m[2].toLowerCase() }
    return { filename, base: s, suffix: 'default' }
  })
}

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2))

/** Words in a file name that say nothing about which video it is. */
const NOISE = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'wmv', '480p', '720p', '1080p', '1440p', '2160p', '4k', '60fps', 'funscript'])
const nameWords = (s: string) => new Set([...tokens(s)].filter(t => !NOISE.has(t)))

/** Shared words over all the words of both: `rem hj full` is closer to `rem` than to `rem oni`. */
function likeness(a: Set<string>, b: Set<string>) {
  let shared = 0
  for (const t of a) {
    if (b.has(t))
      shared++
  }
  const all = a.size + b.size - shared
  return all ? shared / all : 0
}

/** The one video a set of scripts is clearly closest to by name, or -1 on no match or a tie. */
function closestVideo(base: string, titles: string[]): number {
  const words = nameWords(base)
  const scores = titles.map(t => likeness(words, nameWords(t)))
  const best = Math.max(...scores)
  return best > 0 && scores.filter(s => s === best).length === 1 ? scores.indexOf(best) : -1
}

/**
 * The scripts to load with one video of a post.
 *
 * One set of scripts (the usual case): all of them, whatever the names. Several
 * sets, with the names of all the post's videos known: every set goes to the
 * video whose name it is closest to, so `rem.mp4` gets `rem hj` and `rem hj
 * full` while `rem(oni).mp4` gets `rem(oni) hj`. Otherwise the set sharing the
 * most words with this video's name, then the one in the same position when
 * the post lists as many sets as videos, and failing all that everything,
 * stroke scripts first, so the player picks one and the rest wait in the
 * Scripts panel as alternatives.
 */
export function scriptsForVideo(scripts: PostScript[], video: { title?: string, index?: number, count?: number, titles?: string[] } = {}): PostScript[] {
  const order = (list: PostScript[]) => [...list].sort((a, b) => Number(b.suffix === 'default') - Number(a.suffix === 'default'))
  const bases: string[] = []
  for (const s of scripts) {
    if (!bases.some(b => b.toLowerCase() === s.base.toLowerCase()))
      bases.push(s.base)
  }
  if (bases.length <= 1)
    return order(scripts)

  const of = (base: string) => scripts.filter(s => s.base.toLowerCase() === base.toLowerCase())
  if (video.titles && video.titles.length > 1 && video.index !== undefined) {
    const mine = bases.filter(base => closestVideo(base, video.titles!) === video.index)
    if (mine.length)
      return order(mine.flatMap(of))
  }
  if (video.title) {
    const want = tokens(video.title)
    const scored = bases.map((base) => {
      const have = tokens(base)
      let shared = 0
      for (const t of have) {
        if (want.has(t))
          shared++
      }
      return { base, score: have.size ? shared / have.size : 0 }
    }).sort((a, b) => b.score - a.score)
    if (scored[0].score > 0 && scored[0].score > scored[1].score)
      return order(of(scored[0].base))
  }
  if (video.count === bases.length && video.index !== undefined && bases[video.index])
    return order(of(bases[video.index]))
  return order(scripts)
}

/** How alike a folder's video has to be to the scripts' names before it is picked for you. */
const PICK_AT_LEAST = 0.34

/**
 * The video of a folder that goes with these scripts, by name: the one most
 * like any of them, when it clearly is (a big folder of a creator's uploads
 * holds the post's video somewhere among dozens). -1 when nothing stands out.
 */
export function pickVideo(titles: string[], scriptNames: string[]): number {
  if (titles.length < 2 || !scriptNames.length)
    return -1
  const wanted = scriptNames.map(n => nameWords(n.replace(/\.funscript$/i, '')))
  const scores = titles.map((t) => {
    const words = nameWords(t)
    return Math.max(...wanted.map(w => likeness(w, words)))
  })
  const best = Math.max(...scores)
  return best >= PICK_AT_LEAST && scores.filter(s => s === best).length === 1 ? scores.indexOf(best) : -1
}
