<script setup lang="ts">
import { ref } from 'vue'
import { usePlayerStore } from '~/stores/playerStore'

const emit = defineEmits<{ speed: [value: number] }>()
const playerStore = usePlayerStore()
const showMenu = ref(false)
const customVal = ref('')

const SPEEDS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

function setSpeed(s: number) {
  const clamped = Math.max(0.1, Math.min(10, s))
  playerStore.playbackSpeed = clamped
  emit('speed', clamped)
  showMenu.value = false
  customVal.value = ''
}

function applyCustom() {
  const v = Number.parseFloat(customVal.value.replace(',', '.'))
  if (!Number.isNaN(v))
    setSpeed(v)
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
      <div v-if="showMenu" class="mb-2 py-1.5 panel min-w-[90px] bottom-full left-1/2 absolute z-50 -translate-x-1/2">
        <!-- Preset buttons -->
        <button
          v-for="s in SPEEDS" :key="s"
          class="text-xs px-3 py-1 text-center w-full transition-colors hover:bg-white/10"
          :class="playerStore.playbackSpeed === s ? 'text-accent-400 font-semibold' : 'text-white/80'"
          @click="setSpeed(s)"
        >
          {{ s === 1 ? '1×' : `${s}×` }}
        </button>

        <!-- Custom input -->
        <div class="mt-1 px-2 pt-1.5 border-t border-white/5 flex gap-1 items-center">
          <input
            v-model="customVal"
            type="text"
            inputmode="decimal"
            placeholder="1.05"
            class="input text-xs font-mono px-1.5 py-0.5 text-center h-6 w-full"
            @keydown.enter="applyCustom"
            @keydown.esc="showMenu = false"
          >
          <button class="btn-ghost text-xs text-accent-400 px-1.5 py-0.5 shrink-0" @click="applyCustom">
            ✓
          </button>
        </div>
      </div>
    </Transition>

    <div v-if="showMenu" class="inset-0 fixed z-40" @click="showMenu = false" />
  </div>
</template>

<style scoped>
.popup-enter-active,
.popup-leave-active {
  transition:
    opacity 0.1s,
    transform 0.1s;
}
.popup-enter-from,
.popup-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}
</style>
