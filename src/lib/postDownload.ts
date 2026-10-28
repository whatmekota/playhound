import type { PostScript } from '~/lib/postScripts'
import { sanitizeFilename } from '~/lib/fsRename'

/**
 * File names for saving a video from a post together with its scripts.
 *
 * The library pairs a video with its scripts by name (`Name.mp4`,
 * `Name.funscript`, `Name.roll.funscript`), and a post's files rarely share
 * one. So everything is saved under the video's name, each script keeping the
 * axis it was found to drive (see postScripts.ts).
 */

const VIDEO_EXT = /\.(?:mp4|m4v|webm|mkv|mov|avi|wmv|flv)$/i

/** A base name from a video title: no extension, nothing a file system rejects. */
export function baseNameFor(title: string): string {
  const base = sanitizeFilename(title.replace(VIDEO_EXT, ''))
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .slice(0, 150)
    .trim()
  return base || 'video'
}

/** The extension to save a video with, from its title, its Content-Type, or mp4. */
export function videoExtFor(title: string, contentType?: string | null): string {
  const fromTitle = VIDEO_EXT.exec(title)?.[0]
  if (fromTitle)
    return fromTitle.toLowerCase()
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('webm'))
    return '.webm'
  if (type.includes('matroska'))
    return '.mkv'
  if (type.includes('quicktime'))
    return '.mov'
  return '.mp4'
}

export interface DownloadNames {
  video: string
  /** The post's file name → the name to save it under. */
  scripts: { filename: string, saveAs: string }[]
}

/**
 * Names for one video and its scripts. The first stroke script takes the bare
 * name; further ones become alternatives the library recognises, `Name (alt
 * 2).funscript`; an axis script whose axis is taken already gets the same
 * treatment rather than overwriting it.
 */
export function downloadNames(base: string, ext: string, scripts: PostScript[]): DownloadNames {
  const taken = new Set<string>()
  const out: DownloadNames = { video: `${base}${ext}`, scripts: [] }
  for (const s of scripts) {
    const axis = s.suffix === 'default' ? '' : `.${s.suffix}`
    let saveAs = `${base}${axis}.funscript`
    for (let n = 2; taken.has(saveAs.toLowerCase()); n++)
      saveAs = `${base} (alt ${n})${axis}.funscript`
    taken.add(saveAs.toLowerCase())
    out.scripts.push({ filename: s.filename, saveAs })
  }
  return out
}

/** The same names with ` (n)` after the base, for when the first choice exists. */
export function withCopyNumber(names: DownloadNames, base: string, n: number): DownloadNames {
  const swap = (name: string) => `${base} (${n})${name.slice(base.length)}`
  return { video: swap(names.video), scripts: names.scripts.map(s => ({ ...s, saveAs: swap(s.saveAs) })) }
}
