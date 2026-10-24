import type { Ref } from 'vue'
import type { MenuItem } from '~/components/ui/menu'
import type { VideoEntry } from '~/stores/libraryStore'
import type { Playlist, SmartPlaylist } from '~/stores/playlistStore'
import { computed } from 'vue'
import { toast } from '~/composables/useToast'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { evaluateSmartPlaylist, usePlaylistStore } from '~/stores/playlistStore'
import { useQueueStore } from '~/stores/queueStore'

export interface PlaylistSel { kind: 'list' | 'smart', id: string }

export interface PlaylistRow {
  key: string
  /** Index into the playlist's own entries, for reordering and removal. */
  index: number
  name: string
  entry: VideoEntry | null
}

export const isBuiltinSmart = (id: string) => id.startsWith('smart:')
/** Built-in smart playlists carry a symbol in their name; lists show an icon instead. */
export const cleanName = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, '') || name

/**
 * One playlist's rows and how to play them, for the Playlists view and the
 * drawer panel alike. `sel` is whichever playlist the caller is showing.
 */
export function usePlaylistRows(sel: Ref<PlaylistSel | null>) {
  const plStore = usePlaylistStore()
  const library = useLibraryStore()
  const playback = usePlaybackStore()
  const queue = useQueueStore()

  const byName = computed(() => new Map(library.videos.map(v => [v.name, v])))

  const activeList = computed<Playlist | null>(() =>
    sel.value?.kind === 'list' ? plStore.playlists.find(p => p.id === sel.value!.id) ?? null : null)
  const activeSmart = computed<SmartPlaylist | null>(() =>
    sel.value?.kind === 'smart' ? plStore.smartPlaylists.find(p => p.id === sel.value!.id) ?? null : null)

  const canEdit = computed(() =>
    activeList.value ? activeList.value.id !== 'favorites' : activeSmart.value ? !isBuiltinSmart(activeSmart.value.id) : false)

  const rows = computed<PlaylistRow[]>(() => {
    if (activeList.value) {
      return activeList.value.entries.map((pe, index) => ({
        key: `${pe.videoName}\u0000${pe.addedAt}`,
        index,
        name: pe.videoName,
        entry: byName.value.get(pe.videoName) ?? null,
      }))
    }
    if (activeSmart.value) {
      return evaluateSmartPlaylist(activeSmart.value, library.videos)
        .map((entry, index) => ({ key: entry.name, index, name: entry.name, entry }))
    }
    return []
  })

  /** What can actually play: rows whose file is in the library right now. */
  const playable = computed(() => rows.value.flatMap(r => (r.entry ? [r.entry] : [])))
  const missingCount = computed(() => rows.value.length - playable.value.length)
  const activeName = computed(() => activeList.value?.name ?? activeSmart.value?.name ?? '')
  /** As shown: Favorites by its proper name, built-ins without their symbol. */
  const displayName = computed(() => activeList.value?.id === 'favorites' ? 'Favorites' : cleanName(activeName.value))

  const totalDuration = computed(() => {
    let secs = 0
    let unknown = 0
    for (const e of playable.value) {
      if (e.duration === null)
        unknown++
      else
        secs += e.duration
    }
    return { secs, unknown }
  })

  function coverFor(entries: { videoName: string }[]): string | null {
    for (const pe of entries.slice(0, 8)) {
      const e = byName.value.get(pe.videoName)
      if (e?.thumbnailUrl)
        return e.thumbnailUrl
    }
    return null
  }

  // ─── Play ───────────────────────────────────────────────────────────────
  function playFrom(entry: VideoEntry) {
    void playback.play(entry, playable.value, displayName.value)
  }

  function playAll() {
    if (!playable.value.length)
      return
    if (queue.shuffle)
      queue.setShuffle(false)
    void playback.play(playable.value[0], playable.value, displayName.value)
  }

  function shuffleAll() {
    const list = playable.value
    if (!list.length)
      return
    if (!queue.shuffle)
      queue.setShuffle(true)
    void playback.play(list[Math.floor(Math.random() * list.length)], list, displayName.value)
  }

  function onRowClick(row: PlaylistRow) {
    if (row.entry)
      playFrom(row.entry)
    else
      toast.warn('That video is not in the library', { detail: row.name, key: 'missing' })
  }

  function remove(row: PlaylistRow) {
    if (activeList.value)
      plStore.removeFromPlaylist(activeList.value.id, row.name)
  }

  /** Reorder and remove, for rows of an ordinary playlist. */
  function rowEditItems(row: PlaylistRow): MenuItem[] {
    const pl = activeList.value
    if (!pl)
      return []
    const last = pl.entries.length - 1
    return [
      { label: 'Move to top', icon: 'i-carbon-up-to-top', disabled: row.index === 0, run: () => plStore.moveEntry(pl.id, row.index, 0) },
      { label: 'Move to bottom', icon: 'i-carbon-down-to-bottom', disabled: row.index === last, run: () => plStore.moveEntry(pl.id, row.index, last) },
      { label: 'Remove from playlist', icon: 'i-carbon-subtract-alt', danger: true, run: () => remove(row) },
    ]
  }

  return {
    byName,
    activeList,
    activeSmart,
    canEdit,
    rows,
    playable,
    missingCount,
    activeName,
    displayName,
    totalDuration,
    coverFor,
    playFrom,
    playAll,
    shuffleAll,
    onRowClick,
    remove,
    rowEditItems,
  }
}
