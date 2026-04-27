from __future__ import annotations

import argparse
import time

import cv2

from face_api import DEFAULT_DETECTOR_WEIGHT_PATH
from face_api import detect_image
from face_api import load_detector


def main() -> None:
    parser = argparse.ArgumentParser(description="Real-time face detection from webcam stream")
    parser.add_argument("--camera", type=int, default=0, help="Camera index, default 0")
    parser.add_argument("--img-size", type=int, default=640, help="Detector input size")
    parser.add_argument("--conf", type=float, default=0.6, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.5, help="NMS IOU threshold")
    parser.add_argument("--prefer-cuda", action="store_true", help="Use CUDAExecutionProvider if available")
    args = parser.parse_args()

    detector = load_detector(DEFAULT_DETECTOR_WEIGHT_PATH, prefer_cuda=args.prefer_cuda)
    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera index {args.camera}")

    prev_time = time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        det_result = detect_image(
            detector,
            frame,
            img_size=args.img_size,
            conf_thres=args.conf,
            iou_thres=args.iou,
            draw_result=False,
        )
        faces = det_result.get("data", [])
        for face in faces:
            x1, y1, x2, y2 = [int(v) for v in face["box"]]
            conf = float(face.get("conf", 0.0))
            cv2.rectangle(frame, (x1, y1), (x2, y2), (24, 160, 88), 2)
            cv2.putText(
                frame,
                f"face {conf:.2f}",
                (x1, max(20, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (24, 160, 88),
                2,
                cv2.LINE_AA,
            )

        now = time.time()
        fps = 1.0 / max(now - prev_time, 1e-6)
        prev_time = now

        cv2.putText(
            frame,
            f"faces: {len(faces)}  fps: {fps:.1f}",
            (12, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )

        cv2.imshow("Face Stream Detection (press q to quit)", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
