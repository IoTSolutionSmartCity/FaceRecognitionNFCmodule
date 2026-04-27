function el(id) {
  return document.getElementById(id);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const img = el("live-stream");
  const msg = el("stream-status");
  if (!img) return;
  img.addEventListener("load", () => {
    if (msg) msg.textContent = "";
  });
  img.addEventListener("error", () => {
    if (msg) msg.textContent = "Stream failed to load. Confirm login and camera availability.";
  });
  img.src = `/api/stream?t=${Date.now()}`;
}

function stopLiveStream() {
  const img = el("live-stream");
  if (!img) return;
  img.removeAttribute("src");
  img.src = "";
}

async function runCaptureCountdown(seconds = 5) {
  const modal = el("capture-countdown-modal");
  const text = el("capture-countdown-text");
  const preview = el("capture-preview-stream");
  const cancelBtn = el("capture-countdown-cancel-btn");
  const streamImg = el("live-stream");

  if (preview) preview.src = streamImg && streamImg.src ? streamImg.src : "";
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");

  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
  };
  if (cancelBtn) cancelBtn.addEventListener("click", onCancel, { once: true });

  try {
    for (let left = seconds; left > 0; left--) {
      if (text) text.textContent = `Capturing in ${left} second(s)...`;
      await waitMs(1000);
      if (cancelled) return false;
    }
    if (text) text.textContent = "Capturing now, hold still...";
    await waitMs(300);
    return !cancelled;
  } finally {
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    if (preview) preview.src = "";
  }
}

function captureCurrentFrameJpeg() {
  const streamImg = el("live-stream");
  if (!streamImg || !streamImg.naturalWidth || !streamImg.naturalHeight) {
    throw new Error("Live stream is not ready.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = streamImg.naturalWidth;
  canvas.height = streamImg.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(streamImg, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

function setStatus(text) {
  const n = el("recognize-status");
  if (n) n.textContent = text || "";
}

function setResult(text) {
  const n = el("recognize-result");
  if (n) n.textContent = text || "";
}

async function runRecognition() {
  try {
    const accepted = await runCaptureCountdown(5);
    if (!accepted) {
      setStatus("Recognition cancelled");
      return;
    }
    setStatus("Running face recognition...");
    setResult("");
    const image_base64 = captureCurrentFrameJpeg();
    const r = await fetch("/api/face/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ image_base64 })
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.message || "Face recognition failed");

    const face = d.data && d.data.face ? d.data.face : null;
    if (face && face.ok) {
      const name = face.name || "Unknown";
      const score = Number(face.score || 0).toFixed(3);
      setResult(`Detected person: ${name} (score=${score})`);
    } else {
      const reason = face && face.reason ? face.reason : "unknown";
      setResult(`Detected person: no registered match (${reason})`);
    }
    const cap = el("capture-preview");
    if (cap && d.data && d.data.capture_url) {
      cap.src = `${d.data.capture_url}?t=${Date.now()}`;
    }
    setStatus("Recognition complete");
  } catch (e) {
    setStatus(`Recognition failed: ${e.message}`);
  }
}

(async function init() {
  const user = await verifySession();
  if (!user) return;
  setupLiveStream();
  const btn = el("recognize-btn");
  if (btn) btn.addEventListener("click", runRecognition);
})();

window.addEventListener("beforeunload", () => {
  stopLiveStream();
});
