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

## Browser support

Needs a Chromium-based browser: the File System Access API for the library and
organizer, and Web Serial for TCode output. Buttplug works anywhere Intiface does.

## Layout

Panels are grouped in the rail on the right — Media, Script, Session, Device, Data.
Clicking an icon opens a panel; middle-clicking pins it to a second slot above the
active one, so a readout stays visible while you work elsewhere. Sidebar width, both
slots and the split ratio persist.

## Stack

Vue 3.5, Vite 7, UnoCSS (`presetWind4`), vue-router 5 with file-based routing,
Pinia, Vitest, ESLint. Themes are CSS custom properties bound into the UnoCSS theme,
so `surface-*` and `accent-*` reskin across dark, light, catppuccin and dracula.

Scaffolded from [vitesse-lite](https://github.com/antfu-collective/vitesse-lite).
