# Writing a playhound plugin

A plugin is a `.zip` with a `manifest.json` and one ES module. Users install
it from **Settings → Plugins**: from a GitHub repository they follow (the
plugin store), or from a file. Once it's switched on, playhound imports the
module and calls its default export with a context object, the plugin API.

**There is no sandbox.** A plugin runs inside playhound with the same access
playhound has, including the device. The install screen says so, and users
are told to install only plugins they trust. Write accordingly: never move the
device unless the user asked for it, and stop when they panic.

A plugin lists the [permissions](#permissions) it needs, and the install
screen shows them in plain words. The API holds the plugin to its list: a
call outside it throws. That is about being upfront with the user, not a
sandbox.

For a complete, real plugin, see [playmate](https://github.com/whatmekota/playmate).

## The zip

```text
manifest.json
index.js        (the module named by "main")
…               (anything else: images, sounds; reach them with ctx.asset)
```

A single folder wrapping all of this is fine; it's taken off.

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "One line about what it does.",
  "author": "you",
  "main": "index.js",
  "api": 2,
  "permissions": ["player", "device"]
}
```

- `id`: lower-case letters, digits and dashes. It's the plugin's identity:
  installing a zip with the same id updates the installed plugin and keeps its
  settings.
- `main` must be **one self-contained ES module**. It's imported from a
  `blob:` URL, so relative imports don't resolve. Bundle everything into it
  (esbuild, rollup, vite in library mode).
- `api`: the plugin API the plugin is written for, a whole number. Without it,
  1. This playhound speaks 2; a plugin that needs a newer one is refused, with
     a message saying to update playhound.
- `permissions`: what the plugin needs (below). Unknown names are refused.

## Permissions

Without a `permissions` list, an API 1 plugin keeps full access, as before
permissions existed, and Settings → Plugins labels it **Full access (older
plugin)**. With a list (or with `"api": 2`, which means "I list what I need"),
the plugin gets only what it lists; asking for nothing is fine.

| Permission | Shown to the user as                                     | Opens                                                                       |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `device`   | Move your device, and reshape scripts on their way to it | `motion.take`, `motion.filter`                                              |
| `scripts`  | Read the loaded scripts and load its own                 | `scripts.*`                                                                 |
| `player`   | See what is playing, where, and the picture              | `player.state / onChange / script / frame / clock`, `playback.onEnded`      |
| `playback` | Play, pause, seek and change the speed of videos         | `playback.play / pause / resume / playFingerprint`, `player.seek / setRate` |
| `library`  | Read your library: video names, stats and playlists      | `library.*`                                                                 |
| `network`  | Connect to servers through playhound                     | `net.fetch`                                                                 |
| `stage`    | Show its own page and draw over the video                | `ui.page / openPage / showStage / overlay`                                  |
| `web`      | Open web pages inside playhound                          | `webview.create`                                                            |

Everything else needs none: settings, storage, the panel, commands, styles,
toasts, `ui.stage / onStageChange`, `motion.readout`, `safety.*`,
`webview.available`, `asset`, `log`. A call outside the list throws an `Error` naming the permission to add.

A first install always shows the list and waits for the user to agree. An
update shows it again only if it asks for something the installed version
didn't have, with the new ones marked.

## The module

```js
export default function activate(ctx) {
  ctx.ui.settings([
    { type: 'heading', label: 'Basics' },
    { key: 'greeting', type: 'text', label: 'Greeting', default: 'hi' },
  ])
  ctx.ui.panel({
    title: 'My plugin',
    mount(el) {
      el.textContent = ctx.settings.get('greeting')
      return () => {} // cleanup when the panel closes
    },
  })
  // A whole page on the main stage, if a drawer panel is too small
  ctx.ui.page({
    title: 'My plugin',
    mount(el) {
      el.textContent = 'Hello from the stage'
    },
  })
  return () => {
    // undo anything not created through ctx (ctx's own listeners, styles and
    // the motion generator are cleaned up for you)
  }
}
```

`activate` may be async. It may return a function, or `{ deactivate }`, that
runs when the plugin is switched off, updated or removed.

The full contract, with comments, is in
[`src/plugins/types.ts`](../src/plugins/types.ts). In short:

| `ctx.…`                                                                   | What it gives                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`                                                                | the plugin's own manifest                                                                                                                                                                                                                                                                                                                                                        |
| `settings.get / all / set / onChange`                                     | its settings, as the user set them                                                                                                                                                                                                                                                                                                                                               |
| `storage.get / set / del`                                                 | a small persistent key/value store for its own data                                                                                                                                                                                                                                                                                                                              |
| `ui.settings(fields)`                                                     | the form shown under the plugin in Settings → Plugins. Field types: `text`, `password`, `textarea`, `number`, `slider`, `switch`, `select` (fixed or fetched options, optionally free text) and `heading`, which starts a section that folds away. Any field can have `when(values)` to show it only sometimes.                                                                  |
| `ui.panel({ title, icon, mount })`                                        | its panel: its own button on the right-hand rail and a drawer titled with its name. `icon` is an inline SVG in `currentColor` (about 16×16); without one a generic icon is used. `mount` gets a plain element; you build its DOM yourself.                                                                                                                                       |
| `ui.page({ title, icon, mount })`                                         | its page on the main stage, where the player, the library and the media wall show, with its own button in the left nav. Same shape as a panel; `mount` gets an element filling the stage.                                                                                                                                                                                        |
| `ui.openPage / stage / showStage`                                         | put its page on the stage; what the stage shows (`'player'`, `'library'`, `'wall'`, `'eroscripts'`…, or `'plugin:<id>'`); switch the stage to any of those                                                                                                                                                                                                                       |
| `ui.onStageChange(fn)`                                                    | know when the stage switches                                                                                                                                                                                                                                                                                                                                                     |
| `ui.style(css)`                                                           | CSS for that DOM. playhound's utility classes aren't available to you; its CSS variables are (`--text`, `--accent`, `--bg-850`, `--border`, `--radius-md`…), so a panel can follow the theme.                                                                                                                                                                                    |
| `ui.toast / openPanel / openSettings`                                     | small notices, and links into playhound's own UI                                                                                                                                                                                                                                                                                                                                 |
| `ui.overlay({ mount, interactive })`                                      | a layer over the video, on the full-size player and in fullscreen. Click-through unless `interactive`; to take clicks on a button only, leave it off and give the button `pointer-events: auto`. Not on the mini player (too small, and its controls are there) nor in the pop-out (another window your styles don't reach): `mount` runs again when the full player comes back. |
| `commands.register({ id, title, hint, icon, kbd, run }) / unregister(id)` | a command in the palette (Ctrl K), under the plugin's name, and in the shortcuts sheet if it has a key. `kbd` is a letter, digit or F1–F12 with any of Ctrl, Alt, Shift (`"Shift+K"`, `"Alt+2"`). A key playhound, the browser or another plugin uses is refused: `register` returns false, logs why, and adds the command without one.                                          |
| `player.state / onChange / script / frame`                                | what's playing; what the loaded script is doing now and next; the current picture as a small JPEG                                                                                                                                                                                                                                                                                |
| `player.clock / seek / setRate`                                           | the playback position in seconds, read off the video when called and steadied (finer than `state().time`, which moves a few times a second); jump; set the speed (the user's own speed setting). What a "watch together" plugin needs.                                                                                                                                           |
| `scripts.current / load / onChange`                                       | copies of the loaded scripts (per axis: `axis` like `L0`, its actions as in a .funscript, `at` ms and `pos` 0–100, and the video they're for); load one for the current video as if from a file (in memory only; it replaces that axis, others stay); know when they change                                                                                                      |
| `motion.filter((pos, { axis, t }) => pos)`                                | reshape script playback on its way to the device; see [Motion filters](#motion-filters)                                                                                                                                                                                                                                                                                          |
| `library.list / analyse / onChange`                                       | the user's library: videos with their length, script intensity, stars, playlists and play/finish counts                                                                                                                                                                                                                                                                          |
| `library.fingerprint(id)`                                                 | a stable id for a video's file, the same on any machine whatever it's called: `v1:<size>:<sha-256>` over its size and three 64 KB pieces (start, middle, end). Worked out once and kept.                                                                                                                                                                                         |
| `playback.play / pause / resume / onEnded`                                | put on a library video on its own, and know when it ends                                                                                                                                                                                                                                                                                                                         |
| `playback.playFingerprint(fp)`                                            | play the library video with that fingerprint; false if there is none                                                                                                                                                                                                                                                                                                             |
| `motion.take() → { set, hold, release }`                                  | the stroke generator (the Manual source), within the user's speed ceiling. Panic takes it back. Letting go restores the user's settings and leaves the generator stopped.                                                                                                                                                                                                        |
| `motion.readout`                                                          | what the device is doing: the generator's rate and depth, and the stroke position (a script's, while one plays)                                                                                                                                                                                                                                                                  |
| `safety.panicked / onPanic`                                               | panic (Esc). Stop everything you're doing.                                                                                                                                                                                                                                                                                                                                       |
| `net.fetch(url, init)`                                                    | `fetch()`; in the desktop app it's made from the app itself, so local servers without CORS headers answer, and it streams                                                                                                                                                                                                                                                        |
| `webview.create({ url, zoom })`                                           | a real web page inside playhound (desktop app only); see [Web pages](#web-pages)                                                                                                                                                                                                                                                                                                 |
| `asset(path)`                                                             | a `blob:` URL for a file from the plugin's zip                                                                                                                                                                                                                                                                                                                                   |
| `log(...)`                                                                | `console.log` with the plugin's name in front                                                                                                                                                                                                                                                                                                                                    |

## Motion filters

`ctx.motion.filter(fn)` runs every script position through `fn` before it
goes to the device: `pos` and the result are 0–1, `axis` is the TCode channel
(`L0` stroke, `R0` twist, `V0` vibrate…) and `t` the time in the script, ms.

- One filter per plugin; setting another replaces it. Filters of several
  plugins chain in the order the plugins are listed. It's removed when the
  plugin is switched off, or by calling what `filter` returned.
- It runs every frame for every axis, so keep it quick and free of side
  effects. One that throws or returns something that isn't a number is
  taken out at once (the console says so).
- The user stays in charge: the intensity knob, edges and each axis's range
  apply after your filter, and it can't make the device move faster than the
  script itself does at that point or than the speed ceiling, whichever is
  more.
- Streamed devices (serial OSR/SR6, Intiface strokers, a toy following the
  script's position) get it every frame. **The Handy** plays the script's
  points itself (whichever of its modes), so for it the filter runs over every
  point of the stroke script when the filter is set, and again when the
  script changes. A filter whose output drifts over time reaches the Handy
  only when you set it again; under Whole script each set uploads the script
  again, so don't do that every second.

## Web pages

`ctx.webview.create()` puts a real web page inside playhound: any site,
including the many that refuse to be shown in an `<iframe>`. It needs the
`web` permission and the **desktop app**. In a browser `ctx.webview.available`
is `false` and `create()` throws `Web pages need the playhound desktop app`;
check `available` first and say so in your page.

```js
export default function activate(ctx) {
  ctx.ui.page({
    title: 'Web',
    mount(el) {
      if (!ctx.webview.available) {
        el.textContent = 'This needs the playhound desktop app.'
        return
      }
      const box = document.createElement('div')
      box.style.cssText = 'flex: 1; min-height: 0'
      el.append(box)
      const view = ctx.webview.create({ url: 'https://example.com' })
      view.attach(box)
      view.onState(s => ctx.log(s.loading ? 'loading…' : s.title, s.url))
      return () => view.destroy()
    },
  })
}
```

- The page isn't part of your DOM. The desktop app draws it over
  playhound's window, where the element you `attach()` it to is, and keeps it
  there as the element moves or resizes, and when the user changes the
  interface size. It shows only while that element is in the document and
  visible: when your stage page leaves the stage, it hides. Destroy the view
  in your cleanup, as above, unless you want the page kept loaded for next
  time (attach it again then). Views are destroyed for you when the plugin
  is switched off.
- Nothing can be drawn over it, not even by you. playhound hides it while
  any of its own layers would be under it (a dialog, the command palette, a
  menu, a toast, the drop cover), and always on panic, when its sound is
  also muted and its videos paused. Keep your own menus and popups beside
  it, or `attach(null)` while they're open.
- `navigate(url)` takes http and https addresses only; anything else throws.
  `back / forward / reload / stop / setZoom` do what they say.
  `onState(fn)` gets `{ url, title, loading, canGoBack, canGoForward, error,
media, audible, fullscreen, focused, shown }` whenever any of it changes.
- At most 4 views are open at once, across all plugins; `create()` throws
  past that.
- What pages may do: links meant for a new tab or window open in the same
  view (pop-unders are dropped; nothing goes to the system browser). Pages
  get no permissions except full screen and the clipboard: no camera,
  microphone, location, notifications or devices. A video in full screen
  takes the whole window until it leaves. Downloads ask where to save.
- Esc and \` pressed inside a page panic, as everywhere in playhound, and
  Ctrl K (⌘ K) opens the palette.
- Pages run in a browsing session of their own (`persist:browsing`): cookies
  and logins are kept between runs, shared by all plugins' views, and kept
  apart from playhound's own. Sites see a plain Chrome; requests go through
  the proxy set in Settings → Network, like the rest of the app.

**What the permission means for the user.** The pages themselves are
sandboxed: no Node, no preload, no way to send anything to playhound or read
its data. But which page shows is the plugin's choice, and it shows inside
playhound's window: a plugin could put up a site made to look like a login
page or like playhound itself. The install screen says it plainly ("Open web
pages inside playhound"). Show the address of whatever you load, as a
browser would, so the user always knows where they are.

## An example

A plugin that softens the stroke with a key, and says where the video is:

```json
{ "id": "softer", "name": "Softer", "version": "1.0.0", "api": 2, "permissions": ["device", "player", "stage"] }
```

```js
export default function activate(ctx) {
  let remove = null
  ctx.commands.register({
    id: 'toggle',
    title: 'Softer strokes',
    hint: 'Keep the stroke in the middle half of its range',
    kbd: 'Shift+H',
    run() {
      if (remove) {
        remove()
        remove = null
      }
      else {
        remove = ctx.motion.filter((pos, { axis }) => (axis === 'L0' ? 0.25 + pos * 0.5 : pos))
      }
      ctx.ui.toast(remove ? 'Softer strokes on' : 'Softer strokes off')
    },
  })
  ctx.ui.overlay({
    mount(el) {
      const tag = document.createElement('div')
      tag.style.cssText = 'position:absolute;right:12px;bottom:72px;color:#fff;font:12px sans-serif'
      el.append(tag)
      let raf = requestAnimationFrame(function tick() {
        tag.textContent = `${ctx.player.clock().toFixed(1)} s${remove ? ' · softer' : ''}`
        raf = requestAnimationFrame(tick)
      })
      return () => cancelAnimationFrame(raf)
    },
  })
}
```

## Developing one: load it from a folder

**Settings → Plugins → Load from folder…** runs a plugin straight from its
folder (with `manifest.json` at the top, and `main` pointing at the built
module, e.g. `dist/index.js`). It shows with a **dev** badge and a **Reload**
button, and isn't installed: nothing is copied into playhound, and
**Unload** leaves the folder, the plugin's settings and its data alone. A dev
plugin with the id of an installed one stands in for it until it's unloaded.

- Save a file and it reloads: switched off, read again, imported again and
  switched on, its page staying on the stage. If the folder doesn't make a
  plugin at that moment (a half-written build, a typo in the manifest), the
  version running stays and the card says why.
- `node_modules`, `.git` and other dot-folders are skipped; up to 2000 files
  and 64 MB.
- In the desktop app the folder is watched for changes and remembered: the
  plugin comes back at the next start.
- In a browser (Chrome, Edge) the folder is picked with the File System Access
  API and looked at once a second. It comes back after a reload when the
  browser still lets playhound read it; otherwise it's listed with **Load
  again**, which asks.
- No install screen: the permissions are shown on the card, and enforced as
  for an installed plugin.

## Publishing it in the store

The store follows GitHub repositories. Each one's **latest release** is the
plugin. Attach two files to it:

- the plugin zip (any `*.zip` name)
- its `manifest.json`, the same one that's inside the zip. The store reads it
  to show the plugin's name, version and description before anything is
  downloaded.

Tag releases with the version (`v1.2.0`). The store offers an update when the
latest release's version is newer than the installed one. Users add a
repository by `owner/repo` or its github.com link in **Settings → Plugins →
Get plugins**. Nothing installs or updates without them clicking.

Don't put API keys or other secrets in a published zip.
