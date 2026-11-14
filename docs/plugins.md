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

For complete, real plugins, see the official ones:
[playmate](https://github.com/whatmekota/playmate) (panels, settings, motion,
the network), [ph2gether](https://github.com/whatmekota/ph2gether) (sync,
fingerprints, commands, WebRTC) and
[phbrowser](https://github.com/whatmekota/phbrowser) (a stage page with a web
view). All three are TypeScript bundled with esbuild into one module.

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
  "api": 3,
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
  1. This playhound speaks 5; a plugin that needs a newer one is refused, with
     a message saying to update playhound. Plugins written for older ones run
     as they did. API 3 added [playing in another app](#playing-in-another-app),
     [sockets](#sockets), [serving on the network](#serving-on-the-network),
     [library sources](#library-sources) and [session control](#session-control),
     plus a few smaller things marked _(3)_ below. API 4 added
     [the picture, media and music](#the-picture-media-and-music), marked _(4)_,
     and API 5 [a song's shape and a video's strokes](#a-songs-shape-and-a-videos-strokes),
     marked _(5)_.
- `permissions`: what the plugin needs (below). Unknown names are refused.
- The store's own fields (an icon, screenshots, a category and so on) are
  optional; see [The store listing](#the-store-listing).

## Permissions

Without a `permissions` list, an API 1 plugin keeps full access to what
there was before permissions existed (the first nine below), and Settings →
Plugins labels it **Full access (older plugin)**. With a list (or with
`"api": 2` or more, which means "I list what I need"), the plugin gets only
what it lists; asking for nothing is fine. The API 3 permissions always have
to be listed, by older plugins too.

| Permission       | Shown to the user as                                                                      | Opens                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device`         | Move your device, and reshape scripts on their way to it                                  | `motion.take`, `motion.filter`                                                                                                                                                          |
| `scripts`        | Read the loaded scripts and load its own                                                  | `scripts.*`                                                                                                                                                                             |
| `player`         | See what is playing, where, the picture, and your edges and intensity                     | `player.state / onChange / script / frame / clock / picture / onPicture / video`, `playback.onEnded`, `session.edgeState / onEdge / onFinish`, `session.intensity.get / max / onChange` |
| `playback`       | Play, pause, seek and change the speed of videos                                          | `playback.play / pause / resume / playFingerprint / next / previous`, `player.seek / setRate`                                                                                           |
| `library`        | Read your library: videos, their scripts, stats and playlists                             | `library.list / analyse / onChange / fingerprint / info / media / thumbnail / scripts / open / strokes`, `music.analyse({ video })`                                                     |
| `library-edit`   | Change your videos' tags and source links                                                 | `library.tag`, `library.setSource`                                                                                                                                                      |
| `network`        | Connect to servers through playhound                                                      | `net.fetch`                                                                                                                                                                             |
| `stage`          | Show its own page, draw over the video and change how the picture looks                   | `ui.page / openPage / showStage / overlay`, `player.effects`                                                                                                                            |
| `web`            | Open web pages inside playhound                                                           | `webview.create`                                                                                                                                                                        |
| `external`       | Follow a video playing in another app, such as a VR headset, and move your device with it | `playback.external`                                                                                                                                                                     |
| `session`        | Call edges, change the intensity and know when you finish                                 | `session.edge / endEdge / intensity.set / restore`, and what `player` reads of the session                                                                                              |
| `library-source` | Add videos to your library from another app                                               | `library.provide`                                                                                                                                                                       |
| `socket`         | Connect to apps and devices on your network                                               | `net.socket`                                                                                                                                                                            |
| `serve`          | Share your library with devices on your network                                           | `http.serve / url / urls / rootAliases / stop`, `library.mediaUrl / scriptUrl` (these two need `library` as well)                                                                       |

Everything else needs none: settings, storage, the panel, commands, styles,
toasts, `ui.stage / onStageChange / theme / onThemeChange`, `motion.readout`,
`safety.*`, `webview.available`, `net.socketAvailable`, `http.available /
url`, _(4)_ `music.analyse` of a file the plugin has, `music.script`, _(5)_ `music.plan`,
`files.save`, `asset`, `log`. A call outside the list throws an `Error` naming the
permission to add.

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

| `ctx.…`                                                                   | What it gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`                                                                | the plugin's own manifest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `settings.get / all / set / onChange`                                     | its settings, as the user set them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `storage.get / set / del`                                                 | a small persistent key/value store for its own data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ui.settings(fields)`                                                     | the form shown under the plugin in Settings → Plugins. Field types: `text`, `password`, `textarea`, `number`, `slider`, `switch`, `select` (fixed or fetched options, optionally free text) and `heading`, which starts a section that folds away. Any field can have `when(values)` to show it only sometimes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ui.panel({ title, icon, mount })`                                        | its panel: its own button on the right-hand rail and a drawer titled with its name. `icon` is an inline SVG in `currentColor` (about 16×16); without one a generic icon is used. `mount` gets a plain element; you build its DOM yourself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ui.page({ title, icon, mount })`                                         | its page on the main stage, where the player, the library and the media wall show, with its own button in the left nav. Same shape as a panel; `mount` gets an element filling the stage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ui.openPage / stage / showStage`                                         | put its page on the stage; what the stage shows (`'player'`, `'library'`, `'wall'`, `'eroscripts'`…, or `'plugin:<id>'`); switch the stage to any of those                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ui.onStageChange(fn)`                                                    | know when the stage switches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ui.style(css)`                                                           | CSS for that DOM. playhound's utility classes aren't available to you; its CSS variables are (`--text`, `--accent`, `--bg-850`, `--border`, `--radius-md`…), so a panel can follow the theme.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ui.toast / openPanel / openSettings`                                     | small notices, and links into playhound's own UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ui.overlay({ mount, interactive })`                                      | a layer over the video, on the full-size player and in fullscreen. Click-through unless `interactive`; to take clicks on a button only, leave it off and give the button `pointer-events: auto`. Not on the mini player (too small, and its controls are there) nor in the pop-out (another window your styles don't reach): `mount` runs again when the full player comes back. _(3)_ The player's bars cover `var(--ph-controls-top)` and `var(--ph-controls-bottom)` of the picture right now (0px when hidden); `bottom: calc(var(--ph-controls-bottom) + 12px)` keeps clear. The player's root (`el.closest('[data-ph-controls]')`) says `shown` or `hidden`. To sit over the picture itself rather than the whole player (a portrait video is pillarboxed), use `var(--ph-picture-left)`, `-top`, `-width` and `-height`, or `player.picture()` / `player.onPicture(fn)`, which give the same rectangle in px with the player's size. |
| `commands.register({ id, title, hint, icon, kbd, run }) / unregister(id)` | a command in the palette (Ctrl K), under the plugin's name, and in the shortcuts sheet if it has a key. `kbd` is a letter, digit or F1–F12 with any of Ctrl, Alt, Shift (`"Shift+K"`, `"Alt+2"`). A key playhound, the browser or another plugin uses is refused: `register` returns false, logs why, and adds the command without one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `player.state / onChange / script / frame`                                | what's playing (with its speed, `rate`, and _(3)_ the picture's own `width` and `height` in pixels, so a portrait video is `height > width`; 0 before it loads and for sound alone); what the loaded script is doing now and next; the current picture as a small JPEG                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `player.clock / seek / setRate`                                           | the playback position in seconds, read off the video when called and steadied (finer than `state().time`, which moves a few times a second); jump; set the speed (the user's own speed setting). What a "watch together" plugin needs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts.current / load / onChange`                                       | copies of the loaded scripts (per axis: `axis` like `L0`, its actions as in a .funscript, `at` ms and `pos` 0–100, and the video they're for); load one for the current video as if from a file (in memory only; it replaces that axis, others stay); know when they change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `motion.filter((pos, { axis, t }) => pos)`                                | reshape script playback on its way to the device; see [Motion filters](#motion-filters)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `library.list / analyse / onChange / info / media / thumbnail`            | the user's library: videos with their length, script intensity, stars, playlists, play/finish counts, tags and source link, and _(3)_ `width`, `height` (once read) and `sizeBytes`; `info(id)` also reads its script's own metadata (the thread it came from, its creator); _(3)_ `media(id)` reads the length and picture size from the file when they aren't known yet, and `thumbnail(id)` gives the library's 320×180 JPEG (made from a frame if needed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `library.tag(id, { add, remove }) / setSource(id, url)`                   | add and remove a video's tags; set the link it came from (a forum thread), which then shows in its info. Needs `library-edit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `library.fingerprint(id)`                                                 | a stable id for a video's file, the same on any machine whatever it's called: `v1:<size>:<sha-256>` over its size and three 64 KB pieces (start, middle, end). Worked out once and kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `playback.play / pause / resume / onEnded`                                | put on a library video on its own, and know when it ends; _(3)_ `next() / previous()` do what the Next and Previous keys do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `playback.playFingerprint(fp)`                                            | play the library video with that fingerprint; false if there is none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `motion.take() → { set, hold, release }`                                  | the stroke generator (the Manual source), within the user's speed ceiling. Panic takes it back. Letting go restores the user's settings and leaves the generator stopped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `motion.readout`                                                          | what the device is doing: the generator's rate and depth, and the stroke position (a script's, while one plays). _(3)_ `phase`, the generator's stroke phase 0–1 with 0 at the bottom, and `nextStrokeInMs`, until it is next at the bottom (where a beat lands); both null while it isn't stroking. `scriptDriving`: a script plays and drives the stroke, so `motion.take` waits until it stops (the two never fight over one axis)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `safety.panicked / onPanic / onResume`                                    | panic (Esc). Stop everything you're doing; `onResume` when the user lifts it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `net.fetch(url, init)`                                                    | `fetch()`; in the desktop app it's made from the app itself, so local servers without CORS headers answer, and it streams                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `webview.create({ url, zoom })`                                           | a real web page inside playhound (desktop app only); see [Web pages](#web-pages)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `playback.external({ label, video, … })` _(3)_                            | follow a video playing in another app (a VR headset); see [Playing in another app](#playing-in-another-app)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `net.socket({ host, port })` _(3)_                                        | a TCP connection to an app on the local network (desktop app only); see [Sockets](#sockets)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `http.serve / url / stop`, `library.mediaUrl / scriptUrl` _(3)_           | answer devices on the network from the desktop app's server, and links that stream library videos and scripts; see [Serving on the network](#serving-on-the-network)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `library.provide({ label, videos, scripts })` _(3)_                       | add videos from another app to the library; see [Library sources](#library-sources)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.*` _(3)_                                                         | edges, the intensity knob, finishes; see [Session control](#session-control)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ui.theme / onThemeChange` _(3)_                                          | the theme's id (also `data-theme` on `<html>`), and a call when it changes, after its CSS variables have the new colours: read them with `getComputedStyle(document.documentElement)` to repaint a canvas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `commands.keyFree(kbd)` _(3)_                                             | whether a shortcut could be had. `kbd` in `register` may also be a list (`['Shift+B', 'Alt+B']`): the first free one is taken, and only when none is free is that logged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `player.video()` _(4)_                                                    | the player's own `<video>` element, to draw from (a canvas, a WebGL texture); see [The picture, media and music](#the-picture-media-and-music)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `player.effects({ transform, filter, opacity })` _(4)_                    | change the picture itself: scale, shake, tilt, colour, blur. Needs `stage`; see [The picture, media and music](#the-picture-media-and-music)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `library.scripts(id) / open(id)` _(4)_                                    | a library video's scripts, every axis, as data; a link that plays it in the plugin's own `<video>` or `<audio>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `music.analyse / script` _(4)_                                            | the beats of a song or a video's soundtrack, and a script that follows them, as playhound's own "Make a script from the music"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `music.plan` _(5)_                                                        | music.script's script with the strokes it is made of: each bottom, top, and the beat it's on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `library.strokes(id)` _(5)_                                               | a library video's strokes and stroke rate through it, kept until its script changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `files.save(name, data, { mime })` _(4)_                                  | save a file where the user picks: the save dialog, the share sheet on Android                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `asset(path)`                                                             | a `blob:` URL for a file from the plugin's zip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `log(...)`                                                                | `console.log` with the plugin's name in front                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

## Playing in another app

`ctx.playback.external()` (permission `external`) is for a video that plays
somewhere else, a VR headset in HereSphere or DeoVR, while playhound drives
the device. You say which video it is and keep telling playhound where the
other app is; playhound plays that video's scripts to that clock on every
device, exactly as for a video playing here: latency calibration, the
per-video offset and tweaks, the intensity knob, edges, the Handy (resynced
to the other app's time), recording and stats. The player shows **Playing
in HereSphere** with the timeline following, and a **Stop following** button.

```js
const ext = await ctx.playback.external({
  label: 'HereSphere',
  video: id, // a library id, or fingerprint: '…', or title + scripts for one that isn't in the library
  onCommand: cmd => sendToHeadset(cmd), // optional: playhound's play / pause / seek / speed, passed on
})
if (ext) {
  onHeadsetTime(({ time, playing, rate }) => ext.update({ time, playing, rate }))
  ext.onEnd(reason => ctx.log('stopped following:', reason))
}
```

- Send `update()` whenever the other app reports, a few times a second.
  Late and uneven reports are fine: playhound runs its own clock between them
  and bends its speed (never more than 10%, never backwards) to stay with
  them. A report far off is taken as a seek.
- If nothing arrives for about 2.5 s while playing, the device stops until
  something does: a headset that sleeps or a dropped connection never leaves
  the device going.
- Panic stops the device at once, whatever the other app is doing, and it
  stays stopped until the user lifts the panic. `onCommand` gets a `pause`
  then, if you passed one, but don't count on the headset obeying.
- Without `onCommand`, playhound's play, pause and seek do nothing while it
  follows; the user uses the other app's.
- Playing anything else in playhound ends it (`onEnd('replaced')`), as does
  the user's **Stop following** (`'stopped'`), your `end()` (`'ended'`) and
  switching the plugin off.

## Sockets

`ctx.net.socket({ host, port })` (permission `socket`, desktop app only) opens
a TCP connection from the desktop app, the way HereSphere's and DeoVR's
timestamp servers (port 23554) are reached. It resolves once connected.

- Only this computer and the local network: `localhost`, a private address
  (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`, link-local, and the IPv6
  equivalents), or a `.local` name, which is looked up and refused if any
  address it gives is outside. Anything else rejects saying why.
- `send(string | Uint8Array)`, `onData(bytes => …)` (bytes as they arrive,
  not split into messages: framing is the protocol's job; data that came
  before you listened is kept for the first `onData`), `onClose(error => …)`,
  `close()`. At most 16 are open at once; they close when the plugin is
  switched off.
- In a browser `ctx.net.socketAvailable` is `false` and `socket()` rejects
  with `Network connections need the playhound desktop app`.

## Serving on the network

For a headset that browses the library (an XTP-style setup), a plugin can
answer requests on the desktop app's LAN server (permission `serve`, desktop
app only):

```js
const base = await ctx.http.serve(async (req) => {
  if (req.path === '/library.json') {
    const videos = await ctx.library.list()
    return { json: await Promise.all(videos.map(async v => ({
      title: v.title,
      video: await ctx.library.mediaUrl(v.id),
      script: await ctx.library.scriptUrl(v.id),
    }))) }
  }
  // Nothing returned: 404.
})
// base: http://192.168.1.10:6969/plugins/<id>/
```

- The handler gets `{ method, path, query, headers, body, remote, text(),
json() }`, `path` being what follows `/plugins/<id>`, still percent-encoded
  (decode each part before matching names). It answers `{ json }`
  or `{ status, headers, body }` (a string, `Uint8Array` or `Blob`).
- Only the plugin's own prefix reaches it, and only while it is switched on.
- `library.mediaUrl(id)` and `library.scriptUrl(id, axis)` (these need
  `library` too) are links that stream one library video (with Range, so
  seeking works) or one axis of its scripts as a `.funscript` of its own.
  Each is an unguessable address that stops working when the plugin is
  switched off. Nothing else from disk can be reached: the app streams the
  files it already has open, it doesn't serve paths.
- `serve(handler, { rootAliases: ['deovr', 'heresphere'] })` also takes the
  short root paths headsets ask for by themselves, so the user types only
  `http://<pc>:6969/deovr`; the request reaches the handler as `/deovr…`.
  The first plugin to claim one keeps it while it serves; `rootAliases()`
  says which you got.
- `url()` uses this computer's first LAN address; `urls()` lists every
  address it has (one per adapter, a VPN's or a virtual machine's too), and
  the request's `Host` header says which one a device actually used. In the packaged app the
  server is the one on port 6969 that the phone remote uses; running from
  source (`pnpm app`) it is port 6970.
- In a browser `ctx.http.available` is `false` and `serve()` rejects.

## Library sources

`ctx.library.provide()` (permission `library-source`) adds videos from
another app (Stash, a media server) to the library:

```js
const stash = await ctx.library.provide({
  label: 'Stash',
  async videos() {
    const scenes = await fetchScenes()
    return scenes.map(s => ({
      id: s.id,
      title: s.title,
      url: `${server}/scene/${s.id}/stream`,
      headers: { ApiKey: key }, // optional: the stream then goes through playhound's local proxy
      scripts: s.interactive ? [{ url: `${server}/scene/${s.id}/funscript` }] : [],
      tags: s.tags.map(t => t.name),
      chapters: s.scene_markers.map(m => ({ name: m.title, start: m.seconds })),
      thumbnail: s.paths.screenshot,
      duration: s.files[0]?.duration,
      sourceUrl: `${server}/scenes/${s.id}`,
    }))
  },
})
// later: await stash.refresh()
```

- They show in the library with the source's name as a badge, and under it
  in the folder picker, so the user can look at one source. They search,
  sort, star, queue and go in playlists like the rest, and play through the
  player like streams do (scripts are fetched when one first plays, with
  `headers` if given; chapters show as the script's chapters).
- `id` must stay the same for the same video: stars, stats and tweaks are
  kept by it.
- A video whose scripts aren't at a URL can say `hasScript: true`, and the
  source's `scripts(id)` gives them when it plays (`[{ axis, actions }]`).
- Videos that can't be used (no title, a `url` that isn't http(s)…) are left
  out; `problems` says why. `refresh()` replaces the list; `remove()` takes it
  out, as switching the plugin off does (and its videos leave the queue).
- `thumbnail` must load without headers (or be a `data:` image). No preview
  strips or fingerprints for these: there is no file.

## Session control

`ctx.session` is for a partner's controls (permission `session`):

- `edge()` calls an edge, as E does; the user sees which plugin did.
  `endEdge()` ends the hold early ("I'm OK"), not while panic is on.
- `intensity.set(level)` moves the knob toward `level` (0.1–1) a little at a
  time (10% a second up, quicker down), never past the limit the user set in
  **Settings → Plugins** ("Plugins may set intensity up to", 80% unless they
  change it), and returns where it will stop. The user is told, and turning
  the knob themselves, or panic, stops the move where it is. During a panic
  it can only lower the knob (at once: nothing moves then anyway).
- `intensity.restore()` puts the knob back where it was before this plugin
  first moved it, even above the plugin limit, since that was the user's own
  level; for handing control back. It returns null, and does nothing, if the
  user has turned the knob since.
- Reading needs only `player` (or `session`): `edgeState()` gives `{ phase:
'idle' | 'falling' | 'holding' | 'rebuilding', remainingSec, holdBack,
effective }`, `effective` being what actually comes through, the knob
  times what the edge leaves; `onEdge(fn)` hears every edge, `byPlugin`
  marking those a plugin called; `onFinish(fn)` hears the user mark "I
  came"; `intensity.get / max / onChange`.

Panic always wins and stays on this computer: no plugin can lift it.
`safety.onResume(fn)` says when the user lifted it; nothing restarts by
itself, so take control again if you need it.

## The picture, media and music

API 4 (playhound 2.2.3) lets a plugin work with the picture and with media
of its own. Write `"api": 4` and `"minPlayhound": "2.2.3"` in the manifest.

**Effects on the picture.** `player.effects({ transform, filter, opacity })`
(permission `stage`) puts CSS on whatever shows the picture: the video, the
pop-out's mirror and the VR view, around the picture's centre. It is cheap
enough to call every animation frame; `null` clears it. Each plugin has one
set; several plugins' effects stack (transforms and filters one after
another, opacities multiplied). They are cleared when the plugin is switched
off. For what CSS can't do, draw in an [overlay](#the-module) from
`player.video()`: the player's own `<video>` element (permission `player`),
as a canvas `drawImage` source or a WebGL texture. It is a new element for
every video, so ask again after `player.onChange`, and never play, pause or
seek it yourself: that goes through `playback` and `player.seek`. A
stream from a server that sends no CORS headers can be shown but not read:
drawing it taints a canvas, so catch that and skip the effect for that video.
Effects apply wherever the picture shows, the corner player and the pop-out
included; an overlay is mounted on the full-size player only.

```js
// A zoom punch on every stroke, easing out over 150 ms
const hitAt = -1
function frame(now) {
  const k = Math.max(0, 1 - (now - hitAt) / 150)
  ctx.player.effects(k > 0 ? { transform: `scale(${1 + 0.04 * k})` } : null)
  requestAnimationFrame(frame)
}
```

**A library video in your own player.** `library.open(id)` (permission
`library`) gives `{ url, kind, close }`: set `url` as the `src` of your own
`<video>` or `<audio>`, on any platform. `kind` is `'hls'` for a provided
video that streams as a playlist (play it with hls.js, or skip it). Close
what you no longer need; whatever is still open is closed when the plugin is
switched off. `library.scripts(id)` reads every script paired with the video,
every axis and alternate take, as `{ axis, label, name, actions, alt }` with
positions 0–100. To move the device while your own player plays, follow it
with [`playback.external`](#playing-in-another-app), handing over the
scripts and feeding it your player's clock.

**Music.** `music.analyse(file)` finds the beats in a song (a `File` or
`Blob`, say from an `<input type="file">`), and `music.analyse({ video: id })`
in a library video's soundtrack (permission `library`). It returns the tempo
(`bpm`), the beat times, and per beat its loudness (`energy`, dBFS),
brightness (`centroid`), onset `strength` and place in the bar (`barPos`, 0 is
the downbeat), with the stretches that have no rhythm (`gaps`). The first
time is slow, a few seconds a minute of music (`onProgress` gets 0–1); it is
kept after. `music.script(analysis, opts)` turns it into a script as
playhound's own **Make a script from the music** does, within the user's
speed ceiling; any option left out is the user's own music motion setting.

**Saving.** `files.save(name, data, { mime })` saves a `Blob`, a string or
bytes where the user picks: the save dialog in the desktop app, a download in
a browser without one, the share sheet in the Android app. Call it from a
click, since the dialog needs one; it resolves `false` if the user cancelled.

## A song's shape and a video's strokes

API 5 (playhound 2.2.4) tells a plugin more about the music and about
library videos' motion, for plugins that cut or change things with them.
Write `"api": 5` and `"minPlayhound": "2.2.4"`.

**Sections.** `music.analyse` also returns `sections`: the song as
`{ start, end, kind, level, beat }` in order, covering all of it. `kind` is
`intro`, `build`, `drop`, `breakdown`, `verse` or `outro`; `level` is how
loud it is against the rest of the song (0–1), and `beat` the index of its
first beat. Sections are made of four-bar phrases, so a drop starts on the
downbeat where it lands. A song too even to tell apart is one `verse`.
`barConfidence` says per beat how sure `barPos` is (0–1): where it is low,
don't lean on downbeats, cut on beats instead.

**The strokes behind a music script.** `music.plan(analysis, opts)` takes
the same options as `music.script` and returns `{ actions, strokes }`:
`actions` is the same script, and each stroke is `{ at, top, end, beat,
depth }`, its bottom, its top and the next stroke's start in ms, with the
index of the beat its bottom is on (`-1` for strokes between beats, when it
strokes faster than the beat). Line cuts up with `at` and they land exactly
where the device turns.

**A library video's strokes.** `library.strokes(id)` (permission `library`)
returns `{ duration, spm, strokes, tempo, tempoStep }` from the video's
stroke script: every stroke as `{ at, top, end, depth }` (bottom to top to
the next bottom, ms; wobble under 8 positions isn't a stroke, nor is a pause
over 4 s), the typical rate (`spm`, the median) and the rate through the
video, one value per `tempoStep` ms (0 where it holds still). It is worked
out once and kept until the script file changes, so going over a whole
library is quick after the first time. Null without a stroke script.

```js
// The drops of a song, and library videos that stroke at its tempo
const song = await ctx.music.analyse(file)
const drops = song.sections.filter(s => s.kind === 'drop')
const near = []
for (const v of await ctx.library.list()) {
  const p = await ctx.library.strokes(v.id)
  if (p && Math.abs(p.spm - song.bpm) < song.bpm * 0.08)
    near.push(v.id)
}
```

## An example

A plugin that softens the stroke with a key, and says where the video is:

```json
{ "id": "softer", "name": "Softer", "version": "1.0.0", "api": 3, "permissions": ["device", "player", "stage"] }
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

The store follows GitHub repositories. Each one's **latest release** (not a
draft or pre-release) is the plugin. Attach to it:

- the plugin zip (any `*.zip` name)
- its `manifest.json`, the same one that's inside the zip. The store reads it
  to show the plugin before anything is downloaded.
- optionally its icon and screenshots (below).

Tag releases with the version (`v1.2.0`). The store offers an update when the
latest release's version is newer than the installed one. The release notes
show as "What's new". Users add a repository by `owner/repo` or its
github.com link with **Settings → Plugins → Discover → Add from GitHub**; a
repository that doesn't exist, has no release, or whose latest release has no
zip is refused with the reason. Nothing installs or updates without them
clicking.

Don't put API keys or other secrets in a published zip.

### The store listing

Everything here is optional, and a plugin without any of it still installs.
Each field goes in `manifest.json`:

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.2.0",
  "description": "One line about what it does.",
  "author": "you",
  "api": 2,
  "permissions": ["player"],
  "icon": "icon.png",
  "longDescription": "What it does, **in Markdown**.\n\n- how to use it\n- what it needs",
  "screenshots": ["screenshot-1.png", { "file": "screenshot-2.png", "caption": "The panel" }],
  "category": "tools",
  "keywords": ["beats", "music"],
  "homepage": "https://example.com/my-plugin",
  "minPlayhound": "2.2.0"
}
```

| Field             | What the store does with it                                                                           | Rules                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `description`     | The line on the card                                                                                  | One sentence; cut after about 160 characters                                                                                          |
| `author`          | Under the name. Without it, the repository's owner                                                    | Text                                                                                                                                  |
| `icon`            | On the card, the details and the installed list                                                       | A file name: square PNG, 64 to 1024 px (**256 px** is best), under 256 KB; or an SVG under 64 KB                                      |
| `screenshots`     | A strip in the details; a click shows one large                                                       | Up to 6 file names (with an optional `caption`): PNG, JPEG or WebP, 320 to 3840 px a side, under 3 MB each. **1280 × 800** reads well |
| `longDescription` | "About" in the details. Without it, the repository's README shows                                     | Markdown, up to 10,000 characters                                                                                                     |
| `category`        | The category filter, and a label on the card                                                          | One of `partner`, `sync`, `library`, `visuals`, `devices`, `tools`                                                                    |
| `keywords`        | Search finds the plugin by them                                                                       | Up to 10 words of up to 32 characters                                                                                                 |
| `homepage`        | A "Website" link in the details (the repository is always linked)                                     | An `https://` address                                                                                                                 |
| `minPlayhound`    | An older playhound shows "Needs playhound 2.2 or newer" and won't install it, from the store or a zip | A version, like `"2.2.0"`                                                                                                             |

**Where the pictures come from.** The store looks for the files the manifest
names among the **release's assets**: attach `icon.png` and the screenshots
next to the zip and `manifest.json`. Without an `icon` field it still finds
an asset called `icon.png` or `icon.svg`; without `screenshots`, assets called
`screenshot*.png` / `.jpg` / `.webp`, in name order. Once a plugin is
installed, the icon comes from the **zip** if it's in there too, so put
`icon.png` in the zip as well. Nothing is ever loaded from an address in the
manifest: only the release's own files, or the zip's. Each picture is checked
(type, size, dimensions) before it shows, and kept, so the store doesn't
download it again. A plugin without an icon gets its initials on a colour
picked from its id (playhound's own plugins, from its own repositories, get
the icon playhound ships for them instead).

**Text.** The README and the long description are Markdown, shown as text:
HTML in them is dropped (its text kept), except `<img>`. Links open in the
browser. Images in a README show only from GitHub (relative paths load from
the repository, like on GitHub); badges from other sites show their alt text.

**Checking it.** Load the plugin from its folder (dev mode) with the icon and
screenshots next to `manifest.json`: its card shows the icon, and **Store
listing** lists anything the store would leave out, and why.

**Download count.** The store shows how often the zips of the repository's
releases were downloaded (from GitHub; the store's own reads of
`manifest.json` and the pictures don't count).

### Official and trusted plugins

Plugins from repositories owned by **whatmekota** are playhound's own: the
store and the installed list show a check mark next to them. Authors known to
the project can be added to a trusted list (`TRUSTED_OWNERS` in
`src/plugins/sources.ts`); their plugins get a heart. Either mark is a
statement about the author, not a review of every release, and neither changes
what a plugin is allowed to do: that's still its permissions. Every other
plugin's details, and its install screen, say it is **not reviewed by
playhound**.
