#pragma once

#include <TFT_eSPI.h>

// ---------------------------------------------------------------------------
// Tap-to-reveal controls.
//
// The face owns the top of the screen and never draws below UI_TOP, so the bar
// can appear and disappear without either half repainting the other.
//
// A tap anywhere reveals the bar; a second tap on a button fires it. That extra
// step is deliberate — the first touch of a device sitting on a desk is very
// often accidental, and one of these buttons skips the video you were watching.
// ---------------------------------------------------------------------------

void uiBegin(TFT_eSPI *tft);

/** Poll touch, animate the bar. Call every loop. Returns true while visible. */
bool uiTick();

/** True while the settings menu covers the screen and the face must not draw. */
bool uiMenuOpen();
