<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePrivacyLock } from '~/composables/usePrivacyLock'

/**
 * The setup's privacy step: a PIN that opens playhound, and how long away
 * before it asks again (Settings → Privacy has the rest: fingerprint, blank
 * in recent apps, changing or removing the PIN). Nothing is set until Next,
 * so Skip leaves the app as open as it was.
 */
const lock = usePrivacyLock()
const want = ref(lock.enabled.value)
const pin = ref('')
const again = ref('')
const error = ref('')
const digits = (v: string) => v.replace(/\D/g, '').slice(0, lock.PIN_MAX)

const AFTER = computed(() => lock.RELOCK_CHOICES.map(m => ({ value: m as number, label: m ? `${m} min` : 'At once' })))

defineExpose({
  async commit() {
    error.value = ''
    // Already on (a second run of the setup): change it in Settings instead.
    if (!want.value || lock.enabled.value)
      return true
    if (!lock.isValidPin(pin.value)) {
      error.value = `A PIN is ${lock.PIN_MIN} to ${lock.PIN_MAX} digits.`
      return false
    }
    if (pin.value !== again.value) {
      error.value = 'The two PINs aren\'t the same.'
      return false
    }
    await lock.setPin(pin.value)
    return true
  },
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="!lock.supported" class="hint m-0">
      The lock needs this page on localhost, https or one of the apps. Settings → Privacy explains.
    </p>
    <p v-else-if="lock.enabled.value" class="hint m-0">
      A PIN is already set. Settings → Privacy changes it or turns it off.
    </p>
    <template v-else>
      <div class="gap-2.5 grid grid-cols-2" role="radiogroup" aria-label="Lock playhound">
        <button
          v-for="o in [
            { on: false, icon: 'i-carbon-unlocked', title: 'No lock', sub: 'Opens straight away' },
            { on: true, icon: 'i-carbon-locked', title: 'A PIN', sub: 'Asked when it opens' },
          ]"
          :key="String(o.on)"
          type="button"
          role="radio"
          :aria-checked="want === o.on"
          class="p-3 text-left focusable rounded-[var(--radius-lg)] flex gap-2.5 transition-[box-shadow,background-color] duration-200 items-center"
          :class="want === o.on ? 'ring-2 ring-accent bg-accent-soft' : 'ring-1 ring-edge-strong hover:ring-fg/25'"
          @click="want = o.on"
        >
          <span :class="[o.icon, want === o.on ? 'text-accent-300' : 'text-fg-muted']" class="text-[18px] shrink-0" />
          <span class="flex flex-col gap-0.5 min-w-0">
            <span class="text-[13px] text-fg font-medium">{{ o.title }}</span>
            <span class="hint">{{ o.sub }}</span>
          </span>
        </button>
      </div>

      <template v-if="want">
        <div class="gap-2.5 grid grid-cols-2">
          <UiInput :model-value="pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="PIN" aria-label="PIN" @update:model-value="v => (pin = digits(String(v)))" />
          <UiInput :model-value="again" type="password" inputmode="numeric" autocomplete="new-password" placeholder="Again" aria-label="The PIN again" @update:model-value="v => (again = digits(String(v)))" />
        </div>
        <UiField label="Lock again after time away">
          <UiSegmented v-model="lock.relockAfter.value" :options="AFTER" size="xs" />
        </UiField>
        <p v-if="error" class="text-[12px] text-danger m-0">
          {{ error }}
        </p>
        <p class="hint m-0">
          It keeps the app private from people nearby; it doesn't encrypt anything. Forgot the PIN? The lock screen can erase playhound's data on this device to get back in.
        </p>
      </template>
    </template>
  </div>
</template>
