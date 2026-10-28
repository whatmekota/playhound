#pragma once

#include <TFT_eSPI.h>

#include "net.h"

// ---------------------------------------------------------------------------
// Kerfus: the cat robot face, the second face style.
//
// One colour on black: ring eyes with a pupil that slides inside them, bean
// brows, a dot nose over an omega mouth, two whiskers a side, and the robot's
// known expressions (> <, the wink, sad bars with a tear, sleepy lines).
//
// The app draws the same face for a second monitor from src/lib/kerfus.ts.
// Geometry and the pose table here are a copy of that file's: change both.
// ---------------------------------------------------------------------------

/** One frame: what face.cpp's animation decided, handed over to draw. */
struct KerfusFrame {
  bool     panicked;
  bool     edging;
  FaceExpr expr;        // EXPR_NONE: picked from intensity
  float    intensity;
  uint8_t  hearts;      // HeartMode
  bool     full;        // nose, mouth and whiskers, or eyes only
  float    lid;         // 1 open, ~0 mid-blink
  float    lookX;       // -1..1
  float    lookY;       // -1..1, up is negative
  float    bob;         // px
  float    mouthOpen;   // 0..1
  bool     barUp;       // the control bar holds the bottom rows
};

/** Allocate the frame buffer. False if the heap could not spare it. */
bool kerfusBegin(TFT_eSPI *tft);
void kerfusEnd();

/** Draw and push one frame (screen y 62..200, or to 168 while the bar is up). */
void kerfusDraw(const KerfusFrame &f);

/** Colours, by settings.kcolor. */
static const int KERFUS_COLOR_COUNT = 4;
const char *kerfusColorName(uint8_t i);
