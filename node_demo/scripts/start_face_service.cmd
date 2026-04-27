@echo off
setlocal

set FACE_SHOW_WINDOW=0

python -c "import uvicorn" >nul 2>nul
if errorlevel 1 (
  echo [face-service] uvicorn not found in current Python, installing dependencies...
  python -m pip install --upgrade pip
  python -m pip install fastapi uvicorn
)

python -m uvicorn face_service:app --app-dir scripts --host 127.0.0.1 --port 8001
