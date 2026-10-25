#include <SPI.h>
#include <XPT2046_Touchscreen.h>

#include "config.h"
#include "face.h"
#include "net.h"
#include "palette.h"
#include "settings.h"
#include "ui.h"

// ── Layout ──────────────────────────────────────────────────────────────────
static const int UI_TOP     = 168;          // face never draws at or below this
static const int BTN_Y      = 176;
static const int BTN_H      = 58;
static const int BTN_COUNT  = 6;
static const int BTN_W      = 320 / BTN_COUNT;
static const uint32_t HIDE_AFTER_MS = 4500;

// A corner rather than a button: it must not compete with "tap anywhere to
// reveal the controls", which is the gesture people will actually use.
static const int GEAR_W = 62;
static const int GEAR_H = 40;

struct Button {
  const char *label;
  PhAction    action;
  Rgb         tint;
};

// Order runs left to right, with panic parked at the far right where it is
// hard to hit by accident, and edge at the far left, as far from panic as it
// gets: it is the one reached for in a hurry.
static Button BUTTONS[BTN_COUNT] = {
  { "EDGE", ACT_EDGE,        Rgb{ 40, 110, 150 } },
  { "<<",   ACT_PREV,        Rgb{ 88,  78, 112 } },
  { ">||",  ACT_TOGGLE_PLAY, Rgb{ 96,  60, 160 } },
  { ">>",   ACT_NEXT,        Rgb{ 88,  78, 112 } },
  { "RND",  ACT_RANDOM,      Rgb{ 88,  78, 112 } },
  { "STOP", ACT_PANIC,       Rgb{170,  34,  62 } },
};

static TFT_eSPI *gfx = nullptr;
static SPIClass touchSpi(VSPI);
static XPT2046_Touchscreen ts(PIN_TOUCH_CS, PIN_TOUCH_IRQ);

static bool     visible      = false;
static uint32_t hideAt       = 0;
static int      pressed      = -1;      // index being shown as held
static uint32_t pressedUntil = 0;
static bool     wasDown      = false;
static uint32_t lastTouchAt  = 0;
static bool     shownPlaying = false;   // play button's last drawn state
static bool     shownEdging  = false;   // edge button's last drawn state

static int mapClamp(int v, int inLo, int inHi, int outLo, int outHi) {
  if (inHi == inLo)
    return outLo;
  long r = (long)(v - inLo) * (outHi - outLo) / (inHi - inLo) + outLo;
  if (r < outLo) r = outLo;
  if (r > outHi) r = outHi;
  return (int)r;
}

static void drawButton(int i) {
  const Button &b = BUTTONS[i];
  const int x = i * BTN_W;
  const bool held = (i == pressed);

  // Play/pause carries state, so it reads as lit while playing.
  const bool lit = held
    || (b.action == ACT_TOGGLE_PLAY && phState.playing)
    || (b.action == ACT_PANIC && phState.panicked)
    || (b.action == ACT_EDGE && phEdging());

  const uint16_t bg = lit ? rgb(b.tint) : themePanel();
  const uint16_t fg = lit ? rgb(Rgb{255, 255, 255}) : themeMuted();

  gfx->fillRoundRect(x + 4, BTN_Y, BTN_W - 8, BTN_H, 8, bg);
  
  const char *label = b.label;
  if (b.action == ACT_TOGGLE_PLAY)
    label = phState.playing ? "||" : ">";

  gfx->setTextDatum(MC_DATUM);
  gfx->setTextColor(fg, bg);
  gfx->drawString(label, x + BTN_W / 2, BTN_Y + BTN_H / 2, 2);
}

static void showBar() {
  visible = true;
  shownPlaying = phState.playing;
  shownEdging = phEdging();
  gfx->fillRect(0, UI_TOP, 320, 240 - UI_TOP, faceBackground());
  for (int i = 0; i < BTN_COUNT; i++)
    drawButton(i);
}

static void hideBar() {
  visible = false;
  pressed = -1;
  gfx->fillRect(0, UI_TOP, 320, 240 - UI_TOP, faceBackground());
  faceInvalidate();
}

void uiBegin(TFT_eSPI *tft) {
  gfx = tft;
  touchSpi.begin(PIN_TOUCH_CLK, PIN_TOUCH_MISO, PIN_TOUCH_MOSI, PIN_TOUCH_CS);
  ts.begin(touchSpi);
  ts.setRotation(1);           // match the display's landscape rotation
}

bool uiMenuOpen() {
  return settingsMenuVisible();
}

bool uiTick() {
  const uint32_t now = millis();

  // Keep the stateful buttons honest if the desktop changes underneath us.
  if (visible && phState.playing != shownPlaying) {
    shownPlaying = phState.playing;
    for (int i = 0; i < BTN_COUNT; i++) {
      if (BUTTONS[i].action == ACT_TOGGLE_PLAY)
        drawButton(i);
    }
  }
  if (visible && phEdging() != shownEdging) {
    shownEdging = phEdging();
    for (int i = 0; i < BTN_COUNT; i++) {
      if (BUTTONS[i].action == ACT_EDGE)
        drawButton(i);
    }
  }

  if (pressed >= 0 && now > pressedUntil) {
    const int was = pressed;
    pressed = -1;
    if (visible)
      drawButton(was);
  }

  const bool down = ts.touched();

  // Rising edge only: holding a finger down must not repeat an action.
  if (down && !wasDown && now - lastTouchAt > 140) {
    lastTouchAt = now;
    TS_Point p = ts.getPoint();

#ifdef SHOW_TOUCH_RAW
    Serial.printf("[touch] raw x=%d y=%d z=%d\n", p.x, p.y, p.z);
#endif

    const int x = mapClamp(p.x, TOUCH_MIN_X, TOUCH_MAX_X, 0, 319);
    const int y = mapClamp(p.y, TOUCH_MIN_Y, TOUCH_MAX_Y, 0, 239);

    if (settingsMenuVisible()) {
      settingsMenuTap(x, y);
      if (!settingsMenuVisible()) {
        // Coming back from the menu: the face owns the screen again.
        gfx->fillScreen(faceBackground());
        faceInvalidate();
      }
      wasDown = down;
      return false;
    }

    if (!visible && x < GEAR_W && y < GEAR_H) {
      settingsMenuOpen(gfx);
      wasDown = down;
      return false;
    }

    if (!visible) {
      showBar();
    }
    else if (y >= BTN_Y && y < BTN_Y + BTN_H) {
      const int i = x / BTN_W;
      if (i >= 0 && i < BTN_COUNT) {
        netSend(BUTTONS[i].action);
        pressed = i;
        pressedUntil = now + 160;
        drawButton(i);
      }
    }
    else {
      // Tapping the face half while the bar is up puts it away again.
      hideBar();
    }
    hideAt = now + HIDE_AFTER_MS;
  }
  wasDown = down;

  if (visible && now > hideAt)
    hideBar();

  return visible;
}
