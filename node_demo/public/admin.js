const storeJsonEl = document.getElementById("store-json");
const warningsListEl = document.getElementById("warnings-admin-list");

async function fetchStore() {
  const res = await fetch("/api/dev/store");
  const data = await res.json();
  if (!data.success) {
    alert(data.message || "Read failed");
    return null;
  }
  return data.data;
}

function renderWarnings(warnings) {
  warningsListEl.innerHTML = "";
  warnings.forEach((w) => {
    const li = document.createElement("li");
    li.style.marginBottom = "8px";
    li.innerHTML = `
      <strong>#${w.id}</strong> ${w.action} | ${w.camera_ip} | ${w.status}
      <button data-id="${w.id}" class="btn-ghost" style="margin-left:8px;">Delete</button>
    `;
    warningsListEl.appendChild(li);
  });
}

async function refreshStoreView() {
  const store = await fetchStore();
  if (!store) return;
  storeJsonEl.textContent = JSON.stringify(store, null, 2);
  renderWarnings(store.warnings || []);
}

document.getElementById("btn-refresh").addEventListener("click", refreshStoreView);

document.getElementById("add-warning-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const action = document.getElementById("warning-action").value.trim();
  const camera_ip = document.getElementById("warning-ip").value.trim();
  const status = document.getElementById("warning-status").value;
  const res = await fetch("/api/dev/warnings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, camera_ip, status })
  });
  const data = await res.json();
  if (!data.success) return alert(data.message || "Create failed");
  document.getElementById("warning-action").value = "";
  await refreshStoreView();
});

warningsListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const res = await fetch(`/api/dev/warnings/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (!data.success) return alert(data.message || "Delete failed");
  await refreshStoreView();
});

document.getElementById("btn-clear-reset").addEventListener("click", async () => {
  await fetch("/api/dev/tokens/reset", { method: "DELETE" });
  await refreshStoreView();
});

document.getElementById("btn-reset-all").addEventListener("click", async () => {
  const ok = confirm("Reset store.json to default state?");
  if (!ok) return;
  await fetch("/api/dev/reset-store", { method: "POST" });
  await refreshStoreView();
});

refreshStoreView();
