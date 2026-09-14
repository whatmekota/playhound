<script setup lang="ts">
import { computed } from 'vue'
import { useScriptStore } from '@/stores/scriptStore'
import { useFunscript } from '@/composables/useFunscript'
import { usePlayerStore } from '@/stores/playerStore'
import { openScriptFiles } from '@/lib/browserApi'
import type { ScriptFile } from '@/stores/scriptStore'

const scriptStore = useScriptStore()
const playerStore = usePlayerStore()
const { loadScriptFiles } = useFunscript()

async function openScripts() {
  const files = await openScriptFiles()
  if (files.length > 0) {
    const videoBasename = playerStore.videoPath?.replace(/\.[^.]+$/, '') ?? ''
    await loadScriptFiles(files, videoBasename)
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toString().padStart(2, '0')}`
}

const CHANNEL_COLORS: Record<string, string> = {
  L0: 'bg-purple-500', L1: 'bg-blue-500', L2: 'bg-cyan-500',
  R0: 'bg-green-500',  R1: 'bg-yellow-500', R2: 'bg-orange-500',
  V0: 'bg-pink-500',   A0: 'bg-red-500',    A1: 'bg-rose-500',
}

function coveragePct(script: ScriptFile): number | null {
  const duration = playerStore.videoDuration
  if (!duration || script.parsed.actions.length === 0) return null
  const lastAt = script.parsed.actions[script.parsed.actions.length - 1].at
  return Math.min(100, Math.round((lastAt / (duration * 1000)) * 100))
}

function coverageColor(pct: number): string {
  if (pct >= 90) return 'text-green-400 bg-green-500/15'
  if (pct >= 60) return 'text-yellow-400 bg-yellow-500/15'
  return 'text-red-400 bg-red-500/15'
}
</script>

<template>
  <div class="flex flex-col gap-3 p-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold text-white/80">Scripts</h2>
      <div class="flex items-center gap-1.5">
        <span v-if="scriptStore.autoDetected"
          class="text-[10px] text-accent-400 bg-accent-600/20 px-2 py-0.5 rounded-full">
          Auto
        </span>
        <button class="btn-ghost text-xs px-2 py-1" @click="openScripts">+ Load</button>
      </div>
    </div>

    <div v-if="!scriptStore.hasScripts" class="text-xs text-white/30 text-center py-4">
      No scripts loaded.<br>Open a video to auto-detect, or load manually.
    </div>

    <div v-else class="flex flex-col gap-0.5">
      <div
        v-for="script in scriptStore.scripts"
        :key="script.path + script.channel"
        class="flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors"
        :class="script.enabled ? 'bg-white/5 hover:bg-white/10' : 'opacity-40 hover:opacity-70'"
        @click="scriptStore.toggleScript(script.path, script.channel)"
      >
        <!-- Channel colour dot -->
        <div class="w-2 h-2 rounded-full shrink-0"
          :class="CHANNEL_COLORS[script.channel] ?? 'bg-gray-500'" />

        <!-- Channel label -->
        <span class="text-xs font-mono text-white/50 w-7 shrink-0">{{ script.channel }}</span>

        <!-- Axis label -->
        <span class="text-xs text-white/80 flex-1 truncate">{{ script.label }}</span>

        <!-- Alt badge -->
        <span v-if="script.isAlt"
          class="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-600/40 text-amber-300 shrink-0 max-w-[6rem] truncate"
          :title="script.altName"
        >{{ script.altName || 'alt' }}</span>

        <!-- Duration -->
        <span class="text-[10px] text-white/25 font-mono shrink-0">
          {{ formatDuration(script.parsed.duration) }}
        </span>

        <!-- Coverage badge -->
        <span v-if="coveragePct(script) !== null"
          class="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
          :class="coverageColor(coveragePct(script)!)"
        >{{ coveragePct(script) }}%</span>

        <!-- Enabled dot -->
        <div class="w-1.5 h-1.5 rounded-full shrink-0"
          :class="script.enabled ? 'bg-accent-400' : 'bg-white/20'" />
      </div>
    </div>
  </div>
</template>
