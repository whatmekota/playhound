/**
 * Watching the library's folders for new and removed videos, cheaply.
 *
 * Reading a whole folder again to find what changed means a stat of every
 * file in it: on a library of 10,000 videos that kept the disk busy for
 * seconds at a time, and the video playing stuttered with it. Instead:
 *
 *   - the desktop app hears from the system which paths changed (the main
 *     process watches the folders), and only those are looked at again
 *   - a browser cannot be told, so it lists names now and then (no stat of
 *     any file), compares them with what it has, and reads only the new ones,
 *     and not at all while a video plays
 *
 * The pure parts are here, tested in test/libraryWatch.test.ts.
 */
import { isMediaName } from './mediaFiles'
import { isSubtitleName } from './subtitles'

/** How often a browser looks, when nothing is playing. */
export const POLL_MS = 60_000

/** More changes than this at once (a folder copied in): read the whole folder again. */
export const MAX_CHANGES = 1000

/** Anything the library is made of: videos and audio, their scripts, subtitles. */
export function isLibraryName(name: string): boolean {
  return isMediaName(name) || /\.funscript$/i.test(name) || isSubtitleName(name)
}

/** The last part of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * Where a library file is on disk: its folder's place on disk, then its
 * library path past the folder's label ("Videos/sub/clip.mp4" under
 * "D:\Videos" is "D:\Videos\sub\clip.mp4").
 */
export function diskPathOf(root: string, libPath: string): string {
  const sep = root.includes('\\') || /^[a-z]:/i.test(root) ? '\\' : '/'
  const rest = libPath.split('/').slice(1).join(sep)
  return root.endsWith(sep) ? root + rest : `${root}${sep}${rest}`
}

/**
 * Paths reported as changed, made '/'-separated and relative, each once, and
 * none inside another (a folder that changed covers what is in it).
 */
export function normaliseChanges(paths: string[]): string[] {
  const clean = [...new Set(paths.map(p => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))].sort()
  const out: string[] = []
  for (const p of clean) {
    const last = out.at(-1)
    if (last !== undefined && p.startsWith(`${last}/`))
      continue
    out.push(p)
  }
  return out
}

export interface PathChange<T> {
  /** The library path that changed ("Videos/sub/clip.mp4"), a file or a folder. */
  path: string
  /** What is there now: the one file, everything in the folder, or nothing. */
  files: T[]
}

/** The files, with whatever sat at each changed path replaced by what is there now. */
export function applyChanges<T>(files: T[], pathOf: (f: T) => string, changes: PathChange<T>[]): T[] {
  if (!changes.length)
    return files
  const exact = new Set(changes.map(c => c.path))
  const prefixes = changes.map(c => `${c.path}/`)
  const kept = files.filter((f) => {
    const p = pathOf(f)
    return !exact.has(p) && !prefixes.some(x => p.startsWith(x))
  })
  for (const c of changes)
    kept.push(...c.files)
  return kept
}

/**
 * `next`, with each file that is unchanged since `old` (same path, size and
 * time) given back as the very object `old` had. The library keys what it
 * knows of a video on that object, and a File read before is still good to
 * read as long as the file on disk has not changed.
 */
export function keepUnchanged<T extends { size: number, lastModified: number }>(old: T[], next: T[], pathOf: (f: T) => string): T[] {
  const had = new Map(old.map(f => [pathOf(f), f]))
  return next.map((f) => {
    const was = had.get(pathOf(f))
    return was && was.size === f.size && was.lastModified === f.lastModified ? was : f
  })
}

/** What a fresh listing adds and takes away, by path. */
export function diffPaths(before: Iterable<string>, after: Set<string>): { added: string[], removed: string[] } {
  const was = new Set(before)
  const added: string[] = []
  const removed: string[] = []
  for (const p of after) {
    if (!was.has(p))
      added.push(p)
  }
  for (const p of was) {
    if (!after.has(p))
      removed.push(p)
  }
  return { added, removed }
}

/**
 * Every file path under a folder, by name only: no file is opened or
 * stat'ed, which is what makes this cheap. `pause` runs between folders, to
 * give the page its turn (and may stop the walk by returning false).
 */
export async function listPaths(dir: FileSystemDirectoryHandle, prefix: string, pause?: () => Promise<boolean>): Promise<Set<string> | null> {
  const out = new Set<string>()
  const todo: [FileSystemDirectoryHandle, string][] = [[dir, prefix]]
  while (todo.length) {
    const [d, p] = todo.pop()!
    if (pause && !await pause())
      return null
    try {
      for await (const entry of (d as any).values() as AsyncIterable<FileSystemHandle>) {
        if (entry.kind === 'file')
          out.add(`${p}/${entry.name}`)
        else
          todo.push([entry as FileSystemDirectoryHandle, `${p}/${entry.name}`])
      }
    }
    catch {
      // A folder that went away, or cannot be read: it has nothing in it now.
    }
  }
  return out
}
