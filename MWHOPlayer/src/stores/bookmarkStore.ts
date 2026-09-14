import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export interface Bookmark {
  id: string
  videoName: string
  time: number      // seconds
  label: string
  createdAt: number
}

const STORAGE_KEY = 'mwhoplayer:bookmarks'

function load(): Bookmark[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}

export const useBookmarkStore = defineStore('bookmarks', () => {
  const bookmarks = ref<Bookmark[]>(load())

  watch(bookmarks, v => localStorage.setItem(STORAGE_KEY, JSON.stringify(v)), { deep: true })

  function forVideo(videoName: string): Bookmark[] {
    return bookmarks.value.filter(b => b.videoName === videoName).sort((a, b) => a.time - b.time)
  }

  function add(videoName: string, time: number, label?: string): Bookmark {
    const bm: Bookmark = {
      id: crypto.randomUUID(),
      videoName,
      time,
      label: label ?? formatTime(time),
      createdAt: Date.now(),
    }
    bookmarks.value.push(bm)
    return bm
  }

  function remove(id: string) {
    bookmarks.value = bookmarks.value.filter(b => b.id !== id)
  }

  function rename(id: string, label: string) {
    const b = bookmarks.value.find(x => x.id === id)
    if (b) b.label = label
  }

  return { bookmarks, forVideo, add, remove, rename }
})

function formatTime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  return `${m}:${String(sec).padStart(2,'0')}`
}
