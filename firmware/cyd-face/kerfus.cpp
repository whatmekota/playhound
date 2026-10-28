#include "kerfus.h"
#include "palette.h"
#include "settings.h"

// ---------------------------------------------------------------------------
// The whole face is one 4-bit sprite: 320x138 at half a byte a pixel is 22KB,
// less than the anime face's two sprites, and with a palette the dim glow and
// the dot-matrix grid cost nothing extra. Each frame is drawn twice over, a
// grown copy in the glow colour first and the shapes themselves on top.
// ---------------------------------------------------------------------------

// -- Geometry (a copy of KERFUS in src/lib/kerfus.ts) -------------------------
// The numbers are in the app's face box, y 30..168. On the board the box sits
// SHIFT lower so the face is centred under the status line; the mouth and
// whiskers then share the control bar's rows, like the anime face's mouth.
static const int   BOX_Y = 30;     // the box's top, in the numbers below
static const int   BOX_H = 138;
static const int   SHIFT = 32;     // where it lands on screen: y 62..200
static const int   BAR_TOP = 168;  // the control bar's first row

static const float EYE_L = 84, EYE_R = 236, EYE_Y = 100;
static const float EYE_R0 = 46, PUPIL_R = 35;
static const float LID_CUT = 0.3f;   // the focused eye's flat top, as a fraction of the radius above centre

static const float BROW_L = 124, BROW_R = 196, BROW_Y = 42;
static const float BROW_RX = 14, BROW_RY = 5.5f;

static const float NOSE_Y = 118, NOSE_RX = 8, NOSE_RY = 5.5f;

static const float MOUTH_Y = 128, MOUTH_GAP = 13, MOUTH_R = 13, MOUTH_T = 6;

static const float WHISKER_X = 16, WHISKER_LEN = 24, WHISKER_T = 8, WHISKER_TILT = 12;
static const float WHISKER_Y[2] = { 136, 154 };

static const float LINE_T = 11;
static const int   GLOW = 3;       // how far the glow reaches past a shape

// -- Palette -----------------------------------------------------------------
enum : uint8_t { C_BLACK, C_CORE, C_GLOW, C_PINK, C_PINK_GLOW };

static const Rgb COLORS[KERFUS_COLOR_COUNT] = {
  { 61, 165, 255 },   // blue
  { 34, 227, 232 },   // cyan
  { 255, 111, 184 },  // pink
  { 52, 210, 76 },    // green
};
static const char *COLOR_NAMES[KERFUS_COLOR_COUNT] = { "blue", "cyan", "pink", "green" };
static const Rgb PINK { 255, 111, 184 };
static const Rgb BLACK { 0, 0, 0 };

const char *kerfusColorName(uint8_t i) {
  return COLOR_NAMES[i < KERFUS_COLOR_COUNT ? i : 0];
}

static TFT_eSprite *spr = nullptr;

bool kerfusBegin(TFT_eSPI *tft) {
  if (spr != nullptr)
    return spr->created();
  spr = new TFT_eSprite(tft);
  spr->setColorDepth(4);
  spr->createSprite(320, BOX_H);
  if (!spr->created()) {
    Serial.println(F("[kerfus] sprite allocation failed"));
    return false;
  }
  return true;
}

void kerfusEnd() {
  if (spr == nullptr)
    return;
  spr->deleteSprite();
  delete spr;
  spr = nullptr;
}

// -- Pose (a copy of kerfusPose() in src/lib/kerfus.ts) -----------------------
enum Eyes : uint8_t { EYES_RING, EYES_LID, EYES_WINK, EYES_SQUEEZE, EYES_HEARTS, EYES_SAD, EYES_SLEEP, EYES_SHUT };
enum Mouth : uint8_t { MOUTH_W, MOUTH_M, MOUTH_O, MOUTH_FLAT };

struct Pose {
  Eyes  eyes    = EYES_RING;
  float pupil   = 1.0f;
  float browDy  = 0;
  float browTilt = 0;
  Mouth mouth   = MOUTH_W;
  bool  blush   = false;
  bool  dim     = false;
  bool  blinks  = true;
};

static Pose pose(const KerfusFrame &f) {
  Pose p;
  if (f.panicked) {
    p.eyes = EYES_SHUT; p.mouth = MOUTH_FLAT; p.dim = true; p.blinks = false; p.browDy = 4;
    return p;
  }
  if (f.edging) {
    p.eyes = EYES_SAD; p.mouth = MOUTH_M; p.browDy = -2; p.browTilt = -16; p.blinks = false;
    return p;
  }

  FaceExpr e = f.expr;
  if (e == EXPR_NONE) {
    const float x = f.intensity;
    e = x >= 0.82f ? EXPR_FLUSTERED : x >= 0.6f ? EXPR_EXCITED : x >= 0.35f ? EXPR_FOCUSED : EXPR_CALM;
  }
  const bool hearts = f.hearts == HEART_ALWAYS
    || (f.hearts == HEART_AUTO && f.expr == EXPR_NONE && f.intensity > 0.72f);
  if (hearts && e != EXPR_SLEEPY && e != EXPR_SHOCKED) {
    p.eyes = EYES_HEARTS; p.blush = true; p.blinks = false;
    return p;
  }

  switch (e) {
    case EXPR_SLEEPY:    p.eyes = EYES_SLEEP; p.browDy = 6; p.blinks = false; break;
    case EXPR_FOCUSED:   p.eyes = EYES_LID; p.browDy = 4; p.browTilt = 14; break;
    case EXPR_EXCITED:   p.eyes = EYES_WINK; p.browDy = -3; break;
    case EXPR_FLUSTERED: p.eyes = EYES_SQUEEZE; p.blush = true; p.blinks = false; break;
    case EXPR_SHOCKED:   p.pupil = 0.5f; p.browDy = -7; p.mouth = MOUTH_O; break;
    default: break;
  }
  return p;
}

// -- Primitives --------------------------------------------------------------
static int sx(float x) { return (int)lroundf(x); }
static int sy(float y) { return (int)lroundf(y) - BOX_Y; }
static int sr(float r) { return r < 0.5f ? 0 : (int)lroundf(r); }

/** A line with round ends: the stroke every other shape is built from. */
static void capsule(float x0, float y0, float x1, float y1, float r, uint8_t c) {
  const float dx = x1 - x0, dy = y1 - y0;
  const float len = sqrtf(dx * dx + dy * dy);
  if (len >= 0.5f) {
    const float nx = -dy / len * r, ny = dx / len * r;
    spr->fillTriangle(sx(x0 + nx), sy(y0 + ny), sx(x0 - nx), sy(y0 - ny), sx(x1 - nx), sy(y1 - ny), c);
    spr->fillTriangle(sx(x0 + nx), sy(y0 + ny), sx(x1 - nx), sy(y1 - ny), sx(x1 + nx), sy(y1 + ny), c);
  }
  spr->fillCircle(sx(x0), sy(y0), sr(r), c);
  spr->fillCircle(sx(x1), sy(y1), sr(r), c);
}

/** A capsule of half-length `half` about (cx, cy), turned `deg` clockwise. */
static void bar(float cx, float cy, float half, float deg, float r, uint8_t c) {
  const float a = deg * DEG_TO_RAD;
  const float ux = cosf(a) * half, uy = sinf(a) * half;
  capsule(cx - ux, cy - uy, cx + ux, cy + uy, r, c);
}

/** Half of a ring, the lower half when `down`: one bump of the omega. */
static void halfRing(float cx, float cy, float r, float t, bool down, int grow, uint8_t c) {
  const float ro = r + t / 2 + grow, ri = r - t / 2 - grow;
  for (int dy = 0; dy <= (int)ro; dy++) {
    const int wo = (int)sqrtf(fmaxf(0.0f, ro * ro - dy * dy));
    const int wi = dy < ri ? (int)sqrtf(ri * ri - dy * dy) : 0;
    const int y = sy(down ? cy + dy : cy - dy);
    spr->drawFastHLine(sx(cx) - wo, y, wo - wi + 1, c);
    spr->drawFastHLine(sx(cx) + wi, y, wo - wi + 1, c);
  }
  spr->fillCircle(sx(cx - r), sy(cy), sr(t / 2 + grow), c);
  spr->fillCircle(sx(cx + r), sy(cy), sr(t / 2 + grow), c);
}

/** Quadratic Bezier stroke, as short capsules. */
static void curve(float x0, float y0, float qx, float qy, float x1, float y1, float r, uint8_t c) {
  float px = x0, py = y0;
  for (int i = 1; i <= 8; i++) {
    const float t = i / 8.0f, u = 1 - t;
    const float x = u * u * x0 + 2 * u * t * qx + t * t * x1;
    const float y = u * u * y0 + 2 * u * t * qy + t * t * y1;
    capsule(px, py, x, y, r, c);
    px = x;
    py = y;
  }
}

// -- Face --------------------------------------------------------------------
/** One eye. `side` is -1 for the left, +1 for the right. */
/** A heavy upper lid: what makes the focused eye read as intent, not as a cup. */
static void lidBar(float cx, float y, int grow, uint8_t ink) {
  capsule(cx - EYE_R0 + 2, y, cx + EYE_R0 - 2, y, LINE_T / 2 + grow, ink);
}

static void drawEye(const KerfusFrame &f, const Pose &p, int side, int grow, bool core) {
  const float cx = side < 0 ? EYE_L : EYE_R;
  const float cy = EYE_Y + f.bob;
  const uint8_t ink = core ? C_CORE : C_GLOW;

  Eyes e = p.eyes;
  if (e == EYES_WINK)
    e = side > 0 ? EYES_SQUEEZE : EYES_RING;

  switch (e) {
    case EYES_RING:
    case EYES_LID: {
      const float s = p.blinks ? fmaxf(0.1f, f.lid) : 1.0f;
      if (s < 0.3f) {
        // Mid-blink the ring is a line, not a squashed ring.
        capsule(cx - EYE_R0 + 6, cy, cx + EYE_R0 - 6, cy, 4.0f + grow, ink);
        break;
      }
      spr->fillEllipse(sx(cx), sy(cy), sr(EYE_R0 + grow), sr(EYE_R0 * s + grow), ink);
      if (core) {
        // The pupil slides within what is left of the ring, never through it.
        const float pr = PUPIL_R * p.pupil;
        const float travel = EYE_R0 - pr - 3;
        float dx = f.lookX * travel, dy = f.lookY * travel;
        const float n = sqrtf(dx * dx + dy * dy);
        if (n > travel) {
          dx *= travel / n;
          dy *= travel / n;
        }
        spr->fillEllipse(sx(cx + dx), sy(cy + dy * s), sr(pr), sr(pr * s), C_BLACK);
      }
      if (e == EYES_LID) {
        const float cut = cy - EYE_R0 * LID_CUT;
        spr->fillRect(sx(cx - EYE_R0 - GLOW - 2), sy(cy - EYE_R0 - GLOW - 2), sr(2 * EYE_R0 + 2 * GLOW + 4), sy(cut) - sy(cy - EYE_R0 - GLOW - 2), C_BLACK);
        lidBar(cx, cut, grow, ink);
      }
      break;
    }
    case EYES_SQUEEZE: {
      // `>` on the left, `<` on the right: both point at the nose.
      const float tip = cx - side * 22, back = cx + side * 22;
      capsule(back, cy - 20, tip, cy, LINE_T / 2 + grow, ink);
      capsule(tip, cy, back, cy + 20, LINE_T / 2 + grow, ink);
      break;
    }
    case EYES_HEARTS: {
      const uint8_t pink = core ? C_PINK : C_PINK_GLOW;
      const float y = cy - 4;
      spr->fillCircle(sx(cx - 17), sy(y - 9), sr(19 + grow), pink);
      spr->fillCircle(sx(cx + 17), sy(y - 9), sr(19 + grow), pink);
      spr->fillTriangle(sx(cx - 35 - grow), sy(y - 2), sx(cx + 35 + grow), sy(y - 2), sx(cx), sy(y + 33 + grow), pink);
      break;
    }
    case EYES_SAD: {
      const float ix = cx - side * 38, iy = cy - 8;
      const float ox = cx + side * 38, oy = cy + 4;
      capsule(ix, iy, ox, oy, (LINE_T + 3) / 2 + grow, ink);
      spr->fillCircle(sx(ox - side * 2), sy(oy + 11), sr(7 + grow), ink);
      break;
    }
    case EYES_SLEEP:
      curve(cx - 32, cy + 2, cx, cy + 16, cx + 32, cy + 2, 4 + grow, ink);
      break;
    default:   // EYES_SHUT
      capsule(cx - 28, cy + 4, cx + 28, cy + 4, 2.5f + grow, ink);
      break;
  }
}

static void drawFace(const KerfusFrame &f, const Pose &p, int grow, bool core) {
  const uint8_t ink = core ? C_CORE : C_GLOW;

  drawEye(f, p, -1, grow, core);
  drawEye(f, p, 1, grow, core);

  // Brows ride the bob with the eyes; a positive tilt drops the inner ends.
  const float by = BROW_Y + p.browDy + f.bob;
  bar(BROW_L, by, BROW_RX - BROW_RY, p.browTilt, BROW_RY + grow, ink);
  bar(BROW_R, by, BROW_RX - BROW_RY, -p.browTilt, BROW_RY + grow, ink);

  if (!f.full)
    return;

  switch (p.mouth) {
    case MOUTH_W:
      halfRing(160 - MOUTH_GAP, MOUTH_Y, MOUTH_R, MOUTH_T, true, grow, ink);
      halfRing(160 + MOUTH_GAP, MOUTH_Y, MOUTH_R, MOUTH_T, true, grow, ink);
      break;
    case MOUTH_M:
      halfRing(160 - MOUTH_GAP, MOUTH_Y + MOUTH_R, MOUTH_R, MOUTH_T, false, grow, ink);
      halfRing(160 + MOUTH_GAP, MOUTH_Y + MOUTH_R, MOUTH_R, MOUTH_T, false, grow, ink);
      break;
    case MOUTH_O:
      spr->fillCircle(160, sy(MOUTH_Y + 10), sr(10.5f + grow), ink);
      if (core)
        spr->fillCircle(160, sy(MOUTH_Y + 10), 5, C_BLACK);
      break;
    default:
      capsule(148, MOUTH_Y + 6, 172, MOUTH_Y + 6, 2.5f + grow, ink);
      break;
  }

  spr->fillEllipse(160, sy(NOSE_Y), sr(NOSE_RX + grow), sr(NOSE_RY + grow), ink);

  for (int side = -1; side <= 1; side += 2) {
    const float x = side < 0 ? WHISKER_X : 320 - WHISKER_X;
    for (int i = 0; i < 2; i++)
      bar(x, WHISKER_Y[i], WHISKER_LEN / 2, (i == 0 ? 1 : -1) * -side * WHISKER_TILT, WHISKER_T / 2 + grow, ink);
  }

  if (p.blush) {
    const uint8_t pink = core ? C_PINK : C_PINK_GLOW;
    for (int side = -1; side <= 1; side += 2) {
      const float cx = side < 0 ? EYE_L : EYE_R;
      for (int k = 0; k < 3; k++)
        capsule(cx - 17 + k * 12, EYE_Y + 54, cx - 11 + k * 12, EYE_Y + 44, 1.75f + grow, pink);
    }
  }
}

void kerfusDraw(const KerfusFrame &f) {
  if (spr == nullptr || !spr->created())
    return;

  const Pose p = pose(f);
  // Panic dims the drawing as well as the backlight.
  const float level = p.dim ? 0.28f : 1.0f;
  const Rgb ink = COLORS[settings.kcolor < KERFUS_COLOR_COUNT ? settings.kcolor : 0];
  spr->setPaletteColor(C_BLACK, rgb(BLACK));
  spr->setPaletteColor(C_CORE, rgb(mix(BLACK, ink, level)));
  spr->setPaletteColor(C_GLOW, rgb(mix(BLACK, ink, 0.22f * level)));
  spr->setPaletteColor(C_PINK, rgb(PINK));
  spr->setPaletteColor(C_PINK_GLOW, rgb(mix(BLACK, PINK, 0.22f)));

  spr->fillSprite(C_BLACK);
  drawFace(f, p, GLOW, false);
  drawFace(f, p, 0, true);

  // The robot's screen is a dot matrix: every third row and column stays dark.
  for (int y = 2; y < BOX_H; y += 3)
    spr->drawFastHLine(0, y, 320, C_BLACK);
  for (int x = 2; x < 320; x += 3)
    spr->drawFastVLine(x, 0, BOX_H, C_BLACK);

  // While the control bar is up, only the rows above it.
  if (f.barUp)
    spr->pushSprite(0, BOX_Y + SHIFT, 0, 0, 320, BAR_TOP - BOX_Y - SHIFT);
  else
    spr->pushSprite(0, BOX_Y + SHIFT);
}
