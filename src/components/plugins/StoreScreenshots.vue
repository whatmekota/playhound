<script setup lang="ts">
import type { ImageRef } from '~/plugins/storeCache'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { loadImage } from '~/plugins/storeCache'

/**
 * A plugin's screenshots: a strip of them, and one at a time, large, on a
 * click (arrow keys step, Esc closes). Ones that fail to load or aren't fit
 * pictures are left out.
 */
const props = defineProps<{ shots: { image: ImageRef, caption?: string }[], name: string }>()

const urls = ref<(string | null)[]>([])
const loading = ref(false)
watch(() => props.shots.map(s => (s.image.kind === 'release' ? s.image.url : s.image.key)).join('\n'), async () => {
  const list = props.shots
  loading.value = true
  urls.value = list.map(() => null)
  const got = await Promise.all(list.map(s => loadImage(s.image, 'screenshot')))
  if (list === props.shots)
    urls.value = got
  loading.value = false
}, { immediate: true })

const shown = computed(() => props.shots.map((s, i) => ({ ...s, url: urls.value[i] })).filter(s => s.url) as { url: string, caption?: string }[])

const open = ref<number | null>(null)
const current = computed(() => (open.value === null ? null : shown.value[open.value] ?? null))
function step(d: number) {
  if (open.value === null || !shown.value.length)
    return
  open.value = (open.value + d + shown.value.length) % shown.value.length
}

// On window, capturing: ahead of the Settings dialog's own Esc, so Esc closes only this.
function onKey(e: KeyboardEvent) {
  if (open.value === null)
    return
  if (e.key === 'Escape')
    open.value = null
  else if (e.key === 'ArrowRight')
    step(1)
  else if (e.key === 'ArrowLeft')
    step(-1)
  else return
  e.stopPropagation()
  e.preventDefault()
}
watch(open, (o) => {
  if (o !== null)
    window.addEventListener('keydown', onKey, true)
  else
    window.removeEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div v-if="shown.length || loading" class="shots px-1 pb-1 flex gap-2 overflow-x-auto snap-x -mx-1">
    <template v-if="!shown.length">
      <span v-for="n in Math.min(shots.length, 3)" :key="n" class="rounded-[var(--radius-md)] bg-surface-800 shrink-0 h-[132px] w-[210px] animate-pulse" />
    </template>
    <button
      v-for="(s, i) in shown"
      :key="s.url"
      type="button"
      class="group focusable border border-edge rounded-[var(--radius-md)] bg-surface-800 shrink-0 h-[132px] relative overflow-hidden snap-start"
      :aria-label="s.caption ? `Screenshot: ${s.caption}` : `Screenshot ${i + 1} of ${name}`"
      @click="open = i"
    >
      <img :src="s.url" alt="" class="h-full w-auto block transition-transform duration-300 group-hover:scale-[1.03]" draggable="false">
      <span v-if="s.caption" class="cap text-[11px] text-white px-2 pb-1.5 pt-4 text-left truncate inset-x-0 bottom-0 absolute">{{ s.caption }}</span>
    </button>
  </div>

  <Teleport to="body">
    <Transition name="t-modal">
      <div
        v-if="current"
        class="p-6 bg-black/85 flex flex-col gap-3 items-center inset-0 justify-center fixed z-[950] backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        :aria-label="`Screenshots of ${name}`"
        @pointerdown.self="open = null"
      >
        <img :src="current.url" :alt="current.caption ?? ''" class="rounded-[var(--radius-md)] max-h-[82vh] max-w-[92vw] shadow-[var(--shadow-pop)] object-contain" draggable="false">
        <div class="text-[12.5px] text-white/85 flex gap-3 items-center">
          <span v-if="current.caption">{{ current.caption }}</span>
          <span v-if="shown.length > 1" class="text-white/50 num">{{ (open ?? 0) + 1 }} / {{ shown.length }}</span>
        </div>
        <button type="button" class="nav right-4 top-4" aria-label="Close" @click="open = null">
          <span class="i-carbon-close text-[20px]" />
        </button>
        <template v-if="shown.length > 1">
          <button type="button" class="nav left-4 top-1/2 -translate-y-1/2" aria-label="Previous" @click="step(-1)">
            <span class="i-carbon-chevron-left text-[22px]" />
          </button>
          <button type="button" class="nav right-4 top-1/2 -translate-y-1/2" aria-label="Next" @click="step(1)">
            <span class="i-carbon-chevron-right text-[22px]" />
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nav {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  color: #fff;
  background: rgb(255 255 255 / 0.1);
  transition: background-color 0.15s;
}
.nav:hover {
  background: rgb(255 255 255 / 0.2);
}
.nav:focus-visible {
  outline: 2px solid var(--accent);
}
.shots {
  scrollbar-width: thin;
}
.cap {
  background: linear-gradient(to top, rgb(0 0 0 / 0.7), transparent);
}
</style>
