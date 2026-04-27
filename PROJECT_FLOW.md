# IBSP Project Flow

This document describes the end-to-end runtime flow of the IBSP demo system using Mermaid diagrams.

## 1) High-Level Architecture

```mermaid
flowchart LR
    U[User Browser<br/>login/dashboard/admin] --> N[Node.js App<br/>node_demo/server.js]
    N --> S[(JSON Store<br/>node_demo/data/store.json)]
    N --> C[USB Camera via ffmpeg<br/>lib/usb_mjpeg_stream.js]
    N --> E[ESP32 Device<br/>NFC + Permission Display]
    N --> P[Python Face Match Script<br/>scripts/face_match.py]
    P --> F[(Face Library<br/>face/facelib)]
    C --> N
    E --> N
```

## 2) App Startup and Core Services

```mermaid
flowchart TD
    A[npm start] --> B[server.js boot]
    B --> C[Init Express + Session]
    C --> D[Load static pages + APIs]
    D --> E[Ensure store.json exists]
    E --> F[Start HTTP server on :5000]
    F --> G{AUTO_START_NFC_MONITOR != 0?}
    G -- Yes --> H[Start NFC monitor loop]
    G -- No --> I[Wait for manual start API]
```

## 3) Authentication Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant N as Node Server
    participant S as store.json

    B->>N: POST /api/auth/register (optional)
    N->>S: read + write user
    S-->>N: saved
    N-->>B: register success

    B->>N: POST /api/auth/login
    N->>S: validate username/password
    S-->>N: user match
    N-->>B: set session userId

    B->>N: GET /api/auth/verify
    N->>S: lookup session user
    N-->>B: authenticated or 401
```

## 4) Dashboard Live Stream Flow

```mermaid
flowchart TD
    A[Dashboard loads image /api/stream] --> B{Session valid?}
    B -- No --> C[Return 401]
    B -- Yes --> D[startMjpegChildProcess()]
    D --> E[ffmpeg opens USB camera]
    E --> F[Output multipart MJPEG]
    F --> G[Node pipes stdout to HTTP response]
    G --> H[Browser displays live preview]
    H --> I[On close/abort, kill ffmpeg child]
```

## 5) NFC + Face Verification Decision Flow

```mermaid
flowchart TD
    A[NFC monitor tick] --> B[GET ESP32 /nfc/read]
    B --> C{Card UID received?}
    C -- No --> A
    C -- Yes --> D[processNfcSwipe(card_uid)]
    D --> E[3s countdown to ESP32]
    E --> F[Capture camera frame<br/>or use live frame cache]
    F --> G[Run Python face_match.py]
    G --> H{Decision rules}

    H --> H1[Card registered?]
    H --> H2[Face detected + known?]
    H --> H3[Score >= FACE_ACCEPT_SCORE?]
    H --> H4[Name matches profile?]

    H1 --> I{All checks pass?}
    H2 --> I
    H3 --> I
    H4 --> I

    I -- Yes --> J[Permission = allowed]
    I -- No --> K[Permission = denied + add warning]

    J --> L[Store nfcEvents in JSON]
    K --> L
    L --> M[POST result to ESP32 /nfc/permission-result]
```

## 6) Data Ownership / Persistence

```mermaid
flowchart LR
    S[(store.json)] --> A[users]
    S --> B[resetTokens]
    S --> C[nfc profiles]
    S --> D[nfc events]
    S --> E[warnings]

    P[(public/captures)] --> F[captured snapshots]
    F --> C

    L[(face/facelib)] --> G[known face images]
    G --> H[used by face_match.py]
```

## 7) Main Runtime Entry Points

- UI routes: `/login`, `/dashboard`, `/admin`, `/face-test`
- Auth APIs: `/api/auth/*`
- Stream API: `/api/stream`
- NFC APIs: `/api/nfc/*`, `/api/permitted/register`
- ESP32 status API: `/api/esp32/status`
- Dev APIs: `/api/dev/*`

