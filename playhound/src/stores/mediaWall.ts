import { useLocalStorage } from '@vueuse/core'
import { computed, reactive } from 'vue'

export interface WallItem {
  id: string
  type: 'image' | 'video' | 'youtube'
  src: string // object URL for files, video ID for youtube
  label: string
  x: number
  y: number
  width: number
  height: number
  opacity: number
  playbackRate: number
  muted: boolean
  zIndex: number
}

const sessionItems = reactive<WallItem[]>([])
const persistedItems = useLocalStorage<WallItem[]>('ph-wall-items', [])
const items = computed<WallItem[]>(() => [...persistedItems.value, ...sessionItems])
let zCounter = 1

function addItem(item: Omit<WallItem, 'id' | 'zIndex'>): WallItem {
  const newItem: WallItem = { ...item, id: crypto.randomUUID(), zIndex: zCounter++ }
  if (item.type === 'youtube')
    persistedItems.value.push(newItem)
  else
    sessionItems.push(newItem)
  return newItem
}

function removeItem(id: string) {
  const si = sessionItems.findIndex(i => i.id === id)
  if (si >= 0)
    sessionItems.splice(si, 1)
  const pi = persistedItems.value.findIndex(i => i.id === id)
  if (pi >= 0)
    persistedItems.value.splice(pi, 1)
}

function updateItem(id: string, updates: Partial<WallItem>) {
  const si = sessionItems.find(i => i.id === id)
  if (si)
    Object.assign(si, updates)
  const pi = persistedItems.value.find(i => i.id === id)
  if (pi)
    Object.assign(pi, updates)
}

function bringToFront(id: string) {
  updateItem(id, { zIndex: zCounter++ })
}

function clearAll() {
  sessionItems.splice(0)
  persistedItems.value = []
}

export function useMediaWallStore() {
  return { items, addItem, removeItem, updateItem, bringToFront, clearAll }
}
