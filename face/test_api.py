from __future__ import annotations

"""直接运行的人脸识别可视化脚本。"""

# 导入标准库参数解析器。 
import argparse
# 导入标准库路径工具。 
from pathlib import Path
# 导入标准库系统路径工具。 
import sys

# 导入 OpenCV。 
import cv2
# 导入 NumPy。 
import numpy as np


# 记录当前脚本目录。 
CURRENT_DIR = Path(__file__).resolve().parent
# 把项目根目录加入模块搜索路径，兼容直接运行。 
PROJECT_ROOT = CURRENT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# 导入识别核心。 
from face.face_api import FaceRecognizer
# 导入图片读取。 
from face.face_api import read_image
# 导入图片保存。 
from face.face_api import save_image
# 导入中文和关键点绘制工具。 
from face.visualize import draw_chinese_text
# 导入关键点绘制工具。 
from face.visualize import draw_landmarks


def draw_visual_result(image: np.ndarray, result: dict) -> np.ndarray:
    """把识别结果画到原图上。"""
    # 复制一份图片做绘制。 
    rendered = image.copy()
    # 取检测框。 
    box = result.get("box")
    # 取关键点。 
    landmarks = result.get("landmark") or []
    # 取 top1。 
    top1 = result.get("top5", [{}])[0] if result.get("top5") else None
    # 如果没有框，就直接返回原图。 
    if not box:
        draw_chinese_text(
            rendered,
            "未检测到人脸",
            (18, 18),
            24,
            (255, 255, 255),
            (60, 76, 94),
        )
        return rendered
    # 取框坐标。 
    x1, y1, x2, y2 = [int(value) for value in box]
    # 判断是否识别成功。 
    person_name = str(top1.get("name")) if top1 else "未识别"
    # 取分数。 
    score = float(top1.get("score", 0.0)) if top1 else 0.0
    # 绿色表示识别成功。 
    color = (24, 160, 88) if top1 else (40, 80, 220)
    # 绘制边界框。 
    cv2.rectangle(rendered, (x1, y1), (x2, y2), color, 3, cv2.LINE_AA)
    # 绘制相对关键点到原图。 
    if landmarks:
        draw_landmarks(rendered, landmarks, offset=(x1, y1))
    # 拼接标签。 
    label = f"{person_name} {score:.3f}"
    # 在框上方画中文标签。 
    draw_chinese_text(
        rendered,
        label,
        (max(10, x1), max(10, y1 - 36)),
        24,
        (255, 255, 255),
        color,
    )
    # 在左上角补一行说明。 
    draw_chinese_text(
        rendered,
        f"检测到 {int(result.get('face_count', 0))} 张人脸",
        (16, 16),
        22,
        (255, 255, 255),
        (24, 36, 56),
    )
    return rendered


def main() -> None:
    """命令行入口。"""
    # 创建参数解析器。 
    parser = argparse.ArgumentParser(description="直接运行的人脸识别可视化脚本")
    # 输入图片默认使用同目录 test.png。 
    parser.add_argument("--image", default=str(CURRENT_DIR / "test.png"), help="输入图片路径")
    # 输出图片默认保存到同目录 test_result.png。 
    parser.add_argument("--output", default=str(CURRENT_DIR / "test_result.png"), help="输出图片路径")
    # 模型名默认 r18。 
    parser.add_argument("--model", default="r18", help="识别模型名称，默认 r18")
    # 解析命令行。 
    args = parser.parse_args()

    # 解析输入路径。 
    input_path = Path(args.image).resolve()
    # 解析输出路径。 
    output_path = Path(args.output).resolve()
    # 如果输入图片不存在就直接报错。 
    if not input_path.exists():
        raise FileNotFoundError(f"未找到输入图片: {input_path}")

    # 读取原图。 
    image = read_image(input_path)
    # 读图失败时直接报错。 
    if image is None:
        raise RuntimeError(f"无法读取图片: {input_path}")

    # 创建识别器，默认使用 facelib，不影响正式的人脸注册。 
    recognizer = FaceRecognizer(model_name=args.model)
    # 初始化模型。 
    recognizer.init()
    # 执行识别。 
    result = recognizer.recognize(image)
    # 画出可视化结果。 
    rendered = draw_visual_result(image, result)
    # 保存输出图。 
    save_image(output_path, rendered)

    # 控制台输出结果，方便快速确认。 
    print("input:", input_path)
    print("output:", output_path)
    print("result:", result)


if __name__ == "__main__":
    # 运行入口。 
    main()
