import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { formatTime } from '~/lib/time'

export interface Bookmark {
  id: string
  videoName: string
  time: number // seconds
  label: string
  createdAt: number
}

// Legacy key kept so existing bookmarks survive the rename.
const STORAGE_KEY = 'mwhoplayer:bookmarks'

function load(): Bookmark[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') }
  catch { return [] }
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
    if (b)
      b.label = label
  }

  return { bookmarks, forVideo, add, remove, rename }
})
