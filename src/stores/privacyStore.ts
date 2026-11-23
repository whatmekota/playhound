import type { BiometricStatus } from '~/lib/android/app'
import type { Attempts, PinRecord } from '~/lib/privacyLock'
import { StorageSerializers, useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { PhApp } from '~/lib/android/app'
import { KEYS } from '~/lib/persist'
import { isAndroidApp } from '~/lib/platform'
import {
  afterWrongPin,
  canHashPins,
  hashPin,
  isValidPin,
  NO_ATTEMPTS,
  parsePinRecord,
  RELOCK_DEFAULT,
  verifyPin,
  waitLeft,
} from '~/lib/privacyLock'

export type UnlockResult = 'ok' | 'wrong' | 'wait'

/**
 * The app lock: a PIN to open playhound, asked again after time away.
 *
 * The lock is on exactly when a PIN is set; turning it off forgets the PIN.
 * The app starts locked. Locking covers everything (components/shell/LockScreen.vue)
 * and goes through panic, so playback pauses and the device stops; the shell
 * wires that up, and when the app is away (composables/usePrivacyLock.ts).
 *
 * A store, like panic's, so the settings, the lock screen, the command
 * palette and a first-run wizard all see the same lock.
 */
export const usePrivacyStore = defineStore('privacy', () => {
  const pinRaw = useLocalStorage<PinRecord | null>(KEYS.privacyPin.key, null, { serializer: StorageSerializers.object })
  const record = computed(() => parsePinRecord(pinRaw.value))

  /** A PIN is set: the app asks for it at startup and after time away. */
  const enabled = computed(() => !!record.value)
  /** Minutes out of sight before it locks again; 0 at once. */
  const relockAfter = useLocalStorage<number>(KEYS.privacyRelock.key, RELOCK_DEFAULT)
  /** Android: unlock with a fingerprint or face, the PIN still there underneath. */
  const biometric = useLocalStorage<boolean>(KEYS.privacyBiometric.key, true)
  /** Android: FLAG_SECURE, independent of the lock. Off by default: it also stops screenshots for bug reports. */
  const blankRecents = useLocalStorage<boolean>(KEYS.privacyBlankRecents.key, false)
  const attempts = useLocalStorage<Attempts>(KEYS.privacyAttempts.key, { ...NO_ATTEMPTS }, { mergeDefaults: true })

  const locked = ref(enabled.value)
  /** Out of sight right now (minimised, another app, the screen off); set by the shell. */
  const away = ref(false)
  /**
   * Offer the fingerprint prompt as soon as the app is in front: at startup
   * and on coming back to a locked app, not when locked by hand (that is
   * usually handing the phone to someone).
   */
  const promptPending = ref(locked.value)

  // Turned off from somewhere else (another tab, playhound erased): nothing left to unlock with.
  watch(enabled, (on) => {
    if (!on)
      locked.value = false
  })

  /** WebCrypto is here to hash a PIN with (not on plain http from another machine). */
  const supported = canHashPins()

  function lockNow() {
    if (enabled.value)
      locked.value = true
  }

  /** Set (or replace) the PIN, which turns the lock on. Doesn't lock. Throws if it isn't 4–8 digits. */
  async function setPin(pin: string): Promise<void> {
    if (!isValidPin(pin))
      throw new Error('A PIN is 4 to 8 digits')
    pinRaw.value = await hashPin(pin)
    attempts.value = { ...NO_ATTEMPTS }
  }

  /** Whether `pin` is the PIN. For settings, where the app is already open: wrong ones aren't counted. */
  async function checkPin(pin: string): Promise<boolean> {
    const rec = record.value
    return !!rec && verifyPin(pin, rec)
  }

  /** Turn the lock off; it takes the PIN. */
  async function turnOff(pin: string): Promise<boolean> {
    if (!await checkPin(pin))
      return false
    pinRaw.value = null
    attempts.value = { ...NO_ATTEMPTS }
    locked.value = false
    return true
  }

  async function changePin(current: string, next: string): Promise<boolean> {
    if (!await checkPin(current))
      return false
    await setPin(next)
    return true
  }

  /** Milliseconds the lock screen still waits after too many wrong PINs. */
  function waitMs(now = Date.now()) {
    return waitLeft(attempts.value, now)
  }

  function opened() {
    attempts.value = { ...NO_ATTEMPTS }
    locked.value = false
    promptPending.value = false
  }

  /** The lock screen's PIN. */
  async function unlock(pin: string): Promise<UnlockResult> {
    const rec = record.value
    if (!rec) {
      locked.value = false
      return 'ok'
    }
    if (waitMs() > 0)
      return 'wait'
    if (await verifyPin(pin, rec)) {
      opened()
      return 'ok'
    }
    attempts.value = afterWrongPin(attempts.value, Date.now())
    return 'wrong'
  }

  // ── Fingerprint / face (Android) ───────────────────────────────────────────
  const biometricStatus = shallowRef<BiometricStatus | null>(null)
  /** Asked again on coming back: one may have been set up meanwhile. */
  async function refreshBiometric() {
    if (!isAndroidApp)
      return
    try {
      biometricStatus.value = await PhApp.biometricStatus()
    }
    catch {
      biometricStatus.value = null
    }
  }
  void refreshBiometric()

  /** The lock screen offers the fingerprint / face prompt. */
  const canBiometric = computed(() => isAndroidApp && biometric.value && !!biometricStatus.value?.available)
  const prompting = ref(false)

  /** Android's prompt, if it's on and the app is in front. True when it unlocked. */
  async function offerBiometric(): Promise<boolean> {
    if (!locked.value || !canBiometric.value || prompting.value || away.value)
      return false
    prompting.value = true
    try {
      const r = await PhApp.authenticate({ title: 'Unlock', cancel: 'Use PIN' })
      if (r.ok && locked.value) {
        opened()
        return true
      }
    }
    catch (err) {
      console.warn('[privacy] fingerprint prompt', err)
    }
    finally {
      prompting.value = false
    }
    return false
  }

  /** The PIN's length, for the lock screen's dots. */
  const digits = computed(() => record.value?.digits ?? 0)

  return {
    enabled,
    supported,
    locked,
    away,
    promptPending,
    relockAfter,
    biometric,
    blankRecents,
    attempts,
    digits,
    biometricStatus,
    canBiometric,
    prompting,
    lockNow,
    setPin,
    checkPin,
    turnOff,
    changePin,
    unlock,
    waitMs,
    refreshBiometric,
    offerBiometric,
  }
})
