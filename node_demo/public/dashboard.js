const sections = ["stream", "nfc", "enroll", "profiles", "logs", "settings", "warnings"];
const logsList = document.getElementById("logs-list");
const warningsList = document.getElementById("warnings-list");
const warningModal = document.getElementById("warning-modal");
const warningModalBody = document.getElementById("warning-modal-body");
const captureCountdownModal = document.getElementById("capture-countdown-modal");
const captureCountdownText = document.getElementById("capture-countdown-text");
const capturePreviewStream = document.getElementById("capture-preview-stream");
const captureCountdownCancelBtn = document.getElementById("capture-countdown-cancel-btn");

async function verifySession() {
  const res = await fetch("/api/auth/verify", { credentials: "include" });
  const data = await res.json();
  if (!data.success) {
    window.location.href = "/login";
    return null;
  }
  return data.data;
}

function setupLiveStream() {
  const img = document.getElementById("live-stream");
  const msg = document.getElementById("stream-status");
  if (!img) return;
  // Same-origin GET; browser includes session cookie automatically.
  img.addEventListener("load", () => {
    if (msg) msg.textContent = "";
  });
  img.addEventListener("error", () => {
    if (msg) {
      msg.textContent =
        "Stream failed to load: confirm login, set USB_VIDEO_DEVICE on Windows, and ensure camera is available.";
    }
  });
  img.src = `/api/stream?t=${Date.now()}`;
}

function stopLiveStream() {
  const img = document.getElementById("live-stream");
  if (!img) return;
  img.removeAttribute("src");
  img.src = "";
}

function setupTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.dataset.section;
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      sections.forEach((s) => {
        document.getElementById(`${s}-section`).classList.toggle("active", s === section);
      });
    });
  });
}

function el(id) {
  return document.getElementById(id);
}

function setNfcStatus(text) {
  const n = el("nfc-status");
  if (n) n.textContent = text || "";
}

function setEnrollStatus(text) {
  const n = el("enroll-status");
  if (n) n.textContent = text || "";
}

function setSettingsStatus(text) {
  const n = el("settings-status");
  if (n) n.textContent = text || "";
}

function setFaceThresholdStatus(text) {
  const n = el("face-threshold-status");
  if (n) n.textContent = text || "";
}

function setProfilesStatus(text) {
  const n = el("profiles-status");
  if (n) n.textContent = text || "";
}

function setFaceRecognizeStatus(text) {
  const n = el("face-recognize-status");
  if (n) n.textContent = text || "";
}

function setFaceRecognizeResult(text) {
  const n = el("face-recognize-result");
  if (n) n.textContent = text || "";
}

function setNfcLiveStatus(text) {
  const n = el("nfc-live-status");
  if (n) n.textContent = text || "";
}

function setNfcLiveResult(text) {
  const n = el("nfc-live-result");
  if (n) n.textContent = text || "";
}

function setStreamLiveOverlay(show, title, subtitle) {
  const overlay = el("stream-live-overlay");
  const titleEl = el("stream-live-overlay-title");
  const subtitleEl = el("stream-live-overlay-subtitle");
  if (!overlay) return;
  overlay.classList.toggle("show", Boolean(show));
  if (titleEl) titleEl.textContent = title || "Verifying...";
  if (subtitleEl) subtitleEl.textContent = subtitle || "";
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCaptureCountdown(seconds = 5) {
  if (!captureCountdownModal) return true;
  const streamImg = el("live-stream");
  if (capturePreviewStream) {
    capturePreviewStream.src = streamImg && streamImg.src ? streamImg.src : "";
  }
  captureCountdownModal.classList.add("show");
  captureCountdownModal.setAttribute("aria-hidden", "false");

  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
  };
  if (captureCountdownCancelBtn) {
    captureCountdownCancelBtn.addEventListener("click", onCancel, { once: true });
  }

  try {
    for (let left = seconds; left > 0; left--) {
      if (captureCountdownText) {
        captureCountdownText.textContent = `Capturing current frame, please get ready. Auto capture in ${left} second(s).`;
      }
      await waitMs(1000);
      if (cancelled) return false;
    }
    if (captureCountdownText) {
      captureCountdownText.textContent = "Capturing now, please hold still...";
    }
    await waitMs(350);
    return !cancelled;
  } finally {
    captureCountdownModal.classList.remove("show");
    captureCountdownModal.setAttribute("aria-hidden", "true");
    if (capturePreviewStream) capturePreviewStream.src = "";
  }
}

function formatApiError(data, fallback) {
  if (!data) return fallback;
  const msg = data.message || fallback;
  const d = data.detail;
  if (!d) return msg;
  if (typeof d === "string") return `${msg} | ${d}`;
  if (d && typeof d === "object") {
    const bits = [];
    if (d.error) bits.push(`error=${d.error}`);
    if (d.detail) bits.push(`detail=${d.detail}`);
    if (d.hint) bits.push(`hint=${d.hint}`);
    return bits.length ? `${msg} | ${bits.join(" ; ")}` : msg;
  }
  return msg;
}

function renderNfcList(items) {
  const ul = el("nfc-list");
  if (!ul) return;
  ul.innerHTML = "";
  if (!items || !items.length) {
    const li = document.createElement("li");
    li.textContent = "No paired records";
    ul.appendChild(li);
    return;
  }
  items.forEach((r) => {
    const li = document.createElement("li");
    const person = r.person || {};
    const who = person.name || "Unnamed";
    const phone = person.phone || "-";
    const email = person.email || "-";
    const note = person.note || "-";
    const updated = r.updated_at ? new Date(r.updated_at).toLocaleString() : "-";
    const last = r.last_event || null;
    const lastAt = last && last.at ? new Date(last.at).toLocaleString() : "-";
    const permission = last ? (last.permission ? "ALLOW" : "DENY") : "N/A";
    const reason = last && last.reason ? last.reason : "-";
    const faceObj = last && last.face ? last.face : null;
    const faceResult =
      faceObj && faceObj.ok
        ? `${faceObj.name || "Unknown"} (${Number(faceObj.score || 0).toFixed(3)})`
        : `N/A${faceObj && faceObj.reason ? ` (${faceObj.reason})` : ""}`;
    li.innerHTML = `
      <strong>${r.card_uid || "-"}</strong><br />
      Name: ${who} | Phone: ${phone} | Email: ${email}<br />
      Note: ${note}<br />
      Updated: ${updated}<br />
      Last Event: ${lastAt} | Face: ${faceResult} | Permission: ${permission} | Reason: ${reason}
    `;
    ul.appendChild(li);
  });
}

function renderProfiles(items) {
  const container = el("profiles-list");
  if (!container) return;
  container.innerHTML = "";
  if (!items || !items.length) {
    const empty = document.createElement("div");
    empty.className = "profiles-empty muted";
    empty.textContent = "No registered profiles";
    container.appendChild(empty);
    return;
  }

  items.forEach((r) => {
    const card = document.createElement("article");
    card.className = "profile-card";

    const p = r.person || {};
    const name = p.name || "Unnamed";
    const phone = p.phone || "-";
    const email = p.email || "-";
    const note = p.note || "-";
    const updated = r.updated_at ? new Date(r.updated_at).toLocaleString() : "-";
    const imgSrc = r.photo_url || "";
    const cardUid = r.card_uid || "";
    const safeName = String(p.name || "").replace(/"/g, "&quot;");
    const safePhone = String(p.phone || "").replace(/"/g, "&quot;");
    const safeEmail = String(p.email || "").replace(/"/g, "&quot;");
    const safeNote = String(p.note || "").replace(/"/g, "&quot;");

    card.innerHTML = `
      <div class="profile-photo-wrap">
        ${
          imgSrc
            ? `<img class="profile-photo" src="${imgSrc}?t=${Date.now()}" alt="${name}" />`
            : `<div class="profile-photo placeholder">No Photo</div>`
        }
      </div>
      <div class="profile-content">
        <div class="profile-header">
          <h4>${name}</h4>
          <span class="badge ${p.permitted ? "ok" : "warn"}">${p.permitted ? "PERMITTED" : "PENDING"}</span>
        </div>
        <p><strong>Card UID:</strong> ${r.card_uid || "-"}</p>
        <p><strong>Phone:</strong> <span data-view="phone">${phone}</span></p>
        <p><strong>Email:</strong> <span data-view="email">${email}</span></p>
        <p><strong>Note:</strong> <span data-view="note">${note}</span></p>
        <p class="muted"><strong>Updated:</strong> ${updated}</p>
        <div class="profile-actions">
          <button class="btn-ghost" type="button" data-action="edit" data-card-uid="${cardUid}">Edit</button>
          <button class="btn-ghost" type="button" data-action="delete-profile" data-card-uid="${cardUid}">Delete</button>
        </div>
        <div class="profile-edit-form" data-edit-form hidden>
          <div>
            <label>Name</label>
            <input data-field="name" value="${safeName}" />
          </div>
          <div>
            <label>Phone</label>
            <input data-field="phone" value="${safePhone}" />
          </div>
          <div>
            <label>Email</label>
            <input data-field="email" value="${safeEmail}" />
          </div>
          <div>
            <label>Note</label>
            <input data-field="note" value="${safeNote}" />
          </div>
          <div class="profile-edit-actions">
            <button class="btn-ghost" type="button" data-action="cancel-edit">Cancel</button>
            <button class="btn-ghost" type="button" data-action="save-profile" data-card-uid="${cardUid}">Save Profile</button>
            <button class="btn-primary" type="button" data-action="save-profile-photo" data-card-uid="${cardUid}">Save + Retake</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function readProfileForm(card) {
  const getField = (name) => String(card.querySelector(`[data-field="${name}"]`)?.value || "").trim();
  return {
    name: getField("name"),
    phone: getField("phone"),
    email: getField("email"),
    note: getField("note")
  };
}

async function updateProfileFromCard(card, withPhoto) {
  const uidBtn = card.querySelector(`[data-action="${withPhoto ? "save-profile-photo" : "save-profile"}"]`);
  const cardUid = String(uidBtn?.dataset.cardUid || "").trim();
  const person = readProfileForm(card);
  if (!cardUid) {
    setProfilesStatus("Update failed: Card UID not found");
    return;
  }
  if (!person.name) {
    setProfilesStatus("Please enter a name first");
    return;
  }
  try {
    setProfilesStatus(withPhoto ? `Updating ${cardUid} (with retake)...` : `Updating ${cardUid}...`);
    const payload = { card_uid: cardUid, person };
    if (withPhoto) {
      payload.image_base64 = await captureCurrentLiveFrameJpegDataUrl();
    }
    const r = await fetch("/api/nfc/profile/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (!d.success) throw new Error(formatApiError(d, "Update failed"));
    setProfilesStatus(withPhoto ? `Profile updated with retake: ${cardUid}` : `Profile updated: ${cardUid}`);
    await refreshProfiles();
    await refreshNfcList().catch(() => {});
  } catch (e) {
    setProfilesStatus(`Update failed: ${e.message}`);
  }
}

async function deleteProfile(cardUid) {
  if (!cardUid) {
    setProfilesStatus("Delete failed: Card UID not found");
    return;
  }
  const ok = window.confirm(`Delete profile for card ${cardUid}?`);
  if (!ok) return;
  try {
    setProfilesStatus(`Deleting profile ${cardUid}...`);
    const r = await fetch(`/api/nfc/profile/${encodeURIComponent(cardUid)}`, {
      method: "DELETE",
      credentials: "include"
    });
    const d = await r.json();
    if (!d.success) throw new Error(formatApiError(d, "Delete failed"));
    setProfilesStatus(`Profile deleted: ${cardUid}`);
    await refreshProfiles();
    await refreshNfcList();
  } catch (e) {
    setProfilesStatus(`Delete failed: ${e.message}`);
  }
}

function setupProfilesEditor() {
  const container = el("profiles-list");
  if (!container) return;
  container.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const card = btn.closest(".profile-card");
    if (!card) return;
    const form = card.querySelector("[data-edit-form]");
    const action = btn.dataset.action;
    if (action === "edit") {
      if (form) form.hidden = false;
      return;
    }
    if (action === "cancel-edit") {
      if (form) form.hidden = true;
      return;
    }
    if (action === "save-profile") {
      await updateProfileFromCard(card, false);
      return;
    }
    if (action === "save-profile-photo") {
      await updateProfileFromCard(card, true);
      return;
    }
    if (action === "delete-profile") {
      const cardUid = String(btn.dataset.cardUid || "").trim();
      await deleteProfile(cardUid);
    }
  });
}

function renderNfcEvents(items) {
  const ul = el("nfc-events-list");
  if (!ul) return;
  ul.innerHTML = "";
  if (!items || !items.length) {
    const li = document.createElement("li");
    li.textContent = "No events";
    ul.appendChild(li);
    return;
  }
  items.slice(0, 30).forEach((e) => {
    const li = document.createElement("li");
    const who = e.person && e.person.name ? e.person.name : "Unknown";
    const face =
      e.face && e.face.name
        ? `${e.face.name}(${Number(e.face.score || 0).toFixed(2)})`
        : `N/A${e.face && e.face.reason ? `(${e.face.reason})` : ""}`;
    li.textContent = `${new Date(e.at).toLocaleString()} | card=${e.card_uid} | person=${who} | face=${face} | permission=${
      e.permission ? "ALLOW" : "DENY"
    } | reason=${e.reason || "-"}`;
    li.className = e.permission ? "event-ok" : "event-deny";
    ul.appendChild(li);
  });
}

async function refreshProfiles() {
  const r = await fetch("/api/nfc/profiles", { credentials: "include" });
  const d = await r.json();
  if (!d.success) throw new Error(d.message || "Failed to load profiles");
  renderProfiles(d.data);
}

async function refreshNfcEvents() {
  const r = await fetch("/api/nfc/events", { credentials: "include" });
  const d = await r.json();
  if (!d.success) throw new Error(d.message || "Failed to load events");
  renderNfcEvents(d.data);
}

function renderAccessLogs(items) {
  if (!logsList) return;
  logsList.innerHTML = "";
  if (!items || !items.length) {
    const li = document.createElement("li");
    li.textContent = "No access logs yet";
    logsList.appendChild(li);
    return;
  }

  items.slice(0, 40).forEach((ev) => {
    const li = document.createElement("li");
    li.style.marginBottom = "10px";
    li.style.padding = "8px 10px";
    li.style.border = "1px solid #e0e6f0";
    li.style.borderLeft = `4px solid ${ev.permission ? "#35a96a" : "#d74b5a"}`;
    li.style.borderRadius = "8px";
    li.style.background = "#fff";

    const personName = ev.person && ev.person.name ? ev.person.name : "Unknown";
    const phone = ev.person && ev.person.phone ? ev.person.phone : "-";
    const email = ev.person && ev.person.email ? ev.person.email : "-";
    const note = ev.person && ev.person.note ? ev.person.note : "-";
    const faceName = ev.face && ev.face.name ? ev.face.name : "Unknown";
    const faceScore = ev.face && typeof ev.face.score !== "undefined" ? Number(ev.face.score).toFixed(3) : "-";
    const faceReason = ev.face && ev.face.reason ? ev.face.reason : "-";
    const timeText = ev.at ? new Date(ev.at).toLocaleString() : "-";
    const result = ev.permission ? "ALLOW" : "DENY";
    const attemptedBy = ev.face && ev.face.ok ? faceName : personName;

    li.innerHTML = `
      <div><strong>${timeText}</strong> | Result: <strong>${result}</strong> | Card: <strong>${ev.card_uid || "-"}</strong></div>
      <div>Tried by: ${attemptedBy}</div>
      <div>Profile Name: ${personName} | Phone: ${phone} | Email: ${email}</div>
      <div>Face: ${faceName} | Score: ${faceScore} | Face Detail: ${faceReason}</div>
      <div>Reason: ${ev.reason || "-"} | Registered: ${ev.registered ? "yes" : "no"} | Note: ${note}</div>
      ${
        ev.photo_url
          ? `<div style="margin-top:8px;"><img src="${ev.photo_url}?t=${Date.now()}" alt="access-capture" style="max-width:220px;border-radius:6px;border:1px solid #dbe3f5;" /></div>`
          : ""
      }
    `;
    logsList.appendChild(li);
  });
}

async function refreshAccessLogs() {
  const r = await fetch("/api/nfc/events", { credentials: "include" });
  const d = await r.json();
  if (!d.success) throw new Error(d.message || "Failed to load access logs");
  renderAccessLogs(d.data || []);
}

async function refreshNfcMonitorStatus() {
  const p = el("nfc-monitor-status");
  if (!p) return;
  try {
    const r = await fetch("/api/nfc/monitor/status", { credentials: "include" });
    const d = await r.json();
    if (!d.success) throw new Error(d.message || "Failed to load monitor status");
    const s = d.data || {};
    p.textContent = `Monitor: ${s.running ? "running" : "stopped"} | timeout_ms=${s.timeout_ms} | last_error=${
      s.last_error || "-"
    } | last_event_at=${s.last_event_at || "-"}`;
    const live = s.live || {};
    const stage = live.stage || "idle";
    const card = live.card_uid || "-";
    const countdown = Number.isFinite(Number(live.countdown)) ? Number(live.countdown) : null;
    const stageText =
      stage === "countdown" && countdown !== null
        ? `Card ${card} | Capturing in ${countdown}s`
        : `Card ${card} | Stage: ${stage}${live.message ? ` (${live.message})` : ""}`;
    setNfcLiveStatus(stageText);
    if (typeof live.permission === "boolean") {
      const score = Number.isFinite(Number(live.face_score)) ? Number(live.face_score).toFixed(3) : "-";
      const name = live.face_name || "Unknown";
      const reason = live.reason || "-";
      setNfcLiveResult(`Face=${name} (${score}) | Permission=${live.permission ? "ALLOW" : "DENY"} | Reason=${reason}`);
    } else {
      setNfcLiveResult("Waiting for next card...");
    }

    const pendingStages = new Set(["card_detected", "countdown", "matching_face", "processing"]);
    if (pendingStages.has(stage) && typeof live.permission !== "boolean") {
      if (stage === "countdown" && countdown !== null) {
        setStreamLiveOverlay(true, String(countdown), `Card ${card} - face capture countdown`);
      } else if (stage === "matching_face") {
        setStreamLiveOverlay(true, "Scanning Face", `Card ${card} - matching in progress`);
      } else {
        setStreamLiveOverlay(true, "Please Wait", `Card ${card} - verification starting`);
      }
    } else {
      setStreamLiveOverlay(false, "", "");
    }
  } catch (e) {
    p.textContent = `Monitor status error: ${e.message}`;
    setNfcLiveStatus("Live verification unavailable");
    setNfcLiveResult("");
    setStreamLiveOverlay(false, "", "");
  }
}

async function refreshNfcList() {
  try {
    setNfcStatus("Loading NFC records...");
    const res = await fetch("/api/nfc/records", { credentials: "include" });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Load failed");
    renderNfcList(data.data);
    await refreshNfcEvents().catch(() => {});
    await refreshNfcMonitorStatus().catch(() => {});
    setNfcStatus("");
  } catch (e) {
    setNfcStatus(`Load failed: ${e.message}`);
  }
}

async function snapshotOnce() {
  const streamImg = el("live-stream");
  async function uploadCurrentStreamFrame() {
    if (!streamImg || !streamImg.naturalWidth || !streamImg.naturalHeight) {
      throw new Error("Live stream is not ready");
    }
    const canvas = document.createElement("canvas");
    canvas.width = streamImg.naturalWidth;
    canvas.height = streamImg.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(streamImg, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const up = await fetch("/api/capture/frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ image_base64: dataUrl })
    });
    const upData = await up.json();
    if (!upData.success) throw new Error(upData.message || "Frame upload failed");
    return upData.data;
  }

  try {
    const accepted = await runCaptureCountdown(5);
    if (!accepted) {
      setNfcStatus("Capture cancelled");
      return null;
    }
    setNfcStatus("Capturing...");
    const res = await fetch("/api/capture", { method: "POST", credentials: "include" });
    const data = await res.json();
    let shot = null;
    if (data.success) {
      shot = data.data;
    } else {
      // Fallback for "camera already in use": capture from current live-stream frame.
      shot = await uploadCurrentStreamFrame();
    }
    const img = el("nfc-last-photo");
    if (img) img.src = `${shot.url}?t=${Date.now()}`;
    setNfcStatus("Capture complete");
    setTimeout(() => setNfcStatus(""), 1200);
    return shot;
  } catch (e) {
    setNfcStatus(`Capture failed: ${e.message}`);
    return null;
  }
}

async function pushLiveFrameCache() {
  const streamImg = el("live-stream");
  if (!streamImg || !streamImg.naturalWidth || !streamImg.naturalHeight) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = streamImg.naturalWidth;
    canvas.height = streamImg.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(streamImg, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    await fetch("/api/stream/frame-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ image_base64: dataUrl })
    });
  } catch {
    /* ignore background cache errors */
  }
}

async function pairNfcWithPerson() {
  const person = {
    name: String(el("nfc-name")?.value || "").trim(),
    phone: String(el("nfc-phone")?.value || "").trim(),
    email: String(el("nfc-email")?.value || "").trim(),
    note: String(el("nfc-note")?.value || "").trim()
  };
  if (!person.name) {
    setNfcStatus("Please enter a name first");
    return;
  }
  try {
    setNfcStatus("Waiting for ESP32 card read and pairing...");
    const res = await fetch("/api/nfc/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ person, auto_read: true, capture: false })
    });
    const data = await res.json();
    if (!data.success) throw new Error(formatApiError(data, "Pairing failed"));
    const cardUid = data.data && data.data.card_uid;
    const shot = await snapshotOnce();
    if (shot && cardUid) {
      await fetch("/api/nfc/photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ card_uid: cardUid, photo_url: shot.url })
      });
    }
    setNfcStatus(data.message || "Pairing complete");
    await refreshNfcList();
  } catch (e) {
    setNfcStatus(`Pairing failed: ${e.message}`);
  }
}

async function registerPermittedProfile() {
  const person = {
    name: String(el("enroll-name")?.value || "").trim(),
    phone: String(el("enroll-phone")?.value || "").trim(),
    email: String(el("enroll-email")?.value || "").trim(),
    note: String(el("enroll-note")?.value || "").trim()
  };
  if (!person.name) {
    setEnrollStatus("Please enter a name first");
    return;
  }

  try {
    const accepted = await runCaptureCountdown(5);
    if (!accepted) {
      setEnrollStatus("Enrollment cancelled");
      return;
    }
    setEnrollStatus("Capturing live frame...");
    const streamImg = el("live-stream");
    if (!streamImg || !streamImg.naturalWidth || !streamImg.naturalHeight) {
      throw new Error("Live stream is not ready. Please confirm Stream is active.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = streamImg.naturalWidth;
    canvas.height = streamImg.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(streamImg, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

    setEnrollStatus("Waiting for card swipe and enrollment...");
    const res = await fetch("/api/permitted/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ person, image_base64: dataUrl })
    });
    const data = await res.json();
    if (!data.success) throw new Error(formatApiError(data, "Enrollment failed"));
    setEnrollStatus("Enrollment successful");
    await refreshNfcList();
    await refreshProfiles();
  } catch (e) {
    setEnrollStatus(`Enrollment failed: ${e.message}`);
  }
}

function readSettingsPerson() {
  return {
    card_uid: String(el("settings-card-uid")?.value || "").trim(),
    person: {
      name: String(el("settings-name")?.value || "").trim(),
      phone: String(el("settings-phone")?.value || "").trim(),
      email: String(el("settings-email")?.value || "").trim(),
      note: String(el("settings-note")?.value || "").trim()
    }
  };
}

async function captureCurrentLiveFrameJpegDataUrl(withCountdown = true) {
  if (withCountdown) {
    const accepted = await runCaptureCountdown(5);
    if (!accepted) {
      throw new Error("Capture cancelled by user");
    }
  }
  const streamImg = el("live-stream");
  if (!streamImg || !streamImg.naturalWidth || !streamImg.naturalHeight) {
    throw new Error("Live stream is not ready. Please confirm Stream is active.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = streamImg.naturalWidth;
  canvas.height = streamImg.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(streamImg, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

async function recognizeFaceNow() {
  try {
    const accepted = await runCaptureCountdown(5);
    if (!accepted) {
      setFaceRecognizeStatus("Recognition cancelled");
      return;
    }
    setFaceRecognizeStatus("Running face recognition...");
    setFaceRecognizeResult("");
    const imageBase64 = await captureCurrentLiveFrameJpegDataUrl(false);
    const r = await fetch("/api/face/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ image_base64: imageBase64 })
    });
    const d = await r.json();
    if (!d.success) {
      throw new Error(formatApiError(d, "Face recognition failed"));
    }
    const face = d.data && d.data.face ? d.data.face : null;
    if (face && face.ok) {
      const name = face.name || "Unknown";
      const score = Number(face.score || 0).toFixed(3);
      setFaceRecognizeResult(`Detected: ${name} (score=${score})`);
      setFaceRecognizeStatus("Recognition complete");
    } else {
      const reason = face && face.reason ? face.reason : "unknown";
      setFaceRecognizeResult(`Detected: no registered match (${reason})`);
      setFaceRecognizeStatus("Recognition complete");
    }
  } catch (e) {
    setFaceRecognizeStatus(`Recognition failed: ${e.message}`);
  }
}

async function updateProfileFromSettings(withPhoto) {
  const payload = readSettingsPerson();
  if (!payload.card_uid) {
    setSettingsStatus("Please enter Card UID first");
    return;
  }
  if (!payload.person.name) {
    setSettingsStatus("Please enter a name first");
    return;
  }
  try {
    setSettingsStatus(withPhoto ? "Capturing live frame and updating..." : "Updating profile info...");
    if (withPhoto) {
      payload.image_base64 = await captureCurrentLiveFrameJpegDataUrl();
    }
    const r = await fetch("/api/nfc/profile/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (!d.success) throw new Error(formatApiError(d, "Update failed"));
    setSettingsStatus(withPhoto ? "Update successful (with photo)" : "Profile info updated");
    await refreshProfiles().catch(() => {});
    await refreshNfcList().catch(() => {});
  } catch (e) {
    setSettingsStatus(`Update failed: ${e.message}`);
  }
}

async function loadFaceThreshold() {
  try {
    const r = await fetch("/api/face/settings", { credentials: "include" });
    const d = await r.json();
    if (!d.success) throw new Error(d.message || "Failed to load threshold");
    const input = el("face-threshold-input");
    if (input) input.value = Number(d.data && d.data.threshold ? d.data.threshold : 0.85).toFixed(2);
    setFaceThresholdStatus("");
  } catch (e) {
    setFaceThresholdStatus(`Load failed: ${e.message}`);
  }
}

async function saveFaceThreshold() {
  const input = el("face-threshold-input");
  const value = Number(input && input.value);
  if (!Number.isFinite(value) || value < 0.1 || value > 0.99) {
    setFaceThresholdStatus("Enter a value between 0.10 and 0.99");
    return;
  }
  try {
    setFaceThresholdStatus("Saving...");
    const r = await fetch("/api/face/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ threshold: value })
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.message || "Save failed");
    if (input) input.value = Number(d.data.threshold).toFixed(2);
    setFaceThresholdStatus(`Saved: ${Number(d.data.threshold).toFixed(2)}`);
  } catch (e) {
    setFaceThresholdStatus(`Save failed: ${e.message}`);
  }
}

function setupNfcUi() {
  const pairBtn = el("nfc-pair-btn");
  const refreshBtn = el("nfc-refresh-btn");
  const snapBtn = el("nfc-snapshot-btn");
  const startBtn = el("nfc-monitor-start-btn");
  const stopBtn = el("nfc-monitor-stop-btn");
  if (pairBtn) pairBtn.addEventListener("click", pairNfcWithPerson);
  if (refreshBtn) refreshBtn.addEventListener("click", refreshNfcList);
  if (snapBtn) snapBtn.addEventListener("click", snapshotOnce);
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      setNfcStatus("Starting background monitor...");
      const r = await fetch("/api/nfc/monitor/start", { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!d.success) {
        setNfcStatus(`Start failed: ${d.message || "unknown"}`);
        return;
      }
      setNfcStatus("Background monitor started");
      await refreshNfcMonitorStatus();
    });
  }
  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      setNfcStatus("Stopping background monitor...");
      const r = await fetch("/api/nfc/monitor/stop", { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!d.success) {
        setNfcStatus(`Stop failed: ${d.message || "unknown"}`);
        return;
      }
      setNfcStatus("Background monitor stopped");
      await refreshNfcMonitorStatus();
    });
  }
  const profileRefresh = el("profiles-refresh-btn");
  if (profileRefresh) profileRefresh.addEventListener("click", refreshProfiles);
  const enrollSubmit = el("enroll-submit-btn");
  if (enrollSubmit) enrollSubmit.addEventListener("click", registerPermittedProfile);
  const faceRecognizeBtn = el("face-recognize-now-btn");
  if (faceRecognizeBtn) faceRecognizeBtn.addEventListener("click", recognizeFaceNow);
  const thresholdSaveBtn = el("face-threshold-save-btn");
  if (thresholdSaveBtn) thresholdSaveBtn.addEventListener("click", saveFaceThreshold);
}

async function loadWarnings() {
  const res = await fetch("/api/dashboard/warnings", { credentials: "include" });
  const data = await res.json();
  if (!data.success) return;
  warningsList.innerHTML = "";
  warningModalBody.innerHTML = "";
  data.data.forEach((w) => {
    const li = document.createElement("li");
    li.textContent = `${w.action} | ${w.camera_ip} | ${w.status}`;
    warningsList.appendChild(li);
    const p = document.createElement("p");
    p.textContent = `${w.action} - ${new Date(w.time).toLocaleString()}`;
    warningModalBody.appendChild(p);
  });
}

function setupWarningModal() {
  document.getElementById("open-warning-modal").addEventListener("click", () => warningModal.classList.add("show"));
  document.getElementById("close-warning-modal").addEventListener("click", () => warningModal.classList.remove("show"));
  warningModal.addEventListener("click", (e) => {
    if (e.target === warningModal) warningModal.classList.remove("show");
  });
}

function setupLanguage() {
  document.getElementById("lang-select").addEventListener("change", (e) => {
    const isEn = e.target.value === "en";
    document.getElementById("logout-btn").textContent = "Logout";
  });
}

function setupPasswordToggles() {
  document.querySelectorAll(".password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-target");
      const input = document.getElementById(id);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-pressed", show ? "true" : "false");
    });
  });
}

function setupChangePassword() {
  document.getElementById("change-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const old_password = document.getElementById("old-password").value;
    const new_password = document.getElementById("new-password").value;
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password, new_password }),
      credentials: "include"
    });
    const data = await res.json();
    alert(data.message);
  });
}

function setupSettingsProfileRecap() {
  const btnInfo = el("settings-update-only-btn");
  const btnPhoto = el("settings-recap-photo-btn");
  if (btnInfo) {
    btnInfo.addEventListener("click", () => updateProfileFromSettings(false));
  }
  if (btnPhoto) {
    btnPhoto.addEventListener("click", () => updateProfileFromSettings(true));
  }
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  stopLiveStream();
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  window.location.href = "/login";
});

window.addEventListener("beforeunload", () => {
  stopLiveStream();
});

(async function init() {
  const user = await verifySession();
  if (!user) return;
  document.getElementById("welcome-name").textContent = user.username;
  document.getElementById("welcome-type").textContent = user.user_type;
  logsList.innerHTML = `<li>Loading access logs...</li>`;
  setupTabs();
  setupPasswordToggles();
  setupWarningModal();
  setupLanguage();
  setupChangePassword();
  setupSettingsProfileRecap();
  setupProfilesEditor();
  setupLiveStream();
  setupNfcUi();
  await refreshNfcList();
  await refreshProfiles().catch(() => {});
  await loadFaceThreshold().catch(() => {});
  await refreshNfcMonitorStatus().catch(() => {});
  await refreshAccessLogs().catch(() => {});
  setInterval(() => {
    refreshNfcEvents().catch(() => {});
    refreshNfcMonitorStatus().catch(() => {});
    refreshAccessLogs().catch(() => {});
  }, 3000);
  setInterval(() => {
    pushLiveFrameCache().catch(() => {});
  }, 2000);
  await loadWarnings();
})();
