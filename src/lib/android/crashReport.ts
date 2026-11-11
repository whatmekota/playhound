/**
 * Crash reports from the Android app, for the user to copy and send.
 *
 * Two halves:
 * - native (CrashPlugin.kt / CrashLog.kt): Java crashes, the WebView's
 *   renderer dying (crashed, or killed for memory), what Android says ended
 *   the last run, memory warnings. Kept in the app's private storage.
 * - the page (here): the last few uncaught errors, rejected promises and
 *   console.error lines, kept in localStorage so they outlive a crash.
 *
 * On the next launch, if the last run ended badly, the shell shows a banner
 * (CrashBanner.vue) with "Copy report"; Settings → Android app copies the same.
 */
import { registerPlugin } from '@capacitor/core'
import { KEYS } from '../persist'

interface PhCrashPlugin {
  status: () => Promise<{ unseen: boolean }>
  journal: () => Promise<{ app: string, memory: string, journal: string }>
  seen: () => Promise<void>
  clear: () => Promise<void>
}

export const PhCrash = registerPlugin<PhCrashPlugin>('PhCrash')

export interface ErrorEntry {
  /** ms since the epoch. */
  at: number
  kind: 'error' | 'rejection' | 'console'
  text: string
}

/** Entries kept, and the most of one entry's text. */
export const RING_MAX = 40
export const ENTRY_MAX = 2000

/** Add an entry, dropping the oldest past `max`; the same text twice in a row counts once. */
export function pushEntry(list: ErrorEntry[], entry: ErrorEntry, max = RING_MAX): ErrorEntry[] {
  const text = entry.text.length > ENTRY_MAX ? `${entry.text.slice(0, ENTRY_MAX)}…` : entry.text
  const last = list[list.length - 1]
  if (last && last.kind === entry.kind && last.text === text)
    return list
  const next = [...list, { ...entry, text }]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Anything thrown or logged, as one line of text (with a stack when there is one). */
export function describe(value: unknown): string {
  if (value instanceof Error)
    return value.stack && value.stack.includes(value.message) ? value.stack : `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value) ?? String(value)
  }
  catch {
    return String(value)
  }
}

export function formatEntries(list: readonly ErrorEntry[]): string {
  if (!list.length)
    return '(none)'
  return list.map(e => `${new Date(e.at).toISOString()} [${e.kind}] ${e.text}`).join('\n')
}

function load(): ErrorEntry[] {
  try {
    const raw = localStorage.getItem(KEYS.androidErrors.key)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v : []
  }
  catch {
    return []
  }
}

let entries: ErrorEntry[] = []
let saveTimer: ReturnType<typeof setTimeout> | undefined
let installed = false

function save() {
  try {
    localStorage.setItem(KEYS.androidErrors.key, JSON.stringify(entries))
  }
  catch {}
}

function add(kind: ErrorEntry['kind'], text: string) {
  entries = pushEntry(entries, { at: Date.now(), kind, text })
  // Soon, but not on every line of a burst; an error right before a crash
  // still has a good chance of making it.
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 250)
}

/** Start keeping the page's errors (once, at startup, in the Android app only). */
export function installErrorLog() {
  if (installed || typeof window === 'undefined')
    return
  installed = true
  entries = load()
  window.addEventListener('error', (e) => {
    // A resource that failed to load (an <img>, a <video>) is not an error in the page.
    if (!(e instanceof ErrorEvent))
      return
    add('error', e.error ? describe(e.error) : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`)
  }, true)
  window.addEventListener('unhandledrejection', e => add('rejection', describe(e.reason)))
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      add('console', args.map(describe).join(' '))
    }
    catch {}
    original(...args)
  }
}

export function pageErrors(): readonly ErrorEntry[] {
  return entries
}

/** Whether the last run ended badly and nobody has been told yet. */
export async function lastRunEndedBadly(): Promise<boolean> {
  try {
    return (await PhCrash.status()).unseen
  }
  catch {
    return false
  }
}

export async function markCrashSeen() {
  try {
    await PhCrash.seen()
  }
  catch {}
}

/** Everything there is to say, as text for the clipboard. */
export async function buildCrashReport(): Promise<string> {
  let native = { app: 'playhound (Android)', memory: '', journal: '' }
  try {
    native = await PhCrash.journal()
  }
  catch (err) {
    native.journal = `(the crash journal could not be read: ${(err as Error).message})`
  }
  const chrome = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?'
  return [
    'playhound Android crash report',
    `${native.app} · WebView ${chrome}`,
    native.memory,
    `Screen ${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x`,
    '',
    '== Native events (newest last) ==',
    native.journal.trim() || '(none)',
    '',
    '== Page errors (newest last) ==',
    formatEntries(entries),
  ].join('\n')
}

export async function clearCrashReports() {
  entries = []
  save()
  try {
    await PhCrash.clear()
  }
  catch {}
}
