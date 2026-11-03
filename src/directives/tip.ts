import type { Directive } from 'vue'

/**
 * v-tip — a real tooltip in place of `title`.
 *
 *   v-tip="'Shuffle'"
 *   v-tip="{ text: 'Next', kbd: 'N', placement: 'bottom' }"
 *
 * One shared element per document (the main window, and the pop-out player's
 * when the video is popped out), shown after a short delay and then instantly
 * while the pointer moves between tipped elements (the "warm" window), the
 * way native toolbars behave.
 */

export interface TipOptions {
  text?: string
  kbd?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

type TipValue = string | TipOptions | undefined | null

const SHOW_DELAY = 450
const WARM_MS = 600

const tipEls = new WeakMap<Document, HTMLDivElement>()
/** The document whose tip is showing. */
let shownIn: Document | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null
let warmUntil = 0
let current: HTMLElement | null = null
/** The element a delayed show is waiting for. */
let pending: HTMLElement | null = null

const store = new WeakMap<HTMLElement, TipOptions>()

function ensureEl(doc: Document) {
  let tipEl = tipEls.get(doc)
  if (tipEl?.isConnected)
    return tipEl
  tipEl = doc.createElement('div')
  tipEl.setAttribute('role', 'tooltip')
  tipEl.className = 'ph-tip'
  doc.body.appendChild(tipEl)
  tipEls.set(doc, tipEl)
  const style = doc.createElement('style')
  style.textContent = `
.ph-tip{position:fixed;z-index:2000;pointer-events:none;display:flex;align-items:center;gap:8px;
  padding:5px 8px;border-radius:7px;font:500 12px/1.35 Geist,Inter,system-ui,sans-serif;
  color:var(--text);background:var(--bg-700);box-shadow:var(--shadow-pop);
  opacity:0;transform:translateY(2px) scale(.98);transition:opacity .12s var(--ease-out),transform .16s var(--ease-out);
  width:max-content;max-width:min(300px,calc(100vw - 8px));text-wrap:pretty;overflow-wrap:break-word}
.ph-tip.on{opacity:1;transform:none}
.ph-tip span{min-width:0}
.ph-tip kbd{flex-shrink:0;white-space:nowrap;font:500 10.5px 'Geist Mono',ui-monospace,monospace;color:var(--text-muted);
  padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--text) 8%,transparent)}`
  doc.head.appendChild(style)
  return tipEl
}

function normalise(v: TipValue): TipOptions {
  if (!v)
    return {}
  return typeof v === 'string' ? { text: v } : v
}

function place(target: HTMLElement, opts: TipOptions) {
  const doc = target.ownerDocument
  const view = doc.defaultView ?? window
  if (shownIn && shownIn !== doc)
    tipEls.get(shownIn)?.classList.remove('on')
  shownIn = doc
  const el = ensureEl(doc)
  el.innerHTML = ''
  const span = doc.createElement('span')
  span.textContent = opts.text ?? ''
  el.appendChild(span)
  if (opts.kbd) {
    const k = doc.createElement('kbd')
    k.textContent = opts.kbd
    el.appendChild(k)
  }
  const r = target.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  const gap = 8
  let placement = opts.placement ?? 'top'
  if (placement === 'top' && r.top - h - gap < 4)
    placement = 'bottom'
  if (placement === 'left' && r.left - w - gap < 4)
    placement = 'right'
  if (placement === 'right' && r.right + w + gap > view.innerWidth - 4)
    placement = 'left'
  let x: number
  let y: number
  if (placement === 'top' || placement === 'bottom') {
    x = r.left + r.width / 2 - w / 2
    y = placement === 'top' ? r.top - h - gap : r.bottom + gap
  }
  else {
    x = placement === 'left' ? r.left - w - gap : r.right + gap
    y = r.top + r.height / 2 - h / 2
  }
  x = Math.max(4, Math.min(view.innerWidth - w - 4, x))
  y = Math.max(4, Math.min(view.innerHeight - h - 4, y))
  el.style.left = `${x}px`
  el.style.top = `${y}px`
}

function show(target: HTMLElement) {
  const opts = store.get(target)
  // The element may have gone between scheduling and showing (a dialog
  // closed under the pointer); a detached rect would pin the tip at 0,0.
  if (!opts?.text || !target.isConnected)
    return
  current = target
  place(target, opts)
  ensureEl(target.ownerDocument).classList.add('on')
}

function hide() {
  if (showTimer)
    clearTimeout(showTimer)
  showTimer = null
  pending = null
  if (current)
    warmUntil = Date.now() + WARM_MS
  current = null
  if (shownIn)
    tipEls.get(shownIn)?.classList.remove('on')
}

function onEnter(e: Event) {
  const el = e.currentTarget as HTMLElement
  if (showTimer)
    clearTimeout(showTimer)
  pending = el
  const delay = Date.now() < warmUntil ? 0 : SHOW_DELAY
  showTimer = setTimeout(() => show(el), delay)
}

function bind(el: HTMLElement, value: TipValue) {
  store.set(el, normalise(value))
  if (current === el) {
    const o = store.get(el)!
    if (o.text)
      place(el, o)
    else
      hide()
  }
}

export const vTip: Directive<HTMLElement, TipValue> = {
  mounted(el, { value }) {
    bind(el, value)
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointerleave', hide)
    el.addEventListener('pointerdown', hide)
    el.addEventListener('focus', onEnter)
    el.addEventListener('blur', hide)
  },
  updated(el, { value }) {
    bind(el, value)
  },
  beforeUnmount(el) {
    // Also cancel a show still waiting on its delay for this element.
    if (current === el || pending === el)
      hide()
    el.removeEventListener('pointerenter', onEnter)
    el.removeEventListener('pointerleave', hide)
    el.removeEventListener('pointerdown', hide)
    el.removeEventListener('focus', onEnter)
    el.removeEventListener('blur', hide)
  },
}
