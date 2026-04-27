# Node Demo

## Run

1. `cd node_demo`
2. `npm install`
3. `npm start`
4. Open `http://localhost:5000`

## Included

- Login/Register/Auth page: `/login`
- Dashboard page with sections: `/dashboard`
- Admin JSON tools page: `/admin`
- Redirect root: `/` -> `/login`
- Health API: `/api/health`

## Auth APIs (demo, in-memory)

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/verify`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/auth/change-password`

## USB camera stream (session required)

- `GET /api/stream` — multipart MJPEG from the USB webcam at **640×480**, **15 fps** (overridable via env). Uses **`ffmpeg-static`** and a child-process pipe (no OpenCV). The HTTP header **`boundary=ffmpeg`** must match the ffmpeg mpjpeg muxer (older docs sometimes say `ffserver`; that breaks `<img>` playback). The dashboard `<img>` is same-origin so the session cookie is sent; unauthenticated requests get `401`.
- **Windows:** if no `USB_VIDEO_DEVICE` is set, the server **auto-picks** the first DirectShow `(video)` device (prefers names containing Logi / WebCam). If you see “device already in use”, close **Camera**, **Teams**, **OBS**, or other apps using the webcam.

**Windows (DirectShow):** set the camera name exactly as ffmpeg lists it:

```text
set USB_VIDEO_DEVICE=Logi C310 HD WebCam
npm start
```

List devices (uses ffmpeg on PATH or the binary from `node_modules/ffmpeg-static`):

```text
"path\to\node_modules\ffmpeg-static\ffmpeg.exe" -f dshow -list_devices true -i dummy
```

**Linux:** defaults to `/dev/video0`. Override with `USB_VIDEO_DEVICE=/dev/video1` if needed.

**Optional env:** `STREAM_WIDTH`, `STREAM_HEIGHT` (default 640 and 480), `STREAM_FPS` (default 15), `STREAM_JPEG_Q` (ffmpeg `-q:v`, default 5).

## Demo flow

- Enter username/password on `/login`
- Register uses username + password (email not required)
- Redirect to `/dashboard`
- Dashboard shows a live USB preview (`/api/stream`) and warnings
- Logout returns to `/login`

## Temporary backend storage

- Data is persisted in `data/store.json`
- Includes users, password reset tokens, and warnings
- Good for demo/prototyping before MySQL integration

## Dev JSON management APIs

- `GET /api/dev/store` - View current JSON store (passwords hidden)
- `POST /api/dev/warnings` - Add warning
  - body: `{ "action": "xxx", "camera_ip": "192.168.0.136", "status": "pending" }`
- `DELETE /api/dev/warnings/:id` - Remove warning by id
- `DELETE /api/dev/tokens/reset` - Clear all reset tokens
- `POST /api/dev/reset-store` - Reset `store.json` to default state
