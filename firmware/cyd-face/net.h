#pragma once

#include <Arduino.h>

// ---------------------------------------------------------------------------
// What the desktop tells us.
//
// Two streams fill this. `state` mirrors RemoteState in
// src/composables/useRemoteLink.ts: the phone's frame, about controls, sent on
// discrete changes. `face` is ours (docs/face-protocol.md): ten a second, with
// the intensity of whatever is in charge, where the stroke is, and which
// expression to wear. While face frames keep coming they win for the fields
// both carry; when they stop, `state` alone drives the face as it always did.
// ---------------------------------------------------------------------------

// The app decides the expression, with hysteresis, so every face agrees.
enum FaceExpr : uint8_t {
  EXPR_NONE,       // no face frames: derive the look from intensity alone
  EXPR_SLEEPY,
  EXPR_CALM,
  EXPR_FOCUSED,
  EXPR_EXCITED,
  EXPR_FLUSTERED,
  EXPR_SHOCKED,
};

// An edge in progress, from `state.edge`.
enum EdgePhase : uint8_t {
  EDGE_IDLE,
  EDGE_FALLING,     // backing everything off
  EDGE_HOLDING,     // held low; `edgeHold` seconds to go
  EDGE_REBUILDING,  // easing back; `edgeRemaining` seconds to normal
};

struct PhState {
  bool     wifiUp    = false;   // joined the network and have an address
  bool     connected = false;   // socket is up
  bool     hostSeen  = false;   // a desktop is actually in the room
  bool     playing   = false;
  bool     panicked  = false;
  bool     motion    = false;
  bool     audio     = false;
  float    intensity = 0.0f;    // 0..1
  float    spm       = 0.0f;    // strokes per minute
  char     title[64] = {0};
  char     phase[12] = {0};     // idle / entry / build / peak / descent

  // From face frames.
  FaceExpr expr            = EXPR_NONE;
  float    strokePos       = -1.0f;   // 0..1, 1 = top; -1 while nothing moves it
  bool     deviceConnected = false;
  uint32_t faceSeenAt      = 0;       // millis() of the last face frame, 0 = none

  // From state frames.
  EdgePhase edge          = EDGE_IDLE;
  int       edgeHold      = 0;        // seconds of hold left
  int       edgeRemaining = 0;        // seconds until fully back
  int       edgeCount     = 0;        // edges this session
  float     knob          = 1.0f;     // intensity knob, 0.1..1
};

extern PhState phState;

/** Face frames are arriving, so they, not `state`, carry intensity and phase. */
bool phFaceLive();

/** An edge is holding things back (not yet easing back in). */
static inline bool phEdging() {
  return phState.edge == EDGE_FALLING || phState.edge == EDGE_HOLDING;
}

// Actions the relay understands. Same set the phone remote sends.
enum PhAction {
  ACT_TOGGLE_PLAY,
  ACT_PREV,
  ACT_NEXT,
  ACT_RANDOM,
  ACT_PANIC,
  ACT_MOTION_TOGGLE,
  ACT_EDGE,          // back everything off; again while held to go lower
};

void netBegin();
void netLoop();
void netSend(PhAction action);

/** Bring the radio up or take it down without a reboot. */
void netSetEnabled(bool on);
