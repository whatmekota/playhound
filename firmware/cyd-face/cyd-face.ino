/*
 * playhound face — ESP32-2432S028R ("Cheap Yellow Display")
 *
 * A face that watches the session, and a control bar that appears when you tap
 * it. The board joins the same WebSocket relay as the phone remote, so the
 * desktop needs no extra setup beyond turning the Remote panel on.
 *
 * See README.md for libraries, User_Setup.h, and touch calibration.
 */

#include <TFT_eSPI.h>

// config.h holds WiFi credentials, so it is gitignored and does not exist in a
// fresh checkout. Say so plainly rather than leaving a bare missing-header.
#if !__has_include("config.h")
#error "Copy config.example.h to config.h and fill in your WiFi, host and room."
#endif

#include "config.h"
#include "face.h"
#include "net.h"
#include "palette.h"
#include "ui.h"

static TFT_eSPI tft = TFT_eSPI();

// ── Backlight ───────────────────────────────────────────────────────────────
// Dimmed while nothing is happening: this thing may well sit next to a bed.
static const int BL_IDLE = BL_LEVEL / 3;

static void backlightBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_BL, BL_FREQ_HZ, BL_RES_BITS);
#else
  ledcSetup(0, BL_FREQ_HZ, BL_RES_BITS);
  ledcAttachPin(PIN_BL, 0);
#endif
}

static void backlightSet(int level) {
  static int current = -1;
  if (level == current)
    return;
  current = level;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_BL, level);
#else
  ledcWrite(0, level);
#endif
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n[playhound] face starting"));

  backlightBegin();
  backlightSet(BL_LEVEL);

  tft.init();
  tft.setRotation(1);              // landscape, USB on the left
  tft.invertDisplay(PANEL_INVERT);

  faceBegin(&tft);
  tft.fillScreen(faceBackground());
  uiBegin(&tft);
  netBegin();
}

void loop() {
  netLoop();

  const bool barUp = uiTick();
  faceTick();

  // Full brightness while you are touching it or while something is playing;
  // dim otherwise. Panic goes darkest of all — the point is to disappear.
  int level = BL_IDLE;
  if (phState.panicked)
    level = BL_IDLE / 2;
  else if (barUp || phState.playing)
    level = BL_LEVEL;
  backlightSet(level);
}
