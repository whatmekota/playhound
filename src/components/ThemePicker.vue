<script setup lang="ts">
import { THEMES, useThemeStore } from '~/stores/themeStore'

const theme = useThemeStore()
</script>

<template>
  <select
    :value="theme.current"
    class="text-xs px-1.5 py-1 outline-none border rounded-md cursor-pointer transition-colors"
    style="background:var(--bg-850); border-color:var(--border); color:var(--text-muted)"
    title="Theme"
    @change="theme.apply(($event.target as HTMLSelectElement).value as any)"
  >
    <option v-for="t in THEMES" :key="t.id" :value="t.id">
      {{ t.label }}
    </option>
  </select>
</template>
