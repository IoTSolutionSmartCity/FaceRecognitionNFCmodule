const { spawnSync } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");

let cachedName = null;
let cachedNull = false;

/**
 * 解析 ffmpeg dshow 设备列表，返回第一个可用的「(video)」设备友好名。
 * 若存在多个，优先名称中含 Logi / Logitech / WebCam 的项。
 */
function parseDshowVideoNames(stderr) {
  const text = String(stderr || "");
  const re = /"([^"]+)"\s*\(video\)/g;
  const names = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function pickPreferred(names) {
  if (!names.length) return null;
  const prefer = names.find((n) => /logi|logitech|webcam|c310|hd webcam/i.test(n));
  return prefer || names[0];
}

/**
 * @returns {string|null}
 */
function detectFirstDshowVideoName() {
  if (!ffmpegStatic) return null;
  const r = spawnSync(
    ffmpegStatic,
    ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    }
  );
  const merged = `${r.stdout || ""}\n${r.stderr || ""}`;
  const names = parseDshowVideoNames(merged);
  return pickPreferred(names);
}

/**
 * 同步获取 Windows DirectShow 摄像头名（可缓存）。失败返回 null。
 */
function getWindowsVideoDeviceName() {
  if (cachedNull) return null;
  if (cachedName) return cachedName;
  try {
    const name = detectFirstDshowVideoName();
    if (name) {
      cachedName = name;
      return cachedName;
    }
  } catch {
    /* ignore */
  }
  cachedNull = true;
  return null;
}

function clearCache() {
  cachedName = null;
  cachedNull = false;
}

module.exports = {
  getWindowsVideoDeviceName,
  parseDshowVideoNames,
  pickPreferred,
  clearCache
};
