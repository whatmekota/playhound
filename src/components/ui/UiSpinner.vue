<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 16 })
</script>

<template>
  <span
    class="border-2 border-current border-r-transparent rounded-full opacity-70 shrink-0 inline-block [animation:ph-spin_.7s_linear_infinite]"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="status"
    aria-label="Loading"
  />
</template>
