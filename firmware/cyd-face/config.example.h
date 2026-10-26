#pragma once

// ---------------------------------------------------------------------------
// playhound face  —  ESP32-2432S028R ("CYD" / CYD2USB)
//
// Copy this file to config.h and fill it in. config.h is gitignored so the
// WiFi credentials stay on your machine.
//
// The panel pins live in TFT_eSPI/User_Setup.h and are already correct for the
// CYD:
//   ILI9341_2_DRIVER, MISO 12, MOSI 13, SCLK 14, CS 15, DC 2, RST -1, BL 21
//   USE_HSPI_PORT  <- keeps the panel off the touch controller's bus
// ---------------------------------------------------------------------------

// ── Network ────────────────────────────────────────────────────────────────
#define WIFI_SSID       "your-network"
#define WIFI_PASS       "your-password"

// The machine running playhound, and the relay port from es-proxy.mjs.
// Must be the LAN address, not localhost — this board is a different machine.
#define PH_HOST         "192.168.1.20"
#define PH_PORT         7072

// Room id from the Remote panel. Open it on the desktop; the pairing URL ends
// with ?room=<this>. The relay only ever forwards between peers that know it.
#define PH_ROOM         "paste-the-room-id-here"

// ── Panel quirks ─────────────────────────────────────────────────────────
// CYD revisions disagree about these, and the TFT_eSPI fix for them lives in a
// User_Setup.h shared with every other sketch on the machine - so do it here.
//
//   PANEL_INVERT  background comes out white instead of black -> flip this
//   PANEL_BGR     red and blue look swapped -> flip this
#define PANEL_INVERT    1
#define PANEL_BGR       0

// ── Backlight (PWM via LEDC) ───────────────────────────────────────────────
#define PIN_BL          21
#define BL_FREQ_HZ      5000
#define BL_RES_BITS     8
#define BL_LEVEL        200        // 0-255

// ── Touch (XPT2046, its own SPI bus, separate from the panel) ──────────────
#define PIN_TOUCH_CLK   25
#define PIN_TOUCH_MOSI  32
#define PIN_TOUCH_MISO  39
#define PIN_TOUCH_CS    33
#define PIN_TOUCH_IRQ   36

// Raw touch range. These vary between CYD revisions; run with SHOW_TOUCH_RAW
// on, note the corners, and put the numbers here.
#define TOUCH_MIN_X     200
#define TOUCH_MAX_X     3700
#define TOUCH_MIN_Y     240
#define TOUCH_MAX_Y     3800

// Prints raw touch coordinates to serial so the four values above can be set.
// #define SHOW_TOUCH_RAW
