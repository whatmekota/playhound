<script setup lang="ts">
import { onMounted, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiIconButton from '~/components/ui/UiIconButton.vue'
import { toast } from '~/composables/useToast'
import { buildCrashReport, lastRunEndedBadly, markCrashSeen } from '~/lib/android/crashReport'

/**
 * The Android app, after a bad end (a crash, the WebView's renderer killed
 * for memory, an ANR): one line at the top with "Copy report", once. The
 * same report stays in Settings → Android app.
 */

const shown = ref(false)
const copying = ref(false)

onMounted(async () => {
  shown.value = await lastRunEndedBadly()
})

async function copy() {
  copying.value = true
  try {
    await navigator.clipboard.writeText(await buildCrashReport())
    toast.success('Copied the crash report', { detail: 'Paste it into a message or an issue' })
    void markCrashSeen()
    shown.value = false
  }
  catch {
    toast.error('Could not copy it', { detail: 'Settings → Android app has it too' })
  }
  finally {
    copying.value = false
  }
}

function dismiss() {
  shown.value = false
  void markCrashSeen()
}
</script>

<template>
  <Transition name="t-fade">
    <div
      v-if="shown"
      role="alert"
      class="crash-banner text-[13px] text-fg pl-3 pr-1 border-b border-warn/30 bg-surface-850 flex gap-2 items-center"
    >
      <span class="i-carbon-warning-alt text-[16px] text-warn shrink-0" />
      <span class="leading-tight flex-1 min-w-0">playhound closed unexpectedly last time</span>
      <UiButton size="md" variant="primary" icon="i-carbon-copy" :loading="copying" @click="copy">
        Copy report
      </UiButton>
      <UiIconButton icon="i-carbon-close" label="Dismiss" size="lg" @click="dismiss" />
    </div>
  </Transition>
</template>

<style scoped>
.crash-banner {
  min-height: 52px;
  padding-top: env(safe-area-inset-top, 0px);
}
</style>
