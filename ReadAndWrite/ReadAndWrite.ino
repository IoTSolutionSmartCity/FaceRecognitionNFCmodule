/**
 * ----------------------------------------------------------------------------
 * This is a MFRC522 library example; see https://github.com/miguelbalboa/rfid
 * for further details and other examples.
 *
 * NOTE: The library file MFRC522.h has a lot of useful info. Please read it.
 *
 * Released into the public domain.
 * ----------------------------------------------------------------------------
 * This sample shows how to read and write data blocks on a MIFARE Classic PICC
 * (= card/tag).
 *
 * BEWARE: Data will be written to the PICC, in sector #1 (blocks #4 to #7).
 *
 *
 * Typical pin layout used:
 * -----------------------------------------------------------------------------------------
 *             MFRC522      Arduino       Arduino   Arduino    Arduino          Arduino
 *             Reader/PCD   Uno/101       Mega      Nano v3    Leonardo/Micro   Pro Micro
 * Signal      Pin          Pin           Pin       Pin        Pin              Pin
 * -----------------------------------------------------------------------------------------
 * RST/Reset   RST          9             5         D9         RESET/ICSP-5     RST
 * SPI SS      SDA(SS)      10            53        D10        10               10
 * SPI MOSI    MOSI         11 / ICSP-4   51        D11        ICSP-4           16
 * SPI MISO    MISO         12 / ICSP-1   50        D12        ICSP-1           14
 * SPI SCK     SCK          13 / ICSP-3   52        D13        ICSP-3           15
 *
 * More pin layouts for other boards can be found here: https://github.com/miguelbalboa/rfid#pin-layout
 *
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <SPI.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <MFRC522.h>
#include <Adafruit_NeoPixel.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#define RST_PIN         9
#define SS_PIN          10
#define I2C_SDA_PIN     8
#define I2C_SCL_PIN     3
#define LCD_I2C_ADDR    0x27
// ---- Built-in RGB LED config (easy to adjust per board) ----
#define LED_PIN                         48
#define LED_NUM_PIXELS                  1
#define LED_POWER_ENABLE_PIN            38   // set to -1 if board does not need it
#define LED_POWER_ENABLE_ACTIVE_HIGH    1
#define LED_BRIGHTNESS                  100
#define LED_TASK_INTERVAL_MS            25

MFRC522 mfrc522(SS_PIN, RST_PIN);
MFRC522::MIFARE_Key key;
WebServer server(80);
Adafruit_NeoPixel pixels(LED_NUM_PIXELS, LED_PIN, NEO_GRB + NEO_KHZ800);
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 16, 2);

enum LedMode {
    LED_MODE_IDLE = 0,
    LED_MODE_READING = 1,
    LED_MODE_ALLOW = 2,
    LED_MODE_DENY = 3
};

volatile LedMode g_ledMode = LED_MODE_IDLE;
volatile unsigned long g_ledModeUntil = 0;
TaskHandle_t g_ledTaskHandle = nullptr;
uint8_t g_ledAppliedR = 255;
uint8_t g_ledAppliedG = 255;
uint8_t g_ledAppliedB = 255;
unsigned long g_ledForceUntilMs = 0;
LedMode g_lastLcdMode = LED_MODE_DENY;

const char* WIFI_SSID = "IoTSwitch";
const char* WIFI_PASS = "88888888";
const char* MDNS_HOST = "iotswitch-esp32";
const byte BLOCK_ADDR = 4;
const byte TRAILER_BLOCK = 7;
// 设为 1 才运行原始串口 demo（会与 HTTP 接口抢占同一张卡）
#define ENABLE_SERIAL_DEMO 0

void dump_byte_array(byte *buffer, byte bufferSize);

void lcdPrintLine(uint8_t row, const String& text) {
    lcd.setCursor(0, row);
    String out = text;
    if (out.length() < 16) {
        while (out.length() < 16) out += " ";
    } else if (out.length() > 16) {
        out = out.substring(0, 16);
    }
    lcd.print(out);
}

void setLcdStatus(LedMode mode) {
    if (mode == g_lastLcdMode) return;
    g_lastLcdMode = mode;
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("NFC Status:");
    lcd.setCursor(0, 1);
    switch (mode) {
        case LED_MODE_READING:
            lcd.print("Waiting scan...");
            break;
        case LED_MODE_ALLOW:
            lcd.print("Access: ALLOW");
            break;
        case LED_MODE_DENY:
            lcd.print("Access: DENY");
            break;
        case LED_MODE_IDLE:
        default:
            lcd.print("Idle");
            break;
    }
}

void applyLedColor(uint8_t r, uint8_t g, uint8_t b) {
    bool forceWrite = (g_ledForceUntilMs > 0) && ((long)(millis() - g_ledForceUntilMs) < 0);
    if (!forceWrite && r == g_ledAppliedR && g == g_ledAppliedG && b == g_ledAppliedB) {
        return;
    }
    pixels.setPixelColor(0, pixels.Color(r, g, b));
    pixels.show();
    g_ledAppliedR = r;
    g_ledAppliedG = g;
    g_ledAppliedB = b;
}

void setLedColor(uint8_t r, uint8_t g, uint8_t b) {
    applyLedColor(r, g, b);
}

void turnOffLed() {
    setLedColor(0, 0, 0);
}

void ledSetMode(LedMode mode, unsigned long holdMs = 0) {
    g_ledMode = mode;
    g_ledModeUntil = holdMs > 0 ? (millis() + holdMs) : 0;
}

void ledTask(void* _arg) {
    bool blinkOn = false;
    unsigned long lastBlinkAt = 0;
    LedMode lastMode = LED_MODE_IDLE;
    while (true) {
        unsigned long now = millis();
        LedMode mode = g_ledMode;
        unsigned long untilAt = g_ledModeUntil;

        if (untilAt > 0 && (long)(now - untilAt) >= 0) {
            mode = LED_MODE_IDLE;
            g_ledMode = LED_MODE_IDLE;
            g_ledModeUntil = 0;
        }

        if (mode != lastMode) {
            blinkOn = false;
            lastBlinkAt = 0;
            lastMode = mode;
            setLcdStatus(mode);
        }

        uint8_t r = 0;
        uint8_t g = 0;
        uint8_t b = 18; // idle default

        switch (mode) {
            case LED_MODE_READING:
                if (now - lastBlinkAt >= 160) {
                    blinkOn = !blinkOn;
                    lastBlinkAt = now;
                }
                if (blinkOn) {
                    r = 180;
                    g = 80;
                    b = 0;
                } else {
                    r = 0;
                    g = 0;
                    b = 0;
                }
                break;
            case LED_MODE_ALLOW:
                r = 0;
                g = 150;
                b = 0;
                break;
            case LED_MODE_DENY:
                if (now - lastBlinkAt >= 150) {
                    blinkOn = !blinkOn;
                    lastBlinkAt = now;
                }
                if (blinkOn) {
                    r = 160;
                    g = 0;
                    b = 0;
                } else {
                    r = 0;
                    g = 0;
                    b = 0;
                }
                break;
            case LED_MODE_IDLE:
            default:
                r = 0;
                g = 0;
                b = 0;
                break;
        }

        applyLedColor(r, g, b);
        vTaskDelay(pdMS_TO_TICKS(LED_TASK_INTERVAL_MS));
    }
}

void setLedIdle() {
    ledSetMode(LED_MODE_IDLE);
}

void blinkLed(uint8_t r, uint8_t g, uint8_t b, int times, int onMs, int offMs) {
    // keep function signature for compatibility; actual blink handled by LED task
    (void)r;
    (void)g;
    (void)b;
    unsigned long total = (unsigned long)times * (unsigned long)(onMs + offMs);
    ledSetMode(LED_MODE_DENY, total);
}

void showAllowLed(unsigned long holdMs = 5000) {
    ledSetMode(LED_MODE_ALLOW, holdMs > 0 ? holdMs : 5000);
}

void showDenyLed() {
    blinkLed(160, 0, 0, 6, 180, 120);
}

String uidToHex() {
    String s;
    for (byte i = 0; i < mfrc522.uid.size; i++) {
        if (mfrc522.uid.uidByte[i] < 0x10) s += "0";
        s += String(mfrc522.uid.uidByte[i], HEX);
    }
    s.toUpperCase();
    return s;
}

bool waitForCard(unsigned long timeoutMs, bool showReadingLed = false) {
    (void)showReadingLed;
    Serial.print(F("[NFC] waiting for card, timeout_ms="));
    Serial.println(timeoutMs);
    ledSetMode(LED_MODE_READING);
    unsigned long start = millis();
    while (millis() - start < timeoutMs) {
        if (mfrc522.PICC_IsNewCardPresent() && mfrc522.PICC_ReadCardSerial()) {
            Serial.print(F("[NFC] card detected, uid="));
            Serial.println(uidToHex());
            ledSetMode(LED_MODE_IDLE);
            return true;
        }
        delay(5);
    }
    Serial.println(F("[NFC] wait timeout, no card"));
    setLedIdle();
    return false;
}

bool ensureClassicCard() {
    MFRC522::PICC_Type piccType = mfrc522.PICC_GetType(mfrc522.uid.sak);
    return (
        piccType == MFRC522::PICC_TYPE_MIFARE_MINI ||
        piccType == MFRC522::PICC_TYPE_MIFARE_1K ||
        piccType == MFRC522::PICC_TYPE_MIFARE_4K
    );
}

bool authA() {
    MFRC522::StatusCode status = (MFRC522::StatusCode)mfrc522.PCD_Authenticate(
        MFRC522::PICC_CMD_MF_AUTH_KEY_A, TRAILER_BLOCK, &key, &(mfrc522.uid)
    );
    return status == MFRC522::STATUS_OK;
}

bool authB() {
    MFRC522::StatusCode status = (MFRC522::StatusCode)mfrc522.PCD_Authenticate(
        MFRC522::PICC_CMD_MF_AUTH_KEY_B, TRAILER_BLOCK, &key, &(mfrc522.uid)
    );
    return status == MFRC522::STATUS_OK;
}

bool readBlock16(byte* out16) {
    if (!authA()) return false;
    byte buffer[18];
    byte size = sizeof(buffer);
    MFRC522::StatusCode status = (MFRC522::StatusCode)mfrc522.MIFARE_Read(BLOCK_ADDR, buffer, &size);
    if (status != MFRC522::STATUS_OK) return false;
    for (byte i = 0; i < 16; i++) out16[i] = buffer[i];
    return true;
}

bool writeBlock16(const byte* in16) {
    if (!authB()) return false;
    MFRC522::StatusCode status = (MFRC522::StatusCode)mfrc522.MIFARE_Write(BLOCK_ADDR, (byte*)in16, 16);
    return status == MFRC522::STATUS_OK;
}

void finishSession() {
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
}

void sendJson(int code, JsonDocument& doc) {
    String out;
    serializeJson(doc, out);
    server.send(code, "application/json", out);
}

void handleHealth() {
    StaticJsonDocument<160> doc;
    doc["ok"] = true;
    doc["ip"] = WiFi.localIP().toString();
    doc["wifi"] = (WiFi.status() == WL_CONNECTED);
    sendJson(200, doc);
}

void handleNfcRead() {
    Serial.println(F("[HTTP] GET /nfc/read"));
    StaticJsonDocument<320> doc;
    doc["ok"] = false;
    unsigned long timeoutMs = server.hasArg("timeout_ms") ? (unsigned long)server.arg("timeout_ms").toInt() : 15000;

    bool showReadingLed = server.hasArg("show_led") && server.arg("show_led") == "1";
    if (!waitForCard(timeoutMs, showReadingLed)) {
        doc["error"] = "timeout_waiting_for_card";
        Serial.println(F("[NFC] read failed: timeout_waiting_for_card"));
        return sendJson(408, doc);
    }

    doc["card_uid"] = uidToHex();
    if (!ensureClassicCard()) {
        doc["error"] = "unsupported_card_type";
        Serial.println(F("[NFC] read failed: unsupported_card_type"));
        finishSession();
        showDenyLed();
        return sendJson(422, doc);
    }

    byte data[16];
    if (!readBlock16(data)) {
        doc["error"] = "read_block_failed";
        Serial.println(F("[NFC] read failed: read_block_failed"));
        finishSession();
        showDenyLed();
        return sendJson(500, doc);
    }

    char ascii[17];
    for (int i = 0; i < 16; i++) {
        char c = (char)data[i];
        ascii[i] = (c >= 32 && c <= 126) ? c : '.';
    }
    ascii[16] = 0;
    doc["ok"] = true;
    doc["block4_ascii"] = ascii;
    Serial.print(F("[NFC] read ok, block4_ascii="));
    Serial.println(ascii);
    finishSession();
    // Card read success only means "start verification", not final ALLOW.
    // Keep reading/pending indication and wait for /nfc/permission-result.
    ledSetMode(LED_MODE_READING, 7000);
    lcd.clear();
    lcdPrintLine(0, "Verifying face");
    lcdPrintLine(1, "Please wait...");
    sendJson(200, doc);
}

int hexNibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

void handleNfcWrite() {
    Serial.println(F("[HTTP] POST /nfc/write"));
    StaticJsonDocument<384> doc;
    doc["ok"] = false;

    StaticJsonDocument<256> req;
    DeserializationError err = deserializeJson(req, server.arg("plain"));
    if (err) {
        doc["error"] = "invalid_json";
        return sendJson(400, doc);
    }

    const char* payload = req["payload"] | nullptr;
    const char* payload_hex = req["payload_hex"] | nullptr;
    unsigned long timeoutMs = req["timeout_ms"] | 15000;
    if (!payload && !payload_hex) {
        doc["error"] = "payload_required";
        return sendJson(400, doc);
    }

    bool showReadingLed = req["show_led"] | false;
    if (!waitForCard(timeoutMs, showReadingLed)) {
        doc["error"] = "timeout_waiting_for_card";
        Serial.println(F("[NFC] write failed: timeout_waiting_for_card"));
        return sendJson(408, doc);
    }

    doc["card_uid"] = uidToHex();
    if (!ensureClassicCard()) {
        doc["error"] = "unsupported_card_type";
        Serial.println(F("[NFC] write failed: unsupported_card_type"));
        finishSession();
        showDenyLed();
        return sendJson(422, doc);
    }

    byte data[16];
    for (int i = 0; i < 16; i++) data[i] = 0x00;

    if (payload_hex) {
        String h = String(payload_hex);
        h.replace("0x", "");
        h.replace(" ", "");
        h.replace("-", "");
        h.replace(":", "");
        int n = min(16, (int)(h.length() / 2));
        for (int i = 0; i < n; i++) {
            int hi = hexNibble(h[i * 2]);
            int lo = hexNibble(h[i * 2 + 1]);
            if (hi < 0 || lo < 0) {
                doc["error"] = "payload_hex_invalid";
                Serial.println(F("[NFC] write failed: payload_hex_invalid"));
                finishSession();
                showDenyLed();
                return sendJson(400, doc);
            }
            data[i] = (byte)((hi << 4) | lo);
        }
    } else {
        String s = String(payload);
        int n = min(16, (int)s.length());
        for (int i = 0; i < n; i++) data[i] = (byte)s[i];
    }

    if (!writeBlock16(data)) {
        doc["error"] = "write_failed";
        Serial.println(F("[NFC] write failed: write_failed"));
        finishSession();
        showDenyLed();
        return sendJson(500, doc);
    }

    byte verify[16];
    if (!readBlock16(verify)) {
        doc["error"] = "verify_read_failed";
        Serial.println(F("[NFC] write failed: verify_read_failed"));
        finishSession();
        showDenyLed();
        return sendJson(500, doc);
    }

    int matched = 0;
    for (int i = 0; i < 16; i++) {
        if (verify[i] == data[i]) matched++;
    }
    doc["ok"] = (matched == 16);
    doc["matched_bytes"] = matched;
    if (matched != 16) doc["error"] = "write_verify_mismatch";
    Serial.print(F("[NFC] write result matched_bytes="));
    Serial.println(matched);

    finishSession();
    if (matched == 16) showAllowLed();
    else showDenyLed();
    sendJson((matched == 16) ? 200 : 500, doc);
}

void handlePermissionResult() {
    Serial.println(F("[HTTP] POST /nfc/permission-result"));
    StaticJsonDocument<256> doc;
    doc["ok"] = false;

    StaticJsonDocument<256> req;
    DeserializationError err = deserializeJson(req, server.arg("plain"));
    if (err) {
        doc["error"] = "invalid_json";
        return sendJson(400, doc);
    }

    const char* stage = req["stage"] | "";
    if (String(stage) == "countdown") {
        int secLeft = req["seconds_left"] | 0;
        ledSetMode(LED_MODE_READING, 1200);
        lcd.clear();
        lcdPrintLine(0, "Capturing face");
        lcdPrintLine(1, String("In ") + String(secLeft) + String(" sec"));
        doc["ok"] = true;
        doc["stage"] = "countdown";
        return sendJson(200, doc);
    }

    bool allowed = req["allowed"] | false;
    String name = String(req["name"] | "");
    String reason = String(req["reason"] | "");
    float score = req["score"] | 0.0;
    unsigned long holdMs = req["hold_ms"] | (allowed ? 5000 : 1800);
    if (allowed) {
        showAllowLed(holdMs);
        lcd.clear();
        lcdPrintLine(0, "Access ALLOW");
        if (name.length() > 0) {
            lcdPrintLine(1, name);
        } else {
            lcdPrintLine(1, String("score ") + String(score, 2));
        }
    } else {
        showDenyLed();
        lcd.clear();
        lcdPrintLine(0, "Access DENY");
        if (reason.length() > 0) {
            lcdPrintLine(1, reason);
        } else {
            lcdPrintLine(1, "not authorized");
        }
    }
    doc["ok"] = true;
    doc["allowed"] = allowed;
    sendJson(200, doc);
}

void setup() {
    Serial.begin(115200);
    unsigned long serialStart = millis();
    while (!Serial && millis() - serialStart < 1500) {
        delay(10);
    }

    // I2C bus for external LCD (SDA/SCL explicitly assigned by request)
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    lcd.init();
    lcd.backlight();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("NFC Controller");
    lcd.setCursor(0, 1);
    lcd.print("Booting...");

    // ESP32-S3-WROOM-1 built-in RGB LED power rail enable.
    pinMode(38, OUTPUT);
    digitalWrite(38, HIGH);
    delay(10);

#if (LED_POWER_ENABLE_PIN >= 0)
    pinMode(LED_POWER_ENABLE_PIN, OUTPUT);
#if LED_POWER_ENABLE_ACTIVE_HIGH
    digitalWrite(LED_POWER_ENABLE_PIN, HIGH);
#else
    digitalWrite(LED_POWER_ENABLE_PIN, LOW);
#endif
    delay(10);
#endif

    pixels.begin();
    pixels.setBrightness(LED_BRIGHTNESS);
    g_ledForceUntilMs = millis() + 5000;
    turnOffLed();
    // Some NeoPixel library versions on Arduino do not implement clear().
    // Use explicit black + show as a compatible hardware reset sequence.
    pixels.show();
    setLedIdle();
    if (g_ledTaskHandle == nullptr) {
        xTaskCreatePinnedToCore(ledTask, "ledTask", 4096, nullptr, 1, &g_ledTaskHandle, 1);
    }
    SPI.begin();
    mfrc522.PCD_Init();

    for (byte i = 0; i < 6; i++) {
        key.keyByte[i] = 0xFF;
    }

    Serial.println(F("Scan a MIFARE Classic PICC to demonstrate read and write."));
    Serial.print(F("Using key (for A and B):"));
    dump_byte_array(key.keyByte, MFRC522::MF_KEY_SIZE);
    Serial.println();
    Serial.println(F("BEWARE: Data will be written to the PICC, in sector #1"));

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print(F("[WiFi] Connecting to IoTSwitch"));
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
        delay(300);
        Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        Serial.print(F("[WiFi] IP: "));
        Serial.println(WiFi.localIP());
        if (MDNS.begin(MDNS_HOST)) {
            MDNS.addService("http", "tcp", 80);
            Serial.print(F("[mDNS] http://"));
            Serial.print(MDNS_HOST);
            Serial.println(F(".local"));
        } else {
            Serial.println(F("[mDNS] start failed"));
        }
    } else {
        Serial.println(F("[WiFi] connect failed"));
    }

    server.on("/health", HTTP_GET, handleHealth);
    server.on("/nfc/read", HTTP_GET, handleNfcRead);
    server.on("/nfc/write", HTTP_POST, handleNfcWrite);
    server.on("/nfc/permission-result", HTTP_POST, handlePermissionResult);
    server.begin();
    Serial.println(F("[HTTP] listening on port 80"));
}

void loop() {
    server.handleClient();

#if ENABLE_SERIAL_DEMO
    if ( ! mfrc522.PICC_IsNewCardPresent())
        return;
    if ( ! mfrc522.PICC_ReadCardSerial())
        return;

    Serial.print(F("Card UID:"));
    dump_byte_array(mfrc522.uid.uidByte, mfrc522.uid.size);
    Serial.println();
    Serial.print(F("PICC type: "));
    MFRC522::PICC_Type piccType = mfrc522.PICC_GetType(mfrc522.uid.sak);
    Serial.println(mfrc522.PICC_GetTypeName(piccType));

    if (    piccType != MFRC522::PICC_TYPE_MIFARE_MINI
        &&  piccType != MFRC522::PICC_TYPE_MIFARE_1K
        &&  piccType != MFRC522::PICC_TYPE_MIFARE_4K) {
        Serial.println(F("This sample only works with MIFARE Classic cards."));
        return;
    }

    byte dataBlock[] = {
        0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0xff, 0x0b,
        0x0c, 0x0d, 0x0e, 0x0f
    };
    byte buffer[18];
    byte size = sizeof(buffer);
    MFRC522::StatusCode status;

    Serial.println(F("Authenticating using key A..."));
    status = (MFRC522::StatusCode) mfrc522.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, TRAILER_BLOCK, &key, &(mfrc522.uid));
    if (status != MFRC522::STATUS_OK) {
        Serial.print(F("PCD_Authenticate() failed: "));
        Serial.println(mfrc522.GetStatusCodeName(status));
        return;
    }

    Serial.println(F("Current data in sector:"));
    mfrc522.PICC_DumpMifareClassicSectorToSerial(&(mfrc522.uid), &key, 1);
    Serial.println();

    Serial.print(F("Reading data from block ")); Serial.print(BLOCK_ADDR);
    Serial.println(F(" ..."));
    status = (MFRC522::StatusCode) mfrc522.MIFARE_Read(BLOCK_ADDR, buffer, &size);
    if (status != MFRC522::STATUS_OK) {
        Serial.print(F("MIFARE_Read() failed: "));
        Serial.println(mfrc522.GetStatusCodeName(status));
    }
    Serial.print(F("Data in block ")); Serial.print(BLOCK_ADDR); Serial.println(F(":"));
    dump_byte_array(buffer, 16); Serial.println();
    Serial.println();

    Serial.println(F("Authenticating again using key B..."));
    status = (MFRC522::StatusCode) mfrc522.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_B, TRAILER_BLOCK, &key, &(mfrc522.uid));
    if (status != MFRC522::STATUS_OK) {
        Serial.print(F("PCD_Authenticate() failed: "));
        Serial.println(mfrc522.GetStatusCodeName(status));
        return;
    }

    Serial.print(F("Writing data into block ")); Serial.print(BLOCK_ADDR);
    Serial.println(F(" ..."));
    dump_byte_array(dataBlock, 16); Serial.println();
    status = (MFRC522::StatusCode) mfrc522.MIFARE_Write(BLOCK_ADDR, dataBlock, 16);
    if (status != MFRC522::STATUS_OK) {
        Serial.print(F("MIFARE_Write() failed: "));
        Serial.println(mfrc522.GetStatusCodeName(status));
    }
    Serial.println();

    Serial.print(F("Reading data from block ")); Serial.print(BLOCK_ADDR);
    Serial.println(F(" ..."));
    status = (MFRC522::StatusCode) mfrc522.MIFARE_Read(BLOCK_ADDR, buffer, &size);
    if (status != MFRC522::STATUS_OK) {
        Serial.print(F("MIFARE_Read() failed: "));
        Serial.println(mfrc522.GetStatusCodeName(status));
    }
    Serial.print(F("Data in block ")); Serial.print(BLOCK_ADDR); Serial.println(F(":"));
    dump_byte_array(buffer, 16); Serial.println();

    Serial.println(F("Checking result..."));
    byte count = 0;
    for (byte i = 0; i < 16; i++) {
        if (buffer[i] == dataBlock[i]) count++;
    }
    Serial.print(F("Number of bytes that match = ")); Serial.println(count);
    if (count == 16) {
        Serial.println(F("Success :-)"));
    } else {
        Serial.println(F("Failure, no match :-("));
        Serial.println(F("  perhaps the write didn't work properly..."));
    }
    Serial.println();

    Serial.println(F("Current data in sector:"));
    mfrc522.PICC_DumpMifareClassicSectorToSerial(&(mfrc522.uid), &key, 1);
    Serial.println();

    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
#else
    delay(2);
#endif
}

void dump_byte_array(byte *buffer, byte bufferSize) {
    for (byte i = 0; i < bufferSize; i++) {
        Serial.print(buffer[i] < 0x10 ? " 0" : " ");
        Serial.print(buffer[i], HEX);
    }
}
