#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFi.h>

#include "config.h"
#include "net.h"
#include "settings.h"

PhState phState;

static WebSocketsClient ws;

static const char *ACTION_NAMES[] = {
  "togglePlay",
  "prev",
  "next",
  "random",
  "panic",
  "motionToggle",
  "edge",
};

// docs/face-protocol.md: face frames are live while they keep coming; after
// this long without one, `state` is in charge again.
static const uint32_t FACE_STALE_MS = 12000;
static const uint32_t PING_EVERY_MS = 10000;
static const int      FACE_VERSION  = 1;

static const char HELLO[] = "{\"type\":\"hello\",\"client\":\"face\",\"v\":1}";
static const char PING[]  = "{\"type\":\"ping\",\"client\":\"face\"}";

static uint32_t lastPingAt = 0;
static int lastWifiReason = -1;
// Set when the network was not found; netLoop() then lists what the radio can
// see, once, so a wrong name or a 5GHz-only network shows up on the serial log.
static volatile bool wantScan = false;
static bool scanned = false;

// The radio reports itself here, so the face can say whether it is stuck on
// the network or on the relay - two very different problems to fix.
static void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      phState.wifiUp = true;
      lastWifiReason = -1;
      Serial.print(F("[net] wifi up, ip "));
      Serial.print(WiFi.localIP());
      Serial.print(F(", looking for playhound at "));
      Serial.print(F(PH_HOST));
      Serial.print(':');
      Serial.println(PH_PORT);
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED: {
      phState.wifiUp = false;
      // It retries on its own and says the same thing every time; once is
      // enough. 201 no such network (or 5GHz only), 202/15 wrong password.
      const int reason = info.wifi_sta_disconnected.reason;
      if (reason != lastWifiReason) {
        lastWifiReason = reason;
        Serial.printf("[net] wifi not joined, reason %d\n", reason);
      }
      if (reason == WIFI_REASON_NO_AP_FOUND && !scanned)
        wantScan = true;
      break;
    }

    default:
      break;
  }
}

bool phFaceLive() {
  return phState.faceSeenAt != 0 && millis() - phState.faceSeenAt < FACE_STALE_MS;
}

static void copyStr(char *dst, size_t size, const char *src) {
  strncpy(dst, src, size - 1);
  dst[size - 1] = '\0';
}

static FaceExpr parseExpr(const char *s) {
  if (strcmp(s, "sleepy") == 0)    return EXPR_SLEEPY;
  if (strcmp(s, "calm") == 0)      return EXPR_CALM;
  if (strcmp(s, "focused") == 0)   return EXPR_FOCUSED;
  if (strcmp(s, "excited") == 0)   return EXPR_EXCITED;
  if (strcmp(s, "flustered") == 0) return EXPR_FLUSTERED;
  if (strcmp(s, "shocked") == 0)   return EXPR_SHOCKED;
  return EXPR_CALM;
}

static EdgePhase parseEdge(const char *s) {
  if (strcmp(s, "falling") == 0)    return EDGE_FALLING;
  if (strcmp(s, "holding") == 0)    return EDGE_HOLDING;
  if (strcmp(s, "rebuilding") == 0) return EDGE_REBUILDING;
  return EDGE_IDLE;
}

// ---------------------------------------------------------------------------
// The relay is a dumb room-based broadcast: whatever we send goes to the other
// members of our room, and whatever they send arrives here. The desktop pushes
// {type:"state"} whenever anything changes, and answers {type:"hello"} with a
// fresh one — which is what we ask for on connect.
// ---------------------------------------------------------------------------

static void applyState(JsonObjectConst s) {
  phState.playing   = s["playing"]   | false;
  phState.panicked  = s["panicked"]  | false;
  phState.motion    = s["motion"]    | false;
  phState.audio     = s["audio"]     | false;
  phState.knob      = s["knob"]      | 1.0f;

  JsonObjectConst e = s["edge"];
  phState.edge          = parseEdge(e["phase"] | "idle");
  phState.edgeHold      = e["hold"]      | 0;
  phState.edgeRemaining = e["remaining"] | 0;
  phState.edgeCount     = e["count"]     | 0;

  // The face frame is fresher for these, and its title honours the Face
  // panel's switch, which this one does not.
  if (phFaceLive())
    return;
  phState.intensity = s["intensity"] | 0.0f;
  phState.spm       = s["spm"]       | 0.0f;
  copyStr(phState.title, sizeof(phState.title), s["title"] | "");
  copyStr(phState.phase, sizeof(phState.phase), s["phase"] | "idle");
}

// A switched-off field is absent: keep what we had, except the title, which
// is absent precisely when the user does not want it shown.
static void applyFace(JsonDocument &d) {
  phState.playing  = d["playing"] | phState.playing;
  phState.panicked = d["panic"]   | phState.panicked;
  phState.expr     = parseExpr(d["expr"] | "calm");

  if (d["intensity"].is<float>())
    phState.intensity = d["intensity"].as<float>();
  if (d["spm"].is<float>())
    phState.spm = d["spm"].as<float>();
  phState.strokePos = d["strokePos"].is<float>() ? d["strokePos"].as<float>() : -1.0f;
  if (d["deviceConnected"].is<bool>())
    phState.deviceConnected = d["deviceConnected"].as<bool>();
  if (d["phase"].is<const char *>())
    copyStr(phState.phase, sizeof(phState.phase), d["phase"].as<const char *>());
  copyStr(phState.title, sizeof(phState.title), d["title"] | "");

  phState.faceSeenAt = millis();
  if (phState.faceSeenAt == 0)
    phState.faceSeenAt = 1;   // 0 means "never"
}

static void faceGone() {
  phState.faceSeenAt = 0;
  phState.expr = EXPR_NONE;
  phState.strokePos = -1.0f;
}

static void onMessage(const char *text, size_t len) {
#if ARDUINOJSON_VERSION_MAJOR >= 7
  // v7 sizes itself; StaticJsonDocument is gone.
  JsonDocument doc;
#else
  // A long title plus the state object with its edge, and no more.
  StaticJsonDocument<1024> doc;
#endif
  if (deserializeJson(doc, text, len) != DeserializationError::Ok)
    return;

  const char *type = doc["type"] | "";

  if (strcmp(type, "state") == 0) {
    applyState(doc["state"].as<JsonObjectConst>());
    phState.hostSeen = true;
    return;
  }

  if (strcmp(type, "face") == 0) {
    // A version we do not know may mean anything; `state` still works.
    if ((doc["v"] | 0) != FACE_VERSION)
      return;
    applyFace(doc);
    phState.hostSeen = true;
    return;
  }

  if (strcmp(type, "face.bye") == 0) {
    faceGone();
    return;
  }

  // The relay announces who else is in the room, which is how we know the
  // difference between "connected" and "the desktop is actually there".
  if (strcmp(type, "peers") == 0) {
    phState.hostSeen = (doc["hosts"] | 0) > 0;
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      phState.connected = true;
      Serial.println(F("[net] relay connected"));
      // Ask for a state push rather than waiting for the next change, and say
      // what we are, so the Face panel can tell us from a phone.
      ws.sendTXT(HELLO);
      lastPingAt = millis();
      break;

    case WStype_DISCONNECTED:
      // Also what a failed attempt looks like, every few seconds, so only say
      // so when a connection that was up goes down.
      if (phState.connected)
        Serial.println(F("[net] relay lost"));
      phState.connected = false;
      phState.hostSeen = false;
      faceGone();
      break;

    case WStype_TEXT:
      onMessage((const char *)payload, length);
      break;

    default:
      break;
  }
}

static bool enabled = false;
static bool wsStarted = false;

// Nothing here blocks. The face has to be on screen immediately whether or not
// there is a network, because in the standalone modes there may never be one.
static void radioUp() {
  static bool hooked = false;
  if (!hooked) {
    WiFi.onEvent(onWifiEvent);
    hooked = true;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // keeps latency down; this is a remote
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print(F("[net] joining "));
  Serial.println(F(WIFI_SSID));

  if (!wsStarted) {
    static char path[96];
    snprintf(path, sizeof(path), "/rc?room=%s&role=remote", PH_ROOM);
    ws.begin(PH_HOST, PH_PORT, path);
    ws.onEvent(onWsEvent);
    // A dropped socket is the normal case here, not an error: the desktop gets
    // closed, the board stays on.
    ws.setReconnectInterval(3000);
    wsStarted = true;
  }
}

static void radioDown() {
  ws.disconnect();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  phState.wifiUp = false;
  phState.connected = false;
  phState.hostSeen = false;
  faceGone();
  Serial.println(F("[net] radio off"));
}

void netSetEnabled(bool on) {
  if (on == enabled)
    return;
  enabled = on;
  if (on)
    radioUp();
  else
    radioDown();
}

void netBegin() {
  netSetEnabled(settings.wifi);
}

void netLoop() {
  // The setting can change under us from the menu.
  netSetEnabled(settings.wifi);
  if (!enabled)
    return;
  ws.loop();

  if (wantScan) {
    wantScan = false;
    scanned = true;
    // The radio cannot scan while it is still trying to join; stop it first.
    WiFi.disconnect();
    const int n = WiFi.scanNetworks();   // a couple of seconds, once
    Serial.printf("[net] '%s' not found; %d networks in range (2.4GHz only):\n", WIFI_SSID, n);
    for (int i = 0; i < n; i++)
      Serial.printf("[net]   %-32s ch %2d  %4d dBm\n", WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i));
    WiFi.scanDelete();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }

  // Proof of life for the Face panel, which forgets us after 25s.
  if (phState.connected && millis() - lastPingAt >= PING_EVERY_MS) {
    lastPingAt = millis();
    ws.sendTXT(PING);
  }

  // Face frames stopped without a goodbye (the desktop closed, or the link
  // was switched off on an older build): go back to `state`.
  if (phState.faceSeenAt != 0 && !phFaceLive())
    faceGone();
}

void netSend(PhAction action) {
  if (!enabled || !phState.connected)
    return;

  char msg[64];
  snprintf(msg, sizeof(msg), "{\"type\":\"cmd\",\"action\":\"%s\"}",
           ACTION_NAMES[action]);
  ws.sendTXT(msg);
}
