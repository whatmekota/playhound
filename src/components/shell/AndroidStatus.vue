<script setup lang="ts">
import { onMounted, ref } from 'vue'
import UiButton from '~/components/ui/UiButton.vue'
import { toast } from '~/composables/useToast'
import { buildCrashReport, clearCrashReports, pageErrors } from '~/lib/android/crashReport'
import { ANDROID_LATER } from '~/lib/android/features'
import { getMediaBase } from '~/lib/android/nativeFile'

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

async function build(): Promise<Check> {
  try {
    const { appInfo } = await import('~/lib/android/app')
    const i = await appInfo()
    return { label: 'App', value: `${i.version} (${i.code}) · ${i.debug ? 'debug build' : 'release build'}`, ok: null }
  }
  catch (err) {
    return { label: 'App plugin', value: `not answering: ${(err as Error).message}`, ok: false }
  }
}

async function forum(): Promise<Check> {
  try {
    const { PhNet } = await import('~/lib/android/net')
    const { signedIn } = await PhNet.forumStatus()
    return { label: 'EroScripts session', value: signedIn ? 'signed in' : 'not signed in', ok: null }
  }
  catch (err) {
    return { label: 'Net plugin', value: `not answering: ${(err as Error).message}`, ok: false }
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
    await build(),
    { label: 'Android / WebView', value: `Android ${android} · Chrome ${chrome}`, ok: null },
    { label: 'Secure context', value: yes(window.isSecureContext), ok: window.isSecureContext },
    await mediaServer(),
    await folders(),
    await forum(),
    { label: 'Web Audio (binaural, e-stim)', value: yes(typeof AudioContext !== 'undefined'), ok: typeof AudioContext !== 'undefined' },
    { label: 'WebCodecs', value: yes(typeof (globalThis as any).VideoDecoder !== 'undefined'), ok: typeof (globalThis as any).VideoDecoder !== 'undefined' },
    { label: 'WebGL 2 (emulator, VR view)', value: yes(webgl()), ok: webgl() },
    { label: 'Fullscreen', value: yes(!!document.fullscreenEnabled), ok: !!document.fullscreenEnabled },
    { label: 'Screen wake lock', value: yes('wakeLock' in navigator), ok: 'wakeLock' in navigator },
    { label: 'H.264', value: yes(canPlay('video/mp4; codecs="avc1.640028"')), ok: canPlay('video/mp4; codecs="avc1.640028"') },
    { label: 'HEVC', value: yes(canPlay('video/mp4; codecs="hvc1.1.6.L120.90"')), ok: null },
    { label: 'VP9', value: yes(canPlay('video/webm; codecs="vp9"')), ok: null },
    { label: 'AV1', value: yes(canPlay('video/mp4; codecs="av01.0.08M.08"')), ok: null },
    { label: 'Web Bluetooth', value: yes(!!(navigator as any).bluetooth), ok: null },
    { label: 'Web Serial', value: yes('serial' in navigator), ok: null },
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
      The Android app is new. Library folders (reading and saving), playback with scripts, the Handy over WiFi, the
      EroScripts browser and streaming from file hosts are in; the rest follows as native pieces arrive.
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
