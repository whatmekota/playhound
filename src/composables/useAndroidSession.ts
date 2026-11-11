import type { PluginListenerHandle } from '@capacitor/core'
import type { SessionStatus } from '~/lib/android/session'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { disconnectAllBle } from '~/lib/android/ble'
import { closeAllSerial, setSerialPanic } from '~/lib/android/serial'
import { mediaTitle, PhSession, sessionSummary } from '~/lib/android/session'
import { setFrameTimer } from '~/lib/frames'
import { KEYS } from '~/lib/persist'
import { encodeTCode } from '~/lib/tcodeEncoder'
import { useAudioStore } from '~/stores/audio'
import { useDeviceStore } from '~/stores/deviceStore'
import { useMotionStore } from '~/stores/motionStore'
import { usePlayerStore } from '~/stores/playerStore'
import { useSafetyStore } from '~/stores/safetyStore'
import { useButtplug } from './useButtplug'
import { useEstim } from './useEstim'
import { useHandy } from './useHandy'
import { heartRate } from './useHeartRate'
import { toast } from './useToast'

/** Latest from the service, for Settings → Android app. */
export const sessionStatus = ref<SessionStatus | null>(null)

const NOTIFY_ASKED_KEY = KEYS.androidNotifyAsked.key
/** How often the state is sent again while active: it renews the service's wake lock. */
const RENEW_MS = 5 * 60_000
/** Frames by timer while the screen is off: ~30 a second, plenty for TCode's 33 ms. */
const BACKGROUND_FRAME_MS = 30

/**
 * The Android app's session service, driven from the page (AndroidDevices
 * mounts it once): it runs while anything is connected or playing, its
 * notification says what, and its Panic (or the app being swiped away)
 * reaches panic here, exactly as Esc does.
 */
export function useAndroidSession() {
  const device = useDeviceStore()
  const player = usePlayerStore()
  const audio = useAudioStore()
  const motion = useMotionStore()
  const safety = useSafetyStore()
  const handy = useHandy()
  const bp = useButtplug()
  const estim = useEstim()

  const summary = computed(() => {
    const connected: string[] = []
    if (handy.connected.value)
      connected.push(handy.link.value === 'ble' ? 'Handy (Bluetooth)' : 'Handy (WiFi)')
    if (device.serialUp)
      connected.push('OSR (USB)')
    if (device.netUp)
      connected.push('TCode (network)')
    if (bp.connected.value)
      connected.push('Intiface')
    if (heartRate.status === 'connected' || heartRate.status === 'reconnecting')
      connected.push('Heart-rate monitor')
    if (estim.running.value)
      connected.push('E-stim')
    return sessionSummary({
      mediaPlaying: player.isPlaying,
      mediaName: mediaTitle(player.videoPath),
      otherPlaying: audio.isPlaying.value || estim.running.value || motion.running,
      connected,
      network: device.netUp || bp.connected.value || (handy.connected.value && handy.link.value !== 'ble'),
    })
  })

  let sendTimer: ReturnType<typeof setTimeout> | null = null
  let renewTimer: ReturnType<typeof setInterval> | null = null

  async function send() {
    sendTimer = null
    const s = summary.value
    try {
      sessionStatus.value = await PhSession.update(s)
    }
    catch (err) {
      console.warn('[android] session', err)
      return
    }
    if (s.active)
      void askForNotifications()
  }

  // Android 13+: without it the service still runs, but its notification
  // (and so its Panic button) does not show. Asked once, the first time
  // there is something to show; Settings → Android app can ask again.
  async function askForNotifications() {
    const st = sessionStatus.value
    if (!st || st.notifications || st.sdk < 33)
      return
    try {
      if (localStorage.getItem(NOTIFY_ASKED_KEY))
        return
      localStorage.setItem(NOTIFY_ASKED_KEY, '1')
    }
    catch {}
    toast('playhound keeps running with the screen off', {
      detail: 'Allow notifications to see it there, with a Panic button',
      icon: 'i-carbon-notification',
      key: 'android-notify',
    })
    sessionStatus.value = await PhSession.requestNotifications().catch(() => st)
  }

  watch(summary, (s, was) => {
    // Coming on or going off at once; the words can wait a moment.
    const flip = !was || s.active !== was.active
    if (sendTimer !== null)
      clearTimeout(sendTimer)
    sendTimer = setTimeout(() => void send(), flip ? 0 : 400)
    if (s.active && renewTimer === null) {
      renewTimer = setInterval(() => void send(), RENEW_MS)
    }
    else if (!s.active && renewTimer !== null) {
      clearInterval(renewTimer)
      renewTimer = null
    }
  }, { immediate: true, deep: true })

  // What the OSR is sent if the app closes before this page can stop it.
  const homeText = computed(() => {
    if (!device.serialUp)
      return ''
    const ver = device.tcodeVersion
    const channels = new Set([...device.enabledAxes.map(a => a.channel), 'L0'])
    return [...channels].map((ch) => {
      const a = device.axisConfigs[ch]
      return a ? encodeTCode({ channel: ch, position: a.defaultPos, interval: 600 }, { min: a.min, max: a.max, invert: a.invert }, ver) : ''
    }).join('')
  })
  watch(homeText, t => setSerialPanic(t), { immediate: true })

  let foreground = true
  function frameSource() {
    setFrameTimer(!foreground && summary.value.active ? BACKGROUND_FRAME_MS : null)
  }
  watch(() => summary.value.active, frameSource)

  async function onPanic(reason: 'notification' | 'closing') {
    try {
      if (!safety.panicked)
        safety.toggle()
      if (reason === 'closing') {
        // Give the stops a moment on their way, then let go of the devices.
        await new Promise(r => setTimeout(r, 150))
        await Promise.race([
          Promise.all([disconnectAllBle(), closeAllSerial()]),
          new Promise(r => setTimeout(r, 300)),
        ])
      }
    }
    finally {
      void PhSession.panicDone().catch(() => {})
    }
  }

  const onWindowPanic = (e: Event) => void onPanic((e as CustomEvent).detail?.reason === 'closing' ? 'closing' : 'notification')
  window.addEventListener('ph:native-panic', onWindowPanic)

  const handles: Promise<PluginListenerHandle>[] = [
    PhSession.addListener('panic', e => void onPanic(e.reason)),
    PhSession.addListener('appState', (e) => {
      foreground = e.foreground
      frameSource()
    }),
  ]

  onScopeDispose(() => {
    window.removeEventListener('ph:native-panic', onWindowPanic)
    for (const h of handles)
      void h.then(x => x.remove())
    if (sendTimer !== null)
      clearTimeout(sendTimer)
    if (renewTimer !== null)
      clearInterval(renewTimer)
    setFrameTimer(null)
  })
}

/** Ask the service how it is, for Settings → Android app. */
export async function refreshSessionStatus(): Promise<SessionStatus | null> {
  try {
    sessionStatus.value = await PhSession.status()
  }
  catch {
    sessionStatus.value = null
  }
  return sessionStatus.value
}
