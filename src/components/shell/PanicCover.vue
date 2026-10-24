<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

/**
 * The privacy cover panic puts up.
 *
 * Opaque from its very first frame — no fade, no transition — because the
 * whole point is that nothing behind it is visible, even for 100ms. It is a
 * deliberately plain clock: not pretending to be any particular app, just
 * quiet and unremarkable, with the way back spelled out for the one person
 * who needs it.
 *
 * It ignores the app theme on purpose (neutral greys, not the accent), so
 * it does not look like playhound either.
 *
 * Resuming takes Esc / ` (handled by the shell), Enter while focused, or a
 * double-click — a single stray click should not lift the cover.
 */
const emit = defineEmits<{ resume: [] }>()

const root = ref<HTMLElement | null>(null)
const now = ref(new Date())
let tick: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  root.value?.focus({ preventScroll: true })
  tick = setInterval(() => (now.value = new Date()), 1000)
})
onUnmounted(() => {
  if (tick !== null)
    clearInterval(tick)
})

const time = computed(() => now.value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
const date = computed(() => now.value.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))
</script>

<template>
  <div
    ref="root"
    class="panic text-neutral-200 outline-none bg-neutral-950 flex flex-col cursor-default select-none items-center inset-0 justify-center fixed z-[9998]"
    role="dialog"
    aria-modal="true"
    aria-label="Paused. Press Escape to resume."
    tabindex="-1"
    @dblclick="emit('resume')"
    @keydown.enter="emit('resume')"
    @contextmenu.prevent
  >
    <div class="text-[clamp(56px,11vw,128px)] leading-none tracking-[-0.04em] font-extralight tabular-nums">
      {{ time }}
    </div>
    <div class="text-[15px] text-neutral-400 mt-4">
      {{ date }}
    </div>

    <div class="text-[11.5px] text-neutral-600 flex gap-2 items-center bottom-8 absolute">
      <kbd class="font-mono px-1.5 border border-neutral-700 rounded inline-flex h-5 items-center">Esc</kbd>
      <span>or</span>
      <kbd class="font-mono px-1.5 border border-neutral-700 rounded inline-flex h-5 items-center">`</kbd>
      <span>to resume</span>
    </div>
  </div>
</template>

<style scoped>
/* A dim vignette — the kind of nothing a lock screen shows. */
.panic {
  background-image: radial-gradient(
    ellipse 80% 70% at 50% 40%,
    color-mix(in srgb, currentColor 5%, transparent),
    transparent 70%
  );
}
</style>
