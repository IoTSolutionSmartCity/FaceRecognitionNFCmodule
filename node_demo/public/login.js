const api = {
  login: "/api/auth/login",
  register: "/api/auth/register",
  forgot: "/api/auth/forgot-password"
};

const i18n = {
  zh: { title: "IP Camera User & Auth", desc: "Supports login/register/forgot password." },
  en: { title: "IP Camera User & Auth", desc: "Supports login/register/forgot password." }
};

const msgEl = document.getElementById("auth-msg");
const panes = ["login-form", "register-form"];

function showPane(id) {
  panes.forEach((paneId) => {
    document.getElementById(paneId).classList.toggle("active", paneId === id);
  });
}

function setMsg(text, isError = false) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? "#c62828" : "#2e7d32";
}

document.getElementById("tab-login").addEventListener("click", () => {
  document.getElementById("tab-login").classList.add("active");
  document.getElementById("tab-register").classList.remove("active");
  showPane("login-form");
});

document.getElementById("tab-register").addEventListener("click", () => {
  document.getElementById("tab-register").classList.add("active");
  document.getElementById("tab-login").classList.remove("active");
  showPane("register-form");
});

document.getElementById("lang-select").addEventListener("change", (e) => {
  const lang = e.target.value;
  document.getElementById("title").textContent = i18n[lang].title;
  document.getElementById("desc").textContent = i18n[lang].desc;
});

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

setupPasswordToggles();

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    username: document.getElementById("login-username").value.trim(),
    password: document.getElementById("login-password").value
  };
  try {
    const res = await fetch(api.login, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "include"
    });
    const data = await res.json().catch(() => ({}));
    if (!data.success) return setMsg(data.message || "Login failed", true);
    window.location.assign("/dashboard");
  } catch (err) {
    setMsg(err.message || "Network error", true);
  }
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    username: document.getElementById("reg-username").value.trim(),
    password: document.getElementById("reg-password").value,
    user_type: document.getElementById("reg-user-type").value
  };
  const res = await fetch(api.register, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include"
  });
  const data = await res.json();
  if (!data.success) return setMsg(data.message, true);
  setMsg("Registration successful, please log in.");
  showPane("login-form");
});

document.getElementById("btn-forgot").addEventListener("click", async () => {
  const username = prompt("Enter registered username (demo returns a token)");
  if (!username) return;
  const res = await fetch(api.forgot, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
    credentials: "include"
  });
  const data = await res.json();
  if (!data.success) return setMsg(data.message, true);
  setMsg(`Reset token (demo): ${data.data.token_demo}`);
});
