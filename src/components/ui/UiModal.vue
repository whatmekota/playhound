<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

/**
 * Dialog. Teleported, backdrop-blurred, closes on Escape and backdrop click
 * (unless `persistent`). Header/footer are optional slots.
 */
const props = withDefaults(defineProps<{
  title?: string
  subtitle?: string
  icon?: string
  /** Card width; any CSS length. */
  width?: string
  persistent?: boolean
  /** No body padding (for full-bleed content). */
  flush?: boolean
}>(), { width: '480px' })

const open = defineModel<boolean>('open', { default: false })

function close() {
  if (!props.persistent)
    open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    close()
  }
}

watch(open, (v) => {
  if (v)
    document.addEventListener('keydown', onKey, true)
  else
    document.removeEventListener('keydown', onKey, true)
}, { immediate: true })

onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="t-modal">
      <div
        v-if="open"
        class="p-4 bg-black/55 flex items-center inset-0 justify-center fixed z-[900] backdrop-blur-sm"
        @pointerdown.self="close"
      >
        <div
          class="ui-modal-card rounded-[var(--radius-xl)] bg-surface-850 flex flex-col max-h-[min(86vh,900px)] max-w-full shadow-[var(--shadow-pop)] overflow-hidden"
          :style="{ width }"
          role="dialog"
          aria-modal="true"
        >
          <header v-if="title || $slots.header" class="px-5 pb-3 pt-4 flex shrink-0 gap-3 items-start">
            <div v-if="icon" class="text-accent-300 rounded-[var(--radius-md)] bg-accent-soft center shrink-0 h-9 w-9">
              <span :class="icon" class="text-[18px]" />
            </div>
            <div class="flex-1 min-w-0">
              <slot name="header">
                <h2 class="text-[16px] text-fg tracking-[-0.01em] font-semibold">
                  {{ title }}
                </h2>
                <p v-if="subtitle" class="text-[12.5px] text-fg-muted mt-0.5">
                  {{ subtitle }}
                </p>
              </slot>
            </div>
            <button
              v-if="!persistent"
              type="button"
              class="text-fg-faint rounded-[var(--radius-sm)] center shrink-0 h-7 w-7 hover:text-fg hover:bg-fg/8"
              aria-label="Close"
              @click="open = false"
            >
              <span class="i-carbon-close text-[16px]" />
            </button>
          </header>
          <div class="scroll-y flex-1" :class="flush ? '' : 'px-5 pb-5'">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="px-5 py-3 border-t border-edge bg-surface-900/50 flex shrink-0 gap-2 items-center justify-end">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
