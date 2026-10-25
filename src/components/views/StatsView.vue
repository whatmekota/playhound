<script setup lang="ts">
import type { VideoStat } from '~/stores/statsStore'
import { useElementSize, useIntervalFn } from '@vueuse/core'
import { computed, ref } from 'vue'
import { formatTime } from '~/lib/time'
import { useLibraryStore } from '~/stores/libraryStore'
import { usePlaybackStore } from '~/stores/playbackStore'
import { dayKey, useStatsStore } from '~/stores/statsStore'

defineOptions({ name: 'StatsView' })

const stats = useStatsStore()
const library = useLibraryStore()
const playback = usePlaybackStore()

const DAY = 86_400_000
const CHART_H = 168
const AXIS_W = 40
const AXIS_H = 20

// The running session is only written to the totals when it ends, so tick a
// clock while one is live and fold it in, or "today" lags behind reality.
const now = ref(Date.now())
useIntervalFn(() => (now.value = Date.now()), 15_000)
const liveMs = computed(() => (stats.live ? Math.max(0, now.value - stats.live.since) : 0))

const all = computed(() => stats.allStats())
const hasAny = computed(() => all.value.length > 0 || Object.keys(stats.daily).length > 0)

// ─── Headline numbers ────────────────────────────────────────────────────────
const totalMs = computed(() => all.value.reduce((a, s) => a + s.totalWatchedMs, 0) + liveMs.value)
const totalPlays = computed(() => all.value.reduce((a, s) => a + s.totalPlays, 0))
const totalFinishes = computed(() => all.value.reduce((a, s) => a + s.finishEvents.length, 0))
const totalEdges = computed(() => all.value.reduce((a, s) => a + (s.edgeEvents?.length ?? 0), 0))
const videosWatched = computed(() => all.value.filter(s => s.totalPlays > 0).length)

function dayMs(key: string) {
  return (stats.daily[key]?.ms ?? 0) + (key === dayKey(now.value) ? liveMs.value : 0)
}
const weekMs = computed(() => {
  let ms = 0
  for (let i = 0; i < 7; i++)
    ms += dayMs(dayKey(now.value - i * DAY))
  return ms
})
const streak = computed(() => {
  let n = 0
  // Today not watched yet does not break a streak that ran until yesterday.
  let i = dayMs(dayKey(now.value)) > 0 ? 0 : 1
  while (dayMs(dayKey(now.value - i * DAY)) > 0) {
    n++
    i++
  }
  return n
})

// ─── Formatting ──────────────────────────────────────────────────────────────
function fmtDur(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1)
    return ms > 0 ? '<1m' : '0m'
  const h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m`
}
function fmtRelative(ts: number): string {
  const diff = now.value - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 6)
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (d > 0)
    return `${d}d ago`
  if (h > 0)
    return `${h}h ago`
  return m > 0 ? `${m}m ago` : 'just now'
}
const stripExt = (n: string) => n.replace(/\.[^.]+$/, '')

// ─── Column chart geometry ───────────────────────────────────────────────────
interface Bar { x: number, y: number, w: number, h: number, d: string }
interface Geometry { bars: Bar[], ticks: { y: number, label: string }[], band: number }

/** Rounded data end at the top, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
}

function geometry(values: number[], width: number, tickLabel: (v: number) => string, step: number): Geometry {
  const plotW = Math.max(0, width - AXIS_W)
  const plotH = CHART_H - AXIS_H
  const max = Math.max(...values, 0)
  // Round the top of the scale up to a whole step so gridlines land on clean values.
  const top = max > 0 ? Math.ceil(max / step) * step : step
  const band = values.length ? plotW / values.length : 0
  const w = Math.max(1, band - 2)
  const bars = values.map((v, i) => {
    const h = v > 0 ? Math.max(2, (v / top) * plotH) : 0
    const x = AXIS_W + i * band + 1
    const y = plotH - h
    return { x, y, w, h, d: h ? columnPath(x, y, w, h) : '' }
  })
  const ticks = [0, 0.5, 1].map(f => ({ y: plotH - f * plotH, label: tickLabel(top * f) }))
  return { bars, ticks, band }
}

/** A step that gives a readable scale: 15 minutes up to an hour, then whole hours. */
function msStep(max: number) {
  const m = max / 60000
  return (m <= 30 ? 10 : m <= 60 ? 15 : m <= 180 ? 30 : 60) * 60000
}

// ─── Time watched per day ────────────────────────────────────────────────────
const range = ref<14 | 30 | 90>(30)
const dailyEl = ref<HTMLElement | null>(null)
const { width: dailyW } = useElementSize(dailyEl)

const days = computed(() => {
  const out: { key: string, ts: number, ms: number, plays: number }[] = []
  for (let i = range.value - 1; i >= 0; i--) {
    const ts = now.value - i * DAY
    const key = dayKey(ts)
    out.push({ key, ts, ms: dayMs(key), plays: stats.daily[key]?.plays ?? 0 })
  }
  return out
})
const daysWithData = computed(() => days.value.filter(d => d.ms > 0).length)
const dailyGeo = computed(() => {
  const values = days.value.map(d => d.ms)
  return geometry(values, dailyW.value, v => (v ? fmtDur(v) : '0'), msStep(Math.max(...values, 0)))
})
/** Label roughly every week so the axis never crowds. */
const dayLabelEvery = computed(() => (range.value <= 14 ? 2 : range.value <= 30 ? 5 : 14))

const hoverDay = ref<number | null>(null)
function onDailyMove(e: PointerEvent) {
  const r = (e.currentTarget as SVGElement).getBoundingClientRect()
  const i = Math.floor((e.clientX - r.left - AXIS_W) / dailyGeo.value.band)
  hoverDay.value = i >= 0 && i < days.value.length ? i : null
}

// ─── When finishes happen ────────────────────────────────────────────────────
const hourEl = ref<HTMLElement | null>(null)
const { width: hourW } = useElementSize(hourEl)
const hours = computed(() => {
  const h = Array.from<number>({ length: 24 }).fill(0)
  for (const s of all.value) {
    for (const f of s.finishEvents)
      h[new Date(f.ts).getHours()]++
  }
  return h
})
const hourGeo = computed(() => {
  const max = Math.max(...hours.value)
  return geometry(hours.value, hourW.value, v => String(Math.round(v)), max <= 4 ? 2 : max <= 10 ? 5 : 10)
})
const hoverHour = ref<number | null>(null)
function onHourMove(e: PointerEvent) {
  const r = (e.currentTarget as SVGElement).getBoundingClientRect()
  const i = Math.floor((e.clientX - r.left - AXIS_W) / hourGeo.value.band)
  hoverHour.value = i >= 0 && i < 24 ? i : null
}
const peakHour = computed(() => {
  const max = Math.max(...hours.value)
  return max > 0 ? hours.value.indexOf(max) : null
})

// ─── Top videos ──────────────────────────────────────────────────────────────
type Metric = 'time' | 'plays' | 'finishes'
const metric = ref<Metric>('time')
function metricOf(s: VideoStat, m: Metric) {
  return m === 'time' ? s.totalWatchedMs + (stats.live?.videoName === s.videoName ? liveMs.value : 0) : m === 'plays' ? s.totalPlays : s.finishEvents.length
}

const top = computed(() =>
  all.value
    .map(s => ({ s, v: metricOf(s, metric.value) }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 8),
)
const topMax = computed(() => top.value[0]?.v ?? 1)
const fmtMetric = (v: number) => (metric.value === 'time' ? fmtDur(v) : String(v))

const entryFor = (name: string) => library.videos.find(v => v.name === name) ?? null
function play(name: string) {
  const e = entryFor(name)
  if (e)
    void playback.play(e)
}

// ─── Recent ──────────────────────────────────────────────────────────────────
const recent = computed(() => all.value.filter(s => s.lastPlayedAt > 0).slice(0, 8))
const finishes = computed(() =>
  all.value
    .flatMap(s => s.finishEvents.map(f => ({ name: s.videoName, at: f.at, ts: f.ts })))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12),
)

// ─── Clear ───────────────────────────────────────────────────────────────────
const confirmClear = ref(false)
function clearAll() {
  stats.clearAll()
  confirmClear.value = false
}

function fmtDay(ts: number, long = false) {
  return new Date(ts).toLocaleDateString(undefined, long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="bg-surface-950 flex flex-col h-full min-h-0">
    <!-- Header -->
    <header class="px-6 pb-4 pt-5 border-b border-edge flex shrink-0 gap-4 items-end">
      <div class="flex-1 min-w-0">
        <h1 class="h-view">
          Stats
        </h1>
        <p class="text-[12.5px] text-fg-muted mt-0.5">
          What you have watched, how long, and when. Kept in this browser only.
        </p>
      </div>
      <UiBadge v-if="stats.live" tone="ok" dot pulse>
        Recording
      </UiBadge>
      <UiButton v-if="hasAny" variant="ghost" icon="i-carbon-trash-can" @click="confirmClear = true">
        Clear
      </UiButton>
    </header>

    <div class="scroll-y flex-1">
      <UiEmpty
        v-if="!hasAny"
        size="lg"
        icon="i-carbon-chart-bar"
        title="Nothing recorded yet"
        description="Play something and it shows up here: time watched per day, your most played videos and when you finish."
        class="mt-12"
      />

      <div v-else class="mx-auto px-6 pb-[240px] pt-5 flex flex-col gap-4 max-w-[1120px] animate-rise">
        <!-- Headline tiles -->
        <div class="gap-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
          <div class="p-4 card">
            <UiStat label="Time watched" :value="fmtDur(totalMs)" size="lg" tone="accent" />
          </div>
          <div class="p-4 card">
            <UiStat label="Last 7 days" :value="fmtDur(weekMs)" size="lg" />
          </div>
          <div class="p-4 card">
            <UiStat label="Plays" :value="totalPlays.toLocaleString()" size="lg" :hint="`${videosWatched} different videos`" />
          </div>
          <div class="p-4 card">
            <UiStat label="Finishes" :value="totalFinishes" size="lg" />
          </div>
          <div class="p-4 card">
            <UiStat label="Edges" :value="totalEdges" size="lg" :hint="stats.sessionEdges ? `${stats.sessionEdges} this session` : 'Called with E, the gamepad or the phone'" />
          </div>
          <div class="p-4 card">
            <UiStat label="Day streak" :value="streak" :unit="streak === 1 ? 'day' : 'days'" size="lg" hint="Consecutive days with something watched" />
          </div>
        </div>

        <!-- Per day -->
        <section class="p-4 card flex flex-col gap-3">
          <div class="flex gap-3 items-center">
            <div class="flex-1 min-w-0">
              <h2 class="text-[14px] text-fg font-semibold">
                Time watched per day
              </h2>
              <p class="hint">
                {{ daysWithData }} of the last {{ range }} days
              </p>
            </div>
            <UiSegmented
              v-model="range"
              size="xs"
              :options="[{ value: 14, label: '2w' }, { value: 30, label: '30d' }, { value: 90, label: '90d' }]"
            />
          </div>
          <div ref="dailyEl" class="relative" :style="{ height: `${CHART_H}px` }">
            <svg v-if="dailyW" :width="dailyW" :height="CHART_H" class="block overflow-visible" role="img" aria-label="Time watched per day" @pointermove="onDailyMove" @pointerleave="hoverDay = null">
              <g>
                <template v-for="(t, i) in dailyGeo.ticks" :key="i">
                  <line :x1="AXIS_W" :x2="dailyW" :y1="t.y" :y2="t.y" stroke="var(--border)" :stroke-dasharray="i ? '2 3' : undefined" />
                  <text :x="AXIS_W - 8" :y="t.y" dy="0.32em" text-anchor="end" class="text-[10.5px] num" fill="var(--text-faint)">{{ t.label }}</text>
                </template>
              </g>
              <g>
                <path
                  v-for="(b, i) in dailyGeo.bars"
                  :key="days[i].key"
                  :d="b.d"
                  fill="var(--accent)"
                  class="transition-opacity duration-150"
                  :opacity="hoverDay === null || hoverDay === i ? 1 : 0.45"
                />
              </g>
              <g>
                <template v-for="(d, i) in days" :key="d.key">
                  <text
                    v-if="(days.length - 1 - i) % dayLabelEvery === 0"
                    :x="dailyGeo.bars[i].x + dailyGeo.bars[i].w / 2"
                    :y="CHART_H - 4"
                    text-anchor="middle"
                    class="text-[10.5px]"
                    fill="var(--text-faint)"
                  >{{ i === days.length - 1 ? 'Today' : fmtDay(d.ts) }}</text>
                </template>
              </g>
              <rect :x="AXIS_W" y="0" :width="Math.max(0, dailyW - AXIS_W)" :height="CHART_H - AXIS_H" fill="transparent" />
            </svg>
            <Transition name="t-fade">
              <div
                v-if="hoverDay !== null && dailyGeo.bars[hoverDay]"
                class="px-2.5 py-1.5 pop pointer-events-none whitespace-nowrap absolute z-1 -translate-x-1/2"
                :style="{ left: `${Math.min(Math.max(dailyGeo.bars[hoverDay].x + dailyGeo.bars[hoverDay].w / 2, 70), dailyW - 70)}px`, top: '-8px' }"
              >
                <p class="text-[11px] text-fg-muted">
                  {{ fmtDay(days[hoverDay].ts, true) }}
                </p>
                <p class="text-[13px] text-fg font-semibold num">
                  {{ fmtDur(days[hoverDay].ms) }}
                  <span class="text-[11px] text-fg-faint font-normal">· {{ days[hoverDay].plays }} {{ days[hoverDay].plays === 1 ? 'play' : 'plays' }}</span>
                </p>
              </div>
            </Transition>
          </div>
          <p v-if="!Object.keys(stats.daily).length" class="hint">
            Daily history started recording with this version — earlier watch time only counts in the totals.
          </p>
        </section>

        <div class="gap-4 grid lg:grid-cols-2">
          <!-- Top videos -->
          <section class="p-4 card flex flex-col gap-3" :class="totalFinishes ? '' : 'lg:col-span-2'">
            <div class="flex gap-3 items-center">
              <h2 class="text-[14px] text-fg font-semibold flex-1">
                Most watched
              </h2>
              <UiSegmented
                v-model="metric"
                size="xs"
                :options="[{ value: 'time', label: 'Time' }, { value: 'plays', label: 'Plays' }, { value: 'finishes', label: 'Finishes' }]"
              />
            </div>
            <p v-if="!top.length" class="hint py-6 text-center">
              Nothing to rank by {{ metric === 'time' ? 'time' : metric }} yet.
            </p>
            <TransitionGroup v-else name="t-list" tag="ol" class="flex flex-col gap-1 relative">
              <li v-for="(x, i) in top" :key="x.s.videoName" class="group px-1.5 py-1 rounded-[var(--radius-md)] hoverable flex gap-3 items-center">
                <span class="text-[11px] text-fg-faint num text-right shrink-0 w-4">{{ i + 1 }}</span>
                <div class="rounded-[var(--radius-sm)] bg-surface-800 shrink-0 h-9 w-16 relative overflow-hidden">
                  <img v-if="entryFor(x.s.videoName)?.thumbnailUrl" :src="entryFor(x.s.videoName)!.thumbnailUrl!" alt="" class="h-full w-full object-cover">
                  <span v-else class="i-carbon-video text-[14px] text-fg-faint left-1/2 top-1/2 absolute -translate-x-1/2 -translate-y-1/2" />
                  <button
                    v-if="entryFor(x.s.videoName)"
                    type="button"
                    class="text-white bg-black/50 opacity-0 center transition-opacity inset-0 absolute focus-visible:opacity-100 group-hover:opacity-100"
                    :aria-label="`Play ${stripExt(x.s.videoName)}`"
                    @click="play(x.s.videoName)"
                  >
                    <span class="i-carbon-play-filled-alt text-[16px]" />
                  </button>
                </div>
                <div class="flex flex-1 flex-col gap-1.5 min-w-0">
                  <div class="flex gap-2 items-baseline">
                    <span v-tip="x.s.videoName" class="text-[12.5px] text-fg flex-1 truncate">{{ stripExt(x.s.videoName) }}</span>
                    <span class="text-[12px] text-fg-muted num shrink-0">{{ fmtMetric(x.v) }}</span>
                  </div>
                  <div class="rounded-full bg-fg/6 h-1 overflow-hidden">
                    <div class="rounded-full bg-accent h-full transition-[width] duration-500 ease-[var(--ease-out)]" :style="{ width: `${(x.v / topMax) * 100}%` }" />
                  </div>
                </div>
              </li>
            </TransitionGroup>
          </section>

          <!-- Finish hours -->
          <section v-if="totalFinishes" class="p-4 card flex flex-col gap-3">
            <div>
              <h2 class="text-[14px] text-fg font-semibold">
                Finishes by hour
              </h2>
              <p class="hint">
                Most often around {{ String(peakHour).padStart(2, '0') }}:00
              </p>
            </div>
            <div ref="hourEl" class="relative" :style="{ height: `${CHART_H}px` }">
              <svg v-if="hourW" :width="hourW" :height="CHART_H" class="block overflow-visible" role="img" aria-label="Finishes by hour of day" @pointermove="onHourMove" @pointerleave="hoverHour = null">
                <template v-for="(t, i) in hourGeo.ticks" :key="i">
                  <line :x1="AXIS_W" :x2="hourW" :y1="t.y" :y2="t.y" stroke="var(--border)" :stroke-dasharray="i ? '2 3' : undefined" />
                  <text :x="AXIS_W - 8" :y="t.y" dy="0.32em" text-anchor="end" class="text-[10.5px] num" fill="var(--text-faint)">{{ t.label }}</text>
                </template>
                <path
                  v-for="(b, i) in hourGeo.bars"
                  :key="i"
                  :d="b.d"
                  fill="var(--accent)"
                  class="transition-opacity duration-150"
                  :opacity="hoverHour === null || hoverHour === i ? 1 : 0.45"
                />
                <template v-for="h in [0, 6, 12, 18, 23]" :key="h">
                  <text
                    :x="hourGeo.bars[h].x + hourGeo.bars[h].w / 2"
                    :y="CHART_H - 4"
                    text-anchor="middle"
                    class="text-[10.5px] num"
                    fill="var(--text-faint)"
                  >{{ String(h).padStart(2, '0') }}</text>
                </template>
              </svg>
              <Transition name="t-fade">
                <div
                  v-if="hoverHour !== null && hourGeo.bars[hoverHour]"
                  class="px-2.5 py-1.5 pop pointer-events-none whitespace-nowrap absolute z-1 -translate-x-1/2"
                  :style="{ left: `${Math.min(Math.max(hourGeo.bars[hoverHour].x + hourGeo.bars[hoverHour].w / 2, 60), hourW - 60)}px`, top: '-8px' }"
                >
                  <p class="text-[11px] text-fg-muted num">
                    {{ String(hoverHour).padStart(2, '0') }}:00 – {{ String((hoverHour + 1) % 24).padStart(2, '0') }}:00
                  </p>
                  <p class="text-[13px] text-fg font-semibold num">
                    {{ hours[hoverHour] }} <span class="text-[11px] text-fg-faint font-normal">{{ hours[hoverHour] === 1 ? 'finish' : 'finishes' }}</span>
                  </p>
                </div>
              </Transition>
            </div>
          </section>

          <!-- Recently played -->
          <section class="p-4 card flex flex-col gap-2">
            <h2 class="text-[14px] text-fg font-semibold">
              Recently played
            </h2>
            <ul class="flex flex-col">
              <li v-for="s in recent" :key="s.videoName" class="group px-1.5 rounded-[var(--radius-md)] hoverable flex gap-3 h-9 items-center">
                <span
                  class="rounded-full shrink-0 h-1.5 w-1.5"
                  :class="stats.live?.videoName === s.videoName ? 'bg-ok text-ok animate-pulse-dot' : 'bg-fg/20'"
                />
                <span v-tip="s.videoName" class="text-[12.5px] text-fg flex-1 truncate">{{ stripExt(s.videoName) }}</span>
                <span class="text-[11.5px] text-fg-faint num shrink-0">{{ s.totalPlays }}×</span>
                <span class="text-[11.5px] text-fg-muted text-right shrink-0 w-16">{{ stats.live?.videoName === s.videoName ? 'now' : fmtRelative(s.lastPlayedAt) }}</span>
                <UiIconButton
                  v-if="entryFor(s.videoName)"
                  icon="i-carbon-play-filled-alt"
                  label="Play"
                  size="xs"
                  class="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  @click="play(s.videoName)"
                />
              </li>
            </ul>
          </section>

          <!-- Finish history -->
          <section v-if="finishes.length" class="p-4 card flex flex-col gap-2">
            <h2 class="text-[14px] text-fg font-semibold">
              Finish history
            </h2>
            <ol class="pl-4 flex flex-col relative">
              <span class="bg-edge-strong w-px bottom-3 left-[5px] top-3 absolute" />
              <li v-for="f in finishes" :key="`${f.name}-${f.ts}`" class="flex gap-3 h-9 items-center relative">
                <span class="rounded-full bg-accent h-2 w-2 ring-3 ring-surface-850 absolute -left-3.5" />
                <span v-tip="f.name" class="text-[12.5px] text-fg flex-1 truncate">{{ stripExt(f.name) }}</span>
                <UiBadge size="xs" tone="accent">
                  at {{ formatTime(f.at) }}
                </UiBadge>
                <span class="text-[11.5px] text-fg-muted text-right shrink-0 w-16">{{ fmtRelative(f.ts) }}</span>
              </li>
            </ol>
          </section>
        </div>
      </div>
    </div>

    <UiModal v-model:open="confirmClear" title="Clear all stats?" icon="i-carbon-trash-can" width="420px">
      <p class="text-[13px] text-fg-muted leading-relaxed">
        Watch time, plays, the daily history and every recorded finish are deleted from this browser.
        Export a backup first if you might want them back.
      </p>
      <template #footer>
        <UiButton variant="ghost" @click="confirmClear = false">
          Cancel
        </UiButton>
        <UiButton variant="danger" icon="i-carbon-trash-can" @click="clearAll">
          Clear stats
        </UiButton>
      </template>
    </UiModal>
  </div>
</template>
