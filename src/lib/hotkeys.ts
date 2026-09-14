/**
 * Every global hotkey, in one place.
 *
 * The cheat sheet renders from this, and the shell dispatches from it, so a key
 * cannot exist without being listed. Player keys are marked `owner: 'player'`:
 * they are handled inside VideoPlayer, which owns the media element, but they
 * still belong in the list.
 */

export type ShellAction
  = | 'bookmark' | 'star' | 'next' | 'prev' | 'random' | 'panic' | 'help'

export interface Hotkey {
  /** How the key is written in the cheat sheet. */
  keys: string
  label: string
  /** Which handler owns it. */
  owner: 'shell' | 'player'
  /** KeyboardEvent.code, for the keys the shell dispatches itself. */
  code?: string
  action?: ShellAction
}

export interface HotkeyGroup {
  title: string
  keys: Hotkey[]
}

export const HOTKEY_GROUPS: HotkeyGroup[] = [
  {
    title: 'Playback',
    keys: [
      { keys: 'Space', label: 'Play / pause', owner: 'player' },
      { keys: '← / →', label: 'Seek 5 seconds', owner: 'player' },
      { keys: 'Shift + ← / →', label: 'Seek 30 seconds', owner: 'player' },
      { keys: 'F', label: 'Fullscreen', owner: 'player' },
    ],
  },
  {
    title: 'Library',
    keys: [
      { keys: 'N', label: 'Next video', owner: 'shell', code: 'KeyN', action: 'next' },
      { keys: 'P', label: 'Previous video', owner: 'shell', code: 'KeyP', action: 'prev' },
      { keys: 'R', label: 'Random scripted video', owner: 'shell', code: 'KeyR', action: 'random' },
      { keys: 'S', label: 'Star current video', owner: 'shell', code: 'KeyS', action: 'star' },
      { keys: 'B', label: 'Add bookmark here', owner: 'shell', code: 'KeyB', action: 'bookmark' },
    ],
  },
  {
    title: 'Audio',
    keys: [
      { keys: '↑ / ↓', label: 'Volume up / down', owner: 'player' },
      { keys: 'M', label: 'Mute', owner: 'player' },
    ],
  },
  {
    title: 'Speed',
    keys: [
      { keys: '[', label: 'Slower by 0.25×', owner: 'player' },
      { keys: ']', label: 'Faster by 0.25×', owner: 'player' },
      { keys: '\\', label: 'Reset to 1×', owner: 'player' },
    ],
  },
  {
    title: 'Safety',
    keys: [
      { keys: 'Esc  or  `', label: 'Panic — stop everything and cover the screen; again to resume', owner: 'shell', code: 'Escape', action: 'panic' },
    ],
  },
  {
    title: 'Help',
    keys: [
      { keys: '?', label: 'This list', owner: 'shell', action: 'help' },
    ],
  },
]

/** Shell-dispatched keys, as a code lookup. */
export const SHELL_HOTKEYS: { code: string, action: ShellAction }[] = HOTKEY_GROUPS
  .flatMap(g => g.keys)
  .filter((k): k is Hotkey & { code: string, action: ShellAction } =>
    k.owner === 'shell' && !!k.code && !!k.action)
  .map(({ code, action }) => ({ code, action }))
  // Backquote is a second way to reach panic, easier to hit without looking.
  .concat([{ code: 'Backquote', action: 'panic' }])
