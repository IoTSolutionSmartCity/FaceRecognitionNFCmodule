import argparse
import json
import os
import sys
from pathlib import Path


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--faces-dir", required=True)
    args = parser.parse_args()

    if not os.path.isfile(args.image):
        out({"ok": False, "reason": "image_not_found"})
        return 0

    if not os.path.isdir(args.faces_dir):
        out({"ok": False, "reason": "faces_dir_not_found"})
        return 0

    try:
        project_root = Path(__file__).resolve().parents[2]
        face_module_root = project_root / "face"
        if str(face_module_root) not in sys.path:
            sys.path.insert(0, str(face_module_root))
        from face_api import FaceRecognizer
    except Exception as e:
        out({"ok": False, "reason": f"deps_missing_face_api: {e}"})
        return 0

    recognizer = FaceRecognizer(model_name="r18", facelib_path=args.faces_dir)
    recognizer.init()
    result = recognizer.recognize(args.image)
    top1 = (result.get("top5") or [{}])[0]
    score = float(top1.get("score", 0.0) or 0.0)
    name = str(top1.get("name", "Unknown") or "Unknown")
    accepted = bool(result.get("box")) and score >= 0.3
    if accepted:
        out({"ok": True, "name": name, "score": score})
    else:
        reason = "no_face_in_image" if not result.get("box") else "score_below_threshold"
        out({"ok": True, "name": "Unknown", "score": score, "reason": reason})
    return 0


if __name__ == "__main__":
    sys.exit(main())

