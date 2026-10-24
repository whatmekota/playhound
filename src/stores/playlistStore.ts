import type { VideoEntry } from '~/stores/libraryStore'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export interface PlaylistEntry {
  videoName: string // matches VideoEntry.name (filename)
  addedAt: number // timestamp
}

export interface Playlist {
  id: string
  name: string
  entries: PlaylistEntry[]
  createdAt: number
}

// ─── Smart Playlist ───────────────────────────────────────────────────────────
export type SmartRule
  = | { type: 'has_script' }
    | { type: 'starred' }
    | { type: 'multi_axis' }
    | { type: 'has_tag', tag: string }
    | { type: 'min_rating', rating: number }
    | { type: 'no_script' }

export interface SmartPlaylist {
  id: string
  name: string
  rules: SmartRule[] // ALL rules must match (AND logic)
  createdAt: number
}

export function evaluateSmartPlaylist(pl: SmartPlaylist, videos: VideoEntry[]): VideoEntry[] {
  return videos.filter(v => pl.rules.every((rule) => {
    switch (rule.type) {
      case 'has_script': return v.hasScript
      case 'no_script': return !v.hasScript
      case 'starred': return v.starred
      case 'multi_axis': return v.scriptCount > 1 || v.scriptType === 'merged'
      case 'has_tag': return (v.userMeta?.tags ?? v.scriptMeta?.tags ?? []).includes(rule.tag)
      case 'min_rating': return ((v.userMeta?.rating ?? v.scriptMeta?.rating) ?? 0) >= rule.rating
      default: return true
    }
  }))
}

const STORAGE_KEY = 'mwhoplayer:playlists'
// Legacy storage key kept so existing data survives the rename.
const SMART_KEY = 'mwhoplayer:smartplaylists'

function loadFromStorage(): Playlist[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  }
  catch { return [] }
}

function saveToStorage(lists: Playlist[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lists))
}

function loadSmartFromStorage(): SmartPlaylist[] {
  try { return JSON.parse(localStorage.getItem(SMART_KEY) ?? '[]') }
  catch { return [] }
}

const DEFAULT_SMART: SmartPlaylist[] = [
  { id: 'smart:scripted', name: '✦ All Scripted', rules: [{ type: 'has_script' }], createdAt: 0 },
  { id: 'smart:multiaxis', name: '⊞ Multi-Axis', rules: [{ type: 'multi_axis' }], createdAt: 0 },
  { id: 'smart:starred', name: '★ Starred', rules: [{ type: 'starred' }], createdAt: 0 },
  { id: 'smart:noscript', name: '— No Script', rules: [{ type: 'no_script' }], createdAt: 0 },
]

export const usePlaylistStore = defineStore('playlists', () => {
  const playlists = ref<Playlist[]>(loadFromStorage())
  const smartPlaylists = ref<SmartPlaylist[]>([...DEFAULT_SMART, ...loadSmartFromStorage()])

  // Ensure "Favorites" always exists
  if (!playlists.value.find(p => p.id === 'favorites')) {
    playlists.value.unshift({ id: 'favorites', name: '★ Favorites', entries: [], createdAt: Date.now() })
  }

  // Auto-save whenever playlists change
  watch(playlists, v => saveToStorage(v), { deep: true })
  watch(smartPlaylists, (v) => {
    const user = v.filter(p => !p.id.startsWith('smart:'))
    localStorage.setItem(SMART_KEY, JSON.stringify(user))
  }, { deep: true })

  function createPlaylist(name: string): Playlist {
    const pl: Playlist = { id: crypto.randomUUID(), name, entries: [], createdAt: Date.now() }
    playlists.value.push(pl)
    return pl
  }

  function deletePlaylist(id: string) {
    if (id === 'favorites')
      return // can't delete favorites
    playlists.value = playlists.value.filter(p => p.id !== id)
  }

  function renamePlaylist(id: string, name: string) {
    const pl = playlists.value.find(p => p.id === id)
    if (pl && id !== 'favorites')
      pl.name = name
  }

  function addToPlaylist(id: string, videoName: string) {
    const pl = playlists.value.find(p => p.id === id)
    if (!pl)
      return
    if (pl.entries.some(e => e.videoName === videoName))
      return // already in
    pl.entries.push({ videoName, addedAt: Date.now() })
  }

  function removeFromPlaylist(id: string, videoName: string) {
    const pl = playlists.value.find(p => p.id === id)
    if (pl)
      pl.entries = pl.entries.filter(e => e.videoName !== videoName)
  }

  function toggleFavorite(videoName: string) {
    const fav = playlists.value.find(p => p.id === 'favorites')!
    if (fav.entries.some(e => e.videoName === videoName)) {
      fav.entries = fav.entries.filter(e => e.videoName !== videoName)
    }
    else {
      fav.entries.push({ videoName, addedAt: Date.now() })
    }
  }

  function isFavorite(videoName: string) {
    return playlists.value.find(p => p.id === 'favorites')?.entries.some(e => e.videoName === videoName) ?? false
  }

  function isInPlaylist(id: string, videoName: string) {
    return playlists.value.find(p => p.id === id)?.entries.some(e => e.videoName === videoName) ?? false
  }

  function exportAll(): string {
    return JSON.stringify(playlists.value, null, 2)
  }

  function importAll(json: string): boolean {
    try {
      const parsed: Playlist[] = JSON.parse(json)
      if (!Array.isArray(parsed))
        return false
      // Merge: keep existing, overwrite matching ids, append new
      for (const incoming of parsed) {
        const idx = playlists.value.findIndex(p => p.id === incoming.id)
        if (idx >= 0)
          playlists.value[idx] = incoming
        else playlists.value.push(incoming)
      }
      // Ensure favorites is first
      const favIdx = playlists.value.findIndex(p => p.id === 'favorites')
      if (favIdx > 0)
        playlists.value.unshift(playlists.value.splice(favIdx, 1)[0])
      return true
    }
    catch { return false }
  }

  function moveEntry(playlistId: string, fromIdx: number, toIdx: number) {
    const pl = playlists.value.find(p => p.id === playlistId)
    if (!pl)
      return
    const [item] = pl.entries.splice(fromIdx, 1)
    pl.entries.splice(toIdx, 0, item)
  }

  function createSmartPlaylist(name: string, rules: SmartRule[]): SmartPlaylist {
    const pl: SmartPlaylist = { id: crypto.randomUUID(), name, rules, createdAt: Date.now() }
    smartPlaylists.value.push(pl)
    return pl
  }

  function deleteSmartPlaylist(id: string) {
    if (id.startsWith('smart:'))
      return // built-ins are pinned
    smartPlaylists.value = smartPlaylists.value.filter(p => p.id !== id)
  }

  function renameSmartPlaylist(id: string, name: string) {
    const pl = smartPlaylists.value.find(p => p.id === id)
    if (pl && !id.startsWith('smart:'))
      pl.name = name
  }

  /** Replace a user smart playlist's rules. Built-ins stay as they are. */
  function setSmartRules(id: string, rules: SmartRule[]) {
    const pl = smartPlaylists.value.find(p => p.id === id)
    if (pl && !id.startsWith('smart:'))
      pl.rules = rules
  }

  return {
    playlists,
    smartPlaylists,
    createPlaylist,
    deletePlaylist,
    renamePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    toggleFavorite,
    isFavorite,
    isInPlaylist,
    exportAll,
    importAll,
    moveEntry,
    createSmartPlaylist,
    deleteSmartPlaylist,
    renameSmartPlaylist,
    setSmartRules,
  }
})
