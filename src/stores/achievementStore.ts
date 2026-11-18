import type { PluginAchievement } from '~/plugins/types'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { toast } from '~/composables/useToast'
import { ACHIEVEMENTS, TIER_LABEL } from '~/lib/achievements'
import { KEYS } from '~/lib/persist'
import { useUiStore } from './uiStore'

/**
 * What has been earned: playhound's achievements (lib/achievements) and the
 * ones plugins declare (plugin API 7), with when. The checking itself is
 * useAchievements; this keeps the record, tells the user, and opens the
 * gallery in Stats.
 */

export interface PluginAchievementRecord {
  /** The plugin's name, for the gallery's heading. */
  name: string
  /** As last declared, kept so they show while the plugin is off. */
  defs: PluginAchievement[]
  unlocked: Record<string, number>
  progress: Record<string, number>
}

interface Saved {
  /** playhound's own, by id, with when (ms). */
  unlocked: Record<string, number>
  /** Checked once against what was already there, quietly. */
  seeded: boolean
  plugins: Record<string, PluginAchievementRecord>
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS.achievements.key) ?? 'null')
    if (raw && typeof raw === 'object') {
      return {
        unlocked: raw.unlocked && typeof raw.unlocked === 'object' ? raw.unlocked : {},
        seeded: raw.seeded === true,
        plugins: raw.plugins && typeof raw.plugins === 'object' ? raw.plugins : {},
      }
    }
  }
  catch {}
  return { unlocked: {}, seeded: false, plugins: {} }
}

/** A plugin's declared list, made safe: known fields, sensible values, ids once. */
export function cleanPluginAchievements(list: unknown): PluginAchievement[] {
  if (!Array.isArray(list))
    return []
  const seen = new Set<string>()
  const out: PluginAchievement[] = []
  for (const a of list) {
    if (!a || typeof a !== 'object')
      continue
    const r = a as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 60) : ''
    if (!ID_RE.test(id) || !title || seen.has(id))
      continue
    seen.add(id)
    out.push({
      id,
      title,
      description: typeof r.description === 'string' ? r.description.trim().slice(0, 160) : '',
      icon: typeof r.icon === 'string' && r.icon.trim() ? [...r.icon.trim()].slice(0, 4).join('') : undefined,
      target: typeof r.target === 'number' && Number.isFinite(r.target) && r.target > 1 ? Math.round(r.target) : undefined,
      hidden: r.hidden === true || undefined,
      tier: r.tier === 2 || r.tier === 3 || r.tier === 4 ? r.tier : 1,
    })
    if (out.length >= 200)
      break
  }
  return out
}

export const useAchievementStore = defineStore('achievements', () => {
  const saved = ref<Saved>(load())
  watch(saved, v => localStorage.setItem(KEYS.achievements.key, JSON.stringify(v)), { deep: true })

  /** The tab Stats opens on: an earned notice's "See" goes straight to the gallery. */
  const statsTab = ref<'overview' | 'achievements'>('overview')

  const earnedCount = computed(() => ACHIEVEMENTS.filter(a => saved.value.unlocked[a.id]).length)
  const pluginEarnedCount = computed(() => Object.values(saved.value.plugins).reduce((n, p) => n + p.defs.filter(d => p.unlocked[d.id]).length, 0))
  const pluginTotal = computed(() => Object.values(saved.value.plugins).reduce((n, p) => n + p.defs.length, 0))

  function openGallery() {
    statsTab.value = 'achievements'
    useUiStore().openView('stats')
  }

  /** Tell the user, one notice per achievement, or one for many at once. */
  function announce(items: { title: string, description: string, icon?: string, tier: number, from?: string }[]) {
    if (!items.length)
      return
    if (items.length > 3) {
      toast.success(`${items.length} achievements earned`, {
        detail: items.slice(0, 4).map(i => i.title).join(', ') + (items.length > 4 ? '…' : ''),
        icon: 'i-carbon-trophy',
        key: 'achievement',
        action: { label: 'See', run: openGallery },
      })
      return
    }
    for (const i of items) {
      toast.success(`${i.from ? `${i.from}: ` : ''}${i.title}`, {
        detail: `${TIER_LABEL[i.tier as 1 | 2 | 3 | 4] ?? 'Bronze'} achievement · ${i.description}`,
        icon: i.icon?.startsWith('i-') ? i.icon : 'i-carbon-trophy',
        key: `achievement-${i.from ?? ''}${i.title}`,
        action: { label: 'See', run: openGallery },
      })
    }
  }

  /**
   * Earn these of playhound's. The first check ever earns what was already
   * there without a notice each: one line says how many instead.
   */
  function earn(ids: string[]) {
    const now = Date.now()
    const fresh = ids.filter(id => !saved.value.unlocked[id])
    for (const id of fresh)
      saved.value.unlocked[id] = now
    if (!saved.value.seeded) {
      saved.value.seeded = true
      if (fresh.length) {
        toast.success(`You've already earned ${fresh.length} achievement${fresh.length === 1 ? '' : 's'}`, {
          detail: 'From what you have done in playhound so far. There are many more.',
          icon: 'i-carbon-trophy',
          key: 'achievement',
          action: { label: 'See', run: openGallery },
        })
      }
      return
    }
    announce(fresh.map(id => ACHIEVEMENTS.find(a => a.id === id)!).filter(Boolean))
  }

  // ─── Plugins' own ──────────────────────────────────────────────────────
  // A plugin earns several at once (a ×10 pull, catching up at start): the
  // notices of one moment go out together, so a burst is one line, not ten.
  type Notice = Parameters<typeof announce>[0][number]
  let pending: Notice[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  function noticeLater(n: Notice) {
    pending.push(n)
    clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      const items = pending
      pending = []
      announce(items)
    }, 50)
  }
  /**
   * A plugin declaring its list for the first time catches up on what its
   * user had already done; those are earned quietly, with one line after.
   */
  const catchingUp = new Map<string, { until: number, count: number }>()
  const CATCH_UP_MS = 4000

  function pluginRecord(id: string, name: string): PluginAchievementRecord {
    let r = saved.value.plugins[id]
    if (!r) {
      r = { name, defs: [], unlocked: {}, progress: {} }
      saved.value.plugins[id] = r
    }
    r.name = name
    return r
  }

  function pluginDefine(pluginId: string, name: string, list: unknown) {
    const first = !saved.value.plugins[pluginId]?.defs.length
    const r = pluginRecord(pluginId, name)
    r.defs = cleanPluginAchievements(list)
    if (first && r.defs.length) {
      catchingUp.set(pluginId, { until: Date.now() + CATCH_UP_MS, count: 0 })
      setTimeout(() => {
        const c = catchingUp.get(pluginId)
        catchingUp.delete(pluginId)
        if (c?.count) {
          toast.success(`${r.name}: ${c.count} achievement${c.count === 1 ? '' : 's'} already earned`, {
            detail: 'From what you had done with it so far.',
            icon: 'i-carbon-trophy',
            key: `achievement-${pluginId}`,
            action: { label: 'See', run: openGallery },
          })
        }
      }, CATCH_UP_MS)
    }
    // A counted one already at its target (a list that lowered it) is earned.
    for (const d of r.defs) {
      if (d.target && (r.progress[d.id] ?? 0) >= d.target && !r.unlocked[d.id])
        r.unlocked[d.id] = Date.now()
    }
  }

  function pluginUnlock(pluginId: string, id: string): boolean {
    const r = saved.value.plugins[pluginId]
    const d = r?.defs.find(x => x.id === id)
    if (!r || !d || r.unlocked[id])
      return false
    r.unlocked[id] = Date.now()
    const c = catchingUp.get(pluginId)
    if (c && Date.now() < c.until)
      c.count++
    else
      noticeLater({ title: d.title, description: d.description, icon: undefined, tier: d.tier ?? 1, from: r.name })
    return true
  }

  function pluginProgress(pluginId: string, id: string, value: number) {
    const r = saved.value.plugins[pluginId]
    const d = r?.defs.find(x => x.id === id)
    if (!r || !d || !Number.isFinite(value))
      return
    r.progress[id] = Math.max(0, value)
    if (d.target && value >= d.target)
      pluginUnlock(pluginId, id)
  }

  function clearAll() {
    saved.value = { unlocked: {}, seeded: false, plugins: {} }
  }

  return {
    saved,
    statsTab,
    earnedCount,
    pluginEarnedCount,
    pluginTotal,
    openGallery,
    earn,
    pluginDefine,
    pluginUnlock,
    pluginProgress,
    clearAll,
  }
})
