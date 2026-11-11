<script setup lang="ts">
import { computed } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiSpinner from '~/components/ui/UiSpinner.vue'
import { useAndroidSession } from '~/composables/useAndroidSession'
import { activePicker } from '~/lib/android/picker'

/**
 * The Android app's device side, mounted once (pages/index.vue): the sheet
 * that stands in for the browser's Bluetooth and USB choosers
 * (lib/android/picker.ts), and the session service that keeps things going
 * with the screen off (useAndroidSession).
 */

useAndroidSession()

const s = computed(() => activePicker.value)
const v = computed(() => s.value?.view)

const icon = computed(() => (v.value?.kind === 'usb' ? 'i-carbon-usb' : 'i-carbon-bluetooth'))
</script>

<template>
  <Teleport to="body">
    <Transition name="t-fade">
      <div
        v-if="s && v"
        class="ph-picker-backdrop bg-black/50 inset-0 fixed z-[950]"
        @pointerdown.self="s.on.cancel()"
      >
        <div
          class="ph-picker px-4 pb-4 pt-2 border-t border-edge bg-surface-900 flex flex-col gap-3 shadow-[var(--shadow-pop)] bottom-0 left-0 right-0 absolute"
          role="dialog"
          aria-modal="true"
          :aria-label="v.title"
        >
          <div class="mx-auto rounded-full bg-fg/20 h-1 w-10" />
          <div class="flex gap-2.5 items-center">
            <span :class="icon" class="text-[18px] text-accent-300 shrink-0" />
            <h2 class="text-[15px] text-fg font-semibold flex-1 min-w-0 truncate">
              {{ v.title }}
            </h2>
            <UiSpinner v-if="v.scanning" :size="14" />
          </div>

          <!-- Before Android's own dialog, or something to fix first -->
          <template v-if="v.stage !== 'list'">
            <p class="text-[13.5px] text-fg leading-relaxed m-0">
              {{ v.message }}
            </p>
            <div class="flex flex-col gap-2">
              <UiButton v-if="v.action" variant="primary" size="lg" block @click="s.on.action?.()">
                {{ v.action }}
              </UiButton>
              <UiButton v-if="v.secondary" variant="secondary" size="md" block @click="s.on.secondary?.()">
                {{ v.secondary }}
              </UiButton>
            </div>
          </template>

          <!-- The devices found -->
          <template v-else>
            <p v-if="v.scanning && !v.items.length" class="hint m-0">
              {{ v.kind === 'usb' ? 'Looking for USB devices…' : 'Looking for devices nearby…' }}
            </p>
            <div v-if="v.items.length" class="ph-picker-list scroll-y card flex flex-col">
              <button
                v-for="it in v.items"
                :key="it.id"
                type="button"
                class="px-3 py-3 text-left border-b border-edge flex gap-3 min-h-14 items-center last:border-b-0 active:bg-fg/6"
                :disabled="it.busy"
                @click="s.on.choose(it.id)"
              >
                <span :class="icon" class="text-[16px] text-fg-muted shrink-0" />
                <span class="flex flex-1 flex-col min-w-0">
                  <span class="text-[14px] text-fg truncate">{{ it.name }}</span>
                  <span class="text-[11.5px] text-fg-faint truncate">{{ it.detail }}</span>
                </span>
                <UiSpinner v-if="it.busy" :size="14" />
                <span v-else class="i-carbon-chevron-right text-fg-faint shrink-0" />
              </button>
            </div>
            <p v-if="v.note" class="text-[12.5px] text-fg-muted leading-relaxed m-0">
              {{ v.note }}
            </p>
          </template>

          <div
            v-if="v.error"
            class="text-[12.5px] text-danger px-2.5 py-2 rounded-[var(--radius-md)] bg-danger/10 flex gap-2 ring-1 ring-danger/20"
          >
            <span class="i-carbon-error-filled text-[14px] mt-px shrink-0" />
            <span class="min-w-0 break-words">{{ v.error }}</span>
          </div>

          <div class="flex gap-2">
            <UiButton
              v-if="v.stage === 'list' && s.on.rescan"
              variant="secondary"
              size="md"
              class="flex-1"
              icon="i-carbon-renew"
              :disabled="v.scanning"
              @click="s.on.rescan()"
            >
              {{ v.kind === 'usb' ? 'Refresh' : 'Scan again' }}
            </UiButton>
            <UiButton variant="ghost" size="md" class="flex-1" @click="s.on.cancel()">
              Cancel
            </UiButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ph-picker {
  max-height: 80vh;
  border-radius: 16px 16px 0 0;
  padding-bottom: calc(16px + var(--safe-area-inset-bottom, 0px));
}
.ph-picker-list {
  max-height: 46vh;
}
/* Sideways: a narrower sheet, centred, so the list is not a mile wide. */
@media (orientation: landscape) {
  .ph-picker {
    left: 50%;
    right: auto;
    width: min(520px, 100vw);
    transform: translateX(-50%);
    max-height: 92vh;
  }
  .ph-picker-list {
    max-height: 50vh;
  }
}
</style>
