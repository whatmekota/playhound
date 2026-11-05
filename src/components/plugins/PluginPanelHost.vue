<script setup lang="ts">
import type { PanelDef } from '~/plugins/types'
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** Hands a plugin a plain element to build its panel in, and cleans up after it. */
const props = defineProps<{ panel: PanelDef, pluginId: string }>()
const el = ref<HTMLElement | null>(null)
const failed = ref<string | null>(null)
let cleanup: (() => void) | void

onMounted(() => {
  try {
    cleanup = props.panel.mount(el.value!)
  }
  catch (err) {
    console.error(`[plugin ${props.pluginId}] panel failed`, err)
    failed.value = err instanceof Error ? err.message : String(err)
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
  <div class="flex flex-1 flex-col min-h-0">
    <p v-if="failed" class="text-[12px] text-danger m-0 px-3 py-2">
      The panel failed to open: {{ failed }}
    </p>
    <div ref="el" class="plugin-panel flex flex-1 flex-col min-h-0" :data-plugin="pluginId" />
  </div>
</template>
