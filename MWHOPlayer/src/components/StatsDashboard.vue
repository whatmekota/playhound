<script setup lang="ts">
import { computed } from 'vue'
import { useStatsStore } from '@/stores/statsStore'
import type { VideoStat } from '@/stores/statsStore'

const statsStore = useStatsStore()

const allStats = computed(() => statsStore.allStats())

// ── Aggregate numbers ──────────────────────────────────────────────────────
const totalFinishes = computed(() => allStats.value.reduce((a, s) => a + s.finishEvents.length, 0))
const totalWatchedMs = computed(() => allStats.value.reduce((a, s) => a + s.totalWatchedMs, 0))
const uniqueVideos = computed(() => allStats.value.filter(s => s.finishEvents.length > 0).length)

// ── Flat finish events sorted newest first ─────────────────────────────────
interface FlatFinish {
  videoName: string
  at: number      // seconds into video
  ts: number      // unix timestamp
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
    .slice(0, 5)
)

const maxFinishes = computed(() => topVideos.value[0]?.finishEvents.length ?? 1)

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  if (m > 0) return `${m}m ago`
  return 'just now'
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function shortName(name: string): string {
  return name.replace(/\.[^.]+$/, '').length > 36
    ? name.replace(/\.[^.]+$/, '').slice(0, 36) + '…'
    : name.replace(/\.[^.]+$/, '')
}
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden bg-surface-950 text-white">

    <!-- Header -->
    <div class="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/5 bg-surface-900">
      <div class="flex items-center gap-2">
        <span class="text-base">📊</span>
        <h2 class="text-sm font-semibold text-white/80">Stats</h2>
      </div>
      <button class="text-[10px] text-white/20 hover:text-red-400 transition-colors" @click="statsStore.clearAll()">Clear all</button>
    </div>

    <div class="flex-1 overflow-y-auto scrollbar-thin">

      <!-- ── Summary cards ──────────────────────────────────────────────── -->
      <div class="grid grid-cols-3 gap-2 p-3">
        <div class="bg-gradient-to-br from-pink-600/20 to-purple-600/10 border border-pink-500/20 rounded-xl px-3 py-3 text-center">
          <div class="text-2xl font-bold text-pink-400">{{ totalFinishes }}</div>
          <div class="text-[10px] text-white/40 mt-0.5 uppercase tracking-wider">Cums 💦</div>
        </div>
        <div class="bg-surface-800/60 border border-white/5 rounded-xl px-3 py-3 text-center">
          <div class="text-2xl font-bold text-white/70">{{ uniqueVideos }}</div>
          <div class="text-[10px] text-white/40 mt-0.5 uppercase tracking-wider">Videos</div>
        </div>
        <div class="bg-surface-800/60 border border-white/5 rounded-xl px-3 py-3 text-center">
          <div class="text-2xl font-bold text-white/70">{{ fmtMs(totalWatchedMs) }}</div>
          <div class="text-[10px] text-white/40 mt-0.5 uppercase tracking-wider">Watched</div>
        </div>
      </div>

      <!-- ── Top videos bar chart ────────────────────────────────────────── -->
      <div v-if="topVideos.length > 0" class="px-3 pb-3">
        <div class="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-2 px-1">🏆 Most cummed</div>
        <div class="space-y-1.5">
          <div v-for="(s, i) in topVideos" :key="s.videoName" class="group">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="text-[10px] text-white/25 w-3 text-right shrink-0">{{ i + 1 }}</span>
              <span class="text-[11px] text-white/70 truncate flex-1" :title="s.videoName">{{ shortName(s.videoName) }}</span>
              <span class="text-[11px] font-bold text-pink-400 shrink-0">{{ s.finishEvents.length }}💦</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-3 shrink-0" />
              <div class="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-pink-500 to-purple-500 transition-all duration-500"
                  :style="{ width: (s.finishEvents.length / maxFinishes * 100) + '%' }"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Finish timeline ─────────────────────────────────────────────── -->
      <div class="px-3 pb-4">
        <div class="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-2 px-1">
          💦 Cum history
        </div>

        <div v-if="finishTimeline.length === 0"
          class="text-center py-10 text-white/20 text-xs">
          No cums recorded yet.<br>
          <span class="text-white/10">Hit "💦 Cum" while watching!</span>
        </div>

        <div v-else class="relative">
          <!-- Vertical line -->
          <div class="absolute left-[19px] top-2 bottom-2 w-px bg-white/5" />

          <div class="space-y-1">
            <div v-for="(fe, idx) in finishTimeline" :key="idx"
              class="flex items-start gap-3 group">
              <!-- Dot -->
              <div class="shrink-0 w-10 flex flex-col items-center pt-1">
                <div class="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-pink-500 to-purple-500 shadow-sm shadow-pink-500/40 ring-2 ring-surface-950" />
              </div>
              <!-- Content -->
              <div class="flex-1 min-w-0 bg-surface-800/40 hover:bg-surface-800/70 border border-white/5 rounded-lg px-3 py-2 transition-colors">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[11px] text-white/70 truncate" :title="fe.videoName">{{ shortName(fe.videoName) }}</span>
                  <span class="shrink-0 text-[10px] text-white/25">{{ fmtRelative(fe.ts) }}</span>
                </div>
                <div class="flex items-center gap-3 mt-0.5">
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
