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
    | 'view-player' | 'view-library' | 'view-playlists'
    | 'queue' | 'library-panel' | 'device' | 'shuffle' | 'repeat' | 'palette'
    | 'edge' | 'edge-release' | 'intensity-up' | 'intensity-down' | 'next-peak' | 'finish' | 'came'
    | 'tap-tempo' | 'tap-clear' | 'record'

export interface Hotkey {
  /** How the key is written in the cheat sheet. */
  keys: string
  label: string
  /** Which handler owns it. The editor's keys only work while it is open, and win over the others then. */
  owner: 'shell' | 'player' | 'editor'
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
      { keys: ', / .', label: 'Previous / next chapter of the script', owner: 'player' },
      { keys: 'F', label: 'Fullscreen', owner: 'player' },
      { keys: 'O', label: 'Pop out — a small window that stays on top; again to bring it back', owner: 'player' },
      { keys: 'V', label: 'Subtitles on / off', owner: 'player' },
      { keys: 'Shift + V', label: 'Next subtitle track', owner: 'player' },
      { keys: 'Double-click left / right', label: 'Seek 10 seconds (keep clicking to skip more)', owner: 'player' },
      { keys: 'Double-click centre', label: 'Fullscreen', owner: 'player' },
      { keys: 'Shift + S', label: 'Shuffle on / off', owner: 'shell', code: 'KeyS', action: 'shuffle' },
      { keys: 'Shift + R', label: 'Cycle repeat', owner: 'shell', code: 'KeyR', action: 'repeat' },
    ],
  },
  {
    title: 'Navigate',
    keys: [
      { keys: 'Ctrl + K', label: 'Command palette', owner: 'shell', action: 'palette' },
      { keys: '1', label: 'Player', owner: 'shell', code: 'Digit1', action: 'view-player' },
      { keys: '2', label: 'Library', owner: 'shell', code: 'Digit2', action: 'view-library' },
      { keys: '3', label: 'Playlists', owner: 'shell', code: 'Digit3', action: 'view-playlists' },
      { keys: 'Q', label: 'Queue', owner: 'shell', code: 'KeyQ', action: 'queue' },
      { keys: 'L', label: 'Library beside the video', owner: 'shell', code: 'KeyL', action: 'library-panel' },
      { keys: 'D', label: 'Device', owner: 'shell', code: 'KeyD', action: 'device' },
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
      { keys: 'Wheel over the video', label: 'Volume up / down', owner: 'player' },
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
    title: 'Session',
    keys: [
      { keys: 'E', label: 'Edge — back everything off for a while; again if still close', owner: 'shell', code: 'KeyE', action: 'edge' },
      { keys: 'Shift + E', label: 'I’m OK — end the hold and start easing back', owner: 'shell', code: 'KeyE', action: 'edge-release' },
      { keys: '- / =', label: 'Intensity down / up', owner: 'shell', code: 'Equal', action: 'intensity-up' },
      { keys: 'G', label: 'Jump to the next peak', owner: 'shell', code: 'KeyG', action: 'next-peak' },
      { keys: 'Shift + G', label: 'Jump to the finish — the most intense part', owner: 'shell', code: 'KeyG', action: 'finish' },
      { keys: 'C', label: 'I came — mark it on this video', owner: 'shell', code: 'KeyC', action: 'came' },
      { keys: 'Shift + C', label: 'Record what the device does; again to stop', owner: 'shell', code: 'KeyC', action: 'record' },
      { keys: 'T', label: 'Tap tempo — tap on the beat a few times; once to put the beat back', owner: 'shell', code: 'KeyT', action: 'tap-tempo' },
      { keys: 'Shift + T', label: 'Forget the tapped tempo', owner: 'shell', code: 'KeyT', action: 'tap-clear' },
    ],
  },
  {
    title: 'Script editor',
    keys: [
      { keys: 'Drag on empty space', label: 'Select the points in a box', owner: 'editor' },
      { keys: 'Shift + click  or  Ctrl + click', label: 'Add a point to the selection, or take it out', owner: 'editor' },
      { keys: 'Ctrl + A', label: 'Select every point', owner: 'editor' },
      { keys: 'Double-click  or  I', label: 'Add a point — where you click, or at the playhead', owner: 'editor' },
      { keys: 'Delete', label: 'Delete the selected points', owner: 'editor' },
      { keys: 'Shift + I', label: 'Fill between the selected points, or insert a pattern at the playhead', owner: 'editor' },
      { keys: 'Alt + drag', label: 'Mark a stretch of time to fill', owner: 'editor' },
      { keys: '← / →', label: 'Move the selection in time — 10 ms, or a frame when snapping (Shift: ×10)', owner: 'editor' },
      { keys: '↑ / ↓', label: 'Move the selection up or down by 1 (Shift: ×10)', owner: 'editor' },
      { keys: ', / .', label: 'Previous / next point', owner: 'editor' },
      { keys: 'Ctrl + Z', label: 'Undo', owner: 'editor' },
      { keys: 'Ctrl + Shift + Z  or  Ctrl + Y', label: 'Redo', owner: 'editor' },
      { keys: 'Ctrl + S', label: 'Save', owner: 'editor' },
      { keys: 'Ctrl + Shift + S', label: 'Save as…', owner: 'editor' },
      { keys: 'Wheel  or  Shift + wheel', label: 'Zoom  or  scroll', owner: 'editor' },
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

/** Shell-dispatched keys, as a code lookup. `shift` distinguishes S from Shift+S. */
export const SHELL_HOTKEYS: { code: string, shift: boolean, action: ShellAction }[] = HOTKEY_GROUPS
  .flatMap(g => g.keys)
  .filter((k): k is Hotkey & { code: string, action: ShellAction } =>
    k.owner === 'shell' && !!k.code && !!k.action)
  .map(({ code, action, keys }) => ({ code, action, shift: keys.startsWith('Shift') }))
  // Backquote is a second way to reach panic, easier to hit without looking.
  .concat([{ code: 'Backquote', shift: false, action: 'panic' }])
  // '- / =' is one row of the sheet but two keys; the keypad works too.
  .concat([
    { code: 'Minus', shift: false, action: 'intensity-down' },
    { code: 'NumpadSubtract', shift: false, action: 'intensity-down' },
    { code: 'NumpadAdd', shift: false, action: 'intensity-up' },
  ])
