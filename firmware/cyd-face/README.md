# playhound face (ESP32 CYD)

An animated face for the ESP32-2432S028R — the "Cheap Yellow Display" — that
watches a playhound session and hides a control bar behind a tap.

The eyes react to what the desktop is doing:

| state                  | face                                                  |
| ---------------------- | ----------------------------------------------------- |
| no desktop in the room | slow blinking, `waiting for playhound`                |
| nothing for a while    | sleepy: lids low, slow blinks, `z z z`                |
| playing                | pupils warm toward crimson as intensity climbs        |
| focused                | eyes narrowed, the gaze rides the stroke up and down  |
| excited                | wide open, sparkles in the pupils                     |
| flustered              | half lidded, heart pupils, blush on the cheeks        |
| motion running         | the mouth opens and closes with the stroke rate       |
| edge called            | lids and gaze drop, `edge - holding 12s`, then easing |
| panicked               | eyes shut, screen dimmed, `shhh`                      |
| just after a panic     | small pupils and an "o" mouth for a moment            |

The desktop picks the expression (see `docs/face-protocol.md`), so the face and
the app's Face panel always agree. Status and title sit in a strip across the
top, clear of the nose and mouth.

**Tap the top-left corner** for settings. **Tap anywhere else** to reveal `EDGE` / `<<` / play-pause / `>>` / `RND` / `STOP`. The first
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

**`joining wifi...` on the face.** The serial log says why: `reason 201` means
the network was not found, and the board then lists the 2.4GHz networks it can
see. The ESP32 is 2.4GHz only, so a 5GHz-only SSID, or a band-steering router
handing out a 5GHz BSSID, will never associate. `reason 202` or `15` is a wrong
password.

**`looking for playhound at …`.** On the network, but nothing answers at
`PH_HOST:PH_PORT`. Check the desktop's LAN address has not changed (DHCP moves
it; a reservation on the router stops that), that playhound or `start.bat` is
running, and that the firewall lets it listen on this network.

**Connects, but `waiting for playhound`.** The socket reached the relay but no
host is in the room — check the room id matches the desktop's exactly, and that
the Remote panel is enabled.

**Nothing happens when a button is tapped.** The frames only reach the desktop
while it is in the same room; watch the desktop's Remote panel peer count, which
should show 1 remote once the board is up.

## Layout

The face owns everything above y=168 and the control bar everything below, so
neither ever repaints the other.

The face is variant **M** from `_eyesim.py`: a flat slot opening under a
near-straight upper lid, with a large flat-topped pupil doing the work a lash
mass does in the other shapes.

One 160×138 eye sprite (~44KB) is pushed twice. There is no iris sprite — M's
iris is the same colour as the sclera, so only the pupil is ever visible and it
is drawn straight into the eye sprite.

The sprite's margins are asymmetric, 20px inner and 40px outer, because the
flick only ever extends past the outer corner and the inner spike only past the
inner one. A symmetric margin would clip one of them or waste half the screen.

Lid shapes matter more than their numbers:

- the **upper** lid blends a smooth bell with a piecewise-linear tent (`ANG`),
  because `sin()` alone is round no matter where its apex sits
- the **lower** lid is a plateau — flat across the middle, ramping only at the
  corners, eased so it meets the flat part without a hard angle. A peaked curve
  there, however angular, makes the eye read as a diamond.

## Changing the eyes

`_eyesim.py` renders the same geometry on the host, into a sprite-sized buffer
so clipping shows up there too. Try changes there first — it renders in a
second, and it has caught things a photo would not, including lash weight
peaking where the eye has no height and spikes being silently clipped off the
sprite.

    python _eyesim.py          # every variant, two per row
    python _eyesim.py M        # one, across open/half/blink and both themes

It carries fifteen named shapes and nothing is ever deleted from it. It mirrors
`face.cpp` by hand, so the two have to be kept in step deliberately.

## Panel quirks

`PANEL_INVERT` and `PANEL_BGR` in `config.h` handle the two things CYD revisions
disagree about. They are applied in the sketch rather than in `User_Setup.h`,
which is shared with every other sketch on the machine.

- Background comes out **white** instead of black → flip `PANEL_INVERT`.
- Red and blue look **swapped** → flip `PANEL_BGR`.
