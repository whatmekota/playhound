<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import UiBadge from '~/components/ui/UiBadge.vue'
import UiButton from '~/components/ui/UiButton.vue'
import UiField from '~/components/ui/UiField.vue'
import UiSwitch from '~/components/ui/UiSwitch.vue'
import { toast } from '~/composables/useToast'
import { desktop } from '~/lib/browserApi'
import { isAndroidApp } from '~/lib/platform'
import { isValidPin, PIN_MAX, PIN_MIN } from '~/lib/privacyLock'
import { usePrivacyStore } from '~/stores/privacyStore'
import { useUiStore } from '~/stores/uiStore'

/**
 * Settings → Privacy: the app lock (a PIN, when it locks again, the
 * fingerprint) and, in the Android app, blank in recent apps.
 *
 * Changing the PIN or turning the lock off asks for the current one, so
 * someone who finds the app open can't take the lock over.
 */
const privacy = usePrivacyStore()
const ui = useUiStore()

onMounted(() => void privacy.refreshBiometric())

type Mode = 'idle' | 'set' | 'change' | 'off'
const mode = ref<Mode>('idle')
const form = reactive({ current: '', next: '', again: '' })
const error = ref('')
const busy = ref(false)
const formEl = ref<HTMLFormElement | null>(null)

type FieldKey = keyof typeof form
const fields = computed(() => {
  const out: { key: FieldKey, label: string }[] = []
  if (mode.value !== 'set')
    out.push({ key: 'current', label: 'Current PIN' })
  if (mode.value !== 'off') {
    out.push({ key: 'next', label: mode.value === 'set' ? `PIN, ${PIN_MIN} to ${PIN_MAX} digits` : `New PIN, ${PIN_MIN} to ${PIN_MAX} digits` })
    out.push({ key: 'again', label: 'Same again' })
  }
  return out
})

const SUBMIT: Record<Exclude<Mode, 'idle'>, string> = { set: 'Turn on', change: 'Change PIN', off: 'Turn off' }

async function start(m: Exclude<Mode, 'idle'>) {
  form.current = form.next = form.again = ''
  error.value = ''
  mode.value = m
  await nextTick()
  formEl.value?.querySelector('input')?.focus()
}

function cancel() {
  mode.value = 'idle'
  form.current = form.next = form.again = ''
  error.value = ''
}

/** Digits only, whatever the keyboard or a paste put in. */
function digitsOnly(key: FieldKey) {
  const clean = form[key].replace(/\D/g, '').slice(0, PIN_MAX)
  if (clean !== form[key])
    form[key] = clean
}

async function submit() {
  error.value = ''
  const m = mode.value
  if (m === 'idle')
    return
  if (m !== 'set' && !form.current) {
    error.value = 'Type your current PIN'
    return
  }
  if (m !== 'off') {
    if (!isValidPin(form.next)) {
      error.value = `A PIN is ${PIN_MIN} to ${PIN_MAX} digits`
      return
    }
    if (form.next !== form.again) {
      error.value = 'The two PINs are not the same'
      return
    }
  }
  busy.value = true
  try {
    if (m === 'set') {
      await privacy.setPin(form.next)
      toast.success('App lock on', { detail: 'playhound asks for your PIN when it opens', icon: 'i-carbon-locked' })
    }
    else if (m === 'change') {
      if (!await privacy.changePin(form.current, form.next)) {
        error.value = 'That is not your current PIN'
        return
      }
      toast.success('PIN changed', { icon: 'i-carbon-locked' })
    }
    else {
      if (!await privacy.turnOff(form.current)) {
        error.value = 'That is not your current PIN'
        return
      }
      toast('App lock off', { detail: 'playhound opens without a PIN', icon: 'i-carbon-unlocked' })
    }
    cancel()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    busy.value = false
  }
}

function lockNow() {
  ui.settingsOpen = false
  privacy.lockNow()
}

const RELOCK_OPTIONS = [
  { value: 0, label: 'At once' },
  { value: 1, label: '1 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
]
const relockOptions = computed(() =>
  RELOCK_OPTIONS.some(o => o.value === privacy.relockAfter)
    ? RELOCK_OPTIONS
    : [...RELOCK_OPTIONS, { value: privacy.relockAfter, label: `${privacy.relockAfter} min` }],
)
const AWAY = isAndroidApp
  ? 'Out of sight: another app, Home or the screen off. Locking pauses playback and stops the device, so a session with the screen off stops too.'
  : desktop
    ? 'Minimised, or hidden. Locking pauses playback and stops the device.'
    : 'This tab hidden, or the window minimised. Locking pauses playback and stops the device.'

const bioHint = computed(() => {
  const s = privacy.biometricStatus
  if (!s)
    return 'Offered on the lock screen when Android has one set up. The PIN still works.'
  if (!s.hardware)
    return 'This phone has no fingerprint or face unlock. The PIN it is.'
  if (!s.available)
    return 'Set up a fingerprint or face in Android\'s settings first. The PIN still works.'
  return 'Offered as soon as the lock screen shows. The PIN still works.'
})

const ESCAPE = isAndroidApp
  ? 'someone with your unlocked phone and a computer may get past it'
  : desktop
    ? 'someone with your computer and some know-how can get past it'
    : 'in a browser, its developer tools always get past it'
</script>

<template>
  <div v-if="!privacy.supported" class="px-4 py-3 card">
    <p class="hint m-0">
      The app lock needs a secure page, and this one isn't: open playhound on this computer (localhost) or over
      https, or use the desktop or Android app.
    </p>
  </div>

  <template v-else>
    <div class="p-4 card flex flex-col gap-4">
      <div class="flex gap-3 items-center">
        <span class="text-accent-300 rounded-[var(--radius-md)] bg-accent-soft center shrink-0 h-10 w-10">
          <span :class="privacy.enabled ? 'i-carbon-locked' : 'i-carbon-unlocked'" class="text-[19px]" />
        </span>
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          <span class="text-[14px] text-fg font-medium">App lock</span>
          <span class="hint">
            {{ privacy.enabled ? 'playhound asks for your PIN when it opens and after time away.' : 'A PIN to open playhound, asked again after time away.' }}
          </span>
        </div>
        <UiBadge :tone="privacy.enabled ? 'ok' : 'neutral'" dot>
          {{ privacy.enabled ? 'On' : 'Off' }}
        </UiBadge>
      </div>

      <div v-if="mode === 'idle'" class="flex flex-wrap gap-2">
        <UiButton v-if="!privacy.enabled" variant="primary" icon="i-carbon-locked" @click="start('set')">
          Set a PIN
        </UiButton>
        <template v-else>
          <UiButton icon="i-carbon-locked" @click="lockNow">
            Lock now
          </UiButton>
          <UiButton icon="i-carbon-password" @click="start('change')">
            Change PIN
          </UiButton>
          <UiButton variant="danger" icon="i-carbon-unlocked" class="ml-auto" @click="start('off')">
            Turn off
          </UiButton>
        </template>
      </div>

      <form v-else ref="formEl" class="flex flex-col gap-3" @submit.prevent="submit">
        <label v-for="f in fields" :key="f.key" class="flex flex-col gap-1">
          <span class="label">{{ f.label }}</span>
          <input
            v-model="form[f.key]"
            type="password"
            inputmode="numeric"
            pattern="[0-9]*"
            :maxlength="PIN_MAX"
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            class="pin-input text-[15px] text-fg tracking-[0.3em] font-mono px-2.5 outline-none border border-edge-strong rounded-[var(--radius-sm)] bg-surface-900 h-9 w-[180px] transition-[border-color,box-shadow] duration-150 focus:border-accent/70 focus:ring-3 focus:ring-accent-soft"
            @input="digitsOnly(f.key)"
            @keydown.esc.stop="cancel"
          >
        </label>
        <p v-if="error" class="text-[12px] text-danger m-0" role="alert">
          {{ error }}
        </p>
        <div class="flex flex-wrap gap-2">
          <UiButton type="submit" :variant="mode === 'off' ? 'danger' : 'primary'" :loading="busy">
            {{ SUBMIT[mode] }}
          </UiButton>
          <UiButton variant="ghost" :disabled="busy" @click="cancel">
            Cancel
          </UiButton>
        </div>
      </form>
    </div>

    <div v-if="privacy.enabled" class="px-4 py-3 card flex flex-col gap-4">
      <UiField label="Lock again after" :hint="AWAY" stacked>
        <UiSegmented v-model="privacy.relockAfter" :options="relockOptions" size="xs" />
      </UiField>
      <template v-if="isAndroidApp">
        <div class="divider-y" />
        <UiSwitch
          v-model="privacy.biometric"
          label="Unlock with fingerprint or face"
          :hint="bioHint"
          :disabled="privacy.biometricStatus ? !privacy.biometricStatus.hardware : false"
        />
      </template>
    </div>

    <div v-if="isAndroidApp" class="px-4 py-3 card">
      <UiSwitch
        v-model="privacy.blankRecents"
        label="Blank in recent apps"
        hint="Recent apps shows an empty card for playhound. On Android 12 and older it also blocks screenshots and screen recordings of it, so turn it off there to send one with a bug report."
      />
    </div>

    <div class="p-4 border border-edge rounded-[var(--radius-lg)] flex gap-3">
      <span class="i-carbon-information text-[18px] text-fg-muted shrink-0" />
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] text-fg font-medium">Privacy from people nearby, not security</span>
        <span class="hint">
          The lock covers playhound and stops it, so nobody sees or feels what it was doing. It doesn't encrypt
          anything: your files and what playhound keeps aren't scrambled, and {{ ESCAPE }}.
        </span>
        <span class="hint">
          Forgot your PIN? The lock screen can erase everything playhound keeps here (settings, library, playlists,
          stats) so you can start again; your videos and scripts stay. Your PIN is never in a backup, so a backup
          brings the rest back without the lock.
        </span>
      </div>
    </div>
  </template>
</template>
