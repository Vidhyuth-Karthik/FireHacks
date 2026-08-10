// Whisper — ESP32 joystick.
//
// Reads an 8-way analog stick and reports it to the Whisper backend.
//
// WHAT CHANGED from the first sketch, and why:
//
//   1. Posts on CHANGE, not on a timer. The original POSTed its current
//      state every 1000ms whether or not anything moved. That meant up to
//      a full second of lag between pushing the stick and the wheel
//      responding, and it made a double-press (now "not what I meant")
//      essentially undetectable. This polls every 15ms and only sends
//      when the direction or the button actually changes.
//
//   2. Debounces the button in firmware. A physical switch bounces for a
//      few milliseconds on contact; without this you get phantom presses,
//      which on this device means saying something the user didn't choose.
//
//   3. Hysteresis on the stick. One threshold makes a stick resting near
//      the edge flicker between two directions. Leaving a direction now
//      needs a smaller reading than entering it did.
//
//   4. Reuses one HTTPClient and keeps the connection alive, instead of
//      begin()/end() per post.
//
//   5. A heartbeat every 2s even when nothing changes, so the UI's DEVICE
//      pill can tell "idle" from "unplugged".
//
// The backend still accepts the original once-a-second sketch — it just
// feels sluggish and can't do double-press.

#include <WiFi.h>
#include <HTTPClient.h>

#define SW  6
#define VRy 5
#define VRx 4

const char* ssid       = "Arush";
const char* password   = "agrawall";

// Must be the machine running `uvicorn main:app --host 0.0.0.0 --port 8000`.
// --host 0.0.0.0 matters: the default binds to localhost only and the board
// will get connection-refused.
const char* serverName = "http://172.20.10.2:8000/recive";

const int CENTER      = 2048;
const int ENTER_ZONE  = 800;  // how far to push to register a direction
const int EXIT_ZONE   = 550;  // how far back to release it (hysteresis)

const unsigned long POLL_MS      = 15;
const unsigned long DEBOUNCE_MS  = 25;
const unsigned long HEARTBEAT_MS = 2000;

String   lastDirection  = "center";
bool     lastPressed    = false;
bool     rawPressed     = false;
unsigned long lastEdgeAt  = 0;
unsigned long lastPostAt  = 0;

HTTPClient http;

// ─── Joystick direction ───────────────────────────────────────────────────────

// `active` is whether that axis was already registering, so we can apply the
// looser exit threshold to it.
static bool axisHigh(int v, bool active) {
  return active ? (v > CENTER + EXIT_ZONE) : (v > CENTER + ENTER_ZONE);
}
static bool axisLow(int v, bool active) {
  return active ? (v < CENTER - EXIT_ZONE) : (v < CENTER - ENTER_ZONE);
}

String getDirection(int x, int y) {
  bool wasLeft  = lastDirection.indexOf("left")  >= 0;
  bool wasRight = lastDirection.indexOf("right") >= 0;
  bool wasUp    = lastDirection.indexOf("up")    >= 0;
  bool wasDown  = lastDirection.indexOf("down")  >= 0;

  bool left  = axisLow(x, wasLeft);
  bool right = axisHigh(x, wasRight);
  bool up    = axisHigh(y, wasUp);
  bool down  = axisLow(y, wasDown);

  if (up   && left)  return "up-left";
  if (up   && right) return "up-right";
  if (down && left)  return "down-left";
  if (down && right) return "down-right";
  if (up)            return "up";
  if (down)          return "down";
  if (left)          return "left";
  if (right)         return "right";
  return "center";
}

// ─── Reporting ────────────────────────────────────────────────────────────────

void report(const String& dir, bool pressed) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost — skipping POST");
    return;
  }

  String payload = String("{\"id\": \"esp32_01\"") +
                   ", \"direction\": \"" + dir + "\"" +
                   ", \"pressed\": " + (pressed ? "true" : "false") + "}";

  http.begin(serverName);
  http.addHeader("Content-Type", "application/json");
  http.setReuse(true);

  int code = http.POST(payload);
  if (code > 0) {
    Serial.printf("POST %s -> %d %s\n", payload.c_str(), code, http.getString().c_str());
  } else {
    Serial.printf("POST %s -> HTTP error %d\n", payload.c_str(), code);
  }
  http.end();

  lastPostAt = millis();
}

// ─── Setup ────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  Serial.println("\n\n=== ESP32 Booted ===");

  pinMode(SW, INPUT_PULLUP);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(100);

  Serial.printf("Connecting to \"%s\"\n", ssid);
  WiFi.begin(ssid, password);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.printf("  attempt %d — status code: %d\n", ++attempts, WiFi.status());

    if (attempts >= 30) {  // ~15 seconds then give up
      Serial.println("Could not connect. Check:\n"
                     "  1. iPhone hotspot is ON\n"
                     "  2. Settings > Personal Hotspot > Maximize Compatibility is ON (forces 2.4 GHz)\n"
                     "  3. SSID and password are correct");
      while (true) delay(1000);  // halt
    }
  }

  Serial.println("Connected!");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());
  Serial.printf("Reporting to %s\n", serverName);

  report("center", false);  // announce ourselves
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

void loop() {
  int  xValue = analogRead(VRx);
  int  yValue = analogRead(VRy);
  bool swNow  = (digitalRead(SW) == LOW);

  // Debounce: the reading has to hold steady past DEBOUNCE_MS to count.
  if (swNow != rawPressed) {
    rawPressed = swNow;
    lastEdgeAt = millis();
  }
  bool pressed = lastPressed;
  if (millis() - lastEdgeAt >= DEBOUNCE_MS) {
    pressed = rawPressed;
  }

  String dir = getDirection(xValue, yValue);

  bool changed   = (dir != lastDirection) || (pressed != lastPressed);
  bool heartbeat = (millis() - lastPostAt) >= HEARTBEAT_MS;

  if (changed || heartbeat) {
    lastDirection = dir;
    lastPressed   = pressed;
    report(dir, pressed);
  }

  delay(POLL_MS);
}
