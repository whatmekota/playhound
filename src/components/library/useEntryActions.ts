import type { MenuItem } from '~/components/ui/menu'
import type { VideoEntry } from '~/stores/libraryStore'
import type { Playlist } from '~/stores/playlistStore'
import { ref } from 'vue'
import { toast } from '~/composables/useToast'
import { plural } from '~/lib/entryInfo'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { usePlaylistStore } from '~/stores/playlistStore'
import { useUiStore } from '~/stores/uiStore'

export interface CtxMenu { x: number, y: number, items: MenuItem[] }

/**
 * What can be done to one or more library videos: star, queue, add to a
 * playlist, edit info. Each list owns one of these, and renders its context
 * menu and the two dialogs (EntryInfoModal, NewPlaylistModal) itself, so the
 * view and the drawer panel never open each other's.
 */
export function useEntryActions(opts: {
  /** Play one video in the list's own context. */
  play: (entry: VideoEntry) => void
  /** Play several (a selection) as their own queue. */
  playMany?: (entries: VideoEntry[]) => void
}) {
  const library = useLibraryStore()
  const playback = usePlaybackStore()
  const plStore = usePlaylistStore()
  const ui = useUiStore()

  const ctx = ref<CtxMenu | null>(null)
  /** The video whose Info & tags dialog is open. */
  const infoEntry = ref<VideoEntry | null>(null)
  /** Videos waiting for a name for the new playlist they will go into. */
  const newPlaylistFor = ref<VideoEntry[] | null>(null)

  function setStar(entries: VideoEntry[], on: boolean) {
    for (const e of entries) {
      if (e.starred !== on)
        library.toggleStar(e)
    }
    const n = entries.length
    toast(on ? (n === 1 ? 'Starred' : `Starred ${n} videos`) : (n === 1 ? 'Unstarred' : `Unstarred ${n} videos`), {
      icon: on ? 'i-carbon-star-filled' : 'i-carbon-star',
      key: 'star',
    })
  }

  function inPlaylist(pl: Playlist, entries: VideoEntry[]) {
    return entries.every(e => plStore.isInPlaylist(pl.id, e.name))
  }

  function togglePlaylist(pl: Playlist, entries: VideoEntry[]) {
    if (inPlaylist(pl, entries)) {
      for (const e of entries)
        plStore.removeFromPlaylist(pl.id, e.name)
      toast(`Removed from ${pl.name}`, { icon: 'i-carbon-playlist', key: 'playlist' })
    }
    else {
      for (const e of entries)
        plStore.addToPlaylist(pl.id, e.name)
      toast(`Added to ${pl.name}`, {
        detail: entries.length === 1 ? entries[0].basename : plural(entries.length, 'video'),
        icon: 'i-carbon-playlist',
        key: 'playlist',
        action: { label: 'Open', run: () => ui.openView('playlists') },
      })
    }
  }

  function playlistItems(entries: VideoEntry[]): MenuItem[] {
    return [
      ...plStore.playlists.map(pl => ({
        label: pl.id === 'favorites' ? 'Favorites' : pl.name,
        icon: pl.id === 'favorites' ? 'i-carbon-favorite' : 'i-carbon-playlist',
        checked: inPlaylist(pl, entries),
        run: () => togglePlaylist(pl, entries),
      })),
      { separator: true },
      { label: 'New playlist…', icon: 'i-carbon-add', run: () => (newPlaylistFor.value = entries) },
    ]
  }

  async function copyName(entry: VideoEntry) {
    try {
      await navigator.clipboard.writeText(entry.name)
      toast('File name copied', { icon: 'i-carbon-copy', key: 'copy' })
    }
    catch {
      toast.error('Clipboard is not available')
    }
  }

  function menuFor(targets: VideoEntry[], at: { x: number, y: number }, extra: MenuItem[] = []): MenuItem[] {
    const one = targets.length === 1 ? targets[0] : null
    const allStarred = targets.every(t => t.starred)
    const items: MenuItem[] = []
    if (!one)
      items.push({ heading: true, label: `${targets.length} selected` })
    items.push(
      { label: 'Play', icon: 'i-carbon-play-filled-alt', run: () => (one ? opts.play(one) : opts.playMany?.(targets)) },
      { label: 'Play next', icon: 'i-carbon-skip-forward', run: () => playback.playNextInQueue(targets) },
      { label: 'Add to queue', icon: 'i-carbon-list-boxes', run: () => playback.addToQueue(targets) },
      { separator: true },
      // The menu closes after an item runs, so the playlist list opens on the next tick in its place.
      { label: 'Add to playlist ▸', icon: 'i-carbon-playlist', run: () => setTimeout(() => (ctx.value = { ...at, items: [{ heading: true, label: 'Add to playlist' }, ...playlistItems(targets)] })) },
      { label: allStarred ? 'Unstar' : 'Star', icon: allStarred ? 'i-carbon-star-filled' : 'i-carbon-star', run: () => setStar(targets, !allStarred) },
    )
    if (one) {
      items.push(
        { separator: true },
        { label: 'Info & tags…', icon: 'i-carbon-tag-edit', run: () => (infoEntry.value = one) },
        { label: 'Copy file name', icon: 'i-carbon-copy', run: () => void copyName(one) },
      )
    }
    if (extra.length)
      items.push({ separator: true }, ...extra)
    return items
  }

  function openMenu(e: MouseEvent, targets: VideoEntry[], extra: MenuItem[] = []) {
    const at = { x: e.clientX, y: e.clientY }
    ctx.value = { ...at, items: menuFor(targets, at, extra) }
  }

  return { ctx, infoEntry, newPlaylistFor, setStar, playlistItems, menuFor, openMenu, copyName }
}
