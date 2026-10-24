<script setup lang="ts">
withDefaults(defineProps<{ size?: number, animated?: boolean }>(), { size: 28 })
</script>

<template>
  <span class="rounded-[8px] bg-accent shrink-0 inline-block" :style="{ width: `${size}px`, height: `${size}px` }" />
</template>
