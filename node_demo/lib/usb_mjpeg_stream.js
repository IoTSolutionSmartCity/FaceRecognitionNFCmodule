const { spawn } = require("child_process");
const fs = require("fs");
const ffmpegStatic = require("ffmpeg-static");
const { getWindowsVideoDeviceName } = require("./detect_windows_camera");

const WIDTH = 640;
const HEIGHT = 480;
const FPS = 15;

function streamSize() {
  const w = Number(process.env.STREAM_WIDTH) || WIDTH;
  const h = Number(process.env.STREAM_HEIGHT) || HEIGHT;
  return {
    width: Math.min(1920, Math.max(160, Math.round(w))),
    height: Math.min(1080, Math.max(120, Math.round(h)))
  };
}

function streamFps() {
  const n = Number(process.env.STREAM_FPS);
  return Math.min(60, Math.max(1, Number.isFinite(n) && n > 0 ? n : FPS));
}

/**
 * Windows: 优先 USB_VIDEO_DEVICE；未设置时自动枚举第一个 (video) 设备。
 */
function resolveWindowsDevice() {
  const fromEnv = String(process.env.USB_VIDEO_DEVICE || "").trim();
  if (fromEnv) return fromEnv;
  const detected = getWindowsVideoDeviceName();
  if (detected) {
    console.log("[camera] 自动选用 DirectShow 设备:", detected);
    return detected;
  }
  throw new Error(
    "未检测到视频设备：请连接 USB 摄像头，或设置环境变量 USB_VIDEO_DEVICE（名称与 ffmpeg -f dshow -list_devices 一致）。"
  );
}

/**
 * 构造 argv：与已在本机验证通过的 ffmpeg 命令行一致。
 */
function buildMjpegStreamArgv() {
  if (!ffmpegStatic) {
    throw new Error("ffmpeg-static 未提供本机可用的 ffmpeg 二进制文件。");
  }

  const { width, height } = streamSize();
  const fps = streamFps();
  const sizeStr = `${width}x${height}`;
  const plat = process.platform;
  const q = process.env.STREAM_JPEG_Q || "5";

  const tail = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-an",
    "-vf",
    `fps=${fps}`,
    "-f",
    "mpjpeg",
    "-q:v",
    q,
    "-"
  ];

  if (plat === "win32") {
    const dev = resolveWindowsDevice();
    return [
      ffmpegStatic,
      "-f",
      "dshow",
      "-video_size",
      sizeStr,
      "-framerate",
      String(fps),
      "-i",
      `video=${dev}`,
      ...tail
    ];
  }

  if (plat === "linux") {
    const dev = String(process.env.USB_VIDEO_DEVICE || "/dev/video0").trim();
    if (!fs.existsSync(dev)) {
      throw new Error(`摄像头设备不存在: ${dev}（可设置 USB_VIDEO_DEVICE）`);
    }
    return [
      ffmpegStatic,
      "-f",
      "v4l2",
      "-fflags",
      "nobuffer",
      "-video_size",
      sizeStr,
      "-framerate",
      String(fps),
      "-i",
      dev,
      ...tail
    ];
  }

  throw new Error(`当前仅支持 Windows (dshow) 与 Linux (v4l2)，当前平台: ${plat}`);
}

/**
 * 启动子进程：stdout 为 multipart MJPEG，stderr 为日志。
 */
function startMjpegChildProcess() {
  const argv = buildMjpegStreamArgv();
  const child = spawn(argv[0], argv.slice(1), {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return child;
}

module.exports = {
  buildMjpegStreamArgv,
  startMjpegChildProcess,
  streamSize,
  streamFps,
  ffmpegStatic
};
