const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const { startMjpegChildProcess } = require("./lib/usb_mjpeg_stream");
const { spawn } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");
const { getWindowsVideoDeviceName } = require("./lib/detect_windows_camera");
const { createPersistence } = require("./lib/persistence");
const mdns = require("multicast-dns")();
const os = require("os");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(
  session({
    secret: "node-demo-secret",
    resave: false,
    saveUninitialized: false
  })
);
// 重要：不要让 public/index.html 抢占 "/"，否则看不到 /login 与 /dashboard 流程
app.use(express.static(path.join(__dirname, "public"), { index: false }));

const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "store.json");

function createDefaultStore() {
  return {
    users: [
      {
        id: 1,
        username: "admin",
        email: "admin@demo.local",
        password: "admin123",
        userType: "personal"
      }
    ],
    resetTokens: {},
    nfc: [],
    nfcEvents: [],
    warnings: [
      {
        id: 1,
        action: "Unauthorized login attempt",
        camera_ip: "192.168.0.136",
        status: "pending",
        time: new Date().toISOString()
      },
      {
        id: 2,
        action: "Motion detection triggered",
        camera_ip: "192.168.0.137",
        status: "reviewed",
        time: new Date().toISOString()
      }
    ]
  };
}

/** Drop legacy camera blob from older store.json (rewrite pending). */
function migrateStore(store) {
  if (!store || typeof store !== "object") {
    return { store: store || {}, strippedCamera: false };
  }
  if (Object.prototype.hasOwnProperty.call(store, "camera")) {
    delete store.camera;
    return { store, strippedCamera: true };
  }
  return { store, strippedCamera: false };
}

function ensureStoreFile() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(createDefaultStore(), null, 2), "utf8");
  }
}

ensureStoreFile();
const persistence = createPersistence(dataDir);

function bootstrapPersistenceFromStore() {
  const store = readStore();
  const warnings = persistence.getWarnings();
  const events = persistence.getNfcEvents(1);
  if (!warnings.length && Array.isArray(store.warnings) && store.warnings.length) {
    persistence.replaceWarnings(store.warnings);
  }
  if (!events.length && Array.isArray(store.nfcEvents) && store.nfcEvents.length) {
    persistence.replaceNfcEvents(store.nfcEvents);
  }
}

bootstrapPersistenceFromStore();

function readStore() {
  ensureStoreFile();
  const raw = fs.readFileSync(dataFile, "utf8");
  const parsed = JSON.parse(raw);
  const { store, strippedCamera } = migrateStore(parsed);
  if (strippedCamera) {
    try {
      fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), "utf8");
    } catch {
      /* ignore persist errors */
    }
  }
  return store;
}

function writeStore(store) {
  const tmpFile = `${dataFile}.tmp`;
  const safeStore = {
    ...store,
    warnings: [],
    nfcEvents: []
  };
  fs.writeFileSync(tmpFile, JSON.stringify(safeStore, null, 2), "utf8");
  fs.renameSync(tmpFile, dataFile);
}

function nextUserId(store) {
  if (!store.users.length) return 1;
  return Math.max(...store.users.map((u) => u.id)) + 1;
}

function nextNfcId(store) {
  if (!store.nfc || !store.nfc.length) return 1;
  return Math.max(...store.nfc.map((r) => r.id || 0)) + 1;
}

function getSessionUser(req) {
  const store = readStore();
  if (!req.session.userId) return null;
  return store.users.find((u) => u.id === req.session.userId) || null;
}

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ success: false, message: "not authenticated" });
    return null;
  }
  return user;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    message: "Node demo is running",
    timestamp: new Date().toISOString()
  });
});

app.post("/api/auth/register", (req, res) => {
  const store = readStore();
  const { username, password, user_type = "personal" } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "username/password required" });
  }
  if (store.users.some((u) => u.username === username)) {
    return res.status(400).json({ success: false, message: "username already exists" });
  }
  if (!["personal", "company", "security"].includes(user_type)) {
    return res.status(400).json({ success: false, message: "invalid user_type" });
  }
  const user = {
    id: nextUserId(store),
    username,
    email: `${username}@demo.local`,
    password,
    userType: user_type
  };
  store.users.push(user);
  writeStore(store);
  return res.json({
    success: true,
    message: "register success",
    data: { username: user.username }
  });
});

app.post("/api/auth/login", (req, res) => {
  const store = readStore();
  const { username, password } = req.body || {};
  const user = store.users.find((u) => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ success: false, message: "invalid credentials" });
  req.session.userId = user.id;
  return res.json({
    success: true,
    message: "login success",
    data: { id: user.id, username: user.username, email: user.email, user_type: user.userType }
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true, message: "logout success" }));
});

app.get("/api/auth/verify", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, message: "not authenticated" });
  return res.json({
    success: true,
    message: "session valid",
    data: { id: user.id, username: user.username, email: user.email, user_type: user.userType }
  });
});

app.post("/api/auth/forgot-password", (req, res) => {
  const store = readStore();
  const { username } = req.body || {};
  const user = store.users.find((u) => u.username === username);
  if (!user) return res.status(404).json({ success: false, message: "username not found" });
  const token = `reset_${Date.now()}`;
  store.resetTokens[token] = user.username;
  writeStore(store);
  return res.json({ success: true, message: "reset token generated", data: { token_demo: token } });
});

app.post("/api/auth/reset-password", (req, res) => {
  const store = readStore();
  const { token, new_password } = req.body || {};
  const username = store.resetTokens[token];
  if (!username) return res.status(400).json({ success: false, message: "invalid token" });
  const user = store.users.find((u) => u.username === username);
  user.password = new_password;
  delete store.resetTokens[token];
  writeStore(store);
  return res.json({ success: true, message: "password reset success" });
});

app.post("/api/auth/change-password", (req, res) => {
  const store = readStore();
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, message: "not authenticated" });
  const { old_password, new_password } = req.body || {};
  if (user.password !== old_password) return res.status(400).json({ success: false, message: "old password incorrect" });
  const realUser = store.users.find((u) => u.id === user.id);
  realUser.password = new_password;
  writeStore(store);
  return res.json({ success: true, message: "password changed" });
});

app.get("/api/dashboard/warnings", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, message: "not authenticated" });
  return res.json({
    success: true,
    data: persistence.getWarnings()
  });
});

function requireAuthJson(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ success: false, message: "not authenticated" });
    return null;
  }
  return user;
}

function normalizeCardUid(uid) {
  return String(uid || "")
    .trim()
    .replace(/^0x/i, "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
}

function normalizePersonName(name) {
  return String(name || "")
    .trim()
    .replace(/_[0-9A-Fa-f]{8,}$/g, "")
    .replace(/[_\-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ===== ESP32 auto-discovery (mDNS) =====
const ESP32_MDNS_NAMES = ["iotswitch-esp32.local", "esp32-nfc.local"];
let cachedEsp32Base = null;
let cachedEsp32BaseAt = 0;

function ipv4FromAnswers(answers) {
  for (const a of answers || []) {
    if (a && a.type === "A" && typeof a.data === "string") return a.data;
  }
  return null;
}

function discoverEsp32BaseUrlViaMdns(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        mdns.removeListener("response", onResp);
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const onResp = (resp) => {
      const ip = ipv4FromAnswers(resp && resp.answers);
      if (!ip) return;
      finish(`http://${ip}/`);
    };
    mdns.on("response", onResp);

    // query each candidate name; stop on first valid A record response
    for (const name of ESP32_MDNS_NAMES) {
      try {
        mdns.query([{ name, type: "A" }]);
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => finish(null), Math.max(200, timeoutMs - (Date.now() - start)));
  });
}

function listLocalIPv4() {
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (!it || it.family !== "IPv4" || it.internal) continue;
      ips.push(it.address);
    }
  }
  return ips;
}

function ipPrefix24(ip) {
  const m = String(ip || "").match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}.`;
}

async function fetchJsonWithTimeout(url, ms, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function discoverEsp32BaseUrlViaSubnetScan() {
  // 扫描本机 IPv4 所在的 /24 网段，探测 http://x.x.x.{1..254}/health
  const ips = listLocalIPv4();
  const prefixes = Array.from(new Set(ips.map(ipPrefix24).filter(Boolean)));
  if (!prefixes.length) return null;

  const token = String(process.env.ESP32_SHARED_TOKEN || "").trim();
  const headers = token ? { "X-ESP32-Token": token } : undefined;

  const targets = [];
  for (const pref of prefixes) {
    for (let i = 1; i <= 254; i++) {
      targets.push(`${pref}${i}`);
    }
  }

  // 并发限制（避免把电脑/热点打爆）
  const CONCURRENCY = 32;
  let idx = 0;
  let found = null;

  async function worker() {
    while (!found && idx < targets.length) {
      const ip = targets[idx++];
      const j = await fetchJsonWithTimeout(`http://${ip}/health`, 350, headers);
      if (j && j.ok === true) {
        found = `http://${ip}/`;
        return;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  return found;
}

async function resolveEsp32BaseUrl() {
  const fromEnv = String(process.env.ESP32_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.endsWith("/") ? fromEnv : `${fromEnv}/`;

  const now = Date.now();
  if (cachedEsp32Base && now - cachedEsp32BaseAt < 30_000) return cachedEsp32Base;

  let found = await discoverEsp32BaseUrlViaMdns(1200);
  if (!found) {
    found = await discoverEsp32BaseUrlViaSubnetScan();
  }
  if (found) {
    cachedEsp32Base = found;
    cachedEsp32BaseAt = now;
    return found;
  }
  return null;
}

/**
 * ===== NFC (ESP32S3) integration (prototype) =====
 *
 * 约定：ESP32S3 在同一 WiFi（你热点 IoTSwitch）下提供 HTTP 接口：
 * - GET  {ESP32_BASE_URL}/nfc/read   -> { ok:true, card_uid:"A1B2C3D4" }
 *
 * 环境变量：
 * - ESP32_BASE_URL  (例如 http://192.168.137.50 或 http://192.168.4.2)
 * - ESP32_SHARED_TOKEN (可选；会以 header: X-ESP32-Token 发送)
 */
async function esp32Request(method, pathPart, body) {
  const base = await resolveEsp32BaseUrl();
  if (!base) {
    const err = new Error("ESP32 not found (set ESP32_BASE_URL or ensure mDNS name iotswitch-esp32.local)");
    err.statusCode = 503;
    throw err;
  }
  const url = new URL(pathPart, base.endsWith("/") ? base : `${base}/`);
  const token = String(process.env.ESP32_SHARED_TOKEN || "").trim();
  const headers = { Accept: "application/json" };
  if (token) headers["X-ESP32-Token"] = token;
  if (body) headers["Content-Type"] = "application/json";

  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!r.ok) {
    const baseMsg = (json && (json.error || json.message)) || text || `ESP32 request failed: ${r.status}`;
    const detail = json && json.detail ? ` (${json.detail})` : "";
    const hint = json && json.hint ? ` | hint: ${json.hint}` : "";
    const err = new Error(`${baseMsg}${detail}${hint}`);
    err.statusCode = 502;
    err.remoteStatus = r.status;
    err.remoteBody = json || text || null;
    throw err;
  }
  return json;
}

// Expose discovery status to UI
app.get("/api/esp32/status", async (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  try {
    const base = await resolveEsp32BaseUrl();
    return res.json({
      success: true,
      data: { base_url: base, mdns_names: ESP32_MDNS_NAMES, local_ipv4: listLocalIPv4() }
    });
  } catch (e) {
    return res.json({
      success: true,
      data: { base_url: null, mdns_names: ESP32_MDNS_NAMES, local_ipv4: listLocalIPv4(), error: e.message }
    });
  }
});

app.get("/api/nfc/list", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const store = readStore();
  return res.json({ success: true, data: store.nfc || [] });
});

app.get("/api/nfc/records", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const store = readStore();
  const events = persistence.getNfcEvents(200);
  const latestByCard = new Map();
  events.forEach((ev) => {
    const uid = normalizeCardUid(ev && ev.card_uid);
    if (!uid || latestByCard.has(uid)) return;
    latestByCard.set(uid, ev);
  });

  const records = (store.nfc || []).map((r) => {
    const uid = normalizeCardUid(r.card_uid);
    const ev = latestByCard.get(uid) || null;
    return {
      id: r.id,
      card_uid: uid,
      person: r.person || {},
      photo_url: r.photo_url || null,
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
      last_event: ev
        ? {
            at: ev.at || null,
            permission: Boolean(ev.permission),
            reason: ev.reason || null,
            face: ev.face || null
          }
        : null
    };
  });
  return res.json({ success: true, data: records });
});

// Registered people profile page source
app.get("/api/nfc/profiles", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const store = readStore();
  const profiles = (store.nfc || []).map((r) => ({
    id: r.id,
    card_uid: r.card_uid,
    person: r.person || {},
    photo_url: r.photo_url || null,
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
  return res.json({ success: true, data: profiles });
});

app.get("/api/nfc/events", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  return res.json({ success: true, data: persistence.getNfcEvents(200) });
});

// ---------- Face recognition integration (learned from IPCAMER scripts) ----------
const FACE_SERVICE_URL = String(process.env.FACE_SERVICE_URL || "http://127.0.0.1:8001/match").trim();
const FACE_DB_DIR = process.env.FACE_DB_DIR
  ? path.resolve(__dirname, process.env.FACE_DB_DIR)
  : path.resolve(__dirname, "..", "face", "facelib");
let faceAcceptScore = Number(process.env.FACE_ACCEPT_SCORE || 0.85);
const FACE_REQUEST_TIMEOUT_MS = Number(process.env.FACE_REQUEST_TIMEOUT_MS || 5000);

function clampFaceThreshold(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(0.99, Math.max(0.1, n));
}

app.get("/api/face/settings", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  return res.json({ success: true, data: { threshold: faceAcceptScore } });
});

app.post("/api/face/settings", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const threshold = clampFaceThreshold(req.body && req.body.threshold);
  if (threshold === null) {
    return res.status(400).json({ success: false, message: "threshold must be a number between 0.1 and 0.99" });
  }
  faceAcceptScore = threshold;
  return res.json({ success: true, message: "face threshold updated", data: { threshold: faceAcceptScore } });
});

async function runFaceRecognitionOnImage(imagePath, timeoutMs = FACE_REQUEST_TIMEOUT_MS) {
  if (!fs.existsSync(imagePath)) return { ok: false, reason: "image_not_found" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const resp = await fetch(FACE_SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        image_path: imagePath,
        faces_dir: FACE_DB_DIR,
        model_name: "r18"
      }),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      return { ok: false, reason: `face_service_http_${resp.status}`, detail: bodyText || null };
    }
    const parsed = await resp.json().catch(() => null);
    if (!parsed) return { ok: false, reason: "empty_face_result" };
    return parsed;
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, reason: "face_service_timeout" };
    return { ok: false, reason: e.message || "face_recognition_failed" };
  } finally {
    clearTimeout(timer);
  }
}

function addWarning(action, camera_ip = "usb-cam", status = "pending") {
  return persistence.appendWarning({ action, camera_ip, status });
}

async function notifyEsp32PermissionResult(allowed, reason) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      await esp32Request("POST", "nfc/permission-result", {
        allowed: Boolean(allowed),
        reason: reason || ""
      });
      return true;
    } catch (e) {
      lastErr = e;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  if (lastErr) {
    console.warn("[nfc] failed to notify ESP32 permission result:", lastErr.message || lastErr);
  }
  return false;
}

async function notifyEsp32Countdown(secondsLeft) {
  try {
    await esp32Request("POST", "nfc/permission-result", {
      stage: "countdown",
      seconds_left: Number(secondsLeft) || 0,
      status: "pending",
      // Backward-compatible hint for older firmware that defaults missing `allowed` to deny.
      allowed: true
    });
  } catch {
    // best effort only
  }
}

async function notifyEsp32Processing(label) {
  try {
    await esp32Request("POST", "nfc/permission-result", {
      stage: "processing",
      status: "pending",
      message: String(label || "Processing"),
      // Backward-compatible hint for older firmware that defaults missing `allowed` to deny.
      allowed: true
    });
  } catch {
    // best effort only
  }
}

async function processNfcSwipe(card_uid) {
  const store = readStore();

  const reg = (store.nfc || []).find((r) => normalizeCardUid(r.card_uid) === card_uid);
  nfcMonitor.live = {
    ...nfcMonitor.live,
    stage: "card_detected",
    card_uid,
    countdown: null,
    message: "Card detected",
    face_name: null,
    face_score: null,
    permission: null,
    reason: null,
    updated_at: new Date().toISOString()
  };
  await notifyEsp32Processing("Card detected");
  for (let sec = 3; sec >= 1; sec--) {
    nfcMonitor.live = {
      ...nfcMonitor.live,
      stage: "countdown",
      countdown: sec,
      message: `Capturing in ${sec}s`,
      updated_at: new Date().toISOString()
    };
    await notifyEsp32Countdown(sec);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  nfcMonitor.live = {
    ...nfcMonitor.live,
    stage: "matching_face",
    countdown: 0,
    message: "Matching face...",
    updated_at: new Date().toISOString()
  };
  await notifyEsp32Processing("Matching face");
  let shot = null;
  try {
    shot = await captureOneFrameToPublic();
  } catch {
    shot = null;
  }
  if (!shot && liveFrameCache.latest_path && Date.now() - liveFrameCache.updated_at < 15000) {
    shot = {
      url: liveFrameCache.latest_url,
      filename: path.basename(liveFrameCache.latest_path),
      source: "live-frame-cache"
    };
  }

  const faceImagePath =
    shot && shot.filename ? path.join(__dirname, "public", "captures", shot.filename) : liveFrameCache.latest_path || null;

  let face = { ok: false, reason: "no_snapshot" };
  if (faceImagePath) {
    face = await runFaceRecognitionOnImage(faceImagePath, 5000);
  }

  const registered = Boolean(reg);
  let permission = false;
  let reason = registered ? "face_verification_required" : "unregistered_card";
  const expectedName = reg && reg.person ? String(reg.person.name || "").trim() : "";
  const faceName = face && face.name ? String(face.name) : "";
  const faceScore = Number(face && typeof face.score !== "undefined" ? face.score : 0);
  const expectedNameNorm = normalizePersonName(expectedName);
  const faceNameNorm = normalizePersonName(faceName);
  if (!registered) {
    permission = false;
    reason = "unregistered_card";
  } else if (!faceImagePath) {
    permission = false;
    reason = "no_stream_frame";
  } else if (!face || !face.ok) {
    permission = false;
    reason = face && face.reason ? `face_service_${face.reason}` : "face_service_error";
  } else if (!faceName || faceName === "Unknown") {
    permission = false;
    reason = "face_unknown";
  } else if (faceScore < faceAcceptScore) {
    permission = false;
    reason = "face_score_too_low";
  } else if (expectedNameNorm && faceNameNorm !== expectedNameNorm) {
    permission = false;
    reason = "face_mismatch";
  } else {
    permission = true;
    reason = "registered_card_face_match";
  }
  nfcMonitor.live = {
    ...nfcMonitor.live,
    stage: "decision",
    message: permission ? "ALLOW" : "DENY",
    face_name: faceName || "Unknown",
    face_score: Number.isFinite(faceScore) ? faceScore : 0,
    permission: Boolean(permission),
    reason: reason || null,
    updated_at: new Date().toISOString()
  };

  if (!registered) {
    addWarning(`Unregistered NFC card used: ${card_uid}`);
  } else if (!permission) {
    addWarning(`Face mismatch for card ${card_uid} (expected ${expectedName}, got ${faceName || "Unknown"})`);
  }

  const ev = persistence.appendNfcEvent({
    card_uid,
    registered,
    permission,
    reason,
    person: reg ? reg.person || {} : null,
    expected_name: expectedName || null,
    face: face || null,
    photo_url: shot ? shot.url : liveFrameCache.latest_url || null,
    at: new Date().toISOString()
  });
  try {
    await esp32Request("POST", "nfc/permission-result", {
      allowed: Boolean(permission),
      reason: reason || "",
      name: faceName || "",
      score: Number(faceScore || 0),
      hold_ms: permission ? 5000 : 1800
    });
  } catch {
    await notifyEsp32PermissionResult(permission, reason);
  }
  if (permission) {
    // After ALLOW, pause new scan attempts briefly to avoid immediate re-trigger.
    nfcMonitor.pause_until_ms = Date.now() + 3000;
  }
  nfcMonitor.live = {
    ...nfcMonitor.live,
    stage: "done",
    countdown: null,
    updated_at: new Date().toISOString()
  };
  return ev;
}

// ---------- NFC standby monitor ----------
const nfcMonitor = {
  running: false,
  busy: false,
  timer: null,
  timeout_ms: 8000,
  tick_ms: 1200,
  pause_until_ms: 0,
  last_error: null,
  last_event_at: null,
  live: {
    stage: "idle",
    card_uid: null,
    countdown: null,
    message: "",
    face_name: null,
    face_score: null,
    permission: null,
    reason: null,
    updated_at: null
  }
};

const liveFrameCache = {
  latest_path: null,
  latest_url: null,
  updated_at: 0
};

async function nfcMonitorTick() {
  if (!nfcMonitor.running || nfcMonitor.busy) return;
  if (Date.now() < Number(nfcMonitor.pause_until_ms || 0)) return;
  nfcMonitor.busy = true;
  try {
    const out = await esp32Request("GET", `nfc/read?timeout_ms=${nfcMonitor.timeout_ms}&show_led=0`, null);
    const uid = normalizeCardUid(out && (out.card_uid || out.uid));
    if (uid) {
      await processNfcSwipe(uid);
      nfcMonitor.last_event_at = new Date().toISOString();
      nfcMonitor.last_error = null;
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : "");
    // timeouts are expected in standby mode; keep silent
    if (!/timeout_waiting_for_card/i.test(msg)) {
      nfcMonitor.last_error = msg || "monitor_read_failed";
    }
  } finally {
    nfcMonitor.busy = false;
  }
}

function startNfcMonitor() {
  if (nfcMonitor.running) return;
  nfcMonitor.running = true;
  nfcMonitor.timer = setInterval(nfcMonitorTick, nfcMonitor.tick_ms);
}

function stopNfcMonitor() {
  nfcMonitor.running = false;
  if (nfcMonitor.timer) clearInterval(nfcMonitor.timer);
  nfcMonitor.timer = null;
}

app.post("/api/nfc/monitor/start", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const { timeout_ms, tick_ms } = req.body || {};
  if (Number(timeout_ms) > 1000) nfcMonitor.timeout_ms = Number(timeout_ms);
  if (Number(tick_ms) > 200) nfcMonitor.tick_ms = Number(tick_ms);
  stopNfcMonitor();
  startNfcMonitor();
  return res.json({ success: true, data: { ...nfcMonitor, timer: undefined } });
});

app.post("/api/nfc/monitor/stop", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  stopNfcMonitor();
  return res.json({ success: true, data: { ...nfcMonitor, timer: undefined } });
});

app.get("/api/nfc/monitor/status", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  return res.json({ success: true, data: { ...nfcMonitor, timer: undefined } });
});

app.post("/api/nfc/read", async (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  try {
    const out = await esp32Request("GET", "nfc/read?show_led=1", null);
    const card_uid = normalizeCardUid(out && (out.card_uid || out.uid));
    if (!card_uid) return res.status(502).json({ success: false, message: "ESP32 did not return card_uid" });
    return res.json({ success: true, data: { card_uid } });
  } catch (e) {
    return res.status(e.statusCode || 503).json({
      success: false,
      message: e.message || "nfc read failed",
      detail: e.remoteBody || null
    });
  }
});

app.post("/api/nfc/pair", async (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;

  const { person, card_uid: cardUidFromClient, auto_read = true, capture = false } = req.body || {};
  const store = readStore();
  if (!store.nfc) store.nfc = [];

  const safePerson = {
    name: String(person && person.name ? person.name : "").trim(),
    phone: String(person && person.phone ? person.phone : "").trim(),
    email: String(person && person.email ? person.email : "").trim(),
    note: String(person && person.note ? person.note : "").trim()
  };
  if (!safePerson.name) {
    return res.status(400).json({ success: false, message: "person.name required" });
  }

  let card_uid = normalizeCardUid(cardUidFromClient);
  if (auto_read && !card_uid) {
    try {
      const out = await esp32Request("GET", "nfc/read?show_led=1", null);
      card_uid = normalizeCardUid(out && (out.card_uid || out.uid));
    } catch (e) {
      return res.status(e.statusCode || 503).json({
        success: false,
        message: e.message || "ESP32 nfc read failed",
        detail: e.remoteBody || null
      });
    }
  }
  if (!card_uid) {
    return res.status(400).json({ success: false, message: "card_uid required (or enable auto_read with ESP32)" });
  }

  const existing = store.nfc.find((r) => normalizeCardUid(r.card_uid) === card_uid);
  const now = new Date().toISOString();
  const record = existing || {
    id: nextNfcId(store),
    card_uid,
    person: {},
    photo_url: null,
    created_at: now,
    updated_at: now
  };
  record.person = safePerson;
  record.updated_at = now;
  if (!existing) store.nfc.unshift(record);

  // optional capture right after pairing
  if (capture) {
    try {
      const cap = await captureOneFrameToPublic();
      record.photo_url = cap.url;
      record.updated_at = new Date().toISOString();
    } catch (e) {
      // do not fail pairing if camera busy; surface message in response
      writeStore(store);
      return res.json({ success: true, message: `paired (capture failed: ${e.message})`, data: record });
    }
  }

  writeStore(store);
  return res.json({ success: true, message: "paired", data: record });
});

app.post("/api/nfc/photo", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const { card_uid, photo_url } = req.body || {};
  const uid = normalizeCardUid(card_uid);
  if (!uid || !photo_url) {
    return res.status(400).json({ success: false, message: "card_uid and photo_url required" });
  }
  const store = readStore();
  if (!store.nfc) store.nfc = [];
  const rec = store.nfc.find((r) => normalizeCardUid(r.card_uid) === uid);
  if (!rec) return res.status(404).json({ success: false, message: "nfc record not found" });
  rec.photo_url = String(photo_url);
  // Persist captured profile face into face library for recognition.
  // photo_url is expected like /captures/<filename>.jpg
  const m = String(photo_url).match(/^\/captures\/(.+)$/);
  if (m) {
    const srcPath = path.join(__dirname, "public", "captures", m[1]);
    if (fs.existsSync(srcPath)) {
      const personName = rec.person && rec.person.name ? rec.person.name : uid;
      const faceStem = safeFileStem(personName) || uid;
      const faceName = `${faceStem}_${uid}.jpg`;
      const dstPath = path.join(ensureFacesDir(), faceName);
      try {
        fs.copyFileSync(srcPath, dstPath);
        rec.person = rec.person || {};
        rec.person.face_file = faceName;
      } catch {
        // non-fatal; keep profile photo even if face library copy fails
      }
    }
  }
  rec.updated_at = new Date().toISOString();
  writeStore(store);
  return res.json({ success: true, data: rec });
});

app.delete("/api/nfc/profile/:card_uid", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  try {
    const uid = normalizeCardUid(req.params.card_uid);
    if (!uid) return res.status(400).json({ success: false, message: "card_uid required" });

    const store = readStore();
    if (!store.nfc) store.nfc = [];
    const idx = store.nfc.findIndex((r) => normalizeCardUid(r.card_uid) === uid);
    if (idx < 0) return res.status(404).json({ success: false, message: "nfc profile not found" });

    const rec = store.nfc[idx];
    const faceFile = rec && rec.person && rec.person.face_file ? String(rec.person.face_file) : "";
    if (faceFile) {
      const facePath = path.join(ensureFacesDir(), faceFile);
      if (fs.existsSync(facePath)) {
        try {
          fs.unlinkSync(facePath);
        } catch {
          /* ignore file delete errors */
        }
      }
    }

    store.nfc.splice(idx, 1);
    writeStore(store);
    return res.json({ success: true, message: "profile deleted", data: { card_uid: uid } });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || "profile delete failed" });
  }
});

/**
 * ===== USB 摄像头抓拍（单帧 JPEG）=====
 */
function ensureCapturesDir() {
  const dir = path.join(__dirname, "public", "captures");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureFacesDir() {
  const dir = FACE_DB_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeFileStem(s) {
  return String(s || "")
    .trim()
    .replace(/[^\w\-.\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function resolveWindowsSnapshotDevice() {
  const fromEnv = String(process.env.USB_VIDEO_DEVICE || "").trim();
  if (fromEnv) return fromEnv;
  const detected = getWindowsVideoDeviceName();
  if (detected) return detected;
  return null;
}

function captureOneFrameJpeg(outPath) {
  if (!ffmpegStatic) throw new Error("ffmpeg-static not available");
  const plat = process.platform;
  const w = Number(process.env.STREAM_WIDTH) || 640;
  const h = Number(process.env.STREAM_HEIGHT) || 480;
  const sizeStr = `${w}x${h}`;

  let argv;
  if (plat === "win32") {
    const dev = resolveWindowsSnapshotDevice();
    if (!dev) throw new Error("未检测到摄像头；请连接 USB 摄像头或设置 USB_VIDEO_DEVICE");
    argv = [
      ffmpegStatic,
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "dshow",
      "-video_size",
      sizeStr,
      "-i",
      `video=${dev}`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outPath
    ];
  } else if (plat === "linux") {
    const dev = String(process.env.USB_VIDEO_DEVICE || "/dev/video0").trim();
    argv = [
      ffmpegStatic,
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "v4l2",
      "-video_size",
      sizeStr,
      "-i",
      dev,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outPath
    ];
  } else {
    throw new Error(`snapshot unsupported platform: ${plat}`);
  }

  return new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `ffmpeg exited: ${code}`));
    });
  });
}

async function captureOneFrameToPublic() {
  const dir = ensureCapturesDir();
  const filename = `cap_${Date.now()}.jpg`;
  const outPath = path.join(dir, filename);
  await captureOneFrameJpeg(outPath);
  return { url: `/captures/${filename}`, filename };
}

app.post("/api/capture", async (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  try {
    const cap = await captureOneFrameToPublic();
    return res.json({ success: true, data: cap });
  } catch (e) {
    return res.status(503).json({ success: false, message: e.message || "capture failed" });
  }
});

// Browser-side frame upload fallback: avoids reopening camera device while stream is active.
app.post("/api/capture/frame", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const { image_base64 } = req.body || {};
  if (!image_base64 || typeof image_base64 !== "string") {
    return res.status(400).json({ success: false, message: "image_base64 required" });
  }

  const m = image_base64.match(/^data:image\/jpeg;base64,(.+)$/);
  if (!m) {
    return res.status(400).json({ success: false, message: "only data:image/jpeg;base64 supported" });
  }

  try {
    const dir = ensureCapturesDir();
    const filename = `cap_${Date.now()}_frame.jpg`;
    const outPath = path.join(dir, filename);
    fs.writeFileSync(outPath, Buffer.from(m[1], "base64"));
    return res.json({ success: true, data: { url: `/captures/${filename}`, filename, source: "frame-upload" } });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || "save frame failed" });
  }
});

// Run face recognition immediately on an uploaded frame (for live testing UI).
app.post("/api/face/recognize", async (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const { image_base64 } = req.body || {};
  if (!image_base64 || typeof image_base64 !== "string") {
    return res.status(400).json({ success: false, message: "image_base64 required" });
  }

  const m = image_base64.match(/^data:image\/jpeg;base64,(.+)$/);
  if (!m) {
    return res.status(400).json({ success: false, message: "only data:image/jpeg;base64 supported" });
  }

  try {
    const dir = ensureCapturesDir();
    const filename = `face_test_${Date.now()}.jpg`;
    const outPath = path.join(dir, filename);
    fs.writeFileSync(outPath, Buffer.from(m[1], "base64"));

    const face = await runFaceRecognitionOnImage(outPath);
    return res.json({
      success: true,
      data: {
        face: face || null,
        capture_url: `/captures/${filename}`
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || "face recognize failed" });
  }
});

app.post("/api/stream/frame-cache", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  const { image_base64 } = req.body || {};
  if (!image_base64 || typeof image_base64 !== "string") {
    return res.status(400).json({ success: false, message: "image_base64 required" });
  }
  const m = image_base64.match(/^data:image\/jpeg;base64,(.+)$/);
  if (!m) {
    return res.status(400).json({ success: false, message: "only data:image/jpeg;base64 supported" });
  }
  try {
    const dir = ensureCapturesDir();
    const filename = `live_${Date.now()}.jpg`;
    const outPath = path.join(dir, filename);
    fs.writeFileSync(outPath, Buffer.from(m[1], "base64"));
    liveFrameCache.latest_path = outPath;
    liveFrameCache.latest_url = `/captures/${filename}`;
    liveFrameCache.updated_at = Date.now();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || "save live frame failed" });
  }
});

// Register permitted person: fill info + read NFC + capture face image
app.post("/api/permitted/register", async (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  try {
    const { person, card_uid: cardUidFromClient, image_base64 } = req.body || {};
    const safePerson = {
      name: String(person && person.name ? person.name : "").trim(),
      phone: String(person && person.phone ? person.phone : "").trim(),
      email: String(person && person.email ? person.email : "").trim(),
      note: String(person && person.note ? person.note : "").trim()
    };
    if (!safePerson.name) {
      return res.status(400).json({ success: false, message: "person.name required" });
    }
    if (!image_base64 || typeof image_base64 !== "string") {
      return res.status(400).json({ success: false, message: "image_base64 required" });
    }

    let card_uid = normalizeCardUid(cardUidFromClient);
    if (!card_uid) {
      const out = await esp32Request("GET", "nfc/read?show_led=1", null);
      card_uid = normalizeCardUid(out && (out.card_uid || out.uid));
    }
    if (!card_uid) return res.status(400).json({ success: false, message: "unable to read card_uid" });

    const m = image_base64.match(/^data:image\/jpeg;base64,(.+)$/);
    if (!m) {
      return res.status(400).json({ success: false, message: "only data:image/jpeg;base64 supported" });
    }

    const facesDir = ensureFacesDir();
    const faceStem = safeFileStem(safePerson.name) || "person";
    const faceName = `${faceStem}_${card_uid}.jpg`;
    const facePath = path.join(facesDir, faceName);
    fs.writeFileSync(facePath, Buffer.from(m[1], "base64"));

    const captureDir = ensureCapturesDir();
    const previewName = `profile_${Date.now()}_${card_uid}.jpg`;
    const previewPath = path.join(captureDir, previewName);
    fs.writeFileSync(previewPath, Buffer.from(m[1], "base64"));
    const previewUrl = `/captures/${previewName}`;

    const store = readStore();
    if (!store.nfc) store.nfc = [];
    const now = new Date().toISOString();
    const existing = store.nfc.find((r) => normalizeCardUid(r.card_uid) === card_uid);
    const rec =
      existing ||
      ({
        id: nextNfcId(store),
        card_uid,
        person: {},
        photo_url: null,
        created_at: now,
        updated_at: now
      });
    rec.person = { ...safePerson, permitted: true, face_file: faceName };
    rec.photo_url = previewUrl;
    rec.updated_at = now;
    if (!existing) store.nfc.unshift(rec);
    writeStore(store);

    return res.json({
      success: true,
      message: "permitted profile registered",
      data: { card_uid, profile: rec, face_db_file: faceName, preview_url: previewUrl }
    });
  } catch (e) {
    return res.status(503).json({ success: false, message: e.message || "register permitted failed" });
  }
});

// Update existing profile info and optionally recap photo/face file.
app.post("/api/nfc/profile/update", (req, res) => {
  const user = requireAuthJson(req, res);
  if (!user) return;
  try {
    const { card_uid, person, image_base64 } = req.body || {};
    const uid = normalizeCardUid(card_uid);
    if (!uid) {
      return res.status(400).json({ success: false, message: "card_uid required" });
    }

    const store = readStore();
    if (!store.nfc) store.nfc = [];
    const rec = store.nfc.find((r) => normalizeCardUid(r.card_uid) === uid);
    if (!rec) {
      return res.status(404).json({ success: false, message: "nfc profile not found" });
    }

    const old = rec.person || {};
    const safePerson = {
      name: String((person && person.name) || old.name || "").trim(),
      phone: String((person && person.phone) || "").trim(),
      email: String((person && person.email) || "").trim(),
      note: String((person && person.note) || "").trim(),
      permitted: old.permitted !== false,
      face_file: old.face_file || null
    };
    if (!safePerson.name) {
      return res.status(400).json({ success: false, message: "person.name required" });
    }
    rec.person = safePerson;

    let preview_url = null;
    let face_db_file = safePerson.face_file || null;
    if (image_base64) {
      const m = String(image_base64).match(/^data:image\/jpeg;base64,(.+)$/);
      if (!m) {
        return res.status(400).json({ success: false, message: "only data:image/jpeg;base64 supported" });
      }
      const buffer = Buffer.from(m[1], "base64");
      const captureDir = ensureCapturesDir();
      const previewName = `profile_${Date.now()}_${uid}.jpg`;
      const previewPath = path.join(captureDir, previewName);
      fs.writeFileSync(previewPath, buffer);
      preview_url = `/captures/${previewName}`;
      rec.photo_url = preview_url;

      const facesDir = ensureFacesDir();
      const faceStem = safeFileStem(safePerson.name) || "person";
      const faceName = `${faceStem}_${uid}.jpg`;
      const facePath = path.join(facesDir, faceName);
      fs.writeFileSync(facePath, buffer);
      rec.person.face_file = faceName;
      face_db_file = faceName;
    }

    rec.updated_at = new Date().toISOString();
    writeStore(store);
    return res.json({
      success: true,
      message: "profile updated",
      data: { profile: rec, preview_url, face_db_file }
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || "profile update failed" });
  }
});

/**
 * USB 摄像头 → multipart MJPEG（ffmpeg-static 子进程，640×480 @ 15fps）。
 * Windows 未设置 USB_VIDEO_DEVICE 时会自动枚举首个 (video) 设备。
 */
const streamHub = {
  proc: null,
  clients: new Set()
};

function stopSharedStream() {
  if (!streamHub.proc) return;
  try {
    if (!streamHub.proc.killed) {
      streamHub.proc.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  }
  streamHub.proc = null;
}

function startSharedStream() {
  if (streamHub.proc && !streamHub.proc.killed) return streamHub.proc;
  const proc = startMjpegChildProcess();
  streamHub.proc = proc;

  proc.stderr.on("data", (d) => {
    const t = d.toString();
    if (/error|Error|failed|Failed|Cannot|could not/i.test(t)) {
      console.error("[stream] ffmpeg:", t.trim());
    }
  });

  proc.stdout.on("data", (chunk) => {
    for (const client of streamHub.clients) {
      try {
        if (!client.writableEnded) client.write(chunk);
      } catch {
        try {
          client.end();
        } catch {
          /* ignore */
        }
        streamHub.clients.delete(client);
      }
    }
  });

  const closeClients = () => {
    for (const client of streamHub.clients) {
      try {
        if (!client.writableEnded) client.end();
      } catch {
        /* ignore */
      }
    }
    streamHub.clients.clear();
    streamHub.proc = null;
  };

  proc.on("error", (err) => {
    console.error("[stream] 进程错误:", err && err.message);
    closeClients();
  });

  proc.on("close", (code) => {
    if (code && code !== 0 && code !== null) {
      console.warn("[stream] ffmpeg 退出码:", code);
    }
    closeClients();
  });

  return proc;
}

app.get("/api/stream", (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).type("text/plain").send("not authenticated");
  }

  try {
    startSharedStream();
  } catch (err) {
    console.error("[stream] 启动失败:", err && err.message);
    return res.status(503).type("text/plain").send(String((err && err.message) || "stream unavailable"));
  }

  // 须与 ffmpeg mpjpeg 多路输出一致（新版默认为 boundary=ffmpeg，而非 ffserver）
  res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=ffmpeg");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  streamHub.clients.add(res);
  const detach = () => {
    streamHub.clients.delete(res);
    if (streamHub.clients.size === 0) stopSharedStream();
  };
  req.on("close", detach);
  req.on("aborted", detach);
});

// Dev-only management endpoints for JSON store
app.get("/api/dev/store", (_req, res) => {
  const store = readStore();
  const safeUsers = store.users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    userType: u.userType
  }));
  return res.json({
    success: true,
    data: {
      users: safeUsers,
      resetTokens: store.resetTokens,
      nfc: store.nfc || [],
      warnings: persistence.getWarnings()
    }
  });
});

app.post("/api/dev/warnings", (_req, res) => {
  const { action, camera_ip = "192.168.0.136", status = "pending" } = _req.body || {};
  if (!action) return res.status(400).json({ success: false, message: "action is required" });
  const warning = persistence.appendWarning({ action, camera_ip, status });
  return res.json({ success: true, message: "warning added", data: warning });
});

app.delete("/api/dev/warnings/:id", (req, res) => {
  const id = Number(req.params.id);
  const removed = persistence.deleteWarningById(id);
  if (!removed) {
    return res.status(404).json({ success: false, message: "warning not found" });
  }
  return res.json({ success: true, message: "warning removed" });
});

app.delete("/api/dev/tokens/reset", (_req, res) => {
  const store = readStore();
  store.resetTokens = {};
  writeStore(store);
  return res.json({ success: true, message: "all reset tokens cleared" });
});

app.post("/api/dev/reset-store", (_req, res) => {
  const resetStore = createDefaultStore();
  persistence.replaceWarnings(resetStore.warnings || []);
  persistence.replaceNfcEvents(resetStore.nfcEvents || []);
  resetStore.warnings = [];
  resetStore.nfcEvents = [];
  writeStore(resetStore);
  return res.json({ success: true, message: "store reset to defaults", data: resetStore });
});

app.get("/", (_req, res) => {
  res.redirect("/login");
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/face-test", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "face_test.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.listen(PORT, () => {
  console.log(`Demo website: http://localhost:${PORT}`);
  if (String(process.env.AUTO_START_NFC_MONITOR || "1") !== "0") {
    startNfcMonitor();
    console.log("[nfc-monitor] auto started");
  }
});
