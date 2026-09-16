#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFi.h>

#include "config.h"
#include "net.h"

PhState phState;

static WebSocketsClient ws;

static const char *ACTION_NAMES[] = {
  "togglePlay",
  "prev",
  "next",
  "random",
  "panic",
  "motionToggle",
};

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
  phState.intensity = s["intensity"] | 0.0f;
  phState.spm       = s["spm"]       | 0.0f;

  const char *title = s["title"] | "";
  strncpy(phState.title, title, sizeof(phState.title) - 1);
  phState.title[sizeof(phState.title) - 1] = '\0';

  const char *phase = s["phase"] | "idle";
  strncpy(phState.phase, phase, sizeof(phState.phase) - 1);
  phState.phase[sizeof(phState.phase) - 1] = '\0';
}

static void onMessage(const char *text, size_t len) {
#if ARDUINOJSON_VERSION_MAJOR >= 7
  // v7 sizes itself; StaticJsonDocument is gone.
  JsonDocument doc;
#else
  // Big enough for a long title plus the state object, and no more.
  StaticJsonDocument<512> doc;
#endif
  if (deserializeJson(doc, text, len) != DeserializationError::Ok)
    return;

  const char *type = doc["type"] | "";

  if (strcmp(type, "state") == 0) {
    applyState(doc["state"].as<JsonObjectConst>());
    phState.hostSeen = true;
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
      // Ask for a state push rather than waiting for the next change.
      ws.sendTXT("{\"type\":\"hello\"}");
      break;

    case WStype_DISCONNECTED:
      phState.connected = false;
      phState.hostSeen = false;
      Serial.println(F("[net] relay lost"));
      break;

    case WStype_TEXT:
      onMessage((const char *)payload, length);
      break;

    default:
      break;
  }
}

void netBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // keeps latency down; this is a remote
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print(F("[net] joining "));
  Serial.println(F(WIFI_SSID));

  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[net] no WiFi; will keep retrying"));
  } else {
    Serial.print(F("[net] ip "));
    Serial.println(WiFi.localIP());
  }

  static char path[96];
  snprintf(path, sizeof(path), "/rc?room=%s&role=remote", PH_ROOM);

  ws.begin(PH_HOST, PH_PORT, path);
  ws.onEvent(onWsEvent);
  // A dropped socket is the normal case here, not an error: the desktop gets
  // closed, the board stays on.
  ws.setReconnectInterval(3000);
}

void netLoop() {
  ws.loop();
}

void netSend(PhAction action) {
  if (!phState.connected)
    return;

  char msg[64];
  snprintf(msg, sizeof(msg), "{\"type\":\"cmd\",\"action\":\"%s\"}",
           ACTION_NAMES[action]);
  ws.sendTXT(msg);
}
