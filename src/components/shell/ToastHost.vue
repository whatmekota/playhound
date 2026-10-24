<script setup lang="ts">
import type { Toast } from '~/composables/useToast'
import { useToast } from '~/composables/useToast'

const { toasts, dismiss, hold, release } = useToast()

const KIND_ICON: Record<Toast['kind'], string> = {
  info: 'i-carbon-information-filled',
  success: 'i-carbon-checkmark-filled',
  warn: 'i-carbon-warning-filled',
  error: 'i-carbon-error-filled',
}
const KIND_TONE: Record<Toast['kind'], string> = {
  info: 'text-fg-muted',
  success: 'text-ok',
  warn: 'text-warn',
  error: 'text-danger',
}
</script>

<template>
  <div
    class="flex flex-col-reverse gap-2 w-[340px] pointer-events-none items-end bottom-[calc(var(--dock-h)+14px)] right-4 fixed z-[1200]"
    aria-live="polite"
  >
    <TransitionGroup name="t-slide-up">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="p-2 pr-2.5 pop flex gap-2.5 max-w-full pointer-events-auto items-center"
        @pointerenter="hold(t.id)"
        @pointerleave="release(t.id)"
      >
        <img v-if="t.image" :src="t.image" alt="" class="rounded-[var(--radius-sm)] shrink-0 h-9 w-16 object-cover">
        <div v-else class="rounded-[var(--radius-sm)] bg-fg/6 center shrink-0 h-8 w-8" :class="KIND_TONE[t.kind]">
          <span :class="t.icon ?? KIND_ICON[t.kind]" class="text-[16px]" />
        </div>
        <div class="py-0.5 flex-1 min-w-0">
          <p class="text-[13px] text-fg font-medium truncate">
            {{ t.message }}
          </p>
          <p v-if="t.detail" class="text-[12px] text-fg-muted truncate">
            {{ t.detail }}
          </p>
        </div>
        <button
          v-if="t.action"
          type="button"
          class="text-[12.5px] text-accent-300 font-medium px-2 rounded-[var(--radius-sm)] shrink-0 h-7 hover:bg-accent-soft"
          @click="t.action.run(); dismiss(t.id)"
        >
          {{ t.action.label }}
        </button>
        <button
          type="button"
          class="text-fg-faint rounded-[var(--radius-sm)] center shrink-0 h-6 w-6 hover:text-fg hover:bg-fg/8"
          aria-label="Dismiss"
          @click="dismiss(t.id)"
        >
          <span class="i-carbon-close text-[13px]" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
