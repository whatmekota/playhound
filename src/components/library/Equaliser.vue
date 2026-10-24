<script setup lang="ts">
/** The now-playing bars. They freeze, rather than vanish, while paused. */
defineProps<{ playing: boolean }>()
</script>

<template>
  <span class="eq" :class="playing ? '' : 'paused'" aria-label="Now playing" role="img"><i /><i /><i /></span>
</template>

<style scoped>
.eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px;
}
.eq i {
  display: block;
  width: 3px;
  height: 100%;
  border-radius: 1px;
  background: currentColor;
  transform-origin: bottom;
  animation: ph-eq 0.9s ease-in-out infinite;
}
.eq i:nth-child(2) {
  animation-delay: -0.3s;
}
.eq i:nth-child(3) {
  animation-delay: -0.6s;
}
.eq.paused i {
  animation-play-state: paused;
}
</style>
