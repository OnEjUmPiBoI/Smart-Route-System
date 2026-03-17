#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DHT.h>
#include <EEPROM.h>
#include <esp_system.h>   // for esp_random()

// 🔧 ESP32-S3 PINS (adjust as needed for your board)
#define TRIG_PIN 5    // GPIO5
#define ECHO_PIN 4    // GPIO4
#define DHT_PIN 2     // GPIO2
#define BUILTIN_LED LED_BUILTIN  // use built-in constant
#define DHT_TYPE DHT11
#define SOUND_SPEED 0.034

// DUMPSTER DIMENSIONS
#define EMPTY_DISTANCE 35
#define FULL_DISTANCE 5

int bootCount = 1;

DHT dht(DHT_PIN, DHT_TYPE);
WebServer server(80);

const char* ssid = "galaxy";
const char* password = "peiq3746";
String traccarIP = "10.43.219.108";  // Default, can be changed via webhook
const int traccarPort = 5055;

// EEPROM settings
const int EEPROM_SIZE = 512;
const int TRACCAR_IP_ADDR = 0;     // Start address for IP string
const int TRACCAR_IP_LEN = 32;     // Max IP string length

struct Device {
  const char* id;
  float lat;
  float lon;
  int fill;
  float temp;
  float humidity;
  String alert;
};

Device dumpsters[10] = {
  {"10001", 42.002, 21.480, 0, 20.3, 43.0, ""},
  {"10002", 42.015, 21.425, 82, 32.1, 68.0, ""},
  {"10003", 41.985, 21.440, 95, 36.8, 87.0, ""},
  {"10004", 42.005, 21.460, 25, 19.2, 52.0, ""},
  {"10005", 41.995, 21.410, 65, 66.0, 42.0, ""},
  {"10006", 42.010, 21.435, 98, 28.7, 75.0, ""},
  {"10007", 41.997, 21.428, 45, 22.4, 60.0, ""},
  {"10008", 42.008, 21.445, 15, 18.9, 48.0, ""},
  {"10009", 42.000, 21.420, 70, 37.2, 82.0, ""},
  {"10010", 41.990, 21.450, 5, 17.5, 55.0, ""}
};

void blinkLED(int times);
int readDistance();
void sendAllDumpsters(int realFill, float realTemp, float realHumidity, bool skipIfEmpty);
void showFill(int fill);
void randomizeDumpstersExceptZero();
void sanitizeDumpsters();
void runCycle();
void loadTraccarIPFromEEPROM();
void saveTraccarIPToEEPROM();

unsigned long lastRandomizeMillis = 0;
const unsigned long RANDOMIZE_INTERVAL = 5UL * 60UL * 1000UL; // 5 minutes

// Truck trigger & multi-read logic
bool truckNearby = false;
unsigned long lastTruckCheckMillis = 0;
int multiReadCount = 0;
const int MULTI_READ_SAMPLES = 5; // Read 5 times when truck is near

void blinkLED(int times) {
  pinMode(BUILTIN_LED, OUTPUT);
  for (int i = 0; i < times; i++) {
    digitalWrite(BUILTIN_LED, LOW);
    delay(200);
    digitalWrite(BUILTIN_LED, HIGH);
    delay(200);
  }
  pinMode(BUILTIN_LED, INPUT);
}

void showFill(int fill) {
  pinMode(BUILTIN_LED, OUTPUT);
  if (fill > 80) {
    for(int i = 0; i < 5; i++) {
      digitalWrite(BUILTIN_LED, LOW); delay(100);
      digitalWrite(BUILTIN_LED, HIGH); delay(100);
    }
  } else {
    digitalWrite(BUILTIN_LED, LOW); delay(1000);
  }
  digitalWrite(BUILTIN_LED, HIGH);
  pinMode(BUILTIN_LED, INPUT);
}

int readDistance() {
  digitalWrite(TRIG_PIN, LOW); delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return EMPTY_DISTANCE;
  int distance = duration * SOUND_SPEED / 2;
  return constrain(distance, FULL_DISTANCE, EMPTY_DISTANCE);
}

void sendAllDumpsters(int realFill, float realTemp, float realHumidity, bool skipIfEmpty = false) {
  // Skip sending data if dumpster is empty and flag is set
  if (skipIfEmpty && realFill == 0) {
    Serial.println("⏭️ Dumpster empty - skipping data send (status-only mode)");
    return;
  }
  
  dumpsters[0].fill = realFill;
  dumpsters[0].temp = realTemp;
  dumpsters[0].humidity = realHumidity;
  
  String espIP = WiFi.localIP().toString();  // ✅ ESP IP for Traccar
  
  Serial.println("📡 SENDING 10 DUMPSTERS...");
  
  for (int i = 0; i < 10; i++) {
    WiFiClient client;
    HTTPClient http;
    http.setTimeout(10000);
    
    // ✅ FIXED: Use Traccar 'ip' parameter + all custom attributes
    String url = "http://" + traccarIP + ":" + String(traccarPort) +
                 "/?id=" + String(dumpsters[i].id) +
                 "&lat=" + String(dumpsters[i].lat, 6) +
                 "&lon=" + String(dumpsters[i].lon, 6) +
                 "&speed=0" +
                 "&fillLevel=" + String(dumpsters[i].fill) +
                 "&temp=" + String(dumpsters[i].temp, 1) +
                 "&humidity=" + String(dumpsters[i].humidity, 1) +
                 "&ip=" + espIP +                    // ✅ TRACCAR NATIVE IP FIELD
                 "&deviceIP=" + espIP +              // ✅ FOR DASHBOARD
                 "&esp_ip=" + espIP;                 // ✅ EXTRA COMPAT
    
    Serial.printf("🗑️ [%s] %d%% IP:%s\n", dumpsters[i].id, dumpsters[i].fill, espIP.c_str());
    
    blinkLED(1);
    http.begin(client, url);
    int code = http.GET();
    http.end();
    
    Serial.printf("  → HTTP %d\n", code);
    delay(200);
  }
}

void randomizeDumpstersExceptZero() {
  for (int i = 1; i < 10; i++) {
    int fill = random(0, 101);
    float temp = random(150, 401) / 10.0; // 15.0 - 40.0 C
    float hum = random(200, 901) / 10.0;  // 20.0 - 90.0 %
    dumpsters[i].fill = fill;
    dumpsters[i].temp = temp;
    dumpsters[i].humidity = hum;
  }
  sanitizeDumpsters();
}

void sanitizeDumpsters() {
  for (int i = 0; i < 10; i++) {
    dumpsters[i].fill = constrain(dumpsters[i].fill, 0, 100);
    dumpsters[i].humidity = constrain((int)dumpsters[i].humidity, 0, 100);
  }
}

void loadTraccarIPFromEEPROM() {
  EEPROM.begin(EEPROM_SIZE);
  char ipBuffer[TRACCAR_IP_LEN];
  bool validIP = true;
  
  for (int i = 0; i < TRACCAR_IP_LEN; i++) {
    ipBuffer[i] = EEPROM.read(TRACCAR_IP_ADDR + i);
    if (ipBuffer[i] == 0) break;  // Null terminator found
    if (i == TRACCAR_IP_LEN - 1) validIP = false;  // No null terminator = corrupted
  }
  
  if (validIP && ipBuffer[0] != 255) {  // 255 = uninitialized EEPROM
    traccarIP = String(ipBuffer);
    Serial.printf("✅ Loaded Traccar IP from EEPROM: %s\n", traccarIP.c_str());
  } else {
    Serial.printf("⚠️ No Traccar IP in EEPROM, using default: %s\n", traccarIP.c_str());
  }
  EEPROM.end();
}

void saveTraccarIPToEEPROM() {
  EEPROM.begin(EEPROM_SIZE);
  for (int i = 0; i < TRACCAR_IP_LEN; i++) {
    if (i < traccarIP.length()) {
      EEPROM.write(TRACCAR_IP_ADDR + i, traccarIP[i]);
    } else {
      EEPROM.write(TRACCAR_IP_ADDR + i, 0);  // Null terminate
    }
  }
  EEPROM.commit();
  EEPROM.end();
  Serial.printf("💾 Saved Traccar IP to EEPROM: %s\n", traccarIP.c_str());
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  blinkLED(3);

  dht.begin();
  delay(3000);

  // seed random with hardware RNG on ESP32
  randomSeed(esp_random());

  loadTraccarIPFromEEPROM();

  WiFi.begin(ssid, password);
  Serial.print("WiFi");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts++ < 30) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n✅ WiFi Connected: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n⚠️ WiFi not connected (will retry in runCycle)");
  }

  // ✅ /status ENDPOINT for proximity polling
  server.on("/status", []() {
    int fill = constrain(map(readDistance(), FULL_DISTANCE, EMPTY_DISTANCE, 100, 0), 0, 100);
    float temp = dht.readTemperature();
    float hum = dht.readHumidity();
    if (isnan(temp)) temp = 20.0;
    if (isnan(hum)) hum = 50.0;
    
    String json = "{";
    json += "\"fillLevel\":" + String(fill) + ",";
    json += "\"temp\":" + String(temp, 1) + ",";
    json += "\"humidity\":" + String(hum, 1) + ",";
    json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
    json += "\"uptime\":" + String(millis()/1000);
    json += "}";
    
    server.send(200, "application/json", json);
    Serial.println("📡 /status → Fill:" + String(fill) + "% IP:" + WiFi.localIP().toString());
  });

  // Truck nearby webhook
  server.on("/truck-nearby", []() {
    truckNearby = true;
    multiReadCount = 0;
    Serial.println("🚛 TRUCK TRIGGERED - Multi-read mode!");
    server.send(200, "text/plain", "OK");
  });

  // Set Traccar IP endpoint
  server.on("/set-traccar-ip", []() {
    if (server.hasArg("ip")) {
      traccarIP = server.arg("ip");
      saveTraccarIPToEEPROM();
      server.send(200, "text/plain", "✅ Traccar IP: " + traccarIP);
      Serial.println("💾 Traccar IP set: " + traccarIP);
    } else {
      server.send(400, "text/plain", "❌ ?ip=10.0.0.75");
    }
  });

  server.begin();
  Serial.printf("🌐 Server on %s (80:/status, /truck-nearby, /set-traccar-ip)\n", 
                WiFi.localIP().toString().c_str());
}

void runCycle() {
  Serial.printf("🗑️ DUMPSTER ESP v14.6 | Cycle #%d | IP:%s\n", bootCount++, WiFi.localIP().toString().c_str());

  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("❌ DHT failed - using defaults");
    temperature = 20.0; humidity = 50.0;
  }

  Serial.println("📏 SONAR:");
  int readings[10], valid = 0, sum = 0;
  for (int i = 0; i < 10; i++) {
    readings[i] = readDistance();
    Serial.printf("Raw[%d]: %d cm\n", i, readings[i]);
    if (readings[i] >= FULL_DISTANCE && readings[i] <= EMPTY_DISTANCE) {
      sum += readings[i]; valid++;
    }
    delay(80);
  }

  int dist = valid > 4 ? sum / valid : EMPTY_DISTANCE;
  int fill = constrain(map(dist, FULL_DISTANCE, EMPTY_DISTANCE, 100, 0), 0, 100);

  Serial.printf("📊 REAL: Dist=%dcm | Fill=%d%% | T=%.1f°C | H=%.1f%%\n", 
                dist, fill, temperature, humidity);

  blinkLED(2);
  showFill(fill);

  WiFi.begin(ssid, password);
  Serial.print("WiFi");
  int i = 0;
  while (WiFi.status() != WL_CONNECTED && i++ < 30) {
    delay(500); Serial.print(".");
    blinkLED(1);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n✅ WiFi: %s\n", WiFi.localIP().toString().c_str());
    
    if (millis() - lastRandomizeMillis >= RANDOMIZE_INTERVAL) {
      randomizeDumpstersExceptZero();
      lastRandomizeMillis = millis();
    }

    sendAllDumpsters(fill, temperature, humidity, true);
    Serial.println("✅ 10 DUMPSTERS SENT!");
    blinkLED(5);
  } else {
    Serial.println("\n❌ WiFi FAILED!");
    blinkLED(10);
  }

  Serial.println("⏳ WAITING 5min...");
  delay(RANDOMIZE_INTERVAL);
}

void loop() {
  Serial.println("\n" + String(bootCount) + " =================================");
  
  server.handleClient();
  
  if (truckNearby && multiReadCount < MULTI_READ_SAMPLES) {
    Serial.println("🚛 TRUCK NEARBY - Multi-read");
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();
    int dist = readDistance();
    int fill = constrain(map(dist, FULL_DISTANCE, EMPTY_DISTANCE, 100, 0), 0, 100);
    Serial.printf("  #%d: %d%% T=%.1f H=%.1f\n", multiReadCount + 1, fill, temperature, humidity);
    multiReadCount++;
    delay(500);
    return;
  } else if (truckNearby && multiReadCount >= MULTI_READ_SAMPLES) {
    truckNearby = false;
    multiReadCount = 0;
    Serial.println("✅ Multi-read done\n");
  }
  
  runCycle();
}
