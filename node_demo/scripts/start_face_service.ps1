$ErrorActionPreference = "Stop"

$env:FACE_SHOW_WINDOW = "0"

# Probe package presence silently via importlib (no warning text).
cmd /c "python -c \"import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('uvicorn') else 1)\" >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[face-service] uvicorn not found in current Python, installing dependencies..."
    python -m pip install --upgrade pip
    python -m pip install fastapi uvicorn
}

python -m uvicorn face_service:app --app-dir scripts --host 127.0.0.1 --port 8001
