# playhound face (ESP32 CYD)

An animated face for the ESP32-2432S028R — the "Cheap Yellow Display" — that
watches a playhound session and hides a control bar behind a tap.

The eyes react to what the desktop is doing:

| state                  | face                                             |
| ---------------------- | ------------------------------------------------ |
| no desktop in the room | dim blue, slow blinking, `waiting for playhound` |
| idle                   | cool blue, wandering gaze                        |
| playing                | warms toward red as intensity climbs             |
| motion running         | bobs in time with the stroke rate                |
| panicked               | eyes shut, screen dimmed, `shhh`                 |

**Tap anywhere** to reveal `<<` / play-pause / `>>` / `RND` / `STOP`. The first
tap only reveals — it never fires anything — because the first touch of a board
sitting on a desk is usually an accident. The bar hides itself after 4.5s, or on
a tap above it.

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
neither ever repaints the other. Eyes are drawn into a single 96×96 sprite that
is pushed twice — ~18KB, which matters on a board with no PSRAM.
