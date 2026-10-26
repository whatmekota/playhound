# CYD face protocol

How playhound talks to the face in `firmware/cyd-face`. The app side lives in
`src/lib/faceState.ts` (what is sent and the expression logic, unit-tested) and
`src/composables/useFaceLink.ts` (sampling, throttling, sending). The Face
panel in the right rail switches it on and shows every frame as it goes out.

## Transport

Unchanged from the phone remote. The board connects to the relay in
`es-proxy.mjs` as a remote:

```text
ws://<desktop LAN address>:7072/rc?room=<room id>&role=remote
```

The relay forwards every text frame to everyone else in the room. The desktop
sends from the same socket it uses for the phone remote, so **the Remote panel
must be on** for the face to hear anything. Phones in the room receive face
frames too and ignore them (they only read `type: "state"`).

Frames the board already handles keep working exactly as before:

| direction    | frame                                    | notes                                                   |
| ------------ | ---------------------------------------- | ------------------------------------------------------- |
| relay → all  | `{"type":"peers","hosts":1,"remotes":2}` | on every join/leave                                     |
| app → remote | `{"type":"state","state":{…}}`           | controls state; see `RemoteState` in `useRemoteLink.ts` |
| remote → app | `{"type":"hello"}`                       | app answers with `state` **and** `face` at once         |
| remote → app | `{"type":"cmd","action":"togglePlay"}`   | prev / next / random / panic / motionToggle             |

## Face state protocol (app → face)

### `face` frame, version 1

```json
{
  "type": "face",
  "v": 1,
  "playing": true,
  "panic": false,
  "expr": "excited",
  "intensity": 0.68,
  "src": "script",
  "strokePos": 0.31,
  "spm": 92,
  "phase": "idle",
  "deviceConnected": true,
  "title": "Example Video"
}
```

| field             | type   | always | meaning                                                                                                                   |
| ----------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `type`            | string | yes    | `"face"`                                                                                                                  |
| `v`               | int    | yes    | protocol version, `1`. Ignore frames with a `v` you do not know.                                                          |
| `playing`         | bool   | yes    | the video is playing                                                                                                      |
| `panic`           | bool   | yes    | panic is on: go dark, show nothing identifying                                                                            |
| `expr`            | string | yes    | expression to wear, see below. Already debounced.                                                                         |
| `intensity`       | 0..1   | no     | how intense things are right now, 2 decimals                                                                              |
| `src`             | string | no     | where `intensity` came from: `session`, `script`, `motion`, `none`                                                        |
| `strokePos`       | 0..1   | no     | last commanded stroke (L0) position, 2 decimals; 1 = top. Absent while nothing is moving it.                              |
| `spm`             | int    | no     | strokes per minute                                                                                                        |
| `phase`           | string | no     | session phase: `idle`, `entry`, `build`, `peak`, `descent`. `idle` whenever no session is running, even if a video plays. |
| `deviceConnected` | bool   | no     | a stroker is connected (serial or Intiface)                                                                               |
| `title`           | string | no     | video name without path or extension, at most 60 UTF-8 bytes (cut with `…`). Empty during panic.                          |

"no" means the user can switch the field off in the Face panel. **A switched-off
field is absent, not zero** — keep your default (or last value) when a field is
missing. During panic `intensity` and `spm` are `0`, `src` is `none`,
`strokePos` is absent and `title` is `""`.

Where `intensity` comes from, in order: a running session (which is also how
programmes and "audio follows script" reach it); else the playing script's
stroke speed; else generated motion's rate against its ceiling; else `0`.

Size: a full frame with a long title is under 300 bytes, inside the
`StaticJsonDocument<512>` that `net.cpp` already parses into.

### Rates

- The app samples every 100 ms.
- A frame goes out when something changed — a discrete field, or a continuous
  one by at least `intensity` ±0.02, `strokePos` ±0.02, `spm` ±2 — and never
  faster than the panel's rate (1–10 Hz, default **10 Hz**).
- **Keepalive**: an unchanged frame is repeated every **5 s**.
- On `hello` from any remote, and whenever the relay's `remotes` count goes up,
  the next frame goes out immediately with no rate limit.
- Nothing is sent while there are no remotes in the room.
- When the user switches the link off the app sends `{"type":"face.bye","v":1}`.

Firmware: treat the `face` stream as live while frames keep arriving. If none
has arrived for **12 s**, or after `face.bye`, fall back to the plain `state`
frame (which is what the board uses today). With a 10 Hz `strokePos` stream,
interpolate between frames rather than jumping — the eyes look much smoother
if they ease toward each new value over ~100 ms.

### Expressions

| `expr`      | when                                               | suggested look                              |
| ----------- | -------------------------------------------------- | ------------------------------------------- |
| `sleepy`    | nothing playing, no session, no motion for 45 s    | lids mostly down, slow blink, `z`           |
| `calm`      | idle (under 45 s), or active with intensity < 0.35 | relaxed lids, soft smile, cool colours      |
| `focused`   | intensity ≥ 0.35                                   | slightly narrowed, gaze follows `strokePos` |
| `excited`   | intensity ≥ 0.60                                   | wide open, open smile, warm colours         |
| `flustered` | intensity ≥ 0.82                                   | half-lidded, blush, heart pupils            |
| `shocked`   | panic (instant); held 2.5 s after panic lifts      | wide eyes, tiny pupils, `o` mouth, then dim |

Hysteresis is done on the app side, so every face shows the same mood and
none flicker at a band edge:

- climbing a step needs the threshold above; falling back needs intensity to
  drop **0.08 below** it (so focused → calm at < 0.27, excited → focused at
  < 0.52, flustered → excited at < 0.74);
- any change other than to `shocked` must be wanted continuously for
  **1.2 s** before `expr` changes.

The firmware can render `expr` as given and use `intensity`/`spm`/`strokePos`
for continuous motion within an expression (colour warmth, bob rate, gaze).

### Face → app

The relay counts a face and a phone the same (`remotes`), so the panel can only
say "N remotes in the room". To let it say "Face connected", the firmware
identifies itself:

```text
{"type":"hello","client":"face","v":1}
{"type":"ping","client":"face"}
```

`hello` on every connect (instead of the bare `{"type":"hello"}`), and `ping`
every 10 s. The app counts any frame with `"client":"face"` as a sign of life
and shows the face as connected for 25 s after the last one.

### What the firmware does with it

- `net.cpp` copies each `face` frame into `PhState` and stamps `faceSeenAt`.
  An absent field keeps its last value, except `title`, which is cleared: it is
  absent exactly when the user switched it off.
- While face frames are live (one within 12 s, and no `face.bye`), `state`
  frames no longer set `intensity`, `spm`, `phase` or `title`; `playing`,
  `panicked`, `motion`, `audio`, `knob` and `edge` still come from them.
- `expr` bends the look `face.cpp` already derives from intensity: `sleepy`
  caps the lids low and slows blinking, `focused` and up follow `strokePos`
  with the gaze, `excited` drops the squint, `flustered` half-lids and turns
  on hearts (when hearts are on `auto`), and `shocked` shows small pupils and
  an "o" mouth. During panic itself the eyes stay shut, as they always have.
- The edge from `state.edge` lowers the lids and gaze while it holds, shows its
  countdown as the status line, and lights the bar's EDGE button.
