import { reactive } from 'vue'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: number
  message: string
  /** Optional second line, smaller. */
  detail?: string
  kind: ToastKind
  /** UnoCSS icon class; defaults by kind. */
  icon?: string
  /** Thumbnail shown in place of the icon (now-playing cards). */
  image?: string | null
  action?: { label: string, run: () => void }
  /** ms; 0 keeps it until dismissed. */
  duration: number
}

/**
 * Small, app-wide notifications.
 *
 * Module-level state so anything — stores, composables, components — can raise
 * one without threading a provider through. ToastHost renders the list.
 * A toast with the same `key` replaces the previous one instead of stacking,
 * which is what volume or shuffle feedback wants when the key is held.
 */
const toasts = reactive<Toast[]>([])
const keyed = new Map<string, number>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let seq = 1

const MAX_VISIBLE = 4

export function dismissToast(id: number) {
  const i = toasts.findIndex(t => t.id === id)
  if (i >= 0)
    toasts.splice(i, 1)
  const timer = timers.get(id)
  if (timer)
    clearTimeout(timer)
  timers.delete(id)
  for (const [k, v] of keyed) {
    if (v === id)
      keyed.delete(k)
  }
}

export interface ToastOptions extends Partial<Omit<Toast, 'id' | 'message'>> {
  /** Replace any live toast raised with the same key. */
  key?: string
}

export function toast(message: string, opts: ToastOptions = {}): number {
  const { key, ...rest } = opts
  if (key && keyed.has(key))
    dismissToast(keyed.get(key)!)

  const t: Toast = { id: seq++, message, kind: 'info', duration: 2600, ...rest }
  toasts.push(t)
  if (key)
    keyed.set(key, t.id)
  while (toasts.length > MAX_VISIBLE)
    dismissToast(toasts[0].id)
  if (t.duration > 0)
    timers.set(t.id, setTimeout(() => dismissToast(t.id), t.duration))
  return t.id
}

toast.success = (message: string, opts: ToastOptions = {}) => toast(message, { kind: 'success', ...opts })
toast.warn = (message: string, opts: ToastOptions = {}) => toast(message, { kind: 'warn', ...opts })
toast.error = (message: string, opts: ToastOptions = {}) => toast(message, { kind: 'error', duration: 5000, ...opts })

/** Pause auto-dismiss while the pointer is over a toast. */
export function holdToast(id: number) {
  const timer = timers.get(id)
  if (timer)
    clearTimeout(timer)
  timers.delete(id)
}

export function releaseToast(id: number, after = 1500) {
  if (!toasts.some(t => t.id === id))
    return
  holdToast(id)
  timers.set(id, setTimeout(() => dismissToast(id), after))
}

export function useToast() {
  return { toasts, toast, dismiss: dismissToast, hold: holdToast, release: releaseToast }
}
