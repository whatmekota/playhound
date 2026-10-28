#include <Preferences.h>

#include "config.h"
#include "kerfus.h"
#include "palette.h"
#include "settings.h"

Settings settings;

static Preferences prefs;
static TFT_eSPI *gfx = nullptr;
static bool visible = false;

// ── Menu layout ─────────────────────────────────────────────────────────────
static const int ROW_X   = 14;
static const int ROW_W   = 292;
static const int ROW_H   = 25;
static const int ROW_0   = 25;
static const int ROW_GAP = 28;
static const int ROWS    = 7;
static const int DONE_Y  = 226;

static const char *MODE_NAMES[MODE_COUNT]   = { "auto", "idle", "tease", "heart", "demo" };
static const char *HEART_NAMES[HEART_COUNT] = { "auto", "always", "never" };
static const char *THEME_NAMES[THEME_COUNT] = { "light", "dark" };
static const char *LAYOUT_NAMES[FACE_LAYOUT_COUNT] = { "full", "eyes" };
static const char *STYLE_NAMES[STYLE_COUNT] = { "anime", "kerfus" };
static const char *BRIGHT_NAMES[3]          = { "dim", "mid", "full" };
static const uint8_t BRIGHT_DUTY[3]         = { 55, 130, 235 };

static const char *ROW_LABEL[ROWS] = { "mode", "style", "face", "hearts", "theme", "bright", "wifi" };

static bool kerfus() {
  return settings.style == STYLE_KERFUS;
}

// ── Theme ───────────────────────────────────────────────────────────────────
static uint16_t T_BG, T_SCLERA, T_INK, T_PANEL, T_MUTED, T_ACCENT;

static void applyTheme() {
  if (kerfus()) {
    // Kerfus is always a lit screen in the dark; its colour tints the rest.
    static const Rgb INK[KERFUS_COLOR_COUNT] = { { 61, 165, 255 }, { 34, 227, 232 }, { 255, 111, 184 }, { 52, 210, 76 } };
    const Rgb ink = INK[settings.kcolor < KERFUS_COLOR_COUNT ? settings.kcolor : 0];
    T_BG     = rgb(Rgb{  0,   0,   0 });
    T_SCLERA = rgb(ink);
    T_INK    = rgb(ink);
    T_PANEL  = rgb(Rgb{ 18,  20,  28 });
    T_MUTED  = rgb(mix(Rgb{ 0, 0, 0 }, ink, 0.6f));
    T_ACCENT = rgb(ink);
  }
  else if (settings.theme == THEME_DARK) {
    T_BG     = rgb(Rgb{  6,   6,  10 });
    T_SCLERA = rgb(Rgb{250, 248, 252 });
    // Lifted off the background on purpose: a truly black lash on a black
    // screen is invisible and the eye loses its shape.
    T_INK    = rgb(Rgb{ 38,  28,  60 });
    T_PANEL  = rgb(Rgb{ 26,  22,  36 });
    T_MUTED  = rgb(Rgb{124, 110, 146 });
    T_ACCENT = rgb(Rgb{255, 158, 206 });
  }
  else {
    T_BG     = rgb(Rgb{240, 238, 246 });
    T_SCLERA = rgb(Rgb{255, 255, 255 });
    T_INK    = rgb(Rgb{ 10,   8,  16 });
    T_PANEL  = rgb(Rgb{220, 216, 230 });
    T_MUTED  = rgb(Rgb{ 96,  88, 112 });
    T_ACCENT = rgb(Rgb{198,  36, 118 });
  }
}

uint16_t themeBg()     { return T_BG; }
uint16_t themeSclera() { return T_SCLERA; }
uint16_t themeInk()    { return T_INK; }
uint16_t themePanel()  { return T_PANEL; }
uint16_t themeMuted()  { return T_MUTED; }
uint16_t themeAccent() { return T_ACCENT; }

static const char *rowValue(int i) {
  switch (i) {
    case 0: return MODE_NAMES[settings.mode];
    case 1: return STYLE_NAMES[settings.style];
    case 2: return LAYOUT_NAMES[settings.layout];
    case 3: return HEART_NAMES[settings.hearts];
    case 4: return kerfus() ? kerfusColorName(settings.kcolor) : THEME_NAMES[settings.theme];
    case 5: return BRIGHT_NAMES[settings.bright];
    default: return settings.wifi ? "on" : "off";
  }
}

void settingsBegin() {
  prefs.begin("phface", false);
  settings.mode   = prefs.getUChar("mode", MODE_AUTO);
  settings.style  = prefs.getUChar("style", STYLE_ANIME);
  settings.kcolor = prefs.getUChar("kcolor", 0);
  settings.hearts = prefs.getUChar("hearts", HEART_AUTO);
  settings.layout = prefs.getUChar("layout", FACE_FULL);
  settings.theme  = prefs.getUChar("theme", THEME_LIGHT);
  settings.bright = prefs.getUChar("bright", 1);
  settings.wifi   = prefs.getBool("wifi", true);

  // A corrupt or older namespace must not leave anything indexing off the end
  // of a name table.
  if (settings.mode >= MODE_COUNT)
    settings.mode = MODE_AUTO;
  if (settings.style >= STYLE_COUNT)
    settings.style = STYLE_ANIME;
  if (settings.kcolor >= KERFUS_COLOR_COUNT)
    settings.kcolor = 0;
  if (settings.hearts >= HEART_COUNT)
    settings.hearts = HEART_AUTO;
  if (settings.layout >= FACE_LAYOUT_COUNT)
    settings.layout = FACE_FULL;
  if (settings.theme >= THEME_COUNT)
    settings.theme = THEME_LIGHT;
  if (settings.bright > 2)
    settings.bright = 1;

  applyTheme();
}

void settingsSave() {
  prefs.putUChar("mode", settings.mode);
  prefs.putUChar("style", settings.style);
  prefs.putUChar("kcolor", settings.kcolor);
  prefs.putUChar("hearts", settings.hearts);
  prefs.putUChar("layout", settings.layout);
  prefs.putUChar("theme", settings.theme);
  prefs.putUChar("bright", settings.bright);
  prefs.putBool("wifi", settings.wifi);
}

uint8_t settingsBacklight() {
  return BRIGHT_DUTY[settings.bright];
}

bool settingsStandalone() {
  return settings.mode != MODE_AUTO;
}

// ---------------------------------------------------------------------------
// Menu rendering
// ---------------------------------------------------------------------------
static void drawRow(int i) {
  const int y = ROW_0 + i * ROW_GAP;

  gfx->fillRoundRect(ROW_X, y, ROW_W, ROW_H, 7, T_PANEL);

  gfx->setTextDatum(ML_DATUM);
  gfx->setTextColor(T_MUTED, T_PANEL);
  gfx->drawString(i == 4 && kerfus() ? "colour" : ROW_LABEL[i], ROW_X + 12, y + ROW_H / 2, 2);

  gfx->setTextDatum(MR_DATUM);
  gfx->setTextColor(T_ACCENT, T_PANEL);
  gfx->drawString(rowValue(i), ROW_X + ROW_W - 12, y + ROW_H / 2, 2);
}

static void drawAll() {
  gfx->fillScreen(T_BG);

  gfx->setTextDatum(TC_DATUM);
  gfx->setTextColor(T_MUTED, T_BG);
  gfx->drawString("settings", 160, 8, 2);

  for (int i = 0; i < ROWS; i++)
    drawRow(i);

  gfx->setTextDatum(TC_DATUM);
  gfx->setTextColor(T_MUTED, T_BG);
  gfx->drawString("tap a row to change   -   tap here when done", 160, DONE_Y, 1);
}

void settingsMenuOpen(TFT_eSPI *tft) {
  gfx = tft;
  visible = true;
  drawAll();
}

void settingsMenuClose() {
  if (!visible)
    return;
  visible = false;
  settingsSave();
}

bool settingsMenuVisible() {
  return visible;
}

void settingsMenuTap(int x, int y) {
  if (!visible)
    return;

  for (int i = 0; i < ROWS; i++) {
    const int ry = ROW_0 + i * ROW_GAP;
    if (y < ry || y >= ry + ROW_H || x < ROW_X || x >= ROW_X + ROW_W)
      continue;

    switch (i) {
      case 0: settings.mode   = (settings.mode + 1) % MODE_COUNT; break;
      case 1:
        settings.style = (settings.style + 1) % STYLE_COUNT;
        applyTheme();
        drawAll();          // the theme row and every colour just changed
        return;
      case 2: settings.layout = (settings.layout + 1) % FACE_LAYOUT_COUNT; break;
      case 3: settings.hearts = (settings.hearts + 1) % HEART_COUNT; break;
      case 4:
        // Kerfus has a colour rather than a theme.
        if (kerfus())
          settings.kcolor = (settings.kcolor + 1) % KERFUS_COLOR_COUNT;
        else
          settings.theme = (settings.theme + 1) % THEME_COUNT;
        applyTheme();
        drawAll();          // every colour on screen just changed
        return;
      case 5: settings.bright = (settings.bright + 1) % 3; break;
      default: settings.wifi  = !settings.wifi; break;
    }
    drawRow(i);
    return;
  }

  // Anything below the last row closes and saves.
  if (y >= ROW_0 + ROWS * ROW_GAP)
    settingsMenuClose();
}
