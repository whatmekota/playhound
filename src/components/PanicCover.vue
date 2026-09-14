<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const emit = defineEmits<{ resume: [] }>()

const now = ref(new Date())
let tick: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  tick = setInterval(() => {
    now.value = new Date()
  }, 1000)
})
onUnmounted(() => {
  if (tick !== null)
    clearInterval(tick)
})

const time = computed(() =>
  now.value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
)
const date = computed(() =>
  now.value.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }),
)
</script>

<template>
  <!--
    A deliberately plain, anonymous screen. It is not pretending to be any
    particular application — it just needs to be quiet and unremarkable, and to
    make the way back obvious to the one person who needs it.
  -->
  <div
    class="flex flex-col gap-2 select-none items-center inset-0 justify-center fixed z-[9998]"
    style="background: #101014; color: rgba(255, 255, 255, 0.85)"
    role="button"
    tabindex="0"
    aria-label="Paused. Click or press Escape to resume."
    @click="emit('resume')"
    @keydown.enter="emit('resume')"
    @keydown.space.prevent="emit('resume')"
  >
    <div class="text-6xl tracking-tight font-light tabular-nums">
      {{ time }}
    </div>
    <div class="text-sm" style="color: rgba(255, 255, 255, 0.35)">
      {{ date }}
    </div>

    <div
      class="text-[11px] tracking-wide mt-10"
      style="color: rgba(255, 255, 255, 0.18)"
    >
      Click anywhere or press Esc to resume
    </div>
  </div>
</template>
