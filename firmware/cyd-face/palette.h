#pragma once

#include <Arduino.h>

#include "config.h"

// ---------------------------------------------------------------------------
// Colour, with the panel's quirks applied in exactly one place.
//
// CYD revisions disagree about both inversion and channel order, and the
// TFT_eSPI fix for that lives in a User_Setup.h shared with every other sketch
// on the machine. Doing it here instead keeps this sketch self-contained.
// ---------------------------------------------------------------------------

/** RGB565 from 8-bit components. */
static inline uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
#if PANEL_BGR
  const uint8_t t = r;
  r = b;
  b = t;
#endif
  return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

struct Rgb {
  uint8_t r, g, b;
};

/** Linear blend, t clamped to 0..1. */
static inline Rgb mix(Rgb a, Rgb b, float t) {
  if (t < 0.0f)
    t = 0.0f;
  if (t > 1.0f)
    t = 1.0f;
  return Rgb{
    (uint8_t)(a.r + (b.r - a.r) * t),
    (uint8_t)(a.g + (b.g - a.g) * t),
    (uint8_t)(a.b + (b.b - a.b) * t),
  };
}

static inline uint16_t rgb(Rgb c) {
  return rgb(c.r, c.g, c.b);
}
