<script setup lang="ts">
import { ref } from 'vue'
import { serialLog } from '@/lib/serialLog'

const open = ref(false)

function clearLog() { serialLog.value = [] }
</script>

<template>
  <div class="relative">
    <button
      class="btn-ghost text-xs px-2 py-1"
      :class="open ? 'text-accent-400 bg-accent-600/20' : 'text-white/40'"
      title="Serial log"
      @click="open = !open"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
      </svg>
      Log
    </button>

    <Transition name="popup">
      <div
        v-if="open"
        class="absolute top-full mt-2 right-0 z-50 rounded-xl border shadow-2xl flex flex-col"
        style="background:var(--bg-850); border-color:var(--border); width:420px; height:260px"
      >
        <!-- Header -->
        <div class="flex items-center justify-between px-3 py-2 border-b shrink-0"
          style="border-color:var(--border)">
          <span class="text-xs font-medium font-mono" style="color:var(--text-muted)">Serial Log</span>
          <div class="flex items-center gap-2">
            <span class="text-[10px]" style="color:var(--text-faint)">{{ serialLog.length }} cmds</span>
            <button class="text-[10px] hover:opacity-80" style="color:var(--text-muted)" @click="clearLog">Clear</button>
          </div>
        </div>
        <!-- Log lines -->
        <div class="flex-1 overflow-y-auto p-2 font-mono">
          <div v-if="!serialLog.length" class="text-[11px] text-center mt-4" style="color:var(--text-faint)">
            No commands yet
          </div>
          <div
            v-for="(line, i) in serialLog"
            :key="i"
            class="text-[11px] leading-5 truncate hover:whitespace-normal hover:overflow-visible hover:z-10"
            style="color:var(--text-muted)"
          >
            <span style="color:var(--text-faint)">{{ line.slice(0, 8) }}</span>
            <span style="color:var(--accent)">{{ line.slice(8) }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.popup-enter-active, .popup-leave-active { transition: opacity 0.1s, transform 0.1s; }
.popup-enter-from, .popup-leave-to { opacity: 0; transform: translateY(4px); }
</style>
