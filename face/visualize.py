from __future__ import annotations

"""人脸可视化工具。"""

# 导入标准库路径工具。 
from pathlib import Path

# 导入 OpenCV。 
import cv2
# 导入 NumPy。 
import numpy as np
# 导入 PIL 图片对象。 
from PIL import Image
# 导入 PIL 画笔。 
from PIL import ImageDraw
# 导入 PIL 字体。 
from PIL import ImageFont


def resolve_font_path() -> Path | None:
    """解析当前系统可用的中文字体。"""
    # 常见的跨平台中文字体候选路径。 
    candidates = [
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/Hiragino Sans GB.ttc"),
        Path("/Library/Fonts/Arial Unicode.ttf"),
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/msyhbd.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
        Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
    ]
    # 返回第一个存在的字体路径。 
    for candidate in candidates:
        if candidate.exists():
            return candidate
    # 一个都没找到就返回空。 
    return None


def draw_chinese_text(
    image: np.ndarray,
    text: str,
    position: tuple[int, int],
    font_size: int,
    text_color: tuple[int, int, int],
    background_color: tuple[int, int, int] | None = None,
) -> np.ndarray:
    """在图片上绘制中文文本。"""
    # 先找系统字体。 
    font_path = resolve_font_path()
    # 如果找不到字体，就回退到 OpenCV 英文文本。 
    if font_path is None:
        cv2.putText(
            image,
            text,
            position,
            cv2.FONT_HERSHEY_SIMPLEX,
            max(font_size / 34.0, 0.6),
            text_color,
            2,
            cv2.LINE_AA,
        )
        return image
    # 把 BGR 图转成 RGB，交给 PIL 处理。 
    pil_image = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    # 创建画笔。 
    drawer = ImageDraw.Draw(pil_image)
    # 加载字体。 
    font = ImageFont.truetype(str(font_path), font_size)
    # 计算文本边界。 
    left, top, right, bottom = drawer.textbbox(position, text, font=font)
    # 如果传了背景色，就先画底色。 
    if background_color is not None:
        drawer.rounded_rectangle(
            (left - 8, top - 4, right + 8, bottom + 4),
            radius=8,
            fill=(background_color[2], background_color[1], background_color[0]),
        )
    # 绘制文字。 
    drawer.text(position, text, font=font, fill=(text_color[2], text_color[1], text_color[0]))
    # 转回 BGR。 
    rendered = cv2.cvtColor(np.asarray(pil_image), cv2.COLOR_RGB2BGR)
    # 覆盖原图。 
    image[:, :] = rendered
    return image


def draw_landmarks(
    image: np.ndarray,
    landmarks: list[list[int]] | list[tuple[int, int]] | np.ndarray,
    offset: tuple[int, int] = (0, 0),
) -> np.ndarray:
    """在图片上绘制 5 点关键点。"""
    # 统一为 NumPy 数组。 
    points = np.asarray(landmarks, dtype=np.int32).reshape(-1, 2)
    # 预设关键点颜色。 
    colors = [(255, 99, 71), (34, 197, 94), (59, 130, 246), (250, 204, 21), (168, 85, 247)]
    # 遍历每个关键点。 
    for index, point in enumerate(points):
        # 计算实际坐标。 
        point_x = int(point[0] + offset[0])
        # 计算实际坐标。 
        point_y = int(point[1] + offset[1])
        # 画圆。 
        cv2.circle(image, (point_x, point_y), 4, colors[index % len(colors)], -1, cv2.LINE_AA)
        # 画序号。 
        cv2.putText(
            image,
            str(index + 1),
            (point_x + 5, point_y - 5),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            colors[index % len(colors)],
            1,
            cv2.LINE_AA,
        )
    return image
