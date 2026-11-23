import type { PluginListenerHandle } from '@capacitor/core'
import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import { PhApp } from '~/lib/android/app'
import { desktop } from '~/lib/browserApi'
import { isAndroidApp } from '~/lib/platform'
import { awayLongEnough, isValidPin, PIN_MAX, PIN_MIN, RELOCK_CHOICES, relockDelayMs } from '~/lib/privacyLock'
import { usePrivacyStore } from '~/stores/privacyStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { usePopout } from './usePopout'
import { toast } from './useToast'

/**
 * The app lock, for anything outside the lock itself: Settings → Privacy and
 * the first-run setup.
 *
 *   const lock = usePrivacyLock()
 *   if (lock.supported && lock.isValidPin(pin))
 *     await lock.setPin(pin)   // the lock is on from here; it asks at the next start or after time away
 *   lock.enabled.value         // a PIN is set
 *   lock.lockNow()             // lock straight away (does nothing without a PIN)
 *
 * `supported` is false where the page has no WebCrypto to hash a PIN with
 * (plain http from another machine): offer nothing there.
 */
export function usePrivacyLock() {
  const s = usePrivacyStore()
  return {
    supported: s.supported,
    enabled: computed(() => s.enabled),
    locked: computed(() => s.locked),
    /** Minutes away before it locks again, one of RELOCK_CHOICES; 0 is at once. */
    relockAfter: computed({ get: () => s.relockAfter, set: (v: number) => (s.relockAfter = v) }),
    setPin: (pin: string) => s.setPin(pin),
    lockNow: () => s.lockNow(),
    isValidPin,
    PIN_MIN,
    PIN_MAX,
    RELOCK_CHOICES,
  }
}

/**
 * The shell's side (pages/index.vue, once): lock after time away, and make a
 * lock stop everything through panic.
 *
 * Away is the window minimised or hidden (the desktop app), the tab hidden (a
 * browser), the app out of sight (Android: another app, Home, the screen
 * off). A pop-out player still showing means someone is watching, so that is
 * not away. A timer locks while away, so the device stops then and not only
 * once someone is back; the time is checked again on return too, since a
 * phone may not run the timer at all while it sleeps.
 */
export function startPrivacyLock(controls: {
  /** Panic, marked as the lock's doing. */
  panic: () => void
  /** Lift panic's cover, leaving everything stopped. */
  release: () => void
}) {
  const privacy = usePrivacyStore()
  const safety = useSafetyStore()
  const popout = usePopout()

  // ── Locked means panicked ──────────────────────────────────────────────────
  // Locking through panic stops what panic stops (device, video, audio,
  // e-stim, the pop-out and plugin pages hidden), and keeps the phone remote,
  // a gamepad or the notification from starting anything again meanwhile.
  // Unlocking lifts the cover without restarting anything: whoever unlocks
  // presses play. A panic from before the lock stays, to be resumed by hand.
  let panickedByLock = false
  watch(() => privacy.locked, (on) => {
    if (on) {
      if (!safety.panicked) {
        controls.panic()
        panickedByLock = true
      }
      return
    }
    if (!panickedByLock)
      return
    panickedByLock = false
    const was = safety.suspended
    controls.release()
    if (was?.videoPlaying || was?.audioPlaying || was?.motionEnabled)
      toast('Paused while locked', { detail: 'Play to carry on', icon: 'i-carbon-locked', key: 'privacy-paused' })
  }, { immediate: true, flush: 'sync' })

  // ── Away ───────────────────────────────────────────────────────────────────
  const pageHidden = ref(typeof document !== 'undefined' && document.hidden)
  const winMinimized = ref(!!desktop?.window?.state().minimized)
  const appAway = ref(false)
  /** Left for a picker or page the app opened itself (Android). */
  const ownLeave = ref(false)

  const outOfSight = computed(() => {
    // Android: the page's own visibility can't be trusted (a session keeps it "visible").
    if (isAndroidApp)
      return appAway.value
    return pageHidden.value || winMinimized.value
  })
  const away = computed(() => outOfSight.value && !popout.active.value)

  let since = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  function clearTimer() {
    if (timer !== null)
      clearTimeout(timer)
    timer = null
  }

  watch(away, (now) => {
    privacy.away = now
    clearTimer()
    if (now) {
      since = Date.now()
      if (!privacy.enabled || privacy.locked)
        return
      const ms = relockDelayMs(privacy.relockAfter, ownLeave.value)
      if (ms <= 0)
        privacy.lockNow()
      else
        timer = setTimeout(() => privacy.lockNow(), ms)
      return
    }
    if (privacy.enabled && !privacy.locked && since && awayLongEnough(since, Date.now(), privacy.relockAfter, ownLeave.value))
      privacy.lockNow()
    since = 0
    ownLeave.value = false
    if (privacy.locked)
      privacy.promptPending = true
  }, { flush: 'sync' })
  privacy.away = away.value

  // The fingerprint prompt, once the app is in front. Asked about again
  // first: one may have been set up while the app was away.
  watch(() => privacy.locked && privacy.promptPending && !privacy.away, async (go) => {
    if (!go)
      return
    privacy.promptPending = false
    await privacy.refreshBiometric()
    await privacy.offerBiometric()
  }, { immediate: true })

  const onVisibility = () => (pageHidden.value = document.hidden)
  document.addEventListener('visibilitychange', onVisibility)
  const offWin = desktop?.window?.onStateChange(s => (winMinimized.value = !!s.minimized))

  let androidAway: Promise<PluginListenerHandle> | null = null
  if (isAndroidApp) {
    androidAway = PhApp.addListener('away', (e) => {
      if (e.away)
        ownLeave.value = e.own
      appAway.value = e.away
    })
    // Blank in recent apps follows its switch, lock or no lock.
    watch(() => privacy.blankRecents, on => void PhApp.setSecure({ on }).catch(() => {}), { immediate: true })
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibility)
      offWin?.()
      void androidAway?.then(h => h.remove())
    })
  }
}
