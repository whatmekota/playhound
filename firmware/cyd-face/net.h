#pragma once

#include <Arduino.h>

// ---------------------------------------------------------------------------
// What the desktop tells us.
//
// Mirrors RemoteState in src/composables/useRemoteLink.ts. Anything the face
// or the controls need lives here; nothing else is kept.
// ---------------------------------------------------------------------------
struct PhState {
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
};

extern PhState phState;

// Actions the relay understands. Same set the phone remote sends.
enum PhAction {
  ACT_TOGGLE_PLAY,
  ACT_PREV,
  ACT_NEXT,
  ACT_RANDOM,
  ACT_PANIC,
  ACT_MOTION_TOGGLE,
};

void netBegin();
void netLoop();
void netSend(PhAction action);
