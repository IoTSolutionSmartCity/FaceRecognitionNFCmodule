from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Dict, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import sys


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FACE_MODULE_ROOT = PROJECT_ROOT / "face"
if str(FACE_MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(FACE_MODULE_ROOT))

try:
    from face_api import FaceRecognizer
except Exception as exc:  # pragma: no cover
    raise RuntimeError(f"Failed to import face_api from {FACE_MODULE_ROOT}: {exc}") from exc


app = FastAPI(title="IBSP Face Service", version="1.0.0")

_cache_lock = threading.Lock()
_recognizer_cache: Dict[Tuple[str, str], FaceRecognizer] = {}
WINDOW_NAME = "IBSP Face Detection"
SHOW_WINDOW = str(os.getenv("FACE_SHOW_WINDOW", "0")).strip().lower() in {"1", "true", "yes", "on"}


class MatchRequest(BaseModel):
    image_path: str = Field(..., description="Absolute path to image file")
    faces_dir: str = Field(..., description="Directory containing known faces")
    model_name: str = Field(default="r18")
    threshold: float = Field(default=0.3)


def _get_recognizer(faces_dir: Path, model_name: str) -> FaceRecognizer:
    key = (str(faces_dir.resolve()), model_name)
    with _cache_lock:
        if key in _recognizer_cache:
            return _recognizer_cache[key]
        recognizer = FaceRecognizer(model_name=model_name, facelib_path=str(faces_dir))
        recognizer.init()
        _recognizer_cache[key] = recognizer
        return recognizer


def _read_image_for_preview(image_path: Path):
    data = np.fromfile(str(image_path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def _show_preview(image_path: Path, result: dict, name: str, score: float, accepted: bool):
    if not SHOW_WINDOW:
        return
    image = _read_image_for_preview(image_path)
    if image is None:
        return
    box = result.get("box") or []
    if len(box) == 4:
        x1, y1, x2, y2 = [int(v) for v in box]
        color = (0, 180, 0) if accepted else (0, 0, 180)
        cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
    label = f"{name} ({score:.2f}) {'ALLOW' if accepted else 'DENY'}"
    cv2.putText(image, label, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.imshow(WINDOW_NAME, image)
    cv2.waitKey(1)


@app.get("/health")
def health():
    return {"ok": True, "cache_size": len(_recognizer_cache)}


@app.post("/match")
def match_face(req: MatchRequest):
    image_path = Path(req.image_path)
    faces_dir = Path(req.faces_dir)
    if not image_path.is_file():
        return {"ok": False, "reason": "image_not_found"}
    if not faces_dir.is_dir():
        return {"ok": False, "reason": "faces_dir_not_found"}
    try:
        recognizer = _get_recognizer(faces_dir, req.model_name)
        result = recognizer.recognize(str(image_path))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"recognize_failed: {exc}") from exc

    top1 = (result.get("top5") or [{}])[0]
    score = float(top1.get("score", 0.0) or 0.0)
    name = str(top1.get("name", "Unknown") or "Unknown")
    accepted = bool(result.get("box")) and score >= float(req.threshold)
    _show_preview(image_path, result, name, score, accepted)
    if accepted:
        return {"ok": True, "name": name, "score": score}
    reason = "no_face_in_image" if not result.get("box") else "score_below_threshold"
    return {"ok": True, "name": "Unknown", "score": score, "reason": reason}

