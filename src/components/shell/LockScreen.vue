<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { eraseAppData } from '~/lib/backup'
import { desktop } from '~/lib/browserApi'
import { isAndroidApp, isTouchOnly } from '~/lib/platform'
import { PIN_MAX, PIN_MIN } from '~/lib/privacyLock'
import { usePrivacyStore } from '~/stores/privacyStore'

/**
 * The app lock's screen: the PIN on its keypad or the keyboard, or Android's
 * fingerprint / face prompt.
 *
 * Like panic's cover, opaque from its first frame and plain on purpose:
 * neutral greys whatever the theme, no name and no logo, nothing that says
 * which app this is. It sits above everything, panic's cover and the splash
 * included, and the page under it is made inert, so nothing there can be
 * reached by Tab, a click or a screen reader.
 */
const privacy = usePrivacyStore()

const entry = ref('')
const checking = ref(false)
const wrong = ref(false)
/** Bumped to replay the shake on each wrong PIN. */
const shakes = ref(0)
const forgot = ref(false)
const confirmErase = ref(false)
const erasing = ref(false)

const length = computed(() => privacy.digits || PIN_MAX)

// The wait after too many wrong PINs counts down by the second.
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
const waitSec = computed(() => Math.ceil(privacy.waitMs(now.value) / 1000))
watch(waitSec, (s) => {
  if (s > 0 && tick === null) {
    tick = setInterval(() => (now.value = Date.now()), 500)
  }
  else if (s <= 0 && tick !== null) {
    clearInterval(tick)
    tick = null
  }
}, { immediate: true })

const message = computed(() => {
  if (waitSec.value > 0) {
    const m = Math.floor(waitSec.value / 60)
    const s = String(waitSec.value % 60).padStart(2, '0')
    return `Too many tries. Wait ${m}:${s}`
  }
  if (wrong.value)
    return 'Wrong PIN'
  return 'Enter your PIN'
})

function press(d: string) {
  if (checking.value || waitSec.value > 0 || entry.value.length >= length.value)
    return
  wrong.value = false
  entry.value += d
  // The PIN's own length is known, so it checks as soon as the last digit is in.
  if (entry.value.length === length.value)
    void submit()
}

function del() {
  if (!checking.value)
    entry.value = entry.value.slice(0, -1)
}

async function submit() {
  now.value = Date.now()
  if (checking.value || entry.value.length < PIN_MIN || waitSec.value > 0)
    return
  checking.value = true
  try {
    const r = await privacy.unlock(entry.value)
    if (r === 'ok')
      return
    entry.value = ''
    now.value = Date.now()
    if (r === 'wrong') {
      wrong.value = true
      shakes.value++
    }
  }
  finally {
    checking.value = false
  }
}

const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'] as const

// ── Keyboard ─────────────────────────────────────────────────────────────────
// Caught on the way down, before anything else on the page: no shortcut of
// the app's (or a plugin's) runs under the lock.
function onKey(e: KeyboardEvent) {
  e.stopImmediatePropagation()
  if (e.ctrlKey || e.metaKey || e.altKey)
    return
  if (forgot.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeForgot()
    }
    return
  }
  if (/^\d$/.test(e.key)) {
    e.preventDefault()
    press(e.key)
  }
  else if (e.key === 'Backspace') {
    e.preventDefault()
    del()
  }
  else if (e.key === 'Enter') {
    e.preventDefault()
    void submit()
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    entry.value = ''
  }
}

// ── Forgot the PIN ───────────────────────────────────────────────────────────
const WHERE = isAndroidApp ? 'on this phone' : desktop ? 'on this computer' : 'in this browser'
const AGAIN = isTouchOnly ? 'Tap again to erase' : 'Click again to erase'
let eraseTimer: ReturnType<typeof setTimeout> | null = null

function openForgot() {
  entry.value = ''
  wrong.value = false
  forgot.value = true
}

function closeForgot() {
  forgot.value = false
  confirmErase.value = false
}

/** Two presses, like forgetting a folder: there is no undo. */
async function erase() {
  if (!confirmErase.value) {
    confirmErase.value = true
    eraseTimer = setTimeout(() => (confirmErase.value = false), 4000)
    return
  }
  if (eraseTimer)
    clearTimeout(eraseTimer)
  erasing.value = true
  try {
    await eraseAppData()
  }
  finally {
    location.reload()
  }
}

// Everything else on the page goes inert: the app, and what it put straight
// on <body> (dialogs, menus, the palette), including anything that turns up
// while locked.
const root = ref<HTMLElement | null>(null)
const madeInert: HTMLElement[] = []
function inertOthers(nodes: Iterable<Node>) {
  for (const n of nodes) {
    if (n instanceof HTMLElement && n !== root.value && !n.hasAttribute('inert') && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') {
      n.setAttribute('inert', '')
      madeInert.push(n)
    }
  }
}
let watcher: MutationObserver | null = null

onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  inertOthers(document.body.children)
  watcher = new MutationObserver((changes) => {
    for (const c of changes)
      inertOthers(c.addedNodes)
  })
  watcher.observe(document.body, { childList: true })
  // Whatever had focus underneath (a field half typed in) lets go of it.
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  root.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  watcher?.disconnect()
  for (const el of madeInert)
    el.removeAttribute('inert')
  if (tick !== null)
    clearInterval(tick)
  if (eraseTimer)
    clearTimeout(eraseTimer)
})

// The frameless desktop window draws its own title bar, which is under the
// lock: keep a strip to drag the window by, with minimise and close.
const win = desktop?.window ?? null
const mac = desktop?.platform === 'darwin'
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="lock text-neutral-200 outline-none bg-neutral-950 flex flex-col cursor-default select-none inset-0 fixed z-[2147483000]"
      role="dialog"
      aria-modal="true"
      aria-label="Locked. Enter your PIN."
      tabindex="-1"
      @contextmenu.prevent
      @dragover.prevent
      @drop.prevent
    >
      <div v-if="win" class="lock-drag flex shrink-0 h-[34px] justify-end">
        <template v-if="!mac">
          <button type="button" tabindex="-1" class="lock-no-drag text-neutral-400 center h-full w-[46px] hover:text-neutral-100 hover:bg-white/8" aria-label="Minimise" @click="win.minimize()">
            <span class="i-carbon-subtract-large text-[14px]" />
          </button>
          <button type="button" tabindex="-1" class="lock-no-drag text-neutral-400 center h-full w-[46px] hover:text-white hover:bg-[#c42b1c]" aria-label="Close" @click="win.close()">
            <span class="i-carbon-close-large text-[14px]" />
          </button>
        </template>
      </div>

      <div class="lock-body px-4 flex flex-1 min-h-0 items-center justify-center">
        <!-- The PIN -->
        <template v-if="!forgot">
          <div class="lock-head flex flex-col items-center">
            <span class="text-neutral-300 rounded-full bg-white/6 center h-12 w-12">
              <span class="i-carbon-locked text-[22px]" />
            </span>
            <p class="text-[15px] mt-4 h-6" :class="wrong || waitSec > 0 ? 'text-[#f0a0a0]' : 'text-neutral-300'" role="status" aria-live="polite">
              {{ message }}
            </p>
            <div :key="shakes" class="mt-3 flex gap-3.5 h-4 items-center" :class="shakes ? 'lock-shake' : ''" aria-hidden="true">
              <span
                v-for="i in length"
                :key="i"
                class="border-1.5 rounded-full h-3 w-3 transition-[background-color,transform] duration-150"
                :class="[
                  i <= entry.length ? 'bg-neutral-100 border-neutral-100 scale-100' : 'border-neutral-500 scale-90',
                  checking ? 'animate-pulse' : '',
                ]"
              />
            </div>
            <button
              type="button"
              class="lock-forgot text-[12.5px] text-neutral-500 mt-6 px-2 py-1 rounded hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-neutral-400"
              @click="openForgot"
            >
              Forgot your PIN?
            </button>
          </div>

          <div class="lock-pad gap-x-5 gap-y-3.5 grid grid-cols-3" role="group" aria-label="Keypad">
            <template v-for="k in KEYPAD" :key="k">
              <button
                v-if="k === 'bio'"
                type="button"
                class="key text-neutral-300"
                :class="privacy.canBiometric ? '' : 'invisible'"
                :disabled="!privacy.canBiometric || privacy.prompting"
                aria-label="Unlock with fingerprint or face"
                @click="privacy.offerBiometric()"
              >
                <span class="i-carbon-fingerprint-recognition text-[26px]" />
              </button>
              <button
                v-else-if="k === 'del'"
                type="button"
                class="key text-neutral-300"
                :class="entry ? '' : 'opacity-0 pointer-events-none'"
                aria-label="Delete"
                @click="del"
              >
                <span class="i-carbon-arrow-left text-[22px]" />
              </button>
              <button
                v-else
                type="button"
                class="key key-digit text-[26px] text-neutral-100 font-light tabular-nums"
                :disabled="waitSec > 0"
                @click="press(k)"
              >
                {{ k }}
              </button>
            </template>
          </div>
        </template>

        <!-- Forgot it -->
        <div v-else class="flex flex-col gap-4 max-w-[400px] w-full">
          <span class="text-neutral-300 rounded-full bg-white/6 center h-12 w-12">
            <span class="i-carbon-help text-[22px]" />
          </span>
          <h2 class="text-[18px] text-neutral-100 font-medium m-0">
            Forgot your PIN?
          </h2>
          <p class="text-[13.5px] text-neutral-400 leading-relaxed m-0">
            It can't be shown again: playhound keeps only a scrambled copy. The way in without it is to erase
            everything playhound keeps {{ WHERE }}: settings, library folders, playlists, stars, stats and plugins.
          </p>
          <p class="text-[13.5px] text-neutral-400 leading-relaxed m-0">
            Your videos and scripts stay where they are. A backup you exported brings the rest back, without the lock.
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button type="button" class="btn text-neutral-200 bg-white/8 hover:bg-white/12" :disabled="erasing" @click="closeForgot">
              Back
            </button>
            <button
              type="button"
              class="btn text-[#ffb4b4] bg-[#7f1d1d]/45 hover:bg-[#7f1d1d]/65"
              :disabled="erasing"
              @click="erase"
            >
              <span :class="erasing ? 'i-carbon-renew animate-spin' : 'i-carbon-trash-can'" class="text-[15px]" />
              {{ erasing ? 'Erasing…' : confirmErase ? AGAIN : 'Erase everything' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.lock {
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background-image: radial-gradient(
    ellipse 80% 70% at 50% 40%,
    color-mix(in srgb, currentColor 5%, transparent),
    transparent 70%
  );
}

.lock-body {
  flex-direction: column;
  gap: 36px;
}

.key {
  display: grid;
  place-items: center;
  width: 68px;
  height: 68px;
  border-radius: 9999px;
  transition:
    background-color 120ms,
    transform 120ms;
}
.key-digit {
  background: rgb(255 255 255 / 0.06);
}
/* Not on touch: a tapped key would keep its hover colour. */
@media (hover: hover) {
  .key:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.1);
  }
}
.key:active:not(:disabled) {
  background: rgb(255 255 255 / 0.16);
  transform: scale(0.94);
}
.key:disabled {
  opacity: 0.35;
}
.key:focus-visible {
  outline: 2px solid rgb(255 255 255 / 0.5);
  outline-offset: 2px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 13px;
  transition: background-color 120ms;
}
.btn:disabled {
  opacity: 0.5;
}
.btn:focus-visible {
  outline: 2px solid rgb(255 255 255 / 0.5);
  outline-offset: 2px;
}

/* A phone held sideways (or any short window): the PIN beside the keypad. */
@media (max-height: 560px) {
  .lock-body {
    flex-direction: row;
    gap: 48px;
  }
  .lock-forgot {
    margin-top: 16px;
  }
  .lock-pad {
    row-gap: 8px;
  }
  .key {
    width: 56px;
    height: 56px;
  }
}

.lock-shake {
  animation: lock-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
}
@keyframes lock-shake {
  20%,
  60% {
    transform: translateX(-8px);
  }
  40%,
  80% {
    transform: translateX(8px);
  }
}

.lock-drag {
  -webkit-app-region: drag;
  app-region: drag;
}
.lock-no-drag {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
</style>
