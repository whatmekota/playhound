#include "face.h"
#include "kerfus.h"
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
// The artwork only ever occupies 43px above the eye centre and 25px below, so
// the old 138-row sprite was more than half empty. 80 rows fits it with room
// for the bob and frees both RAM and the layout below the eyes.
static const int EYE_H     = 80;
static const int ECY       = 50;    // eye centre inside the sprite
static const int EYE_GAP   = 38;

// Eyes sit lower when there is a mouth under them.
static const int EYE_CY_EYES = 95;
static const int EYE_CY_FULL = 118;

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

// Text lives in the strip above the eyes: the eye sprite never reaches higher
// than y=43 (eyes-only layout, bob included), and below the eyes it would land
// on the nose and mouth.
static const int STATUS_Y = 6;
static const int TITLE_Y  = 18;

// -- Mouth -------------------------------------------------------------------
// Cat mouth: the omega lip stays put and the opening grows downward from it.
// Letting the upper lip rise too makes an opening mouth read as a mound.
static const int   MOUTH_W   = 78;
static const int   MOUTH_H   = 52;
static const int   MOUTH_X   = 160 - MOUTH_W / 2;
static const int   MOUTH_Y   = 170;   // inside the control bar's strip
static const int   MOUTH_LO  = 17;    // how far it opens
static const int   MOUTH_SMILE = -3;  // corners below the centre
static const int   MOUTH_BOW = -7;    // negative raises the centre: the omega
static const float MOUTH_BOW_W = 0.26f;
static const float MOUTH_ARCH_P = 0.85f;
static const int   MOUTH_LINE_T = 3;
static const float FANG_AT   = 0.76f; // one snaggletooth, right of centre
static const int   FANG_LEN  = 9;
static const int   FANG_W    = 5;
static const Rgb   MOUTH_FILL { 72, 26, 34 };

static const int NOSE_Y = 156;

// The mouth is tied to the stroke rate but deliberately slower than it. At
// 120spm the stroke phase is 2Hz, and a mouth flapping twice a second reads as
// chewing rather than breathing.
static const float MOUTH_RATE   = 0.34f;   // fraction of the stroke rate
static const float MOUTH_MAX_HZ = 0.9f;    // and never faster than this

static TFT_eSPI *gfx = nullptr;
static TFT_eSprite *eye = nullptr;
static TFT_eSprite *mouth = nullptr;

// The mouth shares its rows with the control bar, so it yields while the bar
// is up rather than the two fighting over them.
static bool mouthAllowed = true;
static float mouthOpen = 0.0f;
static float mouthPhase = 0.0f;

static bool fullFace() {
  return settings.layout == FACE_FULL;
}

static int eyeCy() {
  return fullFace() ? EYE_CY_FULL : EYE_CY_EYES;
}

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
  bool     panicked;
  bool     moving;
  float    intensity;
  float    spm;
  bool     showText;
  FaceExpr expr;        // EXPR_NONE: look follows intensity alone
  float    strokePos;   // 0..1, or -1 when nothing is stroking
  bool     edging;      // held back by an edge
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
      in = { false, false, 0.0f, 0.0f, false, EXPR_NONE, -1.0f, false };
      break;

    case MODE_TEASE:
      demoPhase += dt * 0.09f;
      in = { false, true, 0.42f + 0.12f * sinf(demoPhase * TWO_PI), 46.0f, false, EXPR_NONE, -1.0f, false };
      break;

    case MODE_HEART:
      demoPhase += dt * 0.16f;
      in = { false, true, 0.88f + 0.08f * sinf(demoPhase * TWO_PI), 88.0f, false, EXPR_NONE, -1.0f, false };
      break;

    case MODE_DEMO: {
      // A slow triangle over ~45s, so everything the face can do shows up
      // without anyone having to drive it.
      demoPhase += dt / 45.0f;
      if (demoPhase > 1.0f)
        demoPhase -= 1.0f;
      const float t = demoPhase < 0.5f ? demoPhase * 2.0f : (1.0f - demoPhase) * 2.0f;
      in = { false, true, t, 30.0f + t * 90.0f, false, EXPR_NONE, -1.0f, false };
      break;
    }

    default: {
      // Face frames carry the intensity of whatever is in charge, a playing
      // script included; `state` only knows the session's, so without them
      // it only counts while a video plays.
      const bool live = phFaceLive();
      in.panicked  = phState.panicked;
      in.moving    = phState.spm > 1 && (phState.motion || (live && phState.playing));
      in.intensity = (live || phState.playing) ? clampf(phState.intensity, 0.0f, 1.0f) : 0.0f;
      in.spm       = phState.spm;
      in.showText  = true;
      in.expr      = live ? phState.expr : EXPR_NONE;
      in.strokePos = live ? phState.strokePos : -1.0f;
      in.edging    = phEdging();
      break;
    }
  }
}

static bool heartsOn() {
  if (settings.hearts == HEART_NEVER)
    return false;
  if (settings.hearts == HEART_ALWAYS)
    return true;
  if (in.panicked)
    return false;
  // The app's ladder already has hysteresis; follow it when there is one.
  if (in.expr != EXPR_NONE)
    return in.expr == EXPR_FLUSTERED;
  return in.intensity > 0.72f;
}

// ---------------------------------------------------------------------------
// Lid shapes
// ---------------------------------------------------------------------------

/** Smooth bell, warped so its apex lands at `a`. */
static float bell(float s, float a, float p) {
  if (s <= 0.0f || s >= 1.0f)
    return 0.0f;
  // Same NaN trap as the lash profile: if powf() rounds to exactly 1.0f the
  // sine lands just below zero and powf() of it is NaN. It cannot happen at
  // the current BODY_W, but it is one column away from happening at a larger
  // one, and a NaN here paints a full-height line.
  const float w = sinf(PI * powf(s, logf(0.5f) / logf(a)));
  return w > 0.0f ? powf(w, p) : 0.0f;
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

static void drawPupil(int cx, int cy, bool hearts, float scale, bool sparkle, uint16_t ink, uint16_t sclera) {
  if (hearts) {
    const int r = (int)(PUPIL_R * 0.66f);
    eye->fillCircle(cx, cy, r, ink);
    drawHeart(cx, cy - 3, (int)(PUPIL_R * 0.55f), sclera);
    return;
  }

  // Flat top, straight sides, elliptical bottom.
  const int rx = (int)(PUPIL_R * PUPIL_W * scale);
  const int ry = (int)(PUPIL_R * PUPIL_H * scale);
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
  const int notch = (int)(NOTCH_R * scale + 0.5f);
  eye->fillTriangle(cx - notch, cy - ry - 1,
                    cx + notch, cy - ry - 1,
                    cx, cy - ry + notch + 1, sclera);

  // Anime shine: a big catchlight up and in, a small one down and out. It is
  // what makes an open eye read as delighted rather than just open.
  if (sparkle) {
    eye->fillCircle(cx - rx / 3, cy - ry / 4, rx / 4 + 1, sclera);
    eye->fillCircle(cx + rx / 3, cy + ry / 3, 2, sclera);
  }
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

  // Without an expression from the app, intensity narrows the eye. With one,
  // the expression sets the lids outright: nudging the intensity look by a
  // few pixels made every mood read the same from across the room. `cap` is
  // how far the lids open at most, so a blink still closes them all the way.
  float squint = clampf(in.intensity, 0, 1) * 0.34f;
  float cap = 1.0f;
  float pupilScale = 1.0f;
  bool sparkle = false;
  switch (in.expr) {
    case EXPR_SLEEPY:    squint = 0.0f; cap = 0.30f; break;
    case EXPR_FOCUSED:   squint = 0.0f; cap = 0.62f; break;                  // narrowed, intent
    case EXPR_EXCITED:   squint = 0.0f; sparkle = true; break;               // wide and shining
    case EXPR_FLUSTERED: squint = 0.0f; cap = 0.55f; break;                  // half lidded, hearts, blush
    case EXPR_SHOCKED:   squint = 0.0f; pupilScale = 0.45f; break;           // wide, tiny pupils
    default: break;
  }
  if (in.edging)
    cap = fminf(cap, 0.6f);
  const float open = in.panicked ? 0.0f : clampf(lid * cap - squint, 0.0f, 1.0f);
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
    const int py = ECY + PUPIL_DY + (int)(lookY * 9.0f);
    const uint16_t pink = rgb(mix(PUPIL_COOL, PUPIL_HOT, in.intensity));
    drawPupil(px, py, heartsOn(), pupilScale, sparkle, pink, SCLERA);
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

    // sinf(PI) is about -8.7e-8 in float rather than 0, and powf() of a
    // negative base with a fractional exponent is NaN. That made `thick`
    // garbage on the last column of every eye and painted a full-height line
    // down it. Python's sin(pi) is positive, so the simulator never showed it.
    const float arch = sinf(PI * u);
    const float roundP = powf(arch > 0.0f ? arch : 0.0f, 0.45f);
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

  eye->pushSprite(bodyCx - BODY_W / 2 - start, eyeCy() - ECY + (int)bob);
}


// ---------------------------------------------------------------------------
// Mouth
//
// Built like the eyes: an upper and a lower edge per column meeting at the
// corners, with `open` scaling their separation, so a shut mouth is those two
// edges collapsing onto one line rather than a second shape to cross-fade to.
// ---------------------------------------------------------------------------
static float mouthBase(float u) {
  // Corners ride below the centre; MOUTH_SMILE is negative for this shape.
  return MOUTH_H * 0.5f - MOUTH_SMILE * powf(fabsf(u - 0.5f) * 2.0f, 1.5f);
}

static float mouthBow(float u) {
  // A notch at the centre of the upper lip. Negative raises it into an omega.
  const float t = fabsf(u - 0.5f) / MOUTH_BOW_W;
  return MOUTH_BOW * fmaxf(0.0f, 1.0f - t);
}

static float mouthTop(float u) {
  return mouthBase(u) + mouthBow(u);
}

static float mouthBottom(float u, float amount) {
  if (u <= 0.0f || u >= 1.0f)
    return mouthTop(u);
  const float arch = powf(sinf(PI * u), MOUTH_ARCH_P);
  return mouthTop(u) + amount * MOUTH_LO * arch;
}

static void drawMouth(float amount) {
  const uint16_t BG = themeBg();
  const uint16_t INK = themeInk();
  const uint16_t SCLERA = themeSclera();
  const uint16_t FILL = rgb(MOUTH_FILL);

  amount = clampf(amount, 0.0f, 1.0f);
  mouth->fillSprite(BG);

  for (int x = 0; x < MOUTH_W; x++) {
    const float u = (float)x / (MOUTH_W - 1);
    const int yT = (int)mouthTop(u);
    const int yB = (int)mouthBottom(u, amount);
    if (yB - yT >= 1)
      mouth->drawFastVLine(x, yT, yB - yT, FILL);
    mouth->drawFastVLine(x, yT - MOUTH_LINE_T + 1, MOUTH_LINE_T, INK);
  }

  // One snaggletooth, rotated onto the lip. Hanging it straight down leaves it
  // leaning away from a lip that is sloping underneath it, so its base lies
  // along the lip and its tip along the lip's normal.
  const int fx = (int)(FANG_AT * (MOUTH_W - 1));
  const float top = mouthTop((float)fx / (MOUTH_W - 1));
  const int step = 3;
  const float a = mouthTop((float)(fx - step) / (MOUTH_W - 1));
  const float b = mouthTop((float)(fx + step) / (MOUTH_W - 1));
  const float m = (b - a) / (2.0f * step);
  const float norm = sqrtf(1.0f + m * m);
  const float ux = 1.0f / norm, uy = m / norm;      // along the lip
  const float nx = -m / norm, ny = 1.0f / norm;     // its normal, pointing down

  auto px = [&](float along, float down) { return (int)(fx + along * ux + down * nx); };
  auto py = [&](float along, float down) { return (int)(top + along * uy + down * ny); };

  mouth->fillTriangle(px(-FANG_W, -1), py(-FANG_W, -1),
                      px(FANG_W, -1), py(FANG_W, -1),
                      px(0, FANG_LEN), py(0, FANG_LEN), INK);
  mouth->fillTriangle(px(-FANG_W + 2, 0), py(-FANG_W + 2, 0),
                      px(FANG_W - 2, 0), py(FANG_W - 2, 0),
                      px(0, FANG_LEN - 3), py(0, FANG_LEN - 3), SCLERA);

  mouth->pushSprite(MOUTH_X, MOUTH_Y);
}

/** A small round "o", for the fright after a panic. */
static void drawMouthOh() {
  mouth->fillSprite(themeBg());
  const int cx = MOUTH_W / 2;
  const int cy = (int)mouthBase(0.5f) + 6;
  mouth->fillEllipse(cx, cy, 8, 10, themeInk());
  mouth->fillEllipse(cx, cy + 1, 5, 7, rgb(MOUTH_FILL));
  mouth->pushSprite(MOUTH_X, MOUTH_Y);
}

// -1 unknown (the screen was repainted), else whether the blush is on screen.
static int blushShown = -1;
static const Rgb BLUSH { 236, 112, 146 };

/**
 * Anime blush: three short slanted strokes on each cheek, just under the eye
 * sprite. Drawn straight to the panel and only when it changes, since nothing
 * else ever paints there.
 */
static void drawBlush(bool on) {
  if (blushShown == (int)on)
    return;
  blushShown = on;

  const int y0 = eyeCy() - ECY + EYE_H + 4;   // below the sprite, bob included
  const int half = BODY_W / 2 + EYE_GAP / 2;
  for (int side = -1; side <= 1; side += 2) {
    const int cx = 160 + side * (half + 8);   // a little outboard of each eye
    gfx->fillRect(cx - 17, y0 - 1, 36, 12, themeBg());
    if (!on)
      continue;
    const uint16_t c = rgb(BLUSH);
    for (int k = 0; k < 3; k++) {
      const int x = cx - 13 + k * 9;
      gfx->drawLine(x, y0 + 9, x + 6, y0, c);
      gfx->drawLine(x + 1, y0 + 9, x + 7, y0, c);
    }
  }
}

/** Anime nose: a short stroke, leaning steeply rather than lying flat. */
static void drawNose() {
  const uint16_t INK = themeInk();
  gfx->drawLine(157, NOSE_Y, 161, NOSE_Y + 7, INK);
  gfx->drawLine(158, NOSE_Y, 162, NOSE_Y + 7, INK);
}

/** One line of text above the eyes: what it is connected to and doing. */
static void drawStatus() {
  char line[48];

  // "idle" is the session's phase whenever no session runs, even mid-video.
  const bool noPhase = !phState.phase[0] || strcmp(phState.phase, "idle") == 0;
  const char *what = noPhase ? (phState.playing ? "playing" : "idle") : phState.phase;

  if (!in.showText)
    line[0] = '\0';
  else if (!settings.wifi)
    snprintf(line, sizeof(line), "wifi off");
  else if (!phState.wifiUp)
    snprintf(line, sizeof(line), "joining wifi...");
  else if (!phState.connected)
    snprintf(line, sizeof(line), "looking for playhound at %s", PH_HOST);
  else if (!phState.hostSeen)
    snprintf(line, sizeof(line), "waiting for playhound");
  else if (phState.panicked)
    snprintf(line, sizeof(line), "shhh");
  else if (phState.edge == EDGE_HOLDING)
    snprintf(line, sizeof(line), "edge - holding %ds", phState.edgeHold);
  else if (phState.edge == EDGE_FALLING)
    snprintf(line, sizeof(line), "edge - backing off");
  else if (phState.edge == EDGE_REBUILDING)
    snprintf(line, sizeof(line), "easing back - %ds", phState.edgeRemaining);
  else if (in.expr == EXPR_SLEEPY)
    snprintf(line, sizeof(line), "z z z");
  else if (in.moving && in.spm > 0)
    snprintf(line, sizeof(line), "%s  %.0f spm", what, in.spm);
  else
    snprintf(line, sizeof(line), "%s", what);

  // The knob turned down is worth a glance; at 100% it is just noise.
  if (in.showText && phState.hostSeen && !phState.panicked && phState.knob < 0.995f) {
    const size_t n = strlen(line);
    snprintf(line + n, sizeof(line) - n, "  -  %d%%", (int)(phState.knob * 100.0f + 0.5f));
  }

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

/**
 * The title as font 1 can draw it. The built-in font is ASCII only, so a
 * Japanese title came out as a row of garbage; keep the ASCII parts, and if
 * that leaves nothing worth reading, show nothing.
 */
static void asciiTitle(const char *src, char *dst, size_t size) {
  size_t n = 0;
  int letters = 0;
  bool space = true;   // swallow leading spaces
  for (const char *p = src; *p && n + 1 < size; p++) {
    const unsigned char c = (unsigned char)*p;
    if (c >= 0x80 || c < 0x20) {
      // A run of foreign characters becomes one space.
      if (!space) {
        dst[n++] = ' ';
        space = true;
      }
      continue;
    }
    if (c == ' ' && space)
      continue;
    dst[n++] = (char)c;
    space = c == ' ';
    if (isalnum(c))
      letters++;
  }
  // Trim trailing spaces and the separators a dropped part leaves behind.
  while (n > 0 && strchr(" -_.,|:~", dst[n - 1]))
    n--;
  dst[n] = '\0';
  size_t lead = 0;
  while (dst[lead] && strchr(" -_.,|:~", dst[lead]))
    lead++;
  if (lead)
    memmove(dst, dst + lead, n - lead + 1);
  if (letters < 3)
    dst[0] = '\0';
}

/** What is loaded, elided in the middle so both ends stay readable. */
static void drawTitle() {
  char line[64];
  if (!in.showText || phState.panicked || !phState.hostSeen)
    line[0] = '\0';
  else
    asciiTitle(phState.title, line, sizeof(line));

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

// The style whose sprites are allocated. Only one style's are at a time: the
// board has no PSRAM, and the two together would be ~56KB of heap.
static uint8_t activeStyle = 0xFF;

static bool kerfusStyle() {
  return settings.style == STYLE_KERFUS;
}

/** Swap sprites when the style changes in the menu, and start from a clean screen. */
static void ensureStyle() {
  if (activeStyle == settings.style)
    return;
  activeStyle = settings.style;

  if (kerfusStyle()) {
    eye->deleteSprite();
    mouth->deleteSprite();
    kerfusBegin(gfx);
  }
  else {
    kerfusEnd();
    // 160x80 at 16bpp is 25KB on the heap. Comfortable on a board with no
    // PSRAM, but worth saying out loud if it ever fails.
    eye->createSprite(EYE_W, EYE_H);
    mouth->createSprite(MOUTH_W, MOUTH_H);
    if (!eye->created() || !mouth->created())
      Serial.println(F("[face] sprite allocation failed"));
  }
  gfx->fillScreen(themeBg());
  faceInvalidate();
}

void faceBegin(TFT_eSPI *tft) {
  gfx = tft;

  eye = new TFT_eSprite(tft);
  eye->setColorDepth(16);
  mouth = new TFT_eSprite(tft);
  mouth->setColorDepth(16);
  ensureStyle();

  nextBlinkAt = millis() + 1200;
  nextLookAt  = millis() + 900;
}

void faceInvalidate() {
  lastStatus[0] = '\0';
  lastTitle[0] = '\0';
  blushShown = -1;
}

void faceShowMouth(bool on) {
  mouthAllowed = on;
}

void faceTick() {
  if (eye == nullptr)
    return;
  ensureStyle();
  if (!kerfusStyle() && !eye->created())
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
      // Sleepy blinks are rare and slow: a heavy lid, not a flicker.
      const bool sleepy = in.expr == EXPR_SLEEPY;
      blinkUntil = now + (sleepy ? 320 : 110);
      const uint32_t base = in.moving
        ? (uint32_t)(2600 - clampf(in.spm, 0, 140) * 12 - t * 700)
        : (sleepy ? 7000 : 4200);
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
  // Once something is going, the eyes ride the stroke up and down. Frames come
  // ten a second; the quick approach below eases between them.
  const bool followStroke = in.strokePos >= 0.0f && !in.panicked && !in.edging
    && (in.expr == EXPR_FOCUSED || in.expr == EXPR_EXCITED || in.expr == EXPR_FLUSTERED);
  if (followStroke)
    lookTY = (0.5f - in.strokePos) * 2.0f;    // 1 is the top, and up is negative
  // Asleep or held back by an edge, the gaze drops.
  if (in.expr == EXPR_SLEEPY || in.edging)
    lookTY = 0.6f;
  if (in.panicked || in.expr == EXPR_SHOCKED) {
    lookTX = 0;
    lookTY = 0;
  }
  lookX = approach(lookX, lookTX, 2.2f, dt);
  lookY = approach(lookY, clampf(lookTY, -1.0f, 1.0f), followStroke ? 9.0f : 2.2f, dt);

  // -- Bob -----------------------------------------------------------------
  if (in.moving && in.spm > 1 && !in.panicked) {
    bobPhase += (in.spm / 60.0f) * dt;
    bob = sinf(bobPhase * TWO_PI) * 2.0f;
  }
  else {
    bob = approach(bob, 0.0f, 12.0f, dt);
  }

  // -- Mouth ---------------------------------------------------------------
  // The mouth carries the rhythm the bob used to: it opens on the stroke
  // phase, scaled by intensity, and shuts when nothing is moving.
  if (in.moving && !in.panicked) {
    float hz = (in.spm / 60.0f) * MOUTH_RATE;
    if (hz > MOUTH_MAX_HZ)
      hz = MOUTH_MAX_HZ;
    mouthPhase += hz * dt;
    if (mouthPhase > 1.0f)
      mouthPhase -= 1.0f;
    const float swing = 0.35f + 0.65f * t;
    mouthOpen = (0.5f - 0.5f * cosf(mouthPhase * TWO_PI)) * swing;
  }
  else {
    mouthOpen = approach(mouthOpen, 0.0f, 3.0f, dt);
  }

  drawStatus();
  drawTitle();

  if (kerfusStyle()) {
    KerfusFrame f;
    f.panicked  = in.panicked;
    f.edging    = in.edging;
    f.expr      = in.expr;
    f.intensity = in.intensity;
    f.hearts    = settings.hearts;
    f.full      = fullFace();
    f.lid       = lid;
    f.lookX     = lookX;
    f.lookY     = lookY;
    f.bob       = bob;
    f.barUp     = !mouthAllowed;
    kerfusDraw(f);
    return;
  }

  drawEye(160 - (BODY_W / 2 + EYE_GAP / 2), true);
  drawEye(160 + (BODY_W / 2 + EYE_GAP / 2), false);
  drawBlush(in.expr == EXPR_FLUSTERED && !in.panicked);

  if (fullFace()) {
    drawNose();
    if (mouthAllowed && mouth != nullptr && mouth->created()) {
      if (in.expr == EXPR_SHOCKED && !in.panicked)
        drawMouthOh();
      else
        drawMouth(mouthOpen);
    }
  }
}
