from __future__ import annotations

"""纯 ONNX Runtime 版的人脸识别入口。"""

# 导入标准库里的路径工具，统一处理 Win、Ubuntu、macOS 的路径。 
from pathlib import Path
# 导入类型注解，方便外部调用时看清参数结构。 
from typing import Any, Iterable, Sequence

# 导入 OpenCV，用来做图片预处理和绘制。 
import cv2
# 导入 NumPy，用来做矩阵计算和图片读写兼容。 
import numpy as np
# 导入 ONNX Runtime，整个推理链路都只走它。 
import onnxruntime as ort

# 复用现有的人脸对齐工具，这个文件本身不依赖 PyTorch。
# 兼容两种运行方式：
# 1) 作为包导入（from face import face_api）
# 2) 直接脚本导入（from face_api import ...）
try:
    from . import align as face_align
except ImportError:
    import align as face_align


# 记录当前工程根目录，后续统一用绝对路径拼接资源。 
PROJECT_ROOT = Path(__file__).resolve().parent
# 默认的人脸图库目录，兼容原有 facelib 目录结构。 
DEFAULT_FACELIB_PATH = PROJECT_ROOT / "facelib"
# 默认的检测模型路径，使用已经导出的 ONNX 模型。 
DEFAULT_DETECTOR_WEIGHT_PATH = PROJECT_ROOT / "models" / "detector.onnx"
# 默认的识别模型路径映射，使用已经导出的 ONNX 模型。 
DEFAULT_RECOGNIZER_WEIGHT_PATHS = {
    "r18": PROJECT_ROOT / "models" / "recognizer_r18.onnx",
    "r100": PROJECT_ROOT / "models" / "recognizer_r100.onnx",
}
# 允许读取的图片后缀名集合。 
SUPPORTED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
# 默认检测批大小，默认保守一点方便 CPU 运行。 
DEFAULT_DET_BATCH_SIZE = 8
# 默认识别批大小，默认保守一点方便 CPU 运行。 
DEFAULT_REC_BATCH_SIZE = 32
# 默认检测输入尺寸，和导出时保持一致。 
DEFAULT_DET_IMAGE_SIZE = 640


def read_image(image: Any) -> np.ndarray | None:
    """读取输入图片，兼容 numpy 数组、中文路径和三平台路径。"""
    # 如果外部已经传了 numpy 数组，就直接返回。 
    if isinstance(image, np.ndarray):
        return image
    # 如果传空值，直接返回空。 
    if image is None:
        return None
    # 把输入统一转成 Path，兼容 str 和 Path。 
    image_path = Path(image)
    # 路径不存在就直接返回空。 
    if not image_path.exists():
        return None
    # 用 NumPy 从文件直接读取字节，兼容中文路径。 
    data = np.fromfile(str(image_path), dtype=np.uint8)
    # 读不到字节就返回空。 
    if data.size == 0:
        return None
    # 用 OpenCV 解码图片。 
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def save_image(image_path: Path | str, image: np.ndarray) -> Path:
    """保存图片，兼容中文路径。"""
    # 统一转成 Path。 
    path = Path(image_path)
    # 先确保父目录存在。 
    path.parent.mkdir(parents=True, exist_ok=True)
    # 自动推断后缀名，默认用 jpg。 
    suffix = path.suffix.lower() or ".jpg"
    # 规范化扩展名格式。 
    extension = suffix if suffix.startswith(".") else f".{suffix}"
    # 用 OpenCV 编码成二进制。 
    ok, encoded = cv2.imencode(extension, image)
    # 编码失败直接抛错，避免静默失败。 
    if not ok:
        raise ValueError(f"Failed to encode image for {path}")
    # 用 tofile 写入，兼容中文路径。 
    encoded.tofile(str(path))
    # 返回最终写入的路径。 
    return path


def _resolve_ort_providers(prefer_cuda: bool = False) -> list[str]:
    """解析 ONNX Runtime 执行提供者。"""
    # 先取出当前环境里可用的 provider。 
    available = set(ort.get_available_providers())
    # 如果调用方希望优先用 CUDA，且环境里存在 CUDA provider，就优先它。 
    if prefer_cuda and "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    # 其他情况下都回落到 CPU，保证跨平台都能跑。 
    return ["CPUExecutionProvider"]


def _create_session(model_path: Path | str, prefer_cuda: bool = False) -> ort.InferenceSession:
    """创建 ONNX Runtime 会话。"""
    # 统一成 Path，后面方便做存在性检查。 
    resolved_path = Path(model_path)
    # 模型文件不存在时直接抛错，方便启动期尽早发现问题。 
    if not resolved_path.exists():
        raise FileNotFoundError(f"Model file not found: {resolved_path}")
    # 创建 SessionOptions，打开图优化。 
    options = ort.SessionOptions()
    # 打开最强图优化。 
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    # 创建推理会话。 
    return ort.InferenceSession(
        str(resolved_path),
        sess_options=options,
        providers=_resolve_ort_providers(prefer_cuda=prefer_cuda),
    )


def _letterbox(
    image: np.ndarray,
    new_shape: int = DEFAULT_DET_IMAGE_SIZE,
    color: tuple[int, int, int] = (114, 114, 114),
) -> tuple[np.ndarray, tuple[float, float], tuple[float, float]]:
    """做和 YOLO 系列一致的缩放加补边。"""
    # 取出原图高宽。 
    original_height, original_width = image.shape[:2]
    # 统一目标尺寸。 
    if isinstance(new_shape, int):
        target_height, target_width = new_shape, new_shape
    else:
        target_height, target_width = new_shape
    # 计算缩放比例。 
    scale = min(target_width / max(original_width, 1), target_height / max(original_height, 1))
    # 计算缩放后的高宽。 
    resized_width = int(round(original_width * scale))
    resized_height = int(round(original_height * scale))
    # 计算左右上下需要补的像素。 
    pad_width = target_width - resized_width
    pad_height = target_height - resized_height
    # 取一半作为左右和上下补边。 
    pad_left = pad_width / 2
    pad_top = pad_height / 2
    # 如果尺寸变化了，就先缩放。 
    if (resized_width, resized_height) != (original_width, original_height):
        resized = cv2.resize(image, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    else:
        resized = image.copy()
    # 计算整数补边尺寸。 
    top = int(round(pad_top - 0.1))
    bottom = int(round(pad_top + 0.1))
    left = int(round(pad_left - 0.1))
    right = int(round(pad_left + 0.1))
    # 做补边得到网络输入图。 
    padded = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
    # 返回补边结果、缩放比例和补边偏移。 
    return padded, (scale, scale), (left, top)


def _clip_box(box: np.ndarray, image_shape: tuple[int, int, int]) -> np.ndarray:
    """把边界框裁到原图范围内。"""
    # 复制一份，避免修改外部引用。 
    clipped = box.astype(np.float32).copy()
    # 裁剪 x 坐标。 
    clipped[[0, 2]] = np.clip(clipped[[0, 2]], 0, image_shape[1])
    # 裁剪 y 坐标。 
    clipped[[1, 3]] = np.clip(clipped[[1, 3]], 0, image_shape[0])
    # 返回裁剪后的框。 
    return clipped


def _scale_box_to_original(
    box: np.ndarray,
    ratio: tuple[float, float],
    pad: tuple[float, float],
    image_shape: tuple[int, int, int],
) -> np.ndarray:
    """把检测框从 letterbox 坐标映射回原图坐标。"""
    # 复制输入框，避免原地污染。 
    scaled = box.astype(np.float32).copy()
    # 去掉左右补边。 
    scaled[[0, 2]] -= float(pad[0])
    # 去掉上下补边。 
    scaled[[1, 3]] -= float(pad[1])
    # 按缩放比例还原回原图。 
    scaled[[0, 2]] /= max(float(ratio[0]), 1e-12)
    # 按缩放比例还原回原图。 
    scaled[[1, 3]] /= max(float(ratio[1]), 1e-12)
    # 最后裁到原图范围。 
    return _clip_box(scaled, image_shape)


def _scale_landmarks_to_original(
    landmarks: np.ndarray,
    ratio: tuple[float, float],
    pad: tuple[float, float],
    image_shape: tuple[int, int, int],
) -> np.ndarray:
    """把关键点从 letterbox 坐标映射回原图坐标。"""
    # 复制一份关键点数组。 
    scaled = landmarks.astype(np.float32).copy().reshape(-1, 2)
    # 去掉左右补边。 
    scaled[:, 0] -= float(pad[0])
    # 去掉上下补边。 
    scaled[:, 1] -= float(pad[1])
    # 按比例还原 x。 
    scaled[:, 0] /= max(float(ratio[0]), 1e-12)
    # 按比例还原 y。 
    scaled[:, 1] /= max(float(ratio[1]), 1e-12)
    # 裁剪到原图范围。 
    scaled[:, 0] = np.clip(scaled[:, 0], 0, image_shape[1])
    # 裁剪到原图范围。 
    scaled[:, 1] = np.clip(scaled[:, 1], 0, image_shape[0])
    # 返回一维关键点数组。 
    return scaled.reshape(-1)


def _xywh_to_xyxy(boxes: np.ndarray) -> np.ndarray:
    """把中心点宽高格式转成左上右下格式。"""
    # 创建输出数组。 
    converted = boxes.astype(np.float32).copy()
    # 计算左上 x。 
    converted[:, 0] = boxes[:, 0] - boxes[:, 2] / 2
    # 计算左上 y。 
    converted[:, 1] = boxes[:, 1] - boxes[:, 3] / 2
    # 计算右下 x。 
    converted[:, 2] = boxes[:, 0] + boxes[:, 2] / 2
    # 计算右下 y。 
    converted[:, 3] = boxes[:, 1] + boxes[:, 3] / 2
    # 返回转换结果。 
    return converted


def _box_iou(box: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """计算一个框和多个框之间的 IoU。"""
    # 计算交集左上角。 
    inter_x1 = np.maximum(box[0], boxes[:, 0])
    # 计算交集左上角。 
    inter_y1 = np.maximum(box[1], boxes[:, 1])
    # 计算交集右下角。 
    inter_x2 = np.minimum(box[2], boxes[:, 2])
    # 计算交集右下角。 
    inter_y2 = np.minimum(box[3], boxes[:, 3])
    # 计算交集宽。 
    inter_w = np.maximum(0.0, inter_x2 - inter_x1)
    # 计算交集高。 
    inter_h = np.maximum(0.0, inter_y2 - inter_y1)
    # 计算交集面积。 
    inter_area = inter_w * inter_h
    # 计算当前框面积。 
    box_area = np.maximum(0.0, box[2] - box[0]) * np.maximum(0.0, box[3] - box[1])
    # 计算候选框面积。 
    boxes_area = np.maximum(0.0, boxes[:, 2] - boxes[:, 0]) * np.maximum(0.0, boxes[:, 3] - boxes[:, 1])
    # 计算并集面积。 
    union_area = np.maximum(box_area + boxes_area - inter_area, 1e-12)
    # 返回 IoU。 
    return inter_area / union_area


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thres: float = 0.5) -> list[int]:
    """做一个纯 NumPy 的 NMS。"""
    # 如果没有框就直接返回空列表。 
    if boxes.size == 0 or scores.size == 0:
        return []
    # 按分数从高到低排序。 
    order = scores.argsort()[::-1]
    # 准备保留索引。 
    keep: list[int] = []
    # 只要还有候选框就继续循环。 
    while order.size > 0:
        # 当前最高分的框索引。 
        current = int(order[0])
        # 先把它保留下来。 
        keep.append(current)
        # 如果只剩这一个框，就结束。 
        if order.size == 1:
            break
        # 计算当前框和剩余框的 IoU。 
        ious = _box_iou(boxes[current], boxes[order[1:]])
        # 只保留 IoU 不超过阈值的候选框。 
        order = order[1:][ious <= iou_thres]
    # 返回保留结果。 
    return keep


def _normalize_feature(feature: np.ndarray) -> np.ndarray:
    """做人脸特征的 L2 归一化。"""
    # 拉平成一维 float32。 
    vector = np.asarray(feature, dtype=np.float32).reshape(-1)
    # 计算范数。 
    norm = np.linalg.norm(vector)
    # 如果范数为 0，就直接返回原值。 
    if norm <= 0:
        return vector
    # 返回归一化结果。 
    return vector / norm


def _empty_result() -> dict[str, Any]:
    """返回统一的空识别结果。"""
    # 返回空结构，方便前端和后端直接判断。 
    return {"top5": [], "box": None, "landmark": [], "face_count": 0}


def load_detector(weight_path: Path | str, prefer_cuda: bool = False) -> ort.InferenceSession:
    """加载 ONNX 检测模型。"""
    # 直接创建 ONNX Runtime 会话。 
    return _create_session(weight_path, prefer_cuda=prefer_cuda)


def load_recognizer(model_name: str, weight_path: Path | str, prefer_cuda: bool = False) -> ort.InferenceSession:
    """加载 ONNX 识别模型。"""
    # 如果模型名不在内置列表里，就让调用方尽早发现。 
    if model_name not in DEFAULT_RECOGNIZER_WEIGHT_PATHS:
        raise ValueError(f"Unsupported model_name: {model_name}")
    # 直接创建 ONNX Runtime 会话。 
    return _create_session(weight_path, prefer_cuda=prefer_cuda)


def _prepare_face_image(face_image: np.ndarray) -> np.ndarray:
    """把对齐后的人脸转成识别模型输入。"""
    # 统一缩放到 112x112。 
    resized = cv2.resize(face_image, (112, 112), interpolation=cv2.INTER_LINEAR)
    # 从 BGR 转成 RGB。 
    rgb_image = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    # 调整成 CHW 格式。 
    chw_image = np.transpose(rgb_image, (2, 0, 1)).astype(np.float32)
    # 归一化到 [-1, 1]。 
    normalized = (chw_image / 255.0 - 0.5) / 0.5
    # 增加 batch 维度。 
    return normalized[None, ...]


def extract_feature(recognizer_model: ort.InferenceSession, face_image: np.ndarray) -> np.ndarray:
    """提取单张人脸的特征。"""
    # 获取输入名。 
    input_name = recognizer_model.get_inputs()[0].name
    # 执行 ONNX 推理。 
    outputs = recognizer_model.run(None, {input_name: _prepare_face_image(face_image)})
    # 拉平后返回。 
    return np.asarray(outputs[0], dtype=np.float32).reshape(-1)


def extract_feature_batch(
    recognizer_model: ort.InferenceSession,
    face_images: Sequence[np.ndarray],
    batch_size: int = DEFAULT_REC_BATCH_SIZE,
) -> np.ndarray:
    """批量提取多张人脸的特征。"""
    # 如果没有输入，就返回空矩阵。 
    if not face_images:
        return np.empty((0, 0), dtype=np.float32)
    # 获取模型输入名。 
    input_name = recognizer_model.get_inputs()[0].name
    # 兜底批大小。 
    batch_size = max(1, int(batch_size or len(face_images)))
    # 准备收集输出。 
    outputs: list[np.ndarray] = []
    # 分批送入模型。 
    for start in range(0, len(face_images), batch_size):
        # 取当前批次。 
        batch_images = face_images[start:start + batch_size]
        # 拼成 batch。 
        batch_array = np.concatenate([_prepare_face_image(image) for image in batch_images], axis=0)
        # 执行推理。 
        batch_output = recognizer_model.run(None, {input_name: batch_array})[0]
        # 收集输出。 
        outputs.append(np.asarray(batch_output, dtype=np.float32))
    # 拼回完整结果。 
    return np.concatenate(outputs, axis=0)


def detect_images(
    detector: ort.InferenceSession,
    images: Sequence[np.ndarray],
    img_size: int = DEFAULT_DET_IMAGE_SIZE,
    conf_thres: float = 0.6,
    iou_thres: float = 0.5,
    draw_result: bool = True,
) -> list[dict[str, Any]]:
    """批量做人脸检测。"""
    # 如果没有输入图片，就直接返回空。 
    if not images:
        return []
    # 取得模型输入名。 
    input_name = detector.get_inputs()[0].name
    # 保存原图副本，避免外部对象被改动。 
    original_images = [image.copy() for image in images]
    # 只有在需要时才创建可视化底图。 
    rendered_images = [image.copy() if draw_result else None for image in original_images]
    # 预处理后的网络输入列表。 
    network_inputs: list[np.ndarray] = []
    # 保存每张图的缩放信息，后续映射回原图。 
    ratio_pads: list[tuple[tuple[float, float], tuple[float, float]]] = []
    # 逐张做 letterbox。 
    for original_image in original_images:
        # 得到网络输入图和映射参数。 
        network_input, ratio, pad = _letterbox(original_image, new_shape=img_size)
        # 转成 NCHW 并归一化。 
        network_inputs.append(network_input.transpose(2, 0, 1).astype(np.float32) / 255.0)
        # 保存映射参数。 
        ratio_pads.append((ratio, pad))
    # 拼成真正的 batch 输入。 
    input_tensor = np.stack(network_inputs, axis=0)
    # 执行 ONNX 推理。 
    predictions = detector.run(None, {input_name: input_tensor})[0]
    # 统一成三维数组。 
    if predictions.ndim == 2:
        predictions = predictions[None, ...]
    # 用来收集所有图片的结果。 
    results: list[dict[str, Any]] = []
    # 遍历每一张图的预测结果。 
    for original_image, rendered_image, ratio_pad, prediction in zip(original_images, rendered_images, ratio_pads, predictions):
        # 结果里的人脸列表。 
        faces: list[dict[str, Any]] = []
        # 没有预测时直接返回空。 
        if prediction.size == 0:
            results.append({"image": original_image, "show_image": rendered_image, "data": faces})
            continue
        # 先按目标置信度粗筛。 
        candidate_mask = prediction[:, 4] > conf_thres
        # 只保留候选项。 
        filtered = prediction[candidate_mask]
        # 粗筛后为空就直接返回空。 
        if filtered.size == 0:
            results.append({"image": original_image, "show_image": rendered_image, "data": faces})
            continue
        # 取出类别分数。 
        class_scores = filtered[:, 15:] if filtered.shape[1] > 15 else np.ones((filtered.shape[0], 1), dtype=np.float32)
        # 取出每个候选项的最佳类别。 
        best_class_indices = np.argmax(class_scores, axis=1)
        # 取出最佳类别分数。 
        best_class_scores = class_scores[np.arange(filtered.shape[0]), best_class_indices]
        # 计算最终分数，保持和原 PyTorch NMS 逻辑一致。 
        final_scores = filtered[:, 4] * best_class_scores
        # 再按最终分数过滤一次。 
        score_mask = final_scores > conf_thres
        # 没有有效结果就直接返回空。 
        if not np.any(score_mask):
            results.append({"image": original_image, "show_image": rendered_image, "data": faces})
            continue
        # 应用最终分数过滤。 
        filtered = filtered[score_mask]
        # 应用分数过滤。 
        final_scores = final_scores[score_mask]
        # 取出框并转成 xyxy。 
        boxes = _xywh_to_xyxy(filtered[:, :4])
        # 取出关键点。 
        landmarks_batch = filtered[:, 5:15]
        # 做 NMS。 
        keep_indices = _nms(boxes, final_scores, iou_thres=iou_thres)
        # 逐个处理保留下来的框。 
        for keep_index in keep_indices:
            # 取出 letterbox 坐标系中的框。 
            letterbox_box = boxes[keep_index]
            # 映射回原图坐标。 
            original_box = _scale_box_to_original(letterbox_box, ratio_pad[0], ratio_pad[1], original_image.shape)
            # 映射回原图坐标。 
            original_landmarks = _scale_landmarks_to_original(
                landmarks_batch[keep_index],
                ratio_pad[0],
                ratio_pad[1],
                original_image.shape,
            )
            # 转成整数坐标，方便后续裁剪。 
            x1, y1, x2, y2 = [int(round(float(value))) for value in original_box]
            # 如果框无效，就跳过。 
            if x2 <= x1 or y2 <= y1:
                continue
            # 按框裁出人脸区域。 
            cropped_image = original_image[y1:y2, x1:x2]
            # 如果裁出来是空，就跳过。 
            if cropped_image.size == 0:
                continue
            # 整理关键点数组。 
            keypoints = np.asarray(original_landmarks, dtype=np.float32).reshape(-1, 2)[:5]
            # 转成相对裁剪框左上角的关键点。 
            cropped_keypoints = keypoints - np.array([x1, y1], dtype=np.float32)
            # 做标准 ArcFace 对齐。 
            aligned_face = face_align.norm_crop(cropped_image, landmark=cropped_keypoints)
            # 收集单张脸结果。 
            faces.append(
                {
                    "box": [float(x1), float(y1), float(x2), float(y2)],
                    "conf": float(final_scores[keep_index]),
                    "landmarks": original_landmarks.astype(np.float32).reshape(-1).tolist(),
                    "face_align": aligned_face,
                }
            )
            # 如果需要可视化，就直接画到图上。 
            if draw_result and rendered_image is not None:
                # 画边界框。 
                cv2.rectangle(rendered_image, (x1, y1), (x2, y2), (0, 220, 0), 2, cv2.LINE_AA)
                # 画置信度文本。 
                cv2.putText(
                    rendered_image,
                    f"{float(final_scores[keep_index]):.3f}",
                    (x1, max(18, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.55,
                    (255, 255, 255),
                    2,
                    cv2.LINE_AA,
                )
                # 画 5 个关键点。 
                for point_index, point in enumerate(keypoints):
                    # 取整当前关键点。 
                    point_x = int(round(float(point[0])))
                    # 取整当前关键点。 
                    point_y = int(round(float(point[1])))
                    # 画圆点。 
                    cv2.circle(rendered_image, (point_x, point_y), 2, (0, 255, 255), -1, cv2.LINE_AA)
                    # 画序号。 
                    cv2.putText(
                        rendered_image,
                        str(point_index),
                        (point_x + 3, point_y - 3),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.35,
                        (255, 255, 0),
                        1,
                        cv2.LINE_AA,
                    )
        # 收集当前图片结果。 
        results.append({"image": original_image, "show_image": rendered_image, "data": faces})
    # 返回所有图片的检测结果。 
    return results


def detect_image(
    detector: ort.InferenceSession,
    image: np.ndarray,
    img_size: int = DEFAULT_DET_IMAGE_SIZE,
    conf_thres: float = 0.6,
    iou_thres: float = 0.5,
    draw_result: bool = True,
) -> dict[str, Any]:
    """单张图片做人脸检测。"""
    # 直接复用批量接口的第一项结果。 
    return detect_images(
        detector,
        [image],
        img_size=img_size,
        conf_thres=conf_thres,
        iou_thres=iou_thres,
        draw_result=draw_result,
    )[0]


def detect_faces(detector: ort.InferenceSession, image: np.ndarray) -> list[dict[str, Any]]:
    """检测图片里的所有人脸。"""
    # 直接返回不绘制时的数据。 
    return detect_image(detector, image, draw_result=False)["data"]


def detect_faces_batch(detector: ort.InferenceSession, images: Sequence[np.ndarray]) -> list[list[dict[str, Any]]]:
    """批量检测图片里的人脸。"""
    # 直接把批量结果里的 data 提取出来。 
    return [result["data"] for result in detect_images(detector, images, draw_result=False)]


class FaceRecognizer:
    """对外的人脸识别类。"""

    def __init__(
        self,
        model_name: str = "r18",
        facelib_path: Path | str | None = None,
        face_entries: Sequence[dict[str, Any]] | None = None,
        top_k: int = 5,
        det_batch_size: int = DEFAULT_DET_BATCH_SIZE,
        rec_batch_size: int = DEFAULT_REC_BATCH_SIZE,
        prefer_cuda: bool = False,
        detector_weight_path: Path | str | None = None,
        recognizer_weight_path: Path | str | None = None,
    ) -> None:
        # 只支持内置模型名，避免运行时出现歧义。 
        if model_name not in DEFAULT_RECOGNIZER_WEIGHT_PATHS:
            raise ValueError(f"Unsupported model_name: {model_name}")
        # 保存工程目录。 
        self.project_root = PROJECT_ROOT
        # 保存模型名。 
        self.model_name = model_name
        # 保存 facelib 路径。 
        self.facelib_path = Path(facelib_path) if facelib_path is not None else DEFAULT_FACELIB_PATH
        # 保存外部传入的人脸图库记录。 
        self.face_entries = list(face_entries or [])
        # 保存 top_k。 
        self.top_k = max(1, int(top_k))
        # 保存检测批大小。 
        self.det_batch_size = max(1, int(det_batch_size))
        # 保存识别批大小。 
        self.rec_batch_size = max(1, int(rec_batch_size))
        # 保存是否优先 CUDA。 
        self.prefer_cuda = bool(prefer_cuda)
        # 解析检测模型路径。 
        self.detector_weight_path = Path(detector_weight_path) if detector_weight_path else DEFAULT_DETECTOR_WEIGHT_PATH
        # 解析识别模型路径。 
        self.recognizer_weight_path = (
            Path(recognizer_weight_path)
            if recognizer_weight_path
            else DEFAULT_RECOGNIZER_WEIGHT_PATHS[model_name]
        )
        # 记录初始化状态。 
        self._initialized = False
        # 检测器会话占位。 
        self._detector: ort.InferenceSession | None = None
        # 识别器会话占位。 
        self._recognizer: ort.InferenceSession | None = None
        # 内存里的人脸库记录。 
        self._face_library: list[dict[str, Any]] = []
        # 人脸库名称索引。 
        self._face_library_names: list[str] = []
        # 人脸库特征矩阵。 
        self._face_library_matrix = np.empty((0, 0), dtype=np.float32)

    def init(self) -> "FaceRecognizer":
        """主动初始化识别器。"""
        # 加载检测器。 
        self._detector = load_detector(self.detector_weight_path, prefer_cuda=self.prefer_cuda)
        # 加载识别器。 
        self._recognizer = load_recognizer(
            self.model_name,
            self.recognizer_weight_path,
            prefer_cuda=self.prefer_cuda,
        )
        # 初次构建人脸库。 
        self.reload_face_library(self.face_entries or None)
        # 标记初始化完成。 
        self._initialized = True
        # 返回自身方便链式调用。 
        return self

    def reload_face_library(self, face_entries: Sequence[dict[str, Any]] | None = None) -> "FaceRecognizer":
        """重建内存中的人脸库。"""
        # 如果外部传入了新的人脸记录，就覆盖当前记录。 
        if face_entries is not None:
            self.face_entries = list(face_entries)
        # 如果模型还没初始化，就先初始化。 
        if self._detector is None or self._recognizer is None:
            self._detector = load_detector(self.detector_weight_path, prefer_cuda=self.prefer_cuda)
            self._recognizer = load_recognizer(
                self.model_name,
                self.recognizer_weight_path,
                prefer_cuda=self.prefer_cuda,
            )
        # 真正重建人脸库。 
        self._face_library = self._build_face_library()
        # 重建名称索引和矩阵索引。 
        self._build_face_library_index()
        # 标记初始化完成。 
        self._initialized = True
        # 返回自身。 
        return self

    def recognize(self, image: Any) -> dict[str, Any]:
        """识别单张图片里的主人脸。"""
        # 如果还没初始化，就补做初始化。 
        if not self._initialized:
            self.init()
        # 读取输入图片。 
        image_array = read_image(image)
        # 如果读图失败，就返回空结果。 
        if image_array is None:
            return _empty_result()
        # 返回不包含特征的标准结果。 
        return self._recognize_image_array(image_array, include_feature=False)

    def recognize_with_feature(self, image: Any) -> dict[str, Any]:
        """识别单张图片，并返回归一化后的主人脸特征。"""
        # 如果还没初始化，就补做初始化。 
        if not self._initialized:
            self.init()
        # 读取输入图片。 
        image_array = read_image(image)
        # 如果读图失败，就返回空结果。 
        if image_array is None:
            return _empty_result()
        # 返回包含特征的结果。 
        return self._recognize_image_array(image_array, include_feature=True)

    def _recognize_image_array(self, image_array: np.ndarray, include_feature: bool) -> dict[str, Any]:
        """识别单张图片数组。"""
        # 检测图片里的所有人脸。 
        faces = detect_faces(self._detector, image_array)
        # 只挑置信度最高的那张脸。 
        selected_face = self._select_best_face(faces)
        # 没有人脸时返回空结果。 
        if selected_face is None:
            return _empty_result()
        # 提取查询特征。 
        query_feature = extract_feature(self._recognizer, selected_face["face_align"])
        # 找出最相似的结果。 
        top_matches = self._find_top_matches(query_feature)
        # 组装统一结构。 
        result = {
            "top5": top_matches,
            "box": self._to_int_box(selected_face["box"]),
            "landmark": self._to_relative_landmarks(selected_face["landmarks"], selected_face["box"]),
            "face_count": len(faces),
        }
        # 只有调用方明确需要时才附带特征。 
        if include_feature:
            result["feature_vector"] = _normalize_feature(query_feature).astype(np.float32).tolist()
        # 返回结果。 
        return result

    def recognize_batch(self, images: Sequence[Any]) -> list[dict[str, Any]]:
        """批量识别多张图片里的主人脸。"""
        # 如果还没初始化，就先初始化。 
        if not self._initialized:
            self.init()
        # 没有输入就直接返回空列表。 
        if not images:
            return []
        # 先准备默认结果列表。 
        results = [_empty_result() for _ in range(len(images))]
        # 保存有效图片索引。 
        valid_indices: list[int] = []
        # 保存有效图片数据。 
        valid_images: list[np.ndarray] = []
        # 先把能读出来的图片筛出来。 
        for index, image in enumerate(images):
            # 读取单张图。 
            image_array = read_image(image)
            # 读图失败就跳过。 
            if image_array is None:
                continue
            # 保存有效索引。 
            valid_indices.append(index)
            # 保存有效图片。 
            valid_images.append(image_array)
        # 如果一张有效图都没有，就直接返回默认结果。 
        if not valid_images:
            return results
        # 保存被选中的主脸。 
        selected_faces: list[tuple[int, dict[str, Any]]] = []
        # 保存每张图的人脸数量。 
        face_counts: dict[int, int] = {}
        # 分批做人脸检测。 
        for start in range(0, len(valid_images), self.det_batch_size):
            # 取当前图片批次。 
            image_batch = valid_images[start:start + self.det_batch_size]
            # 取当前索引批次。 
            index_batch = valid_indices[start:start + self.det_batch_size]
            # 批量检测。 
            faces_batch = detect_faces_batch(self._detector, image_batch)
            # 逐张处理当前批次。 
            for result_index, faces in zip(index_batch, faces_batch):
                # 保存当前图片的人脸数量。 
                face_counts[result_index] = len(faces)
                # 挑出主脸。 
                selected_face = self._select_best_face(faces)
                # 如果有主脸，就收集起来后面统一抽特征。 
                if selected_face is not None:
                    selected_faces.append((result_index, selected_face))
        # 如果没有任何可识别的人脸，就直接返回默认结果。 
        if not selected_faces:
            return results
        # 批量提取查询特征。 
        query_features = extract_feature_batch(
            self._recognizer,
            [selected_face["face_align"] for _, selected_face in selected_faces],
            batch_size=self.rec_batch_size,
        )
        # 批量查 top_k。 
        top_matches_batch = self._find_top_matches_batch(query_features)
        # 回填每张图的结果。 
        for (result_index, selected_face), top_matches in zip(selected_faces, top_matches_batch):
            # 组装单张图结果。 
            results[result_index] = {
                "top5": top_matches,
                "box": self._to_int_box(selected_face["box"]),
                "landmark": self._to_relative_landmarks(selected_face["landmarks"], selected_face["box"]),
                "face_count": face_counts.get(result_index, 0),
            }
        # 返回完整批结果。 
        return results

    def _build_face_library(self) -> list[dict[str, Any]]:
        """扫描外部记录或 facelib，构建内存人脸库。"""
        # 准备最终的人脸条目。 
        face_entries: list[dict[str, Any]] = []
        # 先尝试使用外部传入的 DB 记录。 
        if self.face_entries:
            # 保存清洗后的图片记录。 
            image_entries: list[tuple[str, np.ndarray]] = []
            # 遍历每条外部记录。 
            for face_entry in self.face_entries:
                # 取出名字。 
                name = str(face_entry.get("name", "")).strip()
                # 取出图片路径。 
                image_path = face_entry.get("image_path")
                # 名字或路径缺失时跳过。 
                if not name or not image_path:
                    continue
                # 读取图片。 
                image_array = read_image(image_path)
                # 图片无效就跳过。 
                if image_array is None:
                    continue
                # 收集有效图片记录。 
                image_entries.append((name, image_array))
            # 真正构建特征库。 
            return self._extract_library_features(image_entries)
        # 如果没有外部记录，就回落到 facelib 目录扫描。 
        if not self.facelib_path.exists():
            return face_entries
        # 保存 facelib 里的有效图片。 
        image_entries = []
        # 遍历 facelib 图片。 
        for image_path in self._iter_image_files(self.facelib_path):
            # 读取图片。 
            image_array = read_image(image_path)
            # 图片无效就跳过。 
            if image_array is None:
                continue
            # 用文件名作为人名。 
            image_entries.append((image_path.stem, image_array))
        # 提取 facelib 对应特征。 
        return self._extract_library_features(image_entries)

    def _extract_library_features(self, image_entries: Sequence[tuple[str, np.ndarray]]) -> list[dict[str, Any]]:
        """把一组图片记录变成人脸库特征。"""
        # 如果没有图片记录，就直接返回空。 
        if not image_entries:
            return []
        # 准备最终特征条目。 
        feature_entries: list[dict[str, Any]] = []
        # 分批做人脸检测。 
        for start in range(0, len(image_entries), self.det_batch_size):
            # 取当前批次。 
            batch = image_entries[start:start + self.det_batch_size]
            # 批量检测。 
            faces_batch = detect_faces_batch(self._detector, [image for _, image in batch])
            # 保存当前批次里真正有效的人名。 
            selected_names: list[str] = []
            # 保存当前批次里真正有效的对齐人脸。 
            aligned_faces: list[np.ndarray] = []
            # 按图片顺序逐一处理。 
            for (name, _), faces in zip(batch, faces_batch):
                # 只取主脸。 
                selected_face = self._select_best_face(faces)
                # 没检测到脸就跳过。 
                if selected_face is None:
                    continue
                # 收集名字。 
                selected_names.append(name)
                # 收集对齐后的人脸。 
                aligned_faces.append(selected_face["face_align"])
            # 当前批次没有有效人脸就继续下一批。 
            if not aligned_faces:
                continue
            # 批量提取特征。 
            feature_batch = extract_feature_batch(
                self._recognizer,
                aligned_faces,
                batch_size=self.rec_batch_size,
            )
            # 把名字和特征一一对应起来。 
            for name, feature in zip(selected_names, feature_batch):
                # 收集单条人脸库记录。 
                feature_entries.append({"name": name, "feature": np.asarray(feature, dtype=np.float32)})
        # 返回最终条目。 
        return feature_entries

    def _build_face_library_index(self) -> None:
        """把人脸库转成快速检索矩阵。"""
        # 如果人脸库为空，就重置索引。 
        if not self._face_library:
            self._face_library_names = []
            self._face_library_matrix = np.empty((0, 0), dtype=np.float32)
            return
        # 提取所有名字。 
        self._face_library_names = [str(entry["name"]) for entry in self._face_library]
        # 堆叠归一化后的特征。 
        self._face_library_matrix = np.stack(
            [_normalize_feature(entry["feature"]) for entry in self._face_library],
            axis=0,
        ).astype(np.float32)

    def _find_top_matches(self, query_feature: np.ndarray) -> list[dict[str, Any]]:
        """查单个查询向量的 top_k。"""
        # 复用批量接口后取第一项。 
        return self._find_top_matches_batch(np.asarray(query_feature)[None, :])[0]

    def _find_top_matches_batch(self, query_features: np.ndarray) -> list[list[dict[str, Any]]]:
        """查多个查询向量的 top_k。"""
        # 统一成二维矩阵。 
        query_matrix = np.asarray(query_features, dtype=np.float32)
        # 如果是一维向量，就补成一行。 
        if query_matrix.ndim == 1:
            query_matrix = query_matrix[None, :]
        # 如果人脸库为空，就给每个查询都返回空结果。 
        if self._face_library_matrix.size == 0:
            return [[] for _ in range(query_matrix.shape[0])]
        # 归一化查询向量。 
        query_norm = np.linalg.norm(query_matrix, axis=1, keepdims=True)
        # 防止除零。 
        normalized_query = query_matrix / np.maximum(query_norm, 1e-12)
        # 计算余弦相似度。 
        cosine = np.clip(normalized_query @ self._face_library_matrix.T, -1.0, 1.0)
        # 转成和原项目一致的平方距离。 
        distance = np.maximum(0.0, 2.0 - 2.0 * cosine)
        # 用原项目相同的 logistic 方式转成 0 到 1 的分数。 
        x_value = np.clip(-(distance - 1.40) / 0.2, -100, 100)
        # 得到最终分数。 
        scores = 1.0 / (1.0 + np.exp(-x_value))
        # 计算真正的 top_k。 
        top_k = min(self.top_k, scores.shape[1])
        # 如果 top_k 非法，就返回空。 
        if top_k <= 0:
            return [[] for _ in range(scores.shape[0])]
        # 按分数倒序取 top_k。 
        sort_indices = np.argsort(scores, axis=1)[:, ::-1][:, :top_k]
        # 准备最终输出。 
        top_matches: list[list[dict[str, Any]]] = []
        # 遍历每个查询的排序结果。 
        for row_index, match_indices in enumerate(sort_indices):
            # 组装当前查询的 top_k 列表。 
            current_matches = []
            # 遍历 top_k 索引。 
            for match_index in match_indices:
                # 转成 int 方便索引。 
                resolved_index = int(match_index)
                # 组装单条结果。 
                current_matches.append(
                    {
                        "name": self._face_library_names[resolved_index],
                        "score": float(scores[row_index, resolved_index]),
                    }
                )
            # 收集当前查询的结果。 
            top_matches.append(current_matches)
        # 返回所有结果。 
        return top_matches

    @staticmethod
    def _select_best_face(faces: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
        """从多张检测结果里选出置信度最高的人脸。"""
        # 先统一成列表。 
        faces = list(faces)
        # 没有脸就返回空。 
        if not faces:
            return None
        # 按置信度选最大值。 
        return max(faces, key=lambda item: float(item.get("conf", 0.0)))

    @staticmethod
    def _iter_image_files(directory: Path) -> list[Path]:
        """遍历支持的图片文件，并按文件名排序。"""
        # 过滤目录下的合法图片文件并排序。 
        return sorted(
            [path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_IMAGE_SUFFIXES],
            key=lambda path: path.name,
        )

    @staticmethod
    def _to_int_box(box: Iterable[Any]) -> list[int]:
        """把边界框统一转成整数。"""
        # 对每个坐标做四舍五入后转 int。 
        return [int(round(float(value))) for value in box]

    @classmethod
    def _to_relative_landmarks(cls, landmarks: Iterable[Any], box: Iterable[Any]) -> list[list[int]]:
        """把关键点转换成相对边界框左上角的坐标。"""
        # 先取出框左上角。 
        x1, y1, _, _ = cls._to_int_box(box)
        # 转成列表方便按索引访问。 
        landmark_list = list(landmarks)
        # 准备相对关键点输出。 
        relative_landmarks: list[list[int]] = []
        # 每两个数字是一组关键点。 
        for index in range(0, len(landmark_list), 2):
            # 计算相对 x。 
            x_value = int(round(float(landmark_list[index]) - x1))
            # 计算相对 y。 
            y_value = int(round(float(landmark_list[index + 1]) - y1))
            # 追加当前关键点。 
            relative_landmarks.append([x_value, y_value])
        # 返回最终结果。 
        return relative_landmarks


# 导出公共接口，方便外部直接 import。 
__all__ = [
    "DEFAULT_DETECTOR_WEIGHT_PATH",
    "DEFAULT_FACELIB_PATH",
    "DEFAULT_RECOGNIZER_WEIGHT_PATHS",
    "FaceRecognizer",
    "detect_faces",
    "detect_faces_batch",
    "detect_image",
    "detect_images",
    "extract_feature",
    "extract_feature_batch",
    "load_detector",
    "load_recognizer",
    "read_image",
    "save_image",
]
