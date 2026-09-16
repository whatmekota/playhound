#include "face.h"
#include "net.h"
#include "palette.h"
#include "settings.h"

// ---------------------------------------------------------------------------
// Variant M from _eyesim.py, ported constant for constant.
//
// The eye is a flat slot: a plateau-bottomed opening under a near-straight
// upper lid, with a big flat-topped pupil doing the work that a lash mass does
// in the other shapes. Keep this file and the simulator in step by hand - the
// simulator is the place to try changes, because it renders in a second and
// this does not.
// ---------------------------------------------------------------------------

// -- Sprite ------------------------------------------------------------------
// The margins are asymmetric because the flick only ever extends past the
// OUTER corner and the inner spike only past the inner one. A symmetric margin
// would clip one of them or waste half the screen.
static const int BODY_W    = 100;
static const int MARGIN_IN = 20;
static const int MARGIN_OUT= 40;
static const int EYE_W     = MARGIN_IN + BODY_W + MARGIN_OUT;   // 160
static const int EYE_H     = 138;
static const int ECY       = 98;    // eye centre inside the sprite
static const int EYE_CY    = 101;   // eye centre on screen
static const int EYE_GAP   = 38;

// -- Shape -------------------------------------------------------------------
static const int   LID_UP     = 34;
static const int   LID_LO     = 12;
static const float SLANT      = 0.13f;
static const float ANG        = 0.75f;   // 0 round, 1 piecewise linear
static const float UP_APEX    = 0.44f;
static const float UP_P       = 0.38f;
static const float LO_EDGE    = 0.14f;
static const float RAMP_EASE  = 0.85f;

static const float LASH       = 7.0f;
static const int   LASH_BASE  = 3;
static const int   LOWER_T    = 2;
static const int   FLICK      = 40;
static const float FLICK_RISE = 0.30f;
static const int   INNER_SPIKE= 16;

// -- Pupil -------------------------------------------------------------------
// M's iris is the same colour as the sclera, so only the pupil is ever drawn.
static const int   PUPIL_R    = 30;
static const float PUPIL_S    = 0.47f;   // position along the eye, inner to outer
static const int   PUPIL_DY   = 1;
static const float PUPIL_W    = 0.78f;
static const float PUPIL_H    = 0.92f;
static const float PUPIL_FLAT = 0.26f;   // fraction of the height that is flat
static const int   NOTCH_R    = 5;

static const int STATUS_Y = 145;
static const int TITLE_Y  = 156;

static TFT_eSPI *gfx = nullptr;
static TFT_eSprite *eye = nullptr;

// Lid edges for the current eye, so the two passes over the columns do not
// each pay for the transcendentals.
static int16_t edgeTop[EYE_W];
static int16_t edgeBot[EYE_W];

// The pupil carries what little colour the face has: near-black when idle,
// deepening toward crimson as intensity climbs. M is monochrome by design, so
// this stays dark enough not to fight the drawing.
static const Rgb PUPIL_COOL { 14, 10, 28 };
static const Rgb PUPIL_HOT  { 58, 6, 26 };

// -- Animation state ---------------------------------------------------------
static float lid       = 1.0f;
static float lidTarget = 1.0f;
static float lookX     = 0.0f;
static float lookY     = 0.0f;
static float lookTX    = 0.0f;
static float lookTY    = 0.0f;
static float bob       = 0.0f;
static float bobPhase  = 0.0f;
static float demoPhase = 0.0f;

static uint32_t nextBlinkAt = 0;
static uint32_t blinkUntil  = 0;
static uint32_t nextLookAt  = 0;
static uint32_t lastFrameAt = 0;

static char lastStatus[48] = {0};
static char lastTitle[64]  = {0};

// What the face animates to. In AUTO this mirrors the desktop; in every other
// mode it is synthesised here, which is what lets the board sit on a desk with
// nothing connected. Porting the face to another host means replacing this
// function and nothing else.
struct FaceInput {
  bool  panicked;
  bool  moving;
  float intensity;
  float spm;
  bool  showText;
};
static FaceInput in;

static float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static float approach(float cur, float target, float rate, float dt) {
  const float d = target - cur;
  const float step = rate * dt;
  if (fabsf(d) <= step)
    return target;
  return cur + (d > 0 ? step : -step);
}

static void resolveInput(float dt) {
  switch (settings.mode) {
    case MODE_IDLE:
      in = { false, false, 0.0f, 0.0f, false };
      break;

    case MODE_TEASE:
      demoPhase += dt * 0.09f;
      in = { false, true, 0.42f + 0.12f * sinf(demoPhase * TWO_PI), 46.0f, false };
      break;

    case MODE_HEART:
      demoPhase += dt * 0.16f;
      in = { false, true, 0.88f + 0.08f * sinf(demoPhase * TWO_PI), 88.0f, false };
      break;

    case MODE_DEMO: {
      // A slow triangle over ~45s, so everything the face can do shows up
      // without anyone having to drive it.
      demoPhase += dt / 45.0f;
      if (demoPhase > 1.0f)
        demoPhase -= 1.0f;
      const float t = demoPhase < 0.5f ? demoPhase * 2.0f : (1.0f - demoPhase) * 2.0f;
      in = { false, true, t, 30.0f + t * 90.0f, false };
      break;
    }

    default:
      in.panicked  = phState.panicked;
      in.moving    = phState.motion && phState.spm > 1;
      in.intensity = phState.playing ? clampf(phState.intensity, 0.0f, 1.0f) : 0.0f;
      in.spm       = phState.spm;
      in.showText  = true;
      break;
  }
}

static bool heartsOn() {
  if (settings.hearts == HEART_NEVER)
    return false;
  if (settings.hearts == HEART_ALWAYS)
    return true;
  return in.intensity > 0.72f && !in.panicked;
}

// ---------------------------------------------------------------------------
// Lid shapes
// ---------------------------------------------------------------------------

/** Smooth bell, warped so its apex lands at `a`. */
static float bell(float s, float a, float p) {
  if (s <= 0.0f || s >= 1.0f)
    return 0.0f;
  return powf(sinf(PI * powf(s, logf(0.5f) / logf(a))), p);
}

/** Piecewise-linear peak at `a`: straight edges, hard apex. */
static float tent(float s, float a) {
  if (s <= 0.0f || s >= 1.0f)
    return 0.0f;
  return s < a ? s / a : (1.0f - s) / (1.0f - a);
}

/** Blend of the two. sin() alone is round by construction. */
static float lidUpper(float s) {
  return (1.0f - ANG) * bell(s, UP_APEX, UP_P) + ANG * tent(s, UP_APEX);
}

/** Corner ramp, eased so it meets the plateau with no hard angle. */
static float ramp(float t) {
  t = clampf(t, 0.0f, 1.0f);
  return (1.0f - RAMP_EASE) * t + RAMP_EASE * sinf(t * PI * 0.5f);
}

/**
 * Lower lid: flat across the middle, ramping only at the corners.
 *
 * A peaked curve here - however angular - makes the eye read as a diamond.
 */
static float lidLower(float s) {
  if (s <= 0.0f || s >= 1.0f)
    return 0.0f;
  return ramp(s / LO_EDGE) * ramp((1.0f - s) / LO_EDGE);
}

// ---------------------------------------------------------------------------
// Pupil
// ---------------------------------------------------------------------------
static void drawHeart(int cx, int cy, int r, uint16_t c) {
  // The lobes have to sit a full radius apart or they merge into one blob and
  // the whole thing reads as a teardrop.
  const int lobe = (int)(r * 0.52f);
  const int top = cy - lobe / 2;
  eye->fillCircle(cx - lobe, top, lobe, c);
  eye->fillCircle(cx + lobe, top, lobe, c);
  eye->fillTriangle(cx - 2 * lobe, top, cx + 2 * lobe, top, cx, cy + r, c);
}

static void drawPupil(int cx, int cy, bool hearts, uint16_t ink, uint16_t sclera) {
  if (hearts) {
    const int r = (int)(PUPIL_R * 0.66f);
    eye->fillCircle(cx, cy, r, ink);
    drawHeart(cx, cy - 3, (int)(PUPIL_R * 0.55f), sclera);
    return;
  }

  // Flat top, straight sides, elliptical bottom.
  const int rx = (int)(PUPIL_R * PUPIL_W);
  const int ry = (int)(PUPIL_R * PUPIL_H);
  for (int k = 0; k < 2 * ry; k++) {
    const float t = (float)k / (2 * ry - 1);
    int hw;
    if (t < PUPIL_FLAT) {
      hw = rx;
    }
    else {
      const float q = (t - PUPIL_FLAT) / (1.0f - PUPIL_FLAT);
      hw = (int)(rx * sqrtf(fmaxf(0.0f, 1.0f - q * q)));
    }
    if (hw > 0)
      eye->drawFastHLine(cx - hw, cy - ry + k, 2 * hw + 1, ink);
  }

  // A wedge bitten out of the pupil's top edge.
  eye->fillTriangle(cx - NOTCH_R, cy - ry - 1,
                    cx + NOTCH_R, cy - ry - 1,
                    cx, cy - ry + NOTCH_R + 1, sclera);
}

/** Two offset lines, because the sprite has no line width. */
static void crossStroke(int x0, int y0, int x1, int y1, uint16_t c) {
  eye->drawLine(x0, y0, x1, y1, c);
  eye->drawLine(x0 + 1, y0, x1 + 1, y1, c);
}

// ---------------------------------------------------------------------------
// One eye
// ---------------------------------------------------------------------------
static void drawEye(int bodyCx, bool leftSide) {
  const uint16_t BG = themeBg();
  const uint16_t SCLERA = themeSclera();
  const uint16_t INK = themeInk();

  const int start = leftSide ? MARGIN_OUT : MARGIN_IN;   // body x within sprite
  const int bcx = start + BODY_W / 2;
  const float outerSign = leftSide ? -1.0f : 1.0f;

  const float squint = clampf(in.intensity, 0, 1) * 0.34f;
  const float open   = in.panicked ? 0.0f : clampf(lid - squint, 0.0f, 1.0f);
  const int upOpen = (int)(LID_UP * open);
  const int loOpen = (int)(LID_LO * (0.45f + 0.55f * open));

  eye->fillSprite(BG);

  // Lid edges once, then reused by the mask pass below.
  for (int i = 0; i < BODY_W; i++) {
    const int x = start + i;
    const float u = (float)i / (BODY_W - 1);
    const float s = leftSide ? (1.0f - u) : u;
    const int sl = (int)(-SLANT * (x - bcx) * outerSign);
    edgeTop[x] = ECY + sl - (int)(upOpen * lidUpper(s));
    edgeBot[x] = ECY + sl + (int)(loOpen * lidLower(s));
    if (edgeBot[x] > edgeTop[x])
      eye->drawFastVLine(x, edgeTop[x], edgeBot[x] - edgeTop[x], SCLERA);
  }

  if (upOpen > 8) {
    const float pu = leftSide ? (1.0f - PUPIL_S) : PUPIL_S;
    const int px = start + (int)(pu * (BODY_W - 1)) + (int)(lookX * 7.0f);
    const int py = ECY + PUPIL_DY + (int)(lookY * 5.0f);
    const uint16_t pink = rgb(mix(PUPIL_COOL, PUPIL_HOT, in.intensity));
    drawPupil(px, py, heartsOn(), pink, SCLERA);
  }

  // Mask the pupil back inside the lids, then lay the lash on the edge it just
  // trimmed. One pass, so the two can never disagree.
  for (int i = 0; i < BODY_W; i++) {
    const int x = start + i;
    const float u = (float)i / (BODY_W - 1);
    const float s = leftSide ? (1.0f - u) : u;
    const int yT = edgeTop[x];
    const int yB = edgeBot[x];

    if (yT > 0)
      eye->drawFastVLine(x, 0, yT, BG);
    if (yB < EYE_H)
      eye->drawFastVLine(x, yB, EYE_H - yB, BG);

    const float roundP = powf(sinf(PI * u), 0.45f);
    const float angP = (u < 1.0f - u ? u : 1.0f - u) * 2.0f;
    const float prof = (1.0f - ANG) * roundP + ANG * angP;
    const int thick = LASH_BASE + (int)(LASH * prof * (0.30f + 0.70f * s));

    eye->drawFastVLine(x, yT - thick + 2, thick, INK);
    if (s > 0.10f && s < 0.92f && upOpen > 14)
      eye->drawPixel(x, yT - thick - 3, INK);
    if (loOpen > 5)
      eye->drawFastVLine(x, yB - 1, LOWER_T + 1, INK);
  }

  const int dir = (int)outerSign;
  auto bodyX = [&](float s) {
    const float u = leftSide ? (1.0f - s) : s;
    return start + (int)(u * (BODY_W - 1));
  };
  auto lidY = [&](float s, int bx) {
    return ECY + (int)(-SLANT * (bx - bcx) * outerSign) - (int)(upOpen * lidUpper(s)) - 2;
  };

  // The long flick off the outer corner, plus two smaller spikes inboard.
  const float spikeS[3] = { 0.99f, 0.82f, 0.66f };
  const int spikeLen[3] = { FLICK, (int)(FLICK * 0.42f), (int)(FLICK * 0.26f) };
  const int spikeHalf[3] = { 5, 4, 3 };
  for (int k = 0; k < 3; k++) {
    const int bx = bodyX(spikeS[k]);
    const int by = lidY(spikeS[k], bx);
    const int ln = spikeLen[k];
    eye->fillTriangle(bx - spikeHalf[k], by, bx + spikeHalf[k], by,
                      bx + dir * ln, by - (int)(ln * FLICK_RISE), INK);
  }

  // A matching taper off the inner corner.
  {
    const int bx = bodyX(0.01f);
    const int by = lidY(0.01f, bx) + 1;
    eye->fillTriangle(bx, by - 3, bx, by + 3,
                      bx - dir * INNER_SPIKE, by + (int)(INNER_SPIKE * 0.22f), INK);
  }

  // Crossed lower lashes.
  if (loOpen > 6) {
    const float crossS[3] = { 0.30f, 0.48f, 0.66f };
    for (int k = 0; k < 3; k++) {
      const int bx = bodyX(crossS[k]);
      const int by = ECY + (int)(-SLANT * (bx - bcx) * outerSign)
                   + (int)(loOpen * lidLower(crossS[k]));
      crossStroke(bx - 7, by - 1, bx + 7, by + 11, INK);
      crossStroke(bx + 7, by - 1, bx - 7, by + 11, INK);
    }
  }

  eye->pushSprite(bodyCx - BODY_W / 2 - start, EYE_CY - ECY + (int)bob);
}

/** One line of text below the eyes: what it is connected to and doing. */
static void drawStatus() {
  char line[48];

  if (!in.showText)
    line[0] = '\0';
  else if (!settings.wifi)
    snprintf(line, sizeof(line), "wifi off");
  else if (!phState.connected)
    snprintf(line, sizeof(line), "connecting...");
  else if (!phState.hostSeen)
    snprintf(line, sizeof(line), "waiting for playhound");
  else if (phState.panicked)
    snprintf(line, sizeof(line), "shhh");
  else if (phState.motion && phState.spm > 0)
    snprintf(line, sizeof(line), "%s  %.0f spm", phState.phase, phState.spm);
  else
    snprintf(line, sizeof(line), "%s", phState.playing ? "playing" : "idle");

  if (strcmp(line, lastStatus) == 0)
    return;
  strncpy(lastStatus, line, sizeof(lastStatus) - 1);
  lastStatus[sizeof(lastStatus) - 1] = '\0';

  gfx->fillRect(0, STATUS_Y, 320, 10, themeBg());
  if (!line[0])
    return;
  gfx->setTextDatum(TC_DATUM);
  gfx->setTextColor(themeMuted(), themeBg());
  gfx->drawString(line, 160, STATUS_Y, 1);
}

/** What is loaded, elided in the middle so both ends stay readable. */
static void drawTitle() {
  char line[64];
  if (!in.showText || phState.panicked || !phState.hostSeen)
    line[0] = '\0';
  else
    snprintf(line, sizeof(line), "%s", phState.title);

  if (strcmp(line, lastTitle) == 0)
    return;
  strncpy(lastTitle, line, sizeof(lastTitle) - 1);
  lastTitle[sizeof(lastTitle) - 1] = '\0';

  gfx->fillRect(0, TITLE_Y, 320, 10, themeBg());
  if (!line[0])
    return;

  gfx->setTextDatum(TC_DATUM);
  gfx->setTextColor(themeMuted(), themeBg());

  // Font 1 is 6px per character at size 1, so ~52 fit across the panel.
  const size_t n = strlen(line);
  if (n <= 50) {
    gfx->drawString(line, 160, TITLE_Y, 1);
  }
  else {
    char cut[54];
    snprintf(cut, sizeof(cut), "%.23s...%s", line, line + n - 23);
    gfx->drawString(cut, 160, TITLE_Y, 1);
  }
}

uint16_t faceBackground() {
  return themeBg();
}

void faceBegin(TFT_eSPI *tft) {
  gfx = tft;

  // 160x138 at 16bpp is ~44KB on the heap. Comfortable on a board with no
  // PSRAM, but worth saying out loud if it ever fails.
  eye = new TFT_eSprite(tft);
  eye->setColorDepth(16);
  eye->createSprite(EYE_W, EYE_H);

  if (!eye->created())
    Serial.println(F("[face] sprite allocation failed"));

  nextBlinkAt = millis() + 1200;
  nextLookAt  = millis() + 900;
}

void faceInvalidate() {
  lastStatus[0] = '\0';
  lastTitle[0] = '\0';
}

void faceTick() {
  if (eye == nullptr || !eye->created())
    return;

  const uint32_t now = millis();
  if (now - lastFrameAt < 33)        // ~30fps is plenty for this
    return;
  const float dt = (now - lastFrameAt) / 1000.0f;
  lastFrameAt = now;

  resolveInput(dt);
  const float t = in.intensity;

  // -- Blinking ------------------------------------------------------------
  if (!in.panicked) {
    if (now > nextBlinkAt) {
      blinkUntil = now + 110;
      const uint32_t base = in.moving
        ? (uint32_t)(2600 - clampf(in.spm, 0, 140) * 12 - t * 700)
        : 4200;
      nextBlinkAt = now + base + random(0, 1600);
    }
    lidTarget = (now < blinkUntil) ? 0.05f : 1.0f;
  }
  else {
    lidTarget = 0.0f;
  }
  lid = approach(lid, lidTarget, 9.0f, dt);

  // -- Gaze ----------------------------------------------------------------
  // The wander is random, but it drifts upward as intensity climbs and holds
  // still longer once something is running.
  if (!in.panicked && now > nextLookAt) {
    lookTX = random(-100, 101) / 140.0f;
    lookTY = random(-100, 101) / 220.0f - t * 0.55f;
    const uint32_t calm = in.moving ? 1500 : 2600;
    nextLookAt = now + calm + random(0, 2200);
  }
  if (in.panicked) {
    lookTX = 0;
    lookTY = 0;
  }
  lookX = approach(lookX, lookTX, 2.2f, dt);
  lookY = approach(lookY, clampf(lookTY, -1.0f, 1.0f), 2.2f, dt);

  // -- Bob -----------------------------------------------------------------
  if (in.moving && in.spm > 1 && !in.panicked) {
    bobPhase += (in.spm / 60.0f) * dt;
    bob = sinf(bobPhase * TWO_PI) * 2.0f;
  }
  else {
    bob = approach(bob, 0.0f, 12.0f, dt);
  }

  drawStatus();
  drawTitle();

  drawEye(160 - (BODY_W / 2 + EYE_GAP / 2), true);
  drawEye(160 + (BODY_W / 2 + EYE_GAP / 2), false);
}
