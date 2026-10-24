# playhound

An audiovisual session engine and funscript video player with TCode/OSR device support.

This is the merge of two previously separate apps — **MWHOPlayer** (funscript video
player) and **playhound** (binaural/slideshow session engine) — into one. Both halves
now share a single device output layer, so a session can drive hardware just as a
script can.

## What it does

**Player** — local video library with automatic funscript matching, playlists,
bookmarks, an organizer that renames videos and scripts together, watch stats, an
EroScripts browser, 180° SBS playback and a VRM viewer.

**Session** — binaural tone generator with a noise layer, a free-placement media
wall, a beat-synced slideshow, and a session engine that moves through
entry → build → peak → descent phases, drifting parameters as it goes.

**Device** — TCode over Web Serial, Buttplug/Intiface, and an on-screen OSR
emulator. Per-axis range, inversion and resting position, with presets.

## Motion sources

The device is fed by one of four sources, switchable live:

| Source    | Drives the axis from                                    |
| --------- | ------------------------------------------------------- |
| `script`  | the loaded funscript, following video playback          |
| `session` | session intensity — phase sets stroke rate and depth    |
| `beat`    | the binaural beat, divided down to a usable stroke rate |
| `manual`  | the rate and depth sliders in the Motion panel          |

The funscript always wins while a script is playing, so the generator never fights
video sync for the same axis.

### Safety

Generated motion drives real hardware, so the generator is bounded:

- a speed ceiling (`maxSpm`) it can never exceed, whatever the session asks for
- rate and depth ramp rather than jump — 25 spm/s and 0.4 depth/s by default, so a
  phase change eases in over a few seconds instead of slamming the axis
- phase is accumulated rather than recomputed from elapsed time, so changing the
  rate alters speed without ever jumping position
- frame delta is clamped, so a backgrounded tab cannot resume with a lurch
- stopping eases depth to zero and homes the axes

The maths behind these lives in `src/lib/motionMath.ts` and is covered by unit tests.

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:6969
pnpm dev:proxy    # optional: EroScripts/Pixeldrain CORS proxy on :7071
```

`dev:proxy` is only needed for the EroScripts panel.

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## Desktop app

playhound also runs as a Windows desktop app (Electron, in `desktop/`). It is
the same app, served the same way, so nothing in `src/` knows the difference.

```bash
pnpm app          # dev: Electron window on the Vite dev server, with HMR
pnpm app:build    # vite build + NSIS installer and portable .exe in release/
pnpm app:dir      # same, but only release/win-unpacked/ (quicker)
```

- **What it runs.** The built app serves `dist/` on `0.0.0.0:6969` (so the phone
  can still open `http://<lan-ip>:6969/remote`), runs the EroScripts proxy (:7071)
  and the remote relay (:7072) in-process, and opens its window on
  `http://localhost:6969`. No terminal, no `pnpm dev:proxy`.
- **start.bat** launches the desktop app when it finds one — `release\win-unpacked\`
  first, then an installed copy — and falls back to the old browser flow
  otherwise. `start.bat browser` forces the browser flow.
- **One copy at a time.** Starting it again focuses the open window. If port 6969
  is held by a playhound dev server, the app uses that; if something else holds
  it, it says so and quits. A busy 7071/7072 (a stray `pnpm dev:proxy`) is
  shared, not fatal.
- **Serial.** Connect works as in Chrome, minus the chooser when there is only
  one port. With several, a small list asks which one, defaulting to the port
  used last time.
- **Library folder.** The remembered folder comes back on launch without the
  "reconnect" click the browser needs: the app grants its own origin file
  access on restored handles. Chromium still refuses system folders (AppData,
  Program Files, Windows, the bare user profile) in the folder picker, so keep
  the library somewhere ordinary, such as a Videos folder or another drive.
- **Window.** Size, position and maximised state are remembered; the window
  opens in the colour of the theme it was closed in. No menu bar. Ctrl+Shift+I
  or F12 opens DevTools. External links open in the system browser.
- **Keeps running when hidden.** Background throttling is off, so a minimised
  window keeps driving the device, and audio may start without a click (the
  phone remote can resume a session on an untouched desktop).
- **Data.** The app has its own Chromium profile in `%APPDATA%\playhound`
  (`playhound-dev` for `pnpm app`), so the browser's library, playlists and
  settings do not carry over by themselves. Move them once: in the browser, open
  **Backup** in the right rail and export; in the app, import that file there.
  Uninstalling leaves the profile alone.
- **First run.** The build is unsigned, so SmartScreen asks once, and Windows
  Firewall asks whether playhound may listen on private networks. Allow it, or
  the phone cannot reach the app.

## Browser support

Needs a Chromium-based browser: the File System Access API for the library and
organizer, and Web Serial for TCode output. Buttplug works anywhere Intiface does.

## Layout

- **Left nav** picks what the stage shows: Player, Library, Playlists, Media Wall,
  Slideshow, EroScripts, Organizer, Stats.
- **Right rail** opens tool panels in a resizable drawer: Queue, Scripts, Bookmarks,
  Device, Motion, Remote, Binaural, Hypno, Director, Backup. Middle-click an icon to
  pin that panel above the active one.
- **Dock** along the bottom: now playing, transport, timeline, and live device /
  motion / binaural status.
- Away from the Player view the video keeps playing as a **mini player** in the corner.
- **Ctrl K** opens the command palette (views, commands, videos); **?** lists every
  shortcut.

Everything goes through `src/stores/playbackStore.ts`, so the library, playlists,
queue, hotkeys, gamepad and phone remote all share one idea of what plays next.
UI primitives live in `src/components/ui/`, design tokens in `src/styles/main.css`.

## Stack

Vue 3.5, Vite 7, UnoCSS (`presetWind4`), vue-router 5 with file-based routing,
Pinia, Vitest, ESLint. Themes are CSS custom properties bound into the UnoCSS theme,
so `surface-*`, `fg-*`, `accent-*` and the status colours reskin across dark, light,
catppuccin and dracula.

Scaffolded from [vitesse-lite](https://github.com/antfu-collective/vitesse-lite).
