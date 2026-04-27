const path = require("path");
const Database = require("better-sqlite3");

function createPersistence(dataDir) {
  const dbPath = path.join(dataDir, "events.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      camera_ip TEXT NOT NULL,
      status TEXT NOT NULL,
      time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nfc_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_uid TEXT NOT NULL,
      registered INTEGER NOT NULL,
      permission INTEGER NOT NULL,
      reason TEXT,
      person_json TEXT,
      expected_name TEXT,
      face_json TEXT,
      photo_url TEXT,
      at TEXT NOT NULL
    );
  `);

  const selectWarningsStmt = db.prepare("SELECT id, action, camera_ip, status, time FROM warnings ORDER BY id DESC");
  const insertWarningStmt = db.prepare(
    "INSERT INTO warnings(action, camera_ip, status, time) VALUES (@action, @camera_ip, @status, @time)"
  );
  const deleteWarningStmt = db.prepare("DELETE FROM warnings WHERE id = ?");
  const clearWarningsStmt = db.prepare("DELETE FROM warnings");

  const selectNfcEventsStmt = db.prepare(
    "SELECT id, card_uid, registered, permission, reason, person_json, expected_name, face_json, photo_url, at FROM nfc_events ORDER BY id DESC LIMIT ?"
  );
  const insertNfcEventStmt = db.prepare(
    `INSERT INTO nfc_events(card_uid, registered, permission, reason, person_json, expected_name, face_json, photo_url, at)
     VALUES (@card_uid, @registered, @permission, @reason, @person_json, @expected_name, @face_json, @photo_url, @at)`
  );
  const clearNfcEventsStmt = db.prepare("DELETE FROM nfc_events");
  const pruneNfcEventsStmt = db.prepare(`
    DELETE FROM nfc_events
    WHERE id NOT IN (SELECT id FROM nfc_events ORDER BY id DESC LIMIT @keep_count)
  `);

  function parseJsonSafe(text, fallback) {
    try {
      return text ? JSON.parse(text) : fallback;
    } catch {
      return fallback;
    }
  }

  function rowToNfcEvent(row) {
    return {
      id: row.id,
      card_uid: row.card_uid,
      registered: Boolean(row.registered),
      permission: Boolean(row.permission),
      reason: row.reason || null,
      person: parseJsonSafe(row.person_json, null),
      expected_name: row.expected_name || null,
      face: parseJsonSafe(row.face_json, null),
      photo_url: row.photo_url || null,
      at: row.at
    };
  }

  return {
    getWarnings() {
      return selectWarningsStmt.all();
    },
    appendWarning({ action, camera_ip = "usb-cam", status = "pending", time }) {
      const at = time || new Date().toISOString();
      const info = insertWarningStmt.run({
        action: String(action || "").trim(),
        camera_ip: String(camera_ip || "usb-cam"),
        status: String(status || "pending"),
        time: at
      });
      return {
        id: Number(info.lastInsertRowid),
        action: String(action || "").trim(),
        camera_ip: String(camera_ip || "usb-cam"),
        status: String(status || "pending"),
        time: at
      };
    },
    deleteWarningById(id) {
      const info = deleteWarningStmt.run(Number(id));
      return info.changes > 0;
    },
    replaceWarnings(rows) {
      const tx = db.transaction((items) => {
        clearWarningsStmt.run();
        for (const item of items || []) {
          insertWarningStmt.run({
            action: String(item.action || "").trim(),
            camera_ip: String(item.camera_ip || "usb-cam"),
            status: String(item.status || "pending"),
            time: item.time || new Date().toISOString()
          });
        }
      });
      tx(rows || []);
    },
    getNfcEvents(limit = 200) {
      return selectNfcEventsStmt.all(Number(limit) || 200).map(rowToNfcEvent);
    },
    appendNfcEvent(event) {
      const data = {
        card_uid: String(event.card_uid || ""),
        registered: event.registered ? 1 : 0,
        permission: event.permission ? 1 : 0,
        reason: event.reason || null,
        person_json: JSON.stringify(event.person || null),
        expected_name: event.expected_name || null,
        face_json: JSON.stringify(event.face || null),
        photo_url: event.photo_url || null,
        at: event.at || new Date().toISOString()
      };
      const info = insertNfcEventStmt.run(data);
      pruneNfcEventsStmt.run({ keep_count: 200 });
      return { id: Number(info.lastInsertRowid), ...event, at: data.at };
    },
    replaceNfcEvents(rows) {
      const tx = db.transaction((items) => {
        clearNfcEventsStmt.run();
        for (const event of items || []) {
          insertNfcEventStmt.run({
            card_uid: String(event.card_uid || ""),
            registered: event.registered ? 1 : 0,
            permission: event.permission ? 1 : 0,
            reason: event.reason || null,
            person_json: JSON.stringify(event.person || null),
            expected_name: event.expected_name || null,
            face_json: JSON.stringify(event.face || null),
            photo_url: event.photo_url || null,
            at: event.at || new Date().toISOString()
          });
        }
      });
      tx(rows || []);
    }
  };
}

module.exports = {
  createPersistence
};
