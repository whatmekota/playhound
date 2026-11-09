import type { Pt } from '~/lib/scriptEdit'
import type { Pattern } from '~/lib/scriptPatterns'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { KEYS } from '~/lib/persist'
import { BUILTIN_PATTERNS, cleanName, normalisePattern, parsePatterns, uniqueName } from '~/lib/scriptPatterns'

/**
 * The script editor's patterns: the built-in ones, then the user's own,
 * kept in localStorage (and so in a backup).
 */
export const useScriptPatternStore = defineStore('scriptPatterns', () => {
  const saved = useLocalStorage<Pattern[]>(KEYS.scriptPatterns.key, [], {
    serializer: {
      read: (v) => {
        try {
          return parsePatterns(JSON.parse(v))
        }
        catch {
          return []
        }
      },
      write: v => JSON.stringify(v),
    },
  })

  const all = computed<readonly Pattern[]>(() => [...BUILTIN_PATTERNS, ...saved.value])

  function get(id: string): Pattern | null {
    return all.value.find(p => p.id === id) ?? null
  }

  /** Keep a run of points (positions 0–1) as a pattern. Null when it cannot be one. */
  function add(points: readonly Pt[], name: string): Pattern | null {
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const p = normalisePattern(points, uniqueName(name, all.value.map(q => q.name)), id)
    if (p)
      saved.value = [...saved.value, p]
    return p
  }

  function rename(id: string, name: string) {
    const clean = cleanName(name)
    if (!clean)
      return
    const others = all.value.filter(p => p.id !== id).map(p => p.name)
    saved.value = saved.value.map(p => (p.id === id ? { ...p, name: uniqueName(clean, others) } : p))
  }

  /** Delete one of the user's own; returns a function that puts it back. */
  function remove(id: string): (() => void) | null {
    const i = saved.value.findIndex(p => p.id === id)
    if (i < 0)
      return null
    const p = saved.value[i]
    saved.value = saved.value.filter(q => q.id !== id)
    return () => {
      if (saved.value.some(q => q.id === p.id))
        return
      const next = saved.value.slice()
      next.splice(Math.min(i, next.length), 0, p)
      saved.value = next
    }
  }

  return { saved, all, get, add, rename, remove }
})
