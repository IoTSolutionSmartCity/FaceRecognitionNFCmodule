/**
 * 本地验证：启动 server → 登录 → 拉取 /api/stream 前 32KB 并检查 multipart/jpeg 头。
 * 用法：node scripts/test_stream_http.js
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const root = path.join(__dirname, "..");

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        })
      );
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpStreamFirstBytes(options, maxBytes, msTimeout) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        chunks.push(c);
        total += c.length;
        if (total >= maxBytes) {
          req.destroy();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buf: Buffer.concat(chunks).subarray(0, maxBytes)
          });
        }
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buf: Buffer.concat(chunks)
        })
      );
    });
    req.on("error", reject);
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error("timeout reading stream"));
    }, msTimeout);
  });
}

async function main() {
  const port = String(5010 + Math.floor(Math.random() * 80));
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  await new Promise((r) => setTimeout(r, 1200));

  try {
    const login = await httpRequest(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: "/api/auth/login",
        method: "POST",
        headers: { "Content-Type": "application/json" }
      },
      JSON.stringify({ username: "admin", password: "admin123" })
    );
    if (login.status !== 200) {
      throw new Error(`login failed: ${login.status} ${login.body.toString()}`);
    }
    const setCookie = login.headers["set-cookie"];
    if (!setCookie || !setCookie.length) {
      throw new Error("no Set-Cookie from login");
    }
    const cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ");

    const stream = await httpStreamFirstBytes(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: "/api/stream",
        method: "GET",
        headers: { Cookie: cookieHeader }
      },
      32768,
      12000
    );

    if (stream.status !== 200) {
      throw new Error(`stream status ${stream.status}`);
    }
    const head = stream.buf.subarray(0, 400).toString("latin1");
    const ok =
      (head.includes("--ffmpeg") || head.includes("ffserver")) &&
      /image\/jpeg/i.test(head);
    if (!ok) {
      console.error("First bytes:", head);
      throw new Error("unexpected MJPEG multipart prefix");
    }
    console.log("OK: /api/stream returned multipart MJPEG data (", stream.buf.length, "bytes sampled )");
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
