import type { Directive } from 'vue'

/**
 * v-tip — a real tooltip in place of `title`.
 *
 *   v-tip="'Shuffle'"
 *   v-tip="{ text: 'Next', kbd: 'N', placement: 'bottom' }"
 *
 * One shared element for the whole app, shown after a short delay and then
 * instantly while the pointer moves between tipped elements (the "warm"
 * window), the way native toolbars behave.
 */

export interface TipOptions {
  text?: string
  kbd?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

type TipValue = string | TipOptions | undefined | null

const SHOW_DELAY = 450
const WARM_MS = 600

let tipEl: HTMLDivElement | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null
let warmUntil = 0
let current: HTMLElement | null = null

const store = new WeakMap<HTMLElement, TipOptions>()

function ensureEl() {
  if (tipEl)
    return tipEl
  tipEl = document.createElement('div')
  tipEl.setAttribute('role', 'tooltip')
  tipEl.className = 'ph-tip'
  document.body.appendChild(tipEl)
  const style = document.createElement('style')
  style.textContent = `
.ph-tip{position:fixed;z-index:2000;pointer-events:none;display:flex;align-items:center;gap:8px;
  padding:5px 8px;border-radius:7px;font:500 12px/1.2 Geist,Inter,system-ui,sans-serif;
  color:var(--text);background:var(--bg-700);box-shadow:var(--shadow-pop);
  opacity:0;transform:translateY(2px) scale(.98);transition:opacity .12s var(--ease-out),transform .16s var(--ease-out);
  white-space:nowrap;max-width:320px}
.ph-tip.on{opacity:1;transform:none}
.ph-tip kbd{font:500 10.5px 'Geist Mono',ui-monospace,monospace;color:var(--text-muted);
  padding:1px 5px;border-radius:4px;background:color-mix(in srgb,var(--text) 8%,transparent)}`
  document.head.appendChild(style)
  return tipEl
}

function normalise(v: TipValue): TipOptions {
  if (!v)
    return {}
  return typeof v === 'string' ? { text: v } : v
}

function place(target: HTMLElement, opts: TipOptions) {
  const el = ensureEl()
  el.innerHTML = ''
  const span = document.createElement('span')
  span.textContent = opts.text ?? ''
  el.appendChild(span)
  if (opts.kbd) {
    const k = document.createElement('kbd')
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
  if (placement === 'right' && r.right + w + gap > window.innerWidth - 4)
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
  x = Math.max(4, Math.min(window.innerWidth - w - 4, x))
  y = Math.max(4, Math.min(window.innerHeight - h - 4, y))
  el.style.left = `${x}px`
  el.style.top = `${y}px`
}

function show(target: HTMLElement) {
  const opts = store.get(target)
  if (!opts?.text)
    return
  current = target
  place(target, opts)
  ensureEl().classList.add('on')
}

function hide() {
  if (showTimer)
    clearTimeout(showTimer)
  showTimer = null
  if (current)
    warmUntil = Date.now() + WARM_MS
  current = null
  tipEl?.classList.remove('on')
}

function onEnter(this: HTMLElement) {
  if (showTimer)
    clearTimeout(showTimer)
  const delay = Date.now() < warmUntil ? 0 : SHOW_DELAY
  showTimer = setTimeout(() => show(this), delay)
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
    if (current === el)
      hide()
    el.removeEventListener('pointerenter', onEnter)
    el.removeEventListener('pointerleave', hide)
    el.removeEventListener('pointerdown', hide)
    el.removeEventListener('focus', onEnter)
    el.removeEventListener('blur', hide)
  },
}
