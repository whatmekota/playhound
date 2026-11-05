# Writing a playhound plugin

A plugin is a `.zip` with a `manifest.json` and one ES module. Users install
it from **Settings → Plugins**: from a GitHub repository they follow (the
plugin store), or from a file. Once it's switched on, playhound imports the
module and calls its default export with a context object, the plugin API.

**There is no sandbox.** A plugin runs inside playhound with the same access
playhound has, including the device. The install screen says so, and users
are told to install only plugins they trust. Write accordingly: never move the
device unless the user asked for it, and stop when they panic.

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
  "main": "index.js"
}
```

- `id`: lower-case letters, digits and dashes. It's the plugin's identity:
  installing a zip with the same id updates the installed plugin and keeps its
  settings.
- `main` must be **one self-contained ES module**. It's imported from a
  `blob:` URL, so relative imports don't resolve. Bundle everything into it
  (esbuild, rollup, vite in library mode).

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

| `ctx.…`                                    | What it gives                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`                                 | the plugin's own manifest                                                                                                                                                                                                                                                                                       |
| `settings.get / all / set / onChange`      | its settings, as the user set them                                                                                                                                                                                                                                                                              |
| `storage.get / set / del`                  | a small persistent key/value store for its own data                                                                                                                                                                                                                                                             |
| `ui.settings(fields)`                      | the form shown under the plugin in Settings → Plugins. Field types: `text`, `password`, `textarea`, `number`, `slider`, `switch`, `select` (fixed or fetched options, optionally free text) and `heading`, which starts a section that folds away. Any field can have `when(values)` to show it only sometimes. |
| `ui.panel({ title, icon, mount })`         | its panel: its own button on the right-hand rail and a drawer titled with its name. `icon` is an inline SVG in `currentColor` (about 16×16); without one a generic icon is used. `mount` gets a plain element; you build its DOM yourself.                                                                      |
| `ui.style(css)`                            | CSS for that DOM. playhound's utility classes aren't available to you; its CSS variables are (`--text`, `--accent`, `--bg-850`, `--border`, `--radius-md`…), so a panel can follow the theme.                                                                                                                   |
| `ui.toast / openPanel / openSettings`      | small notices, and links into playhound's own UI                                                                                                                                                                                                                                                                |
| `player.state / onChange / script / frame` | what's playing; what the loaded script is doing now and next; the current picture as a small JPEG                                                                                                                                                                                                               |
| `library.list / analyse / onChange`        | the user's library: videos with their length, script intensity, stars, playlists and play/finish counts                                                                                                                                                                                                         |
| `playback.play / pause / resume / onEnded` | put on a library video on its own, and know when it ends                                                                                                                                                                                                                                                        |
| `motion.take() → { set, hold, release }`   | the stroke generator (the Manual source), within the user's speed ceiling. Panic takes it back. Letting go restores the user's settings and leaves the generator stopped.                                                                                                                                       |
| `motion.readout`                           | what the device is doing: the generator's rate and depth, and the stroke position (a script's, while one plays)                                                                                                                                                                                                 |
| `safety.panicked / onPanic`                | panic (Esc). Stop everything you're doing.                                                                                                                                                                                                                                                                      |
| `net.fetch(url, init)`                     | `fetch()`; in the desktop app it's made from the app itself, so local servers without CORS headers answer, and it streams                                                                                                                                                                                       |
| `asset(path)`                              | a `blob:` URL for a file from the plugin's zip                                                                                                                                                                                                                                                                  |
| `log(...)`                                 | `console.log` with the plugin's name in front                                                                                                                                                                                                                                                                   |

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
