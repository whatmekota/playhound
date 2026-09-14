<script setup lang="ts">
import { computed, ref } from 'vue'
import { useScriptStore } from '~/stores/scriptStore'

const scriptStore = useScriptStore()
const open = ref(false)

const hasScripts = computed(() => scriptStore.scripts.length > 0)

function clamp(val: number) {
  return Math.max(-9999, Math.min(9999, val))
}

function setOffset(script: typeof scriptStore.scripts[0], val: string) {
  const n = parseInt(val, 10)
  script.offsetMs = isNaN(n) ? 0 : clamp(n)
}

function resetAll() {
  scriptStore.scripts.forEach(s => s.offsetMs = 0)
}
</script>

<template>
  <div class="relative">
    <button
      class="btn-ghost text-xs px-2 py-1 font-mono"
      :class="open ? 'text-accent-400 bg-accent-600/20' : 'text-white/40'"
      title="Script offset (ms)"
      @click="open = !open"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <span>Offset</span>
    </button>

    <Transition name="popup">
      <div
        v-if="open"
        class="absolute bottom-full mb-2 right-0 z-50 rounded-xl border shadow-2xl p-3 w-64"
        style="background:var(--bg-850); border-color:var(--border)"
      >
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-medium" style="color:var(--text-muted)">Script Offset (ms)</span>
          <button class="text-[10px] hover:opacity-80" style="color:var(--text-muted)" @click="resetAll">Reset all</button>
        </div>

        <div v-if="!hasScripts" class="text-xs text-center py-2" style="color:var(--text-faint)">
          No scripts loaded
        </div>

        <div v-else class="flex flex-col gap-1.5">
          <div
            v-for="script in scriptStore.scripts"
            :key="script.path + script.channel"
            class="flex items-center gap-2"
          >
            <!-- Channel badge -->
            <span class="text-[10px] font-mono w-6 shrink-0" style="color:var(--accent)">{{ script.channel }}</span>
            <!-- Label -->
            <span class="text-[11px] flex-1 truncate" style="color:var(--text-muted)" :title="script.label">
              {{ script.label }}
              <span v-if="script.isAlt" class="text-[9px] ml-1 opacity-60">({{ script.altName }})</span>
            </span>
            <!-- Offset input -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                class="w-5 h-5 rounded flex items-center justify-center hover:opacity-80 transition-opacity text-xs"
                style="background:var(--bg-700); color:var(--text)"
                @click="script.offsetMs = clamp(script.offsetMs - 50)"
              >−</button>
              <input
                type="number"
                :value="script.offsetMs"
                class="w-16 text-center text-xs rounded py-0.5 focus:outline-none"
                style="background:var(--bg-900); border:1px solid var(--border); color:var(--text)"
                step="50"
                @change="setOffset(script, ($event.target as HTMLInputElement).value)"
              />
              <button
                class="w-5 h-5 rounded flex items-center justify-center hover:opacity-80 transition-opacity text-xs"
                style="background:var(--bg-700); color:var(--text)"
                @click="script.offsetMs = clamp(script.offsetMs + 50)"
              >+</button>
            </div>
          </div>
        </div>

        <p class="text-[10px] mt-2" style="color:var(--text-faint)">
          + = script ahead of video &nbsp;·&nbsp; − = script behind
        </p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.popup-enter-active, .popup-leave-active { transition: opacity 0.1s, transform 0.1s; }
.popup-enter-from, .popup-leave-to { opacity: 0; transform: translateY(4px); }
</style>
