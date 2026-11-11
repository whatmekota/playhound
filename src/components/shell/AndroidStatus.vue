<script setup lang="ts">
import { onMounted, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import { refreshSessionStatus, sessionStatus } from '~/composables/useAndroidSession'
import { toast } from '~/composables/useToast'
import { buildCrashReport, clearCrashReports, pageErrors } from '~/lib/android/crashReport'
import { ANDROID_LATER } from '~/lib/android/features'
import { getMediaBase } from '~/lib/android/nativeFile'
import { PhSession } from '~/lib/android/session'

/**
 * Settings → Android app: what this phone's WebView can do, checked live,
 * and what the app leaves out for now. "Copy report" puts the checks on the
 * clipboard, for a bug report.
 */

interface Check {
  label: string
  value: string
  ok: boolean | null
}

const checks = ref<Check[]>([])
const running = ref(true)

function canPlay(type: string) {
  const v = document.createElement('video')
  const ms = (globalThis as any).MediaSource
  return !!v.canPlayType(type) || (!!ms?.isTypeSupported && ms.isTypeSupported(type))
}

async function mediaServer(): Promise<Check> {
  const base = getMediaBase()
  if (!base) {
    try {
      const { ensureMediaServer } = await import('~/lib/android/folders')
      await ensureMediaServer()
    }
    catch (err) {
      return { label: 'Media server', value: `did not start: ${(err as Error).message}`, ok: false }
    }
  }
  try {
    // Its health check: 200 when it is up and the token is right.
    const res = await fetch(`${getMediaBase()}ping`, { cache: 'no-store' })
    return res.ok
      ? { label: 'Media server', value: 'OK', ok: true }
      : { label: 'Media server', value: `answers ${res.status}`, ok: false }
  }
  catch (err) {
    return { label: 'Media server', value: `not reachable: ${(err as Error).message}`, ok: false }
  }
}

async function folders(): Promise<Check> {
  try {
    const { PhFolders } = await import('~/lib/android/folders')
    const { trees } = await PhFolders.trees()
    return { label: 'Folders with access', value: trees.length ? trees.map(t => t.name).join(', ') : 'none yet', ok: null }
  }
  catch (err) {
    return { label: 'Folders plugin', value: `not answering: ${(err as Error).message}`, ok: false }
  }
}

async function bluetooth(): Promise<Check[]> {
  if (!(navigator as any).bluetooth)
    return [{ label: 'Bluetooth', value: 'did not start', ok: false }]
  try {
    const { blePermitted, bleEnabled } = await import('~/lib/android/ble')
    if (!(await blePermitted()))
      return [{ label: 'Bluetooth', value: 'not allowed yet: asked the first time you connect a Bluetooth device', ok: null }]
    const on = await bleEnabled()
    return [{ label: 'Bluetooth', value: on === false ? 'allowed, but Bluetooth is off' : 'allowed, on', ok: on !== false }]
  }
  catch (err) {
    return [{ label: 'Bluetooth', value: `not answering: ${(err as Error).message}`, ok: false }]
  }
}

async function usb(): Promise<Check[]> {
  try {
    const { usbLabel, usbStatus } = await import('~/lib/android/serial')
    const { host, devices, others } = await usbStatus()
    const names = devices.map(d => `${usbLabel(d).name}${d.permitted ? '' : ' (not allowed yet)'}`)
    return [
      { label: 'USB OTG (host)', value: host ? 'yes' : 'this phone says no', ok: host },
      { label: 'USB serial devices', value: names.length ? names.join(', ') : others ? `none (${others} other USB device${others === 1 ? '' : 's'})` : 'none plugged in', ok: null },
    ]
  }
  catch (err) {
    return [{ label: 'USB serial', value: `not answering: ${(err as Error).message}`, ok: false }]
  }
}

async function session(): Promise<Check[]> {
  const st = await refreshSessionStatus()
  if (!st)
    return [{ label: 'Background service', value: 'not answering', ok: false }]
  return [
    { label: 'Background service', value: st.error ? `could not start: ${st.error}` : st.running ? 'running' : 'idle (starts when a device connects or something plays)', ok: st.error ? false : null },
    { label: 'Keeps running with the screen off', value: st.webViewKept ? 'yes' : 'no: the app WebView is not in place', ok: st.webViewKept },
    { label: 'Notifications (Panic button)', value: st.notifications ? 'allowed' : 'off: the Panic button will not show', ok: st.notifications },
    { label: 'Battery', value: st.batteryUnrestricted ? 'unrestricted' : 'optimised: some phones stop apps in the background anyway', ok: st.batteryUnrestricted ? true : null },
  ]
}

async function allowNotifications() {
  const st = sessionStatus.value
  try {
    if (st && st.sdk >= 33 && !st.notifications)
      await PhSession.requestNotifications()
    await refreshSessionStatus()
    if (!sessionStatus.value?.notifications)
      await PhSession.openNotificationSettings()
  }
  catch {
    toast.error('Could not open the notification settings')
  }
}

async function batterySettings() {
  try {
    await PhSession.openBatterySettings()
  }
  catch {
    toast.error('Could not open the battery settings')
  }
}

function webgl(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
  }
  catch {
    return false
  }
}

async function run() {
  running.value = true
  const chrome = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?'
  const android = navigator.userAgent.match(/Android ([\d.]+)/)?.[1] ?? '?'
  const yes = (b: boolean) => (b ? 'yes' : 'no')
  const list: Check[] = [
    { label: 'Android / WebView', value: `Android ${android} · Chrome ${chrome}`, ok: null },
    { label: 'Secure context', value: yes(window.isSecureContext), ok: window.isSecureContext },
    await mediaServer(),
    await folders(),
    { label: 'Web Audio (binaural, e-stim)', value: yes(typeof AudioContext !== 'undefined'), ok: typeof AudioContext !== 'undefined' },
    { label: 'WebCodecs', value: yes(typeof (globalThis as any).VideoDecoder !== 'undefined'), ok: typeof (globalThis as any).VideoDecoder !== 'undefined' },
    { label: 'WebGL 2 (emulator, VR view)', value: yes(webgl()), ok: webgl() },
    { label: 'Fullscreen', value: yes(!!document.fullscreenEnabled), ok: !!document.fullscreenEnabled },
    { label: 'Screen wake lock', value: yes('wakeLock' in navigator), ok: 'wakeLock' in navigator },
    { label: 'H.264', value: yes(canPlay('video/mp4; codecs="avc1.640028"')), ok: canPlay('video/mp4; codecs="avc1.640028"') },
    { label: 'HEVC', value: yes(canPlay('video/mp4; codecs="hvc1.1.6.L120.90"')), ok: null },
    { label: 'VP9', value: yes(canPlay('video/webm; codecs="vp9"')), ok: null },
    { label: 'AV1', value: yes(canPlay('video/mp4; codecs="av01.0.08M.08"')), ok: null },
    ...await bluetooth(),
    ...await usb(),
    ...await session(),
  ]
  checks.value = list
  running.value = false
}

onMounted(run)

const errorCount = ref(pageErrors().length)

async function clearReports() {
  await clearCrashReports()
  errorCount.value = 0
  toast('Crash reports cleared', { icon: 'i-carbon-trash-can' })
}

async function copy() {
  const text = checks.value.map(c => `${c.label}: ${c.value}`).join('\n')
  try {
    await navigator.clipboard.writeText(`playhound Android checks\n${text}\n\n${await buildCrashReport()}`)
    toast.success('Copied the checks and crash reports')
  }
  catch {
    toast.error('Could not copy them')
  }
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <p class="hint">
      The Android app is new. Library folders, playback with scripts, the Handy over WiFi or Bluetooth, an OSR on a USB
      OTG cable, heart-rate monitors, Intiface on your PC over Wi-Fi and playing with the screen off are in; the rest
      follows as native pieces arrive.
    </p>

    <section class="flex flex-col gap-2">
      <div class="flex gap-2 items-center justify-between">
        <span class="eyebrow">This phone</span>
        <div class="flex gap-1">
          <UiButton size="xs" icon="i-carbon-renew" :loading="running" @click="run">
            Check again
          </UiButton>
          <UiButton size="xs" icon="i-carbon-copy" :disabled="running" @click="copy">
            Copy report
          </UiButton>
        </div>
      </div>
      <div class="card flex flex-col">
        <div v-for="c in checks" :key="c.label" class="text-[12.5px] px-3 py-2 border-b border-edge flex gap-3 items-baseline last:border-b-0">
          <span
            class="rounded-full shrink-0 h-2 w-2"
            :class="c.ok === true ? 'bg-ok' : c.ok === false ? 'bg-danger' : 'bg-fg-faint'"
          />
          <span class="text-fg-muted flex-1">{{ c.label }}</span>
          <span class="text-fg text-right max-w-[60%] break-words">{{ c.value }}</span>
        </div>
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <span class="eyebrow">Screen off</span>
      <p class="hint">
        While a device is connected or something plays, playhound keeps running behind its notification, which has a
        Panic button (the same as Esc). Closing the app from the recent apps panics too. If the phone stops it anyway
        (some brands do, to save battery), set playhound's battery use to Unrestricted. The Handy over WiFi plays the
        script on its own clock and keeps time even then; USB, Bluetooth, Intiface and TCode over the network need the
        app awake.
      </p>
      <div class="flex flex-wrap gap-1">
        <UiButton v-if="sessionStatus && !sessionStatus.notifications" size="xs" icon="i-carbon-notification" @click="allowNotifications">
          Allow notifications
        </UiButton>
        <UiButton size="xs" icon="i-carbon-battery-charging" @click="batterySettings">
          Battery settings
        </UiButton>
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <span class="eyebrow">Crash reports</span>
      <p class="hint">
        If playhound closes unexpectedly, it says so on the next start. "Copy report" above includes what it
        recorded: crashes, the page's renderer being closed for memory, and the page's last
        {{ errorCount }} error{{ errorCount === 1 ? '' : 's' }}. Nothing leaves the phone unless you paste it somewhere.
      </p>
      <div>
        <UiButton size="xs" icon="i-carbon-trash-can" @click="clearReports">
          Clear crash reports
        </UiButton>
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <span class="eyebrow">Not in the Android app yet</span>
      <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
        <li v-for="f in ANDROID_LATER" :key="f.label" class="text-[12.5px]">
          <span class="text-fg">{{ f.label }}</span>
          <span class="text-fg-muted">: {{ f.why }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
