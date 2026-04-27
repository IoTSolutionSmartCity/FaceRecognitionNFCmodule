#!/usr/bin/env bash
set -euo pipefail

export FACE_SHOW_WINDOW=0

python -m uvicorn face_service:app --app-dir scripts --host 127.0.0.1 --port 8001
