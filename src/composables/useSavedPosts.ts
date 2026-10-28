import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
import { KEYS } from '~/lib/persist'

/**
 * EroScripts posts starred to come back to: stream them again, or download the
 * video and scripts later. Kept with the user's own data (stats, playlists),
 * so Backup → Export carries them; only what is needed to list a post is
 * stored, and opening one fetches it fresh.
 */

export interface SavedPost {
  id: number
  slug: string
  title: string
  image_url: string | null
  tags: string[]
  created_at: string
  /** Unknown for a post starred from search results, until it is opened. */
  like_count: number | null
  views: number | null
  category_id: number
  savedAt: number
}

/** What a topic from the forum's lists has, as far as saving goes. */
interface TopicLike {
  id: number
  slug: string
  title: string
  image_url: string | null
  tags: (string | { name: string })[]
  created_at: string
  like_count?: number | null
  views?: number | null
  category_id: number
}

export const savedPosts = useLocalStorage<SavedPost[]>(KEYS.esSaved.key, [])

const savedIds = computed(() => new Set(savedPosts.value.map(p => p.id)))

export function isSaved(id: number) {
  return savedIds.value.has(id)
}

/** Star or unstar. Returns whether the post is saved now. */
export function toggleSaved(t: TopicLike): boolean {
  if (isSaved(t.id)) {
    savedPosts.value = savedPosts.value.filter(p => p.id !== t.id)
    return false
  }
  savedPosts.value = [{
    id: t.id,
    slug: t.slug,
    title: t.title,
    image_url: t.image_url,
    tags: (t.tags ?? []).map(x => (typeof x === 'string' ? x : x.name)),
    created_at: t.created_at,
    like_count: t.like_count ?? null,
    views: t.views ?? null,
    category_id: t.category_id,
    savedAt: Date.now(),
  }, ...savedPosts.value]
  return true
}

/** Fill in what a saved post was missing (a cover, counts) once it has been opened. */
export function refreshSaved(id: number, fresh: Partial<Pick<SavedPost, 'image_url' | 'like_count' | 'views' | 'title'>>) {
  const i = savedPosts.value.findIndex(p => p.id === id)
  if (i < 0)
    return
  const p = savedPosts.value[i]
  const next = {
    ...p,
    image_url: fresh.image_url ?? p.image_url,
    like_count: fresh.like_count ?? p.like_count,
    views: fresh.views ?? p.views,
    title: fresh.title ?? p.title,
  }
  if (JSON.stringify(next) !== JSON.stringify(p))
    savedPosts.value = savedPosts.value.map((x, k) => (k === i ? next : x))
}
