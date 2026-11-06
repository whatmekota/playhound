<script setup lang="ts">
import type { OverlayDef } from '~/plugins/types'
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** One plugin's layer over the video: a plain element filling the picture, and its cleanup. */
const props = defineProps<{ overlay: OverlayDef, pluginId: string }>()
const el = ref<HTMLElement | null>(null)
let cleanup: (() => void) | void

onMounted(() => {
  try {
    cleanup = props.overlay.mount(el.value!)
  }
  catch (err) {
    // A broken layer just isn't there; the video plays on under it.
    console.error(`[plugin ${props.pluginId}] overlay failed`, err)
  }
})
onBeforeUnmount(() => {
  try {
    cleanup?.()
  }
  catch {}
})
</script>

<template>
  <div
    ref="el"
    class="plugin-overlay inset-0 absolute overflow-hidden"
    :class="overlay.interactive ? 'pointer-events-auto' : 'pointer-events-none'"
    :data-plugin="pluginId"
  />
</template>
