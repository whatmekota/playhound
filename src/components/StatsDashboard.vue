<script setup lang="ts">
import { computed } from 'vue'
import { useStatsStore } from '~/stores/statsStore'

const statsStore = useStatsStore()

const allStats = computed(() => statsStore.allStats())

// ── Aggregate numbers ──────────────────────────────────────────────────────
const totalFinishes = computed(() => allStats.value.reduce((a, s) => a + s.finishEvents.length, 0))
const totalWatchedMs = computed(() => allStats.value.reduce((a, s) => a + s.totalWatchedMs, 0))
const uniqueVideos = computed(() => allStats.value.filter(s => s.finishEvents.length > 0).length)

// ── Flat finish events sorted newest first ─────────────────────────────────
interface FlatFinish {
  videoName: string
  at: number // seconds into video
  ts: number // unix timestamp
}

const finishTimeline = computed<FlatFinish[]>(() => {
  const events: FlatFinish[] = []
  for (const s of allStats.value) {
    for (const fe of s.finishEvents) {
      events.push({ videoName: s.videoName, at: fe.at, ts: fe.ts })
    }
  }
  return events.sort((a, b) => b.ts - a.ts)
})

// ── Top videos by finish count ─────────────────────────────────────────────
const topVideos = computed(() =>
  allStats.value
    .filter(s => s.finishEvents.length > 0)
    .sort((a, b) => b.finishEvents.length - a.finishEvents.length)
    .slice(0, 5),
)

const maxFinishes = computed(() => topVideos.value[0]?.finishEvents.length ?? 1)

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0)
    return `${h}h ${m}m`
  return `${m}m`
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60); const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0)
    return `${d}d ago`
  if (h > 0)
    return `${h}h ago`
  if (m > 0)
    return `${m}m ago`
  return 'just now'
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function shortName(name: string): string {
  return name.replace(/\.[^.]+$/, '').length > 36
    ? `${name.replace(/\.[^.]+$/, '').slice(0, 36)}…`
    : name.replace(/\.[^.]+$/, '')
}
</script>

<template>
  <div class="text-white bg-surface-950 flex flex-col h-full overflow-hidden">
    <!-- Header -->
    <div class="px-4 py-3 border-b border-white/5 bg-surface-900 flex shrink-0 items-center justify-between">
      <div class="flex gap-2 items-center">
        <span class="text-base">📊</span>
        <h2 class="text-sm text-white/80 font-semibold">
          Stats
        </h2>
      </div>
      <button class="text-[10px] text-white/20 transition-colors hover:text-red-400" @click="statsStore.clearAll()">
        Clear all
      </button>
    </div>

    <div class="scrollbar-thin flex-1 overflow-y-auto">
      <!-- ── Summary cards ──────────────────────────────────────────────── -->
      <div class="p-3 gap-2 grid grid-cols-3">
        <div class="px-3 py-3 text-center border border-pink-500/20 rounded-xl from-pink-600/20 to-purple-600/10 bg-gradient-to-br">
          <div class="text-2xl text-pink-400 font-bold">
            {{ totalFinishes }}
          </div>
          <div class="text-[10px] text-white/40 tracking-wider mt-0.5 uppercase">
            Cums 💦
          </div>
        </div>
        <div class="px-3 py-3 text-center border border-white/5 rounded-xl bg-surface-800/60">
          <div class="text-2xl text-white/70 font-bold">
            {{ uniqueVideos }}
          </div>
          <div class="text-[10px] text-white/40 tracking-wider mt-0.5 uppercase">
            Videos
          </div>
        </div>
        <div class="px-3 py-3 text-center border border-white/5 rounded-xl bg-surface-800/60">
          <div class="text-2xl text-white/70 font-bold">
            {{ fmtMs(totalWatchedMs) }}
          </div>
          <div class="text-[10px] text-white/40 tracking-wider mt-0.5 uppercase">
            Watched
          </div>
        </div>
      </div>

      <!-- ── Top videos bar chart ────────────────────────────────────────── -->
      <div v-if="topVideos.length > 0" class="px-3 pb-3">
        <div class="text-[10px] text-white/30 tracking-widest font-semibold mb-2 px-1 uppercase">
          🏆 Most cummed
        </div>
        <div class="space-y-1.5">
          <div v-for="(s, i) in topVideos" :key="s.videoName" class="group">
            <div class="mb-0.5 flex gap-2 items-center">
              <span class="text-[10px] text-white/25 text-right shrink-0 w-3">{{ i + 1 }}</span>
              <span class="text-[11px] text-white/70 flex-1 truncate" :title="s.videoName">{{ shortName(s.videoName) }}</span>
              <span class="text-[11px] text-pink-400 font-bold shrink-0">{{ s.finishEvents.length }}💦</span>
            </div>
            <div class="flex gap-2 items-center">
              <span class="shrink-0 w-3" />
              <div class="rounded-full bg-white/5 flex-1 h-1.5 overflow-hidden">
                <div
                  class="rounded-full h-full transition-all duration-500 from-pink-500 to-purple-500 bg-gradient-to-r"
                  :style="{ width: `${s.finishEvents.length / maxFinishes * 100}%` }"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Finish timeline ─────────────────────────────────────────────── -->
      <div class="px-3 pb-4">
        <div class="text-[10px] text-white/30 tracking-widest font-semibold mb-2 px-1 uppercase">
          💦 Cum history
        </div>

        <div
          v-if="finishTimeline.length === 0"
          class="text-xs text-white/20 py-10 text-center"
        >
          No cums recorded yet.<br>
          <span class="text-white/10">Hit "💦 Cum" while watching!</span>
        </div>

        <div v-else class="relative">
          <!-- Vertical line -->
          <div class="bg-white/5 w-px bottom-2 left-[19px] top-2 absolute" />

          <div class="space-y-1">
            <div
              v-for="(fe, idx) in finishTimeline" :key="idx"
              class="group flex gap-3 items-start"
            >
              <!-- Dot -->
              <div class="pt-1 flex shrink-0 flex-col w-10 items-center">
                <div class="rounded-full h-2.5 w-2.5 ring-2 ring-surface-950 shadow-pink-500/40 shadow-sm from-pink-500 to-purple-500 bg-gradient-to-br" />
              </div>
              <!-- Content -->
              <div class="px-3 py-2 border border-white/5 rounded-lg bg-surface-800/40 flex-1 min-w-0 transition-colors hover:bg-surface-800/70">
                <div class="flex gap-2 items-center justify-between">
                  <span class="text-[11px] text-white/70 truncate" :title="fe.videoName">{{ shortName(fe.videoName) }}</span>
                  <span class="text-[10px] text-white/25 shrink-0">{{ fmtRelative(fe.ts) }}</span>
                </div>
                <div class="mt-0.5 flex gap-3 items-center">
                  <span class="text-[10px] text-pink-400/70">at {{ fmtTime(fe.at) }}</span>
                  <span class="text-[10px] text-white/20">{{ fmtDate(fe.ts) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
