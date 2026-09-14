<script setup lang="ts">
import { ref } from 'vue'
import { usePlayerStore } from '~/stores/playerStore'

const playerStore = usePlayerStore()
const showMenu = ref(false)
const customVal = ref('')

const SPEEDS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

const emit = defineEmits<{ speed: [value: number] }>()

function setSpeed(s: number) {
  const clamped = Math.max(0.1, Math.min(10, s))
  playerStore.playbackSpeed = clamped
  emit('speed', clamped)
  showMenu.value = false
  customVal.value = ''
}

function applyCustom() {
  const v = parseFloat(customVal.value.replace(',', '.'))
  if (!isNaN(v)) setSpeed(v)
}
</script>

<template>
  <div class="relative">
    <button
      class="btn-ghost text-xs font-mono min-w-[3.5rem] justify-center"
      @click="showMenu = !showMenu"
    >
      {{ playerStore.playbackSpeed === 1 ? '1×' : `${playerStore.playbackSpeed}×` }}
    </button>

    <Transition name="popup">
      <div v-if="showMenu" class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 panel py-1.5 z-50 min-w-[90px]">
        <!-- Preset buttons -->
        <button
          v-for="s in SPEEDS" :key="s"
          class="w-full px-3 py-1 text-xs text-center hover:bg-white/10 transition-colors"
          :class="playerStore.playbackSpeed === s ? 'text-accent-400 font-semibold' : 'text-white/80'"
          @click="setSpeed(s)"
        >{{ s === 1 ? '1×' : `${s}×` }}</button>

        <!-- Custom input -->
        <div class="flex items-center gap-1 px-2 pt-1.5 mt-1 border-t border-white/5">
          <input
            v-model="customVal"
            type="text"
            inputmode="decimal"
            placeholder="1.05"
            class="input text-xs py-0.5 px-1.5 h-6 w-full font-mono text-center"
            @keydown.enter="applyCustom"
            @keydown.esc="showMenu = false"
          />
          <button class="btn-ghost px-1.5 py-0.5 text-xs text-accent-400 shrink-0" @click="applyCustom">✓</button>
        </div>
      </div>
    </Transition>

    <div v-if="showMenu" class="fixed inset-0 z-40" @click="showMenu = false" />
  </div>
</template>

<style scoped>
.popup-enter-active, .popup-leave-active { transition: opacity 0.1s, transform 0.1s; }
.popup-enter-from, .popup-leave-to { opacity: 0; transform: translateX(-50%) translateY(4px); }
</style>
