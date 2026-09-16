# playhound face (ESP32 CYD)

An animated face for the ESP32-2432S028R — the "Cheap Yellow Display" — that
watches a playhound session and hides a control bar behind a tap.

The eyes react to what the desktop is doing:

| state                  | face                                              |
| ---------------------- | ------------------------------------------------- |
| no desktop in the room | grey iris, slow blinking, `waiting for playhound` |
| idle                   | cool blue, wandering gaze                         |
| playing                | warms toward pink as intensity climbs             |
| intensity high         | half lidded, gaze drifts up, heart pupils         |
| motion running         | bobs in time with the stroke rate                 |
| panicked               | eyes shut, screen dimmed, `shhh`                  |

**Tap the top-left corner** for settings. **Tap anywhere else** to reveal `<<` / play-pause / `>>` / `RND` / `STOP`. The first
tap only reveals — it never fires anything — because the first touch of a board
sitting on a desk is usually an accident. The bar hides itself after 4.5s, or on
a tap above it.

## Settings

Five rows, tapped to cycle, saved to NVS so they survive a power cut.

| row    | values                             |                                                              |
| ------ | ---------------------------------- | ------------------------------------------------------------ |
| mode   | auto / idle / tease / heart / demo | `auto` follows playhound; the rest drive the face themselves |
| hearts | auto / always / never              | `auto` means hearts once intensity passes 0.72               |
| theme  | light / dark                       | see **Themes** below                                         |
| bright | dim / mid / full                   |                                                              |
| wifi   | on / off                           | takes effect immediately, no reboot                          |

Only `auto` needs a desktop. The other four synthesise their own state, so the
board is worth having on a desk with nothing running — `demo` walks the whole
range over 45 seconds, which is also the quickest way to see everything the face
does.

## Themes

The reference art this is drawn from is black lash on white paper, and that is
what `light` reproduces. On a dark background a black lash is invisible: the eye
becomes a white silhouette with bites cut out of it, and the spikes outside the
eye vanish entirely. `dark` therefore does not simply invert — it lifts the lash
off the background to a dark violet so the shape still reads.

## How it connects

The board is just another remote on the relay that the phone remote already
uses. `es-proxy.mjs` listens on `0.0.0.0:7072`, so:

```text
ws://<your-pc>:7072/rc?room=<room id>&role=remote
```

Nothing has to change on the desktop beyond enabling the Remote panel — the
board sends the same `{type:"cmd",action:…}` frames the phone does, and receives
the same `{type:"state",…}` pushes.

## Libraries

Install through the Arduino IDE library manager (or `arduino-cli lib install`):

- **TFT_eSPI** — Bodmer
- **XPT2046_Touchscreen** — Paul Stoffregen
- **WebSockets** — Markus Sattler (`arduinoWebSockets`)
- **ArduinoJson** — Benoit Blanchon (v6; v7 also works)

Board: _ESP32 Dev Module_, 240MHz, flash 4MB, partition _Default 4MB with spiffs_.
The sketch uses about 89% of that partition, so if you add much to it, switch to
_Huge APP (3MB No OTA)_ rather than trying to shrink the face.

If Library Manager fails with **403 Forbidden**, that is `downloads.arduino.cc`
refusing the request rather than anything local — a VPN exit IP is the usual
cause. Either drop the VPN, or install from the upstream repo by hand: download
<https://github.com/Links2004/arduinoWebSockets> as a zip and extract it into
`Documents/Arduino/libraries/WebSockets` (the folder must contain
`library.properties` directly, not another folder).

## TFT_eSPI setup

TFT_eSPI is configured at compile time by editing its own `User_Setup.h` (in
`Arduino/libraries/TFT_eSPI/`). For the CYD:

```c
#define ILI9341_2_DRIVER        // note the _2 — plain ILI9341 gives inverted colours
#define TFT_WIDTH  240
#define TFT_HEIGHT 320

#define TFT_MISO 12
#define TFT_MOSI 13
#define TFT_SCLK 14
#define TFT_CS   15
#define TFT_DC    2
#define TFT_RST  -1
#define TFT_BL   21

#define LOAD_GLCD
#define LOAD_FONT2
#define SMOOTH_FONT

#define SPI_FREQUENCY       55000000
#define SPI_READ_FREQUENCY  20000000
#define USE_HSPI_PORT       // keeps the panel off the touch controller's bus
```

`USE_HSPI_PORT` matters: the touch controller runs on VSPI with its own pins, and
without this the two fight over the bus and you get either a blank panel or
touch that reads garbage.

If the display is there but colours look wrong — white showing as yellow, blue
as orange — you have the plain `ILI9341_DRIVER` rather than `ILI9341_2_DRIVER`.
Some revisions instead want `#define TFT_INVERSION_OFF`.

## Configuration

```sh
cp config.example.h config.h
```

Fill in your WiFi, the LAN address of the machine running playhound (not
`localhost` — this is a different machine), and the room id. The room id is in
the pairing URL shown in the desktop's Remote panel: `…/remote?room=<this>`.

`config.h` is gitignored, so the credentials stay on your machine.

## Touch calibration

The raw XPT2046 ranges differ between CYD revisions, and a mismatch means the
buttons are simply in the wrong place. To fix:

1. Uncomment `#define SHOW_TOUCH_RAW` in `config.h` and flash.
2. Open the serial monitor at 115200 and tap each corner of the screen.
3. Put the smallest and largest `x`/`y` you see into `TOUCH_MIN_X`/`TOUCH_MAX_X`
   and `TOUCH_MIN_Y`/`TOUCH_MAX_Y`.
4. Comment `SHOW_TOUCH_RAW` back out and reflash.

If the buttons respond in reverse — the far left button fires when you tap the
far right — swap the MIN and MAX for that axis rather than changing the rotation.

## Troubleshooting

**Backlight on, screen black.** Almost always `User_Setup.h`: either the pins
above are wrong or `USE_HSPI_PORT` is missing.

**`[net] joining …` forever.** The ESP32 is 2.4GHz only. A 5GHz-only SSID, or a
band-steering router handing out a 5GHz BSSID, will never associate.

**Connects, but `waiting for playhound`.** The socket reached the relay but no
host is in the room — check the room id matches the desktop's exactly, and that
the Remote panel is enabled.

**Nothing happens when a button is tapped.** The frames only reach the desktop
while it is in the same room; watch the desktop's Remote panel peer count, which
should show 1 remote once the board is up.

## Layout

The face owns everything above y=168 and the control bar everything below, so
neither ever repaints the other.

One 116×116 eye sprite is pushed twice (~27KB), and the iris is a second 59×59
sprite (~7KB) pushed into it with transparent corners. The iris is only rebuilt
when its colours change — its vertical gradient is far too expensive to redraw at
30fps.

The eye is not an ellipse: the upper and lower lids are separate curves that both
reach zero at the corners, which is what makes an almond with points rather than
an oval. The outer corner is lifted by `SLANT`. The lash is drawn per column so
it follows that outline exactly at any blink position, and it is heaviest over
the _body_ of the eye rather than at the corner tip, where the eye has no height
and a thick value would still render as a thin line.

The sprite is sized around the artwork's extents, not the eye's — spikes reach
70px above the eye centre and teeth 44px below, and anything outside the sprite
is silently clipped. `_eyesim.py` renders the same geometry on the host into a
sprite-sized buffer, which is how those bounds get checked without a flash cycle.
It mirrors `face.cpp` constant for constant and has to be kept in step by hand.

## Porting the face

The eyes are deliberately easy to lift onto another board. All of the playhound
coupling is in `resolveInput()`, plus `drawStatus()`/`drawTitle()`. The drawing
itself needs only `fillSprite`, `drawFastVLine`, `drawFastHLine`, `drawPixel`,
`drawCircle`, `fillCircle`, `fillEllipse`, `fillTriangle`, `pushToSprite` and
`pushSprite` — swap those for the target's primitives and the rest is arithmetic.

## Panel quirks

`PANEL_INVERT` and `PANEL_BGR` in `config.h` handle the two things CYD revisions
disagree about. They are applied in the sketch rather than in `User_Setup.h`,
which is shared with every other sketch on the machine.

- Background comes out **white** instead of black → flip `PANEL_INVERT`.
- Red and blue look **swapped** → flip `PANEL_BGR`.
