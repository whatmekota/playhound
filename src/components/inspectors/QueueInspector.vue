<script setup lang="ts">
import { useQueueStore } from '~/stores/queueStore'

const queue = useQueueStore()
</script>

<template>
  <div class="text-xs text-fg-muted p-3">
    {{ queue.length }} in queue
  </div>
</template>
