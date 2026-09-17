#pragma once

#include <TFT_eSPI.h>

// ---------------------------------------------------------------------------
// The face.
//
// Written for the 320x240 16-bit panel rather than adapted from an OLED
// original: eyes are drawn into a sprite and pushed, which is both flicker-free
// and simpler than trying to make 1-bit blitting behave in colour.
//
// Everything it does is driven by the session state — it is a readout that
// happens to have a personality, not a decoration.
// ---------------------------------------------------------------------------

void faceBegin(TFT_eSPI *tft);

/** Advance animation and redraw if anything moved. Call every loop. */
void faceTick();

/** Repaint on the next tick, e.g. after the control bar has been hidden. */
void faceInvalidate();

/** The face's background, so the control bar clears to the same colour. */
uint16_t faceBackground();

/**
 * Whether the mouth may draw.
 *
 * It lives in the strip the control bar occupies, so it yields whenever the
 * bar is up rather than the two fighting over those rows.
 */
void faceShowMouth(bool on);
