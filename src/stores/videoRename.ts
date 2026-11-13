/**
 * A video renamed on disk (the Organizer): everything playhound keeps by its
 * file name goes with it. That is its saved info (tags, the link it came
 * from, script tweaks), its star, stats and session history, playlists,
 * bookmarks, the VR view set for it, its thumbnail and its script's summary.
 * Without this a rename quietly drops all of them, since the library only
 * knows a video by its name.
 */
import { metaDb, summaryDb, thumbDb } from '~/lib/idb'
import { useBookmarkStore } from './bookmarkStore'
import { useLibraryStore } from './libraryStore'
import { usePlayerStore } from './playerStore'
import { usePlaylistStore } from './playlistStore'
import { useStatsStore } from './statsStore'

/** Copy a cache entry to the new name when the new name has none. */
async function copyKey<T>(db: { get: (k: string) => Promise<T | undefined>, set: (k: string, v: T) => Promise<void> }, from: string, to: string) {
  try {
    const v = await db.get(from)
    if (v !== undefined && (await db.get(to)) === undefined)
      await db.set(to, v)
  }
  catch {}
}

export async function carryVideoData(oldName: string, newName: string): Promise<void> {
  if (!oldName || !newName || oldName === newName)
    return
  await useLibraryStore().renameVideoData(oldName, newName)

  const stats = useStatsStore()
  const old = stats.stats[oldName]
  if (old) {
    const into = stats.stats[newName]
    stats.stats[newName] = into
      ? {
          ...into,
          totalPlays: into.totalPlays + old.totalPlays,
          totalWatchedMs: into.totalWatchedMs + old.totalWatchedMs,
          finishEvents: [...old.finishEvents, ...into.finishEvents],
          edgeEvents: [...(old.edgeEvents ?? []), ...(into.edgeEvents ?? [])],
          lastPlayedAt: Math.max(into.lastPlayedAt, old.lastPlayedAt),
        }
      : { ...old, videoName: newName }
    delete stats.stats[oldName]
  }
  for (const s of stats.history.sessions) {
    for (const list of [s.plays, s.edges, s.finishes] as { video: string | null }[][]) {
      for (const item of list) {
        if (item.video === oldName)
          item.video = newName
      }
    }
  }

  for (const pl of usePlaylistStore().playlists) {
    for (const e of pl.entries) {
      if (e.videoName === oldName && !pl.entries.some(x => x.videoName === newName))
        e.videoName = newName
    }
  }
  for (const b of useBookmarkStore().bookmarks) {
    if (b.videoName === oldName)
      b.videoName = newName
  }
  usePlayerStore().renameVrChoice(oldName, newName)

  await copyKey(thumbDb, oldName, newName)
  await copyKey(summaryDb, oldName, newName)
  await copyKey(metaDb, `eye1:${oldName}`, `eye1:${newName}`)
}
