import { SHELL_HOTKEYS } from '~/lib/hotkeys'
import { MOD_KEY } from '~/lib/platform'

/**
 * Keyboard shortcuts for plugin commands.
 *
 * A shortcut is a letter, a digit or F1–F12, with any of Ctrl, Alt and Shift
 * ("Shift+K", "Alt+2", "Ctrl+Shift+Y"). Keys are matched by position
 * (KeyboardEvent.code), like playhound's own, so they work on any layout.
 * A plugin can't take a key playhound uses, one the browser or the window
 * needs (copy, reload, devtools…), or one another plugin has.
 */

export interface Chord {
  /** KeyboardEvent.code: KeyA…KeyZ, Digit0…Digit9, F1…F12. */
  code: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

const CODE_RE = /^(?:Key[A-Z]|Digit\d|F(?:[1-9]|1[0-2]))$/

/** "Ctrl+Shift+Y" → a chord; null if it isn't one a plugin can have. */
export function parseKbd(input: unknown): Chord | null {
  if (typeof input !== 'string')
    return null
  const parts = input.split('+').map(p => p.trim()).filter(Boolean)
  if (!parts.length)
    return null
  const key = parts.pop()!
  const c: Chord = { code: '', ctrl: false, alt: false, shift: false }
  for (const m of parts) {
    const k = m.toLowerCase()
    if (k === 'ctrl' || k === 'control' || k === 'cmd' || k === 'mod')
      c.ctrl = true
    else if (k === 'alt' || k === 'option')
      c.alt = true
    else if (k === 'shift')
      c.shift = true
    else
      return null
  }
  if (/^[a-z]$/i.test(key))
    c.code = `Key${key.toUpperCase()}`
  else if (/^\d$/.test(key))
    c.code = `Digit${key}`
  else if (/^f\d{1,2}$/i.test(key))
    c.code = key.toUpperCase()
  else
    return null
  return CODE_RE.test(c.code) ? c : null
}

/** The chord as keycaps: ['Ctrl', 'Shift', 'Y']. */
export function kbdKeys(c: Chord): string[] {
  const key = c.code.startsWith('Key') ? c.code.slice(3) : c.code.startsWith('Digit') ? c.code.slice(5) : c.code
  // Cmd counts as Ctrl (see chordOf), so a Mac shows it as ⌘.
  return [c.ctrl && MOD_KEY, c.alt && 'Alt', c.shift && 'Shift', key].filter((k): k is string => !!k)
}

/** One string per chord, for comparing. */
export const chordId = (c: Chord) => `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}-${c.code}`

/** The chord a key press makes. Cmd counts as Ctrl. */
export function chordOf(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): Chord {
  return { code: e.code, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey }
}

const plain = (code: string, shift = false): Chord => ({ code, ctrl: false, alt: false, shift })
const ctrlShift = (code: string): Chord => ({ code, ctrl: true, alt: false, shift: true })
const alt = (code: string): Chord => ({ code, ctrl: false, alt: true, shift: false })

/**
 * Keys a plugin can't have, with who has them. playhound's own come from the
 * hotkey list; the player reads F, M and O whether or not Shift is down.
 */
const RESERVED: [Chord, string][] = [
  ...SHELL_HOTKEYS.map(h => [plain(h.code, h.shift), 'playhound'] as [Chord, string]),
  ...['KeyF', 'KeyM', 'KeyO'].flatMap(code => [[plain(code), 'the player'], [plain(code, true), 'the player']] as [Chord, string][]),
  ...['KeyI', 'KeyJ', 'KeyC', 'KeyR', 'KeyN', 'KeyT', 'KeyW', 'KeyQ', 'KeyZ', 'KeyV', 'KeyB'].map(code => [ctrlShift(code), 'the browser'] as [Chord, string]),
  ...['KeyD', 'KeyE', 'KeyF'].map(code => [alt(code), 'the browser'] as [Chord, string]),
  [alt('F4'), 'the window'],
]
const RESERVED_IDS = new Map(RESERVED.map(([c, who]) => [chordId(c), who]))

/** Who already has this chord among playhound, the browser and the window; null if it is free. */
export function reservedBy(c: Chord): string | null {
  // Ctrl with a letter or digit, and no Shift, is the browser's and the
  // app's (copy, paste, select all, the palette, interface size…).
  if (c.ctrl && !c.shift)
    return 'the browser'
  // Reload, fullscreen, devtools, caret browsing.
  if (['F5', 'F7', 'F11', 'F12'].includes(c.code))
    return 'the browser'
  return RESERVED_IDS.get(chordId(c)) ?? null
}
