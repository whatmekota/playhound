#include "face.h"
#include "net.h"
#include "palette.h"
#include "settings.h"

// -- Layout -----------------------------------------------------------------
// The sprite is sized around the artwork's real extents, not the eye's: the
// lash spikes reach 70px above the eye centre and the lower teeth 44px below,
// and anything outside the sprite is silently clipped.
static const int EYE_W    = 116;
static const int EYE_H    = 116;
static const int ECY      = 70;    // eye centre inside the sprite
static const int EYE_CY   = 90;    // eye centre on screen
static const int EYE_GAP  = 26;
static const int LID_UP   = 47;    // how far the upper lid opens from centre
static const int LID_LO   = 34;    // the lower lid is shallower - that is the almond
static const int IRIS_R   = 29;
static const int STATUS_Y = 2;
static const int TITLE_Y  = 150;

// The outer corner rides higher than the inner one. This one number is most of
// the difference between a cute round eye and a sharp one.
static const float SLANT = 0.13f;

static TFT_eSPI *gfx = nullptr;
static TFT_eSprite *eye  = nullptr;
static TFT_eSprite *iris = nullptr;

// Iris colour is the only colour in the face; everything else is theme ink.
static const Rgb COOL_TOP { 10, 34, 78 };
static const Rgb COOL_BOT { 96, 190, 232 };
static const Rgb HOT_TOP  { 74, 4, 48 };
static const Rgb HOT_BOT  { 255, 86, 156 };
static const Rgb DEAD_TOP { 26, 24, 32 };
static const Rgb DEAD_BOT { 88, 84, 98 };

// -- Animation state --------------------------------------------------------
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
static int      irisKey     = -1;

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
// The eye outline.
//
// Two different curves, both zero at the corners so they meet in a point: the
// upper lid is fuller, the lower one shallower. That asymmetry is what makes an
// almond rather than an ellipse.
// ---------------------------------------------------------------------------
static float upperCurve(float u) {
  return powf(sinf(PI * u), 0.70f);
}

static float lowerCurve(float u) {
  return powf(sinf(PI * u), 1.30f);
}

/** Vertical offset that lifts the outer corner. */
static int slantAt(int dx, float outerSign) {
  return (int)(-SLANT * dx * outerSign);
}

static void drawHeart(TFT_eSprite *s, int cx, int cy, int r, uint16_t c) {
  // The lobes have to sit a full radius apart or they merge into one blob and
  // the whole thing reads as a teardrop.
  const int lobe = (int)(r * 0.52f);
  const int top = cy - lobe / 2;
  s->fillCircle(cx - lobe, top, lobe, c);
  s->fillCircle(cx + lobe, top, lobe, c);
  s->fillTriangle(cx - 2 * lobe, top, cx + 2 * lobe, top, cx, cy + r, c);
}

// ---------------------------------------------------------------------------
// The iris. Rebuilt only when its colours change - the gradient is far too
// expensive to redraw at 30fps.
// ---------------------------------------------------------------------------
static void renderIris(float t, bool hearts) {
  Rgb top, bot;
  if (in.panicked || (settings.mode == MODE_AUTO && !phState.hostSeen)) {
    top = DEAD_TOP;
    bot = DEAD_BOT;
  }
  else {
    top = mix(COOL_TOP, HOT_TOP, t);
    bot = mix(COOL_BOT, HOT_BOT, t);
  }

  iris->fillSprite(TFT_TRANSPARENT);

  for (int dy = -IRIS_R; dy <= IRIS_R; dy++) {
    const float f = (float)dy / IRIS_R;
    const int hw = (int)(IRIS_R * sqrtf(1.0f - f * f));
    if (hw <= 0)
      continue;
    const Rgb c = mix(top, bot, (dy + IRIS_R) / (2.0f * IRIS_R));
    iris->drawFastHLine(IRIS_R - hw, IRIS_R + dy, 2 * hw + 1, rgb(c));
  }

  // Heavy dark rim. In the references the iris reads almost as a solid shape,
  // so this is thick rather than a hairline.
  const uint16_t ring = rgb(mix(top, Rgb{0, 0, 0}, 0.62f));
  for (int k = 0; k < 4; k++)
    iris->drawCircle(IRIS_R, IRIS_R, IRIS_R - k, ring);

  const uint16_t dark = rgb(mix(top, Rgb{0, 0, 0}, 0.80f));
  const uint16_t white = rgb(Rgb{255, 255, 255});

  if (hearts) {
    // A bright heart sitting in a dark pupil, which is how both heart
    // references read.
    iris->fillCircle(IRIS_R, IRIS_R, (int)(IRIS_R * 0.66f), dark);
    drawHeart(iris, IRIS_R, IRIS_R - 3, (int)(IRIS_R * 0.55f), white);
  }
  else {
    iris->fillEllipse(IRIS_R, IRIS_R, (int)(IRIS_R * 0.42f), (int)(IRIS_R * 0.52f), dark);
    iris->fillCircle(IRIS_R - 11, IRIS_R - 12, 8, white);
    iris->fillCircle(IRIS_R + 10, IRIS_R + 12, 4, rgb(Rgb{214, 232, 255}));
  }
}

// ---------------------------------------------------------------------------
// One eye, drawn column by column so the lash follows the outline exactly at
// any blink position.
// ---------------------------------------------------------------------------
static void drawEye(int cx, bool leftSide) {
  const int scx = EYE_W / 2;
  const float outerSign = leftSide ? -1.0f : 1.0f;
  const uint16_t BG = themeBg();
  const uint16_t SCLERA = themeSclera();
  const uint16_t INK = themeInk();

  // Half lidded as intensity climbs - the look in the first reference.
  const float squint = clampf(in.intensity, 0, 1) * 0.34f;
  const float open   = in.panicked ? 0.0f : clampf(lid - squint, 0.0f, 1.0f);

  const int upOpen = (int)(LID_UP * open);
  const int loOpen = (int)(LID_LO * (0.45f + 0.55f * open));

  eye->fillSprite(BG);

  // Sclera, one column at a time.
  for (int x = 0; x < EYE_W; x++) {
    const float u = (float)x / (EYE_W - 1);
    const int sl = slantAt(x - scx, outerSign);
    const int yT = ECY + sl - (int)(upOpen * upperCurve(u));
    const int yB = ECY + sl + (int)(loOpen * lowerCurve(u));
    if (yB > yT)
      eye->drawFastVLine(x, yT, yB - yT, SCLERA);
  }

  if (upOpen > 8) {
    const int ix = scx + (int)(lookX * 12.0f);
    const int iy = ECY + (int)(lookY * 9.0f);
    iris->pushToSprite(eye, ix - IRIS_R, iy - IRIS_R, TFT_TRANSPARENT);
  }

  // Mask the iris back inside the lids, then lay the lash on top. One pass, so
  // the lash always sits exactly on the edge it just trimmed.
  for (int x = 0; x < EYE_W; x++) {
    const float u = (float)x / (EYE_W - 1);
    const int sl = slantAt(x - scx, outerSign);
    const int yT = ECY + sl - (int)(upOpen * upperCurve(u));
    const int yB = ECY + sl + (int)(loOpen * lowerCurve(u));

    if (yT > 0)
      eye->drawFastVLine(x, 0, yT, BG);
    if (yB < EYE_H)
      eye->drawFastVLine(x, yB, EYE_H - yB, BG);

    // The lash wedge, heaviest over the body of the eye and toward the outer
    // corner - not at the corner tip, where the eye has no height and the lash
    // would read as a thin outline.
    const float outerness = leftSide ? (1.0f - u) : u;
    const int thick = 6 + (int)(17.0f * powf(sinf(PI * u), 0.50f)
                                * (0.38f + 0.62f * outerness));
    eye->drawFastVLine(x, yT - thick + 2, thick, INK);

    // A hairline crease above the lash, as in both sketches.
    if (u > 0.12f && u < 0.88f && upOpen > 14)
      eye->drawPixel(x, yT - thick - 3, INK);

    // Lower lid, a line rather than a wedge.
    if (loOpen > 6)
      eye->drawFastVLine(x, yB - 2, 4, INK);
  }

  // Upper lash spikes, longer and sharper toward the outer corner.
  for (int i = 0; i < 6; i++) {
    const float u = 0.10f + i * 0.16f;
    const float outerness = leftSide ? (1.0f - u) : u;
    const int bx = (int)(u * (EYE_W - 1));
    const int sl = slantAt(bx - scx, outerSign);
    const int by = ECY + sl - (int)(upOpen * upperCurve(u)) - 2;
    const int len = 10 + (int)(21.0f * outerness);
    const int dir = (int)outerSign;
    eye->fillTriangle(bx - 3, by,
                      bx + 3, by,
                      bx + dir * (int)(len * 0.62f), by - len, INK);
  }

  // Lower lash teeth - small, and the thing that stops the eye reading as a
  // plain outline.
  if (loOpen > 10) {
    for (int i = 0; i < 5; i++) {
      const float u = 0.22f + i * 0.14f;
      const int bx = (int)(u * (EYE_W - 1));
      const int sl = slantAt(bx - scx, outerSign);
      const int by = ECY + sl + (int)(loOpen * lowerCurve(u));
      const int dir = (int)outerSign;
      eye->fillTriangle(bx - 3, by - 2, bx + 3, by - 2, bx - dir * 3, by + 10, INK);
    }
  }

  eye->pushSprite(cx - EYE_W / 2, EYE_CY - ECY + (int)bob);
}

/** One line of text above the eyes: what it is connected to and doing. */
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

  gfx->fillRect(0, STATUS_Y, 320, 12, themeBg());
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

  gfx->fillRect(0, TITLE_Y, 320, 14, themeBg());
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

  // ~27KB and ~7KB at 16bpp, both on the heap. Comfortable on a board with no
  // PSRAM, but worth saying out loud if it ever fails.
  eye = new TFT_eSprite(tft);
  eye->setColorDepth(16);
  eye->createSprite(EYE_W, EYE_H);

  iris = new TFT_eSprite(tft);
  iris->setColorDepth(16);
  iris->createSprite(IRIS_R * 2 + 1, IRIS_R * 2 + 1);

  if (!eye->created() || !iris->created())
    Serial.println(F("[face] sprite allocation failed"));

  nextBlinkAt = millis() + 1200;
  nextLookAt  = millis() + 900;
}

void faceInvalidate() {
  lastStatus[0] = '\0';
  lastTitle[0] = '\0';
  irisKey = -1;
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
  const bool hearts = heartsOn();

  // Quantised, or a drifting intensity would rebuild the gradient every frame.
  const int key = (in.panicked ? 1 : 0) | (hearts ? 2 : 0)
                | ((settings.mode == MODE_AUTO && !phState.hostSeen) ? 4 : 0)
                | ((int)(t * 15.0f) << 3);
  if (key != irisKey) {
    irisKey = key;
    renderIris(t, hearts);
  }

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
    bob = sinf(bobPhase * TWO_PI) * 3.0f;
  }
  else {
    bob = approach(bob, 0.0f, 12.0f, dt);
  }

  drawStatus();
  drawTitle();

  const int cx = 160;
  drawEye(cx - (EYE_W / 2 + EYE_GAP / 2), true);
  drawEye(cx + (EYE_W / 2 + EYE_GAP / 2), false);
}
