<script setup lang="ts">
import type { AchievementDef, AchievementFacts, AchievementGroup, AchievementTier } from '~/lib/achievements'
import { computed, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiProgress from '~/components/ui/UiProgress.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import { ACHIEVEMENT_GROUPS, ACHIEVEMENTS, progressOf, progressText, TIER_LABEL } from '~/lib/achievements'
import { useAchievementStore } from '~/stores/achievementStore'

/**
 * Stats → Achievements: every badge, earned or not. Earned ones in their
 * tier's colour with the date; the rest greyed, with how far along the
 * counted ones are; secret ones stay "???" until earned. Plugins' own come
 * after playhound's, under each plugin's name.
 */
const props = defineProps<{ facts: AchievementFacts | null }>()
const store = useAchievementStore()

type Filter = 'all' | 'earned' | 'todo'
const filter = ref<Filter>('all')
const group = ref<AchievementGroup | 'all' | 'plugins'>('all')

const FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'earned' as const, label: 'Earned' },
  { value: 'todo' as const, label: 'To do' },
]

const earnedAt = (id: string) => store.saved.unlocked[id] ?? null

interface Row {
  key: string
  title: string
  description: string
  icon: string | null
  emoji: string | null
  tier: AchievementTier
  at: number | null
  secret: boolean
  value: number | null
  target: number
  text: string | null
}

function rowOf(a: AchievementDef): Row {
  const at = earnedAt(a.id)
  const p = props.facts ? progressOf(a, props.facts) : null
  return {
    key: a.id,
    title: a.title,
    description: a.description,
    icon: a.icon,
    emoji: null,
    tier: a.tier,
    at,
    secret: !!a.hidden && !at,
    value: p && a.target > 1 ? p.value : null,
    target: a.target,
    text: p && a.target > 1 ? progressText(a, p.value) : null,
  }
}

const keep = (r: Row) => filter.value === 'all' || (filter.value === 'earned' ? !!r.at : !r.at)

/** playhound's, by group, in their order. */
const sections = computed(() => ACHIEVEMENT_GROUPS
  .filter(g => group.value === 'all' || group.value === g.id)
  .map(g => ({ key: g.id, label: g.label, icon: g.icon, rows: ACHIEVEMENTS.filter(a => a.group === g.id).map(rowOf).filter(keep) }))
  .filter(s => s.rows.length))

/** Each plugin's own, under its name. */
const pluginSections = computed(() => {
  if (group.value !== 'all' && group.value !== 'plugins')
    return []
  return Object.entries(store.saved.plugins)
    .map(([id, p]) => ({
      key: `plugin:${id}`,
      label: p.name,
      rows: p.defs.map((d): Row => {
        const at = p.unlocked[d.id] ?? null
        const target = d.target ?? 1
        const value = target > 1 ? Math.min(target, p.progress[d.id] ?? 0) : null
        return {
          key: `${id}:${d.id}`,
          title: d.title,
          description: d.description,
          icon: null,
          emoji: d.icon ?? null,
          tier: d.tier ?? 1,
          at,
          secret: !!d.hidden && !at,
          value,
          target,
          text: value !== null ? `${Math.floor(value).toLocaleString()} / ${target.toLocaleString()}` : null,
        }
      }).filter(keep),
    }))
    .filter(s => s.rows.length)
})

const total = computed(() => ACHIEVEMENTS.length + store.pluginTotal)
const earned = computed(() => store.earnedCount + store.pluginEarnedCount)
const byTier = computed(() => ([1, 2, 3, 4] as AchievementTier[]).map(t => ({
  tier: t,
  earned: ACHIEVEMENTS.filter(a => a.tier === t && earnedAt(a.id)).length,
  total: ACHIEVEMENTS.filter(a => a.tier === t).length,
})))

const groupOptions = computed(() => [
  { value: 'all' as const, label: 'All' },
  ...ACHIEVEMENT_GROUPS.map(g => ({ value: g.id, label: g.label })),
  ...(Object.keys(store.saved.plugins).length ? [{ value: 'plugins' as const, label: 'Plugins' }] : []),
])

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const confirmReset = ref(false)
function reset() {
  if (!confirmReset.value) {
    confirmReset.value = true
    setTimeout(() => (confirmReset.value = false), 4000)
    return
  }
  confirmReset.value = false
  store.clearAll()
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- How far along -->
    <section class="p-4 card flex flex-wrap gap-x-6 gap-y-3 items-center">
      <div class="flex gap-3 items-center">
        <span class="ach-medal tier-3 h-12 w-12">
          <span class="i-carbon-trophy text-[22px]" />
        </span>
        <div class="flex flex-col">
          <span class="text-[22px] text-fg tracking-[-0.02em] font-semibold num">{{ earned }} <span class="text-[14px] text-fg-faint font-normal">/ {{ total }}</span></span>
          <span class="eyebrow">Achievements earned</span>
        </div>
      </div>
      <div class="flex flex-1 flex-wrap gap-4 min-w-[240px]">
        <div v-for="t in byTier" :key="t.tier" class="flex gap-2 items-center">
          <span class="ach-dot" :class="`tier-${t.tier}`" />
          <span class="text-[12.5px] text-fg-muted">{{ TIER_LABEL[t.tier] }}</span>
          <span class="text-[12.5px] text-fg num">{{ t.earned }}/{{ t.total }}</span>
        </div>
      </div>
      <UiProgress :value="total ? earned / total : 0" class="basis-full" />
    </section>

    <div class="flex flex-wrap gap-2 items-center">
      <UiSegmented v-model="filter" :options="FILTERS" size="sm" />
      <div class="flex-1" />
      <select
        v-model="group"
        class="text-[12.5px] text-fg px-2 outline-none border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-7"
        aria-label="Which achievements"
      >
        <option v-for="o in groupOptions" :key="o.value" :value="o.value">
          {{ o.label }}
        </option>
      </select>
    </div>

    <section v-for="s in [...sections, ...pluginSections]" :key="s.key" class="flex flex-col gap-2">
      <h2 class="text-[13px] text-fg-muted font-semibold flex gap-2 items-center">
        <span v-if="'icon' in s && s.icon" :class="s.icon" class="text-[14px] text-fg-faint" />
        <span v-else class="i-carbon-application text-[14px] text-fg-faint" />
        {{ s.label }}
        <span class="text-[11.5px] text-fg-faint font-normal num">{{ s.rows.filter(r => r.at).length }}/{{ s.rows.length }}</span>
      </h2>
      <div class="gap-2 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))]">
        <div
          v-for="r in s.rows"
          :key="r.key"
          class="ach-card p-3 flex gap-3 items-start"
          :class="r.at ? `is-earned tier-${r.tier}` : ''"
        >
          <span class="ach-medal shrink-0 h-10 w-10" :class="r.at ? `tier-${r.tier}` : 'is-locked'">
            <span v-if="r.secret" class="i-carbon-help text-[18px]" />
            <span v-else-if="r.emoji" class="text-[18px] leading-none">{{ r.emoji }}</span>
            <span v-else :class="r.icon ?? 'i-carbon-trophy'" class="text-[18px]" />
          </span>
          <div class="flex flex-1 flex-col gap-0.5 min-w-0">
            <span class="text-[13px] font-medium truncate" :class="r.at ? 'text-fg' : 'text-fg-muted'">{{ r.secret ? 'Secret' : r.title }}</span>
            <span class="text-[11.5px] text-fg-faint leading-snug">{{ r.secret ? 'Keep playing to find out' : r.description }}</span>
            <span v-if="r.at" class="text-[11px] num mt-0.5" :class="`ach-tier-text tier-${r.tier}`">{{ TIER_LABEL[r.tier] }} · {{ fmtDate(r.at) }}</span>
            <div v-else-if="r.value !== null && !r.secret" class="mt-1 flex gap-2 items-center">
              <UiProgress :value="r.target ? r.value / r.target : 0" class="flex-1" />
              <span class="text-[11px] text-fg-faint num shrink-0">{{ r.text }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <p v-if="!sections.length && !pluginSections.length" class="hint py-6 text-center">
      Nothing here yet.
    </p>

    <div class="pt-2 flex justify-end">
      <UiButton variant="ghost" size="sm" icon="i-carbon-reset" @click="reset">
        {{ confirmReset ? 'Click again to start over' : 'Start achievements over' }}
      </UiButton>
    </div>
  </div>
</template>

<style scoped>
.ach-card {
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--text) 2%, transparent);
}
.ach-card.is-earned {
  border-color: color-mix(in srgb, var(--tier) 35%, var(--border));
  background: color-mix(in srgb, var(--tier) 7%, transparent);
}
.tier-1 {
  --tier: #c98a4b;
}
.tier-2 {
  --tier: #b9c3cf;
}
.tier-3 {
  --tier: #e8b923;
}
.tier-4 {
  --tier: #8fd3ff;
}
.ach-medal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: #111;
  background: radial-gradient(
    circle at 35% 30%,
    color-mix(in srgb, var(--tier) 55%, white),
    var(--tier) 60%,
    color-mix(in srgb, var(--tier) 65%, black)
  );
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--tier) 60%, black),
    0 2px 10px color-mix(in srgb, var(--tier) 25%, transparent);
}
.ach-medal.is-locked {
  color: var(--text-faint);
  background: color-mix(in srgb, var(--text) 6%, transparent);
  box-shadow: inset 0 0 0 1px var(--border);
}
.ach-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--tier);
}
.ach-tier-text {
  color: color-mix(in srgb, var(--tier) 80%, var(--text));
}
</style>
