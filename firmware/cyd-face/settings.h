#pragma once

#include <Arduino.h>
#include <TFT_eSPI.h>

// ---------------------------------------------------------------------------
// Persisted settings, and the menu that edits them.
//
// The point of the modes is that the board is useful sitting on a desk with no
// desktop in the room: only AUTO follows playhound, the rest drive the face
// from a synthetic state so it animates on its own.
// ---------------------------------------------------------------------------

enum FaceMode : uint8_t {
  MODE_AUTO,     // follow playhound
  MODE_IDLE,     // calm, standalone
  MODE_TEASE,    // simmering, standalone
  MODE_HEART,    // hearts and half lids, standalone
  MODE_DEMO,     // cycles the whole range, standalone
  MODE_COUNT,
};

enum HeartMode : uint8_t {
  HEART_AUTO,    // hearts once intensity is high
  HEART_ALWAYS,
  HEART_NEVER,
  HEART_COUNT,
};

// Light is what the reference art actually looks like: black lash on white. On
// a dark background the lash is a silhouette and the spikes outside the eye
// disappear entirely, so the theme genuinely changes the drawing, not the mood.
enum Theme : uint8_t {
  THEME_LIGHT,
  THEME_DARK,
  THEME_COUNT,
};

// Eyes-only is the close crop that shows every detail; full adds a nose and a
// mouth in the strip the control bar occupies, which is empty while it is
// hidden - i.e. nearly always.
enum FaceLayout : uint8_t {
  FACE_FULL,
  FACE_EYES,
  FACE_LAYOUT_COUNT,
};

// Which face: the anime eyes this was drawn for first, or Kerfus, the cat
// robot (BellaBot) in one colour on black.
enum FaceStyle : uint8_t {
  STYLE_ANIME,
  STYLE_KERFUS,
  STYLE_COUNT,
};

struct Settings {
  uint8_t mode   = MODE_AUTO;
  uint8_t style  = STYLE_ANIME;
  uint8_t kcolor = 0;          // Kerfus colour, see kerfusColorName()
  uint8_t layout = FACE_FULL;
  uint8_t hearts = HEART_AUTO;
  uint8_t theme  = THEME_LIGHT;
  uint8_t bright = 1;          // 0 dim, 1 mid, 2 full
  bool    wifi   = true;
};

extern Settings settings;

void settingsBegin();
void settingsSave();

/** Backlight duty for the current brightness step. */
uint8_t settingsBacklight();

/** True when the mode drives the face itself instead of following playhound. */
bool settingsStandalone();

// ── Theme colours, resolved once per change ────────────────────────────────
uint16_t themeBg();
uint16_t themeSclera();
uint16_t themeInk();       // lash and lineart
uint16_t themePanel();     // buttons and menu rows
uint16_t themeMuted();     // secondary text
uint16_t themeAccent();

// ── Menu ───────────────────────────────────────────────────────────────────
void settingsMenuOpen(TFT_eSPI *tft);
void settingsMenuClose();
bool settingsMenuVisible();

/** Route a tap to the menu. Closes it if the tap was below the last row. */
void settingsMenuTap(int x, int y);
