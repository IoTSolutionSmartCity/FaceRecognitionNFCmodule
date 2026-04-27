from __future__ import annotations

import argparse
import time

import cv2

from face_api import FaceRecognizer


def main() -> None:
    parser = argparse.ArgumentParser(description="Real-time face recognition from webcam stream")
    parser.add_argument("--camera", type=int, default=0, help="Camera index, default 0")
    parser.add_argument("--model", default="r18", help="Recognizer model name: r18 or r100")
    parser.add_argument("--threshold", type=float, default=0.3, help="Min score to accept identity")
    parser.add_argument("--prefer-cuda", action="store_true", help="Use CUDAExecutionProvider if available")
    args = parser.parse_args()

    recognizer = FaceRecognizer(model_name=args.model, prefer_cuda=args.prefer_cuda)
    recognizer.init()

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera index {args.camera}")

    prev_time = time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        result = recognizer.recognize(frame)
        box = result.get("box") or []
        top1 = (result.get("top5") or [{}])[0]
        score = float(top1.get("score", 0.0) or 0.0)
        name = str(top1.get("name", "unknown"))
        accepted = bool(box) and score >= args.threshold

        if box:
            x1, y1, x2, y2 = [int(v) for v in box]
            color = (24, 160, 88) if accepted else (40, 80, 220)
            label = f"{name} {score:.3f}" if accepted else f"unknown {score:.3f}"
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(
                frame,
                label,
                (x1, max(20, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                color,
                2,
                cv2.LINE_AA,
            )

        now = time.time()
        fps = 1.0 / max(now - prev_time, 1e-6)
        prev_time = now
        cv2.putText(
            frame,
            f"face_count: {int(result.get('face_count', 0))}  fps: {fps:.1f}",
            (12, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )

        cv2.imshow("Face Stream Recognition (press q to quit)", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
