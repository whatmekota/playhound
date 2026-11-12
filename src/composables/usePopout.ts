import type { DesktopDisplay } from '~/lib/browserApi'
import { useLocalStorage } from '@vueuse/core'
import { computed, effectScope, nextTick, ref, shallowRef, watch } from 'vue'
import { desktop } from '~/lib/browserApi'
import { setFrameSource } from '~/lib/frames'
import { KEYS } from '~/lib/persist'
import { useSafetyStore } from '~/stores/safetyStore'

/**
 * The pop-out player: the video in a small window of its own that stays on
 * top of other apps.
 *
 * The player's own element moves into the new window (VideoPlayer teleports
 * itself there): its bars, overlays and the 180° viewer. The <video> does
 * not. Chromium reloads a media element that changes document, so the video
 * would start again from the top; instead it stays in the main window,
 * parked out of sight but playing, and the pop-out paints its frames onto a
 * canvas. Script sync and the devices keep following the very element they
 * always did, and audio carries on from the main window. The window is an
 * empty same-origin document the main window writes into; it runs no code
 * of its own.
 *
 *   - desktop app: a frameless always-on-top window, with an opacity slider
 *     and click-through, so it can sit over a game or another video
 *   - Chrome / Edge: Document Picture-in-Picture, which browsers keep on top
 *     themselves but cannot make see-through
 *   - anywhere else: an ordinary popup window
 */

export type PopoutKind = 'desktop' | 'pip' | 'window'

const NAME = 'ph-popout'
/** Never fully see-through: something that cannot be seen cannot be found. */
export const MIN_OPACITY = 0.2
const BASE_WIDTH = 480

const win = shallowRef<Window | null>(null)
const target = shallowRef<HTMLElement | null>(null)
/** Click-through, desktop only. Never remembered: it would open unclickable. */
const clickThrough = ref(false)
/** The desktop app's global key for click-through, or null when another app holds it. */
const shortcut = ref<string | null>(null)
/** The pop-out fills its screen. */
const fullScreen = ref(false)

let opacity: ReturnType<typeof useLocalStorage<number>> | null = null
let teardown: (() => void) | null = null
let started = false
let parking: HTMLElement | null = null

/**
 * Where the <video> waits in the main window while popped out: on the page
 * (so it keeps decoding frames) but one pixel and fully transparent.
 */
function parkingEl() {
  if (!parking) {
    parking = document.createElement('div')
    parking.setAttribute('aria-hidden', 'true')
    parking.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1'
    document.body.appendChild(parking)
  }
  return parking
}

function kindNow(): PopoutKind {
  if (desktop?.popout)
    return 'desktop'
  if (typeof window !== 'undefined' && 'documentPictureInPicture' in window)
    return 'pip'
  return 'window'
}

// ── The new document ─────────────────────────────────────────────────────────

/** Theme, colour scheme and font size live on <html>; carry them over. */
function mirrorRoot(doc: Document) {
  const from = document.documentElement
  const to = doc.documentElement
  for (const name of ['class', 'data-theme', 'style', 'lang']) {
    const v = from.getAttribute(name)
    if (v === null)
      to.removeAttribute(name)
    else
      to.setAttribute(name, v)
  }
  doc.body.className = document.body.className
}

/**
 * The app's stylesheets, as they stand. Links get their absolute URL, since
 * the new document is about:blank. Re-run when <head> changes (the dev
 * server swaps styles in; the tooltip adds one).
 */
function copyStyles(doc: Document) {
  for (const old of doc.head.querySelectorAll('[data-ph-copied]'))
    old.remove()
  for (const node of document.head.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]')) {
    let copy: HTMLElement
    if (node instanceof HTMLLinkElement) {
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = node.href
      copy = link
    }
    else {
      copy = doc.createElement('style')
      copy.textContent = node.textContent
    }
    copy.setAttribute('data-ph-copied', '')
    doc.head.appendChild(copy)
  }
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable)
}

/**
 * Wire up a fresh window. Keys go to the main window, where every shortcut
 * is handled; focus and activity go there too, so panic-on-blur and the idle
 * cut-off see the pop-out as part of the app.
 */
function adopt(w: Window) {
  const doc = w.document
  doc.title = 'playhound'
  const base = doc.createElement('style')
  base.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden}#ph-popout{position:fixed;inset:0}'
  doc.head.appendChild(base)
  copyStyles(doc)
  mirrorRoot(doc)
  const mount = doc.createElement('div')
  mount.id = 'ph-popout'
  doc.body.appendChild(mount)

  let restyle: ReturnType<typeof setTimeout> | undefined
  const headObs = new MutationObserver(() => {
    clearTimeout(restyle)
    restyle = setTimeout(() => !w.closed && copyStyles(doc), 50)
  })
  headObs.observe(document.head, { childList: true, subtree: true, characterData: true })
  const rootObs = new MutationObserver(() => !w.closed && mirrorRoot(doc))
  rootObs.observe(document.documentElement, { attributes: true })
  rootObs.observe(document.body, { attributes: true, attributeFilter: ['class'] })

  // Full screen is the pop-out's own business: F11 toggles it, and Esc
  // leaves it here rather than reaching the main window as panic. (F, and a
  // double-click on the video, go through the player like any other key.)
  const ownKeys = new Set<string>()
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target))
      return
    if (e.type === 'keydown' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const own = (e.key === 'F11' && kindNow() === 'desktop') || (e.key === 'Escape' && fullScreen.value)
      if (own) {
        e.preventDefault()
        ownKeys.add(e.code)
        void setFullScreen(e.key === 'F11' ? !fullScreen.value : false)
        return
      }
    }
    if (e.type === 'keyup' && ownKeys.delete(e.code))
      return
    const copy = new KeyboardEvent(e.type, {
      key: e.key,
      code: e.code,
      location: e.location,
      repeat: e.repeat,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      bubbles: true,
      cancelable: true,
    })
    document.body.dispatchEvent(copy)
    if (copy.defaultPrevented)
      e.preventDefault()
  }
  // Only for whoever counts activity on the main window (the idle cut-off);
  // no coordinates, so nothing mistakes it for a real click there.
  const onActivity = () => window.dispatchEvent(new Event('ph:popout-activity'))
  const onBlur = () => window.dispatchEvent(new Event('ph:popout-blur'))

  w.addEventListener('keydown', onKey)
  w.addEventListener('keyup', onKey)
  w.addEventListener('pointerdown', onActivity, { passive: true })
  w.addEventListener('wheel', onActivity, { passive: true })
  w.addEventListener('blur', onBlur)
  w.addEventListener('pagehide', () => gone(w))
  // A browser's pop-out goes full screen through its own document.
  const onFullscreen = () => {
    if (kindNow() !== 'desktop')
      fullScreen.value = !!doc.fullscreenElement
  }
  doc.addEventListener('fullscreenchange', onFullscreen)
  // Belt and braces: not every way a window closes fires pagehide in time.
  const poll = setInterval(() => w.closed && gone(w), 1000)

  teardown = () => {
    clearInterval(poll)
    clearTimeout(restyle)
    headObs.disconnect()
    rootObs.disconnect()
    doc.removeEventListener('fullscreenchange', onFullscreen)
  }

  win.value = w
  target.value = mount
  setFrameSource(w)
}

/** The window went away (closed by the user, or by us). */
function gone(w: Window) {
  if (win.value !== w)
    return
  detach()
}

function detach() {
  teardown?.()
  teardown = null
  win.value = null
  target.value = null
  clickThrough.value = false
  fullScreen.value = false
  setFrameSource(null)
}

// ── Desktop window controls ──────────────────────────────────────────────────

function start() {
  if (started)
    return
  started = true
  opacity = useLocalStorage<number>(KEYS.popoutOpacity.key, 1)
  const api = desktop?.popout
  effectScope(true).run(() => {
    const safety = useSafetyStore()
    if (api) {
      api.onState((s) => {
        clickThrough.value = s.clickThrough
        shortcut.value = s.shortcut
        fullScreen.value = !!s.fullScreen && !!win.value
      })
      watch([win, () => opacity!.value, clickThrough, () => safety.panicked], ([w, o, through, panicked]) => {
        if (w)
          api.set({ opacity: Math.max(MIN_OPACITY, Math.min(1, o)), clickThrough: through, hidden: panicked })
      }, { flush: 'post' })
    }
    // Panic covers the main window and hides the pop-out: out of full screen first.
    watch(() => safety.panicked, (p) => {
      if (p && fullScreen.value)
        void setFullScreen(false)
    })
  })
}

/** Whether this kind of pop-out can fill the screen (Picture-in-Picture cannot). */
function canFullScreen() {
  return kindNow() === 'desktop' ? !!desktop?.popout?.displays : kindNow() === 'window'
}

/**
 * Fill the screen with the pop-out, or stop. The desktop app fills the
 * screen the window is on, or `display` (DesktopDisplay.id); a browser's
 * pop-out asks its own document (from a click or key in it).
 */
async function setFullScreen(on: boolean, display?: number) {
  const w = win.value
  if (!w || w.closed || !canFullScreen())
    return
  if (kindNow() === 'desktop') {
    desktop!.popout!.set(display === undefined ? { fullScreen: on } : { fullScreen: on, display })
    return
  }
  const doc = w.document
  try {
    if (on && !doc.fullscreenElement)
      await doc.documentElement.requestFullscreen()
    else if (!on && doc.fullscreenElement)
      await doc.exitFullscreen()
  }
  catch {
    // Refused (no click to go on): nothing to undo.
  }
}

/** The screens, for "Full screen on …" (desktop app; empty elsewhere). */
async function displays(): Promise<DesktopDisplay[]> {
  try {
    return await desktop?.popout?.displays?.() ?? []
  }
  catch {
    return []
  }
}

// ── Public ───────────────────────────────────────────────────────────────────

/**
 * Pop the video out. Call from a click or a key press: browsers only open
 * windows on a user gesture. `aspect` is width / height, for the first size.
 */
async function open(aspect = 16 / 9) {
  start()
  const current = win.value
  if (current && !current.closed) {
    current.focus()
    return true
  }
  const ratio = Number.isFinite(aspect) && aspect > 0.2 && aspect < 5 ? aspect : 16 / 9
  const width = BASE_WIDTH
  const height = Math.round(width / ratio)
  let w: Window | null = null
  try {
    if (kindNow() === 'pip')
      w = await (window as any).documentPictureInPicture.requestWindow({ width, height })
    else
      w = window.open('', NAME, `popup,width=${width},height=${height}`)
  }
  catch (err) {
    console.warn('[popout] could not open', err)
  }
  if (!w)
    return false
  adopt(w)
  desktop?.popout?.set({ aspect: ratio })
  return true
}

/** Bring the video back into the main window, then close the pop-out. */
async function close() {
  const w = win.value
  if (!w)
    return
  detach()
  // The player's element comes home on the next render; close after it.
  await nextTick()
  await nextTick()
  w.close()
}

/** The video's shape changed (a new video): fit the window to it. */
function fit(aspect: number) {
  if (win.value && Number.isFinite(aspect) && aspect > 0.2 && aspect < 5)
    desktop?.popout?.set({ aspect })
}

/** Whether focus is in the pop-out, for panic-on-blur. */
export function popoutFocused() {
  const w = win.value
  try {
    return !!w && !w.closed && w.document.hasFocus()
  }
  catch {
    return false
  }
}

export function usePopout() {
  start()
  return {
    kind: kindNow(),
    /** The element VideoPlayer teleports into while popped out. */
    target,
    /** Where the <video> waits in the main window meanwhile. */
    parking: parkingEl(),
    active: computed(() => !!target.value),
    opacity: opacity!,
    clickThrough,
    shortcut,
    fullScreen,
    canFullScreen: canFullScreen(),
    setFullScreen,
    displays,
    open,
    close,
    fit,
    toggle: (aspect?: number) => (target.value ? close() : open(aspect)),
  }
}
