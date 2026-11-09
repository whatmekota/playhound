<script setup lang="ts">
import type { PluginManifest, PluginPermission } from '~/plugins/types'
import { computed } from 'vue'
import { accessOf, PERMISSIONS } from '~/plugins/manifest'

/**
 * What a plugin may do, in plain words: its permissions, or that it has full
 * access because it was written before plugins asked for them. `added` marks
 * the ones an update asks for that the installed version didn't have.
 */
const props = defineProps<{ manifest: PluginManifest, added?: PluginPermission[] }>()

const access = computed(() => accessOf(props.manifest))
const rows = computed(() => {
  const a = access.value
  return a.full ? [] : PERMISSIONS.filter(p => a.granted.has(p.id))
})
const isNew = (p: PluginPermission) => !!props.added?.includes(p)
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <template v-if="access.full">
      <span class="text-[12.5px] text-warn font-medium flex gap-1.5 items-center">
        <span class="i-carbon-warning-alt text-[14px] shrink-0" /> Full access (older plugin)
      </span>
      <span class="hint">It was made before plugins asked for permissions, so it can do anything plugins could then, including moving your device. Anything newer it has to ask for.</span>
    </template>
    <template v-else-if="rows.length">
      <span class="text-[12px] text-fg-muted">It can:</span>
      <ul class="m-0 p-0 list-none flex flex-col gap-1">
        <li v-for="p in rows" :key="p.id" class="text-[12.5px] text-fg flex gap-2 items-start">
          <span class="i-carbon-checkmark text-[13px] text-accent-300 mt-[2px] shrink-0" />
          <span class="flex-1">{{ p.label }}</span>
          <span v-if="isNew(p.id)" class="text-[10.5px] text-accent-300 font-medium px-1.5 rounded-[var(--radius-xs)] bg-accent-soft shrink-0">New</span>
        </li>
      </ul>
    </template>
    <span v-else class="hint">It asks for no permissions: it can only show its own settings, panel and commands.</span>
  </div>
</template>
