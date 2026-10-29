from __future__ import annotations

import base64
import hmac
import json
import math
import os
import re
import statistics
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable
from urllib.parse import parse_qs, urlsplit

MAX_SAMPLE_AGE_SECONDS = 0.5
MAX_FUTURE_SKEW_SECONDS = 0.1
MAX_DISTANCE_METERS = 40.0
TF_WARNING_INTERVAL_SECONDS = 5.0
SENSOR_CLOCK_MAX_OFFSET_SECONDS = 30.0
SENSOR_CLOCK_MAX_JITTER_SECONDS = 0.1
SENSOR_CLOCK_STABLE_SAMPLES = 5
MAX_CLOUD_FUSION_SKEW_SECONDS = 0.1
MAX_POINTCLOUD_SOURCES = 16
MAX_CAMERA_SOURCES = 8
MAX_CAMERA_WIDTH = 1280
MAX_CAMERA_HEIGHT = 720
MAX_CAMERA_FRAME_BYTES = 4 * 1024 * 1024
MAX_CAMERA_FRAME_AGE_SECONDS = 0.5
MIN_CAMERA_CAPTURE_INTERVAL_SECONDS = 0.5
SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]+$")
ROS_TOPIC_PATTERN = re.compile(r"^/[A-Za-z0-9_/-]+$")
ROS_FRAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_/]*$")


def parse_pointcloud_source_specs(
    primary_topic: str,
    primary_sensor_id: str,
    primary_frame_id: str,
    extra_sources_json: str | None = None,
) -> list[dict[str, object]]:
    if not ROS_TOPIC_PATTERN.fullmatch(primary_topic) or "//" in primary_topic:
        raise ValueError("Primary PointCloud2 topic is invalid.")
    if not SOURCE_ID_PATTERN.fullmatch(primary_sensor_id):
        raise ValueError("Primary PointCloud2 sensor ID is invalid.")
    if not ROS_FRAME_PATTERN.fullmatch(primary_frame_id):
        raise ValueError("Primary PointCloud2 frame ID is invalid.")
    sources: list[dict[str, object]] = [
        {
            "id": primary_sensor_id,
            "topic": primary_topic,
            "frame_id": primary_frame_id,
            "coverage": ["forward", "rear"],
            "model_mount": True,
        }
    ]
    if not extra_sources_json or not extra_sources_json.strip():
        return sources
    try:
        extras = json.loads(extra_sources_json)
    except json.JSONDecodeError as error:
        raise ValueError("Supplemental point-cloud source configuration must be valid JSON.") from error
    if not isinstance(extras, list):
        raise ValueError("Supplemental point-cloud sources must be a JSON array.")
    if len(extras) + 1 > MAX_POINTCLOUD_SOURCES:
        raise ValueError(f"At most {MAX_POINTCLOUD_SOURCES} point-cloud sources may be configured.")
    known_ids = {primary_sensor_id}
    known_topics = {primary_topic}
    for index, source in enumerate(extras, start=1):
        if not isinstance(source, dict):
            raise ValueError(f"Supplemental point-cloud source {index} must be an object.")
        source_id = source.get("id")
        topic = source.get("topic")
        frame_id = source.get("frame_id")
        coverage = source.get("coverage")
        if not isinstance(source_id, str) or not SOURCE_ID_PATTERN.fullmatch(source_id):
            raise ValueError(f"Supplemental point-cloud source {index} has an invalid ID.")
        if source_id in known_ids:
            raise ValueError(f"Supplemental point-cloud source ID {source_id!r} is duplicated.")
        if not isinstance(topic, str) or not ROS_TOPIC_PATTERN.fullmatch(topic) or "//" in topic:
            raise ValueError(f"Supplemental point-cloud source {source_id!r} has an invalid topic.")
        if topic in known_topics:
            raise ValueError(f"PointCloud2 topic {topic!r} is configured more than once.")
        if not isinstance(frame_id, str) or not ROS_FRAME_PATTERN.fullmatch(frame_id):
            raise ValueError(f"Supplemental point-cloud source {source_id!r} has an invalid expected frame.")
        if not isinstance(coverage, list) or not coverage or any(
            sector not in {"forward", "rear"} for sector in coverage
        ) or len(set(coverage)) != len(coverage):
            raise ValueError(
                f"Supplemental point-cloud source {source_id!r} must declare unique forward/rear coverage."
            )
        if "model_mount" in source:
            raise ValueError(
                "Only the configured primary MID-360 may use a model-mount fallback."
            )
        sources.append(
            {
                "id": source_id,
                "topic": topic,
                "frame_id": frame_id,
                "coverage": list(coverage),
                "model_mount": False,
            }
        )
        known_ids.add(source_id)
        known_topics.add(topic)
    return sources


def parse_camera_source_specs(camera_sources_json: str | None = None) -> list[dict[str, str]]:
    if not camera_sources_json or not camera_sources_json.strip():
        return []
    try:
        sources = json.loads(camera_sources_json)
    except json.JSONDecodeError as error:
        raise ValueError("Camera source configuration must be valid JSON.") from error
    if not isinstance(sources, list) or len(sources) > MAX_CAMERA_SOURCES:
        raise ValueError(f"Camera source configuration must be an array of at most {MAX_CAMERA_SOURCES} topics.")
    result = []
    seen_topics = set()
    for index, source in enumerate(sources, start=1):
        if not isinstance(source, dict):
            raise ValueError(f"Camera source {index} must be an object.")
        topic = source.get("topic")
        frame_id = source.get("frame_id")
        if not isinstance(topic, str) or not ROS_TOPIC_PATTERN.fullmatch(topic) or "//" in topic:
            raise ValueError(f"Camera source {index} has an invalid topic.")
        if topic in seen_topics:
            raise ValueError(f"Camera topic {topic!r} is configured more than once.")
        if not isinstance(frame_id, str) or not ROS_FRAME_PATTERN.fullmatch(frame_id):
            raise ValueError(f"Camera source {topic!r} has an invalid expected frame.")
        result.append({"topic": topic, "frame_id": frame_id})
        seen_topics.add(topic)
    return result


class CameraFrameCache:
    def __init__(self, source_specs: list[dict[str, str]]):
        self._specs = {source["topic"]: dict(source) for source in source_specs}
        self._frames: dict[str, dict[str, object]] = {}
        self._errors: dict[str, str] = {}
        self._last_capture_allowed: dict[str, float] = {}
        self._lock = threading.Lock()

    def should_accept_image(self, topic: str) -> bool:
        if topic not in self._specs:
            raise ValueError("Camera topic is not configured for streaming.")
        now = time.monotonic()
        with self._lock:
            last_allowed = self._last_capture_allowed.get(topic)
            if (
                last_allowed is not None
                and now - last_allowed < MIN_CAMERA_CAPTURE_INTERVAL_SECONDS
            ):
                return False
            self._last_capture_allowed[topic] = now
            return True

    def mark_unavailable(self, topic: str, reason: str) -> None:
        if topic not in self._specs:
            raise ValueError("Camera topic is not configured for streaming.")
        with self._lock:
            self._errors[topic] = reason

    def update_image(
        self,
        topic: str,
        frame_id: str,
        captured_at: datetime,
        encoding: str,
        width: int,
        height: int,
        step: int,
        data: bytes,
    ) -> None:
        spec = self._specs.get(topic)
        if spec is None:
            raise ValueError("Camera topic is not configured for streaming.")
        if frame_id != spec["frame_id"]:
            raise ValueError(
                f"Camera topic {topic} frame {frame_id!r} does not match expected {spec['frame_id']!r}."
            )
        channels = {"rgb8": 3, "bgr8": 3, "rgba8": 4, "bgra8": 4, "mono8": 1}
        if encoding not in channels:
            raise ValueError(f"Camera image encoding {encoding!r} is not supported for preview.")
        if (
            isinstance(width, bool)
            or not isinstance(width, int)
            or width < 1
            or width > MAX_CAMERA_WIDTH
            or isinstance(height, bool)
            or not isinstance(height, int)
            or height < 1
            or height > MAX_CAMERA_HEIGHT
            or isinstance(step, bool)
            or not isinstance(step, int)
            or step < width * channels[encoding]
            or len(data) != step * height
            or len(data) > MAX_CAMERA_FRAME_BYTES
        ):
            raise ValueError("Camera frame dimensions, row stride, or data size are invalid or too large.")
        if captured_at.tzinfo is None:
            raise ValueError("Camera frame timestamp must include a timezone.")
        received_at = datetime.now(timezone.utc)
        with self._lock:
            self._frames[topic] = {
                "topic": topic,
                "frame_id": frame_id,
                "timestamp": captured_at.astimezone(timezone.utc),
                "received_at": received_at,
                "received_monotonic": time.monotonic(),
                "encoding": encoding,
                "width": width,
                "height": height,
                "step": step,
                "data": bytes(data),
            }
            self._errors.pop(topic, None)

    def current_frame(self, topic: str) -> dict[str, object]:
        if topic not in self._specs:
            raise KeyError("Camera topic is not configured for streaming.")
        with self._lock:
            frame = self._frames.get(topic)
            error = self._errors.get(topic)
        if error:
            raise LookupError(error)
        if frame is None:
            raise LookupError(error or "No camera image frame has been received.")
        receive_age = time.monotonic() - float(frame["received_monotonic"])
        stamp_age = (datetime.now(timezone.utc) - frame["timestamp"]).total_seconds()
        if receive_age < 0 or stamp_age < -MAX_FUTURE_SKEW_SECONDS:
            raise ValueError("Camera frame timestamp is invalid or in the future.")
        if receive_age > MAX_CAMERA_FRAME_AGE_SECONDS or stamp_age > MAX_CAMERA_FRAME_AGE_SECONDS:
            raise LookupError("Camera frame is stale.")
        return {
            "topic": topic,
            "frame_id": frame["frame_id"],
            "timestamp": frame["timestamp"].isoformat(),
            "received_at": frame["received_at"].isoformat(),
            "receive_age_ms": max(0, round(receive_age * 1000)),
            "stamp_age_ms": round(stamp_age * 1000),
            "encoding": frame["encoding"],
            "width": frame["width"],
            "height": frame["height"],
            "step": frame["step"],
            "data_base64": base64.b64encode(frame["data"]).decode("ascii"),
        }


def should_log_tf_warning(last_warning_at: float | None, now: float) -> bool:
    return last_warning_at is None or now - last_warning_at >= TF_WARNING_INTERVAL_SECONDS


class PointCloudClockNormalizer:
    def __init__(self) -> None:
        self._future_offsets: deque[float] = deque(maxlen=15)
        self.offset_seconds: float | None = None

    def normalize(
        self,
        seconds: int,
        nanoseconds: int,
        now_seconds: float,
    ) -> datetime:
        if (
            isinstance(seconds, bool)
            or not isinstance(seconds, int)
            or isinstance(nanoseconds, bool)
            or not isinstance(nanoseconds, int)
            or seconds < 0
            or not 0 <= nanoseconds < 1_000_000_000
        ):
            raise ValueError("LiDAR point-cloud timestamp is invalid.")
        raw_timestamp = seconds + nanoseconds / 1_000_000_000
        if raw_timestamp <= 0:
            raise ValueError("LiDAR point-cloud timestamp is missing.")
        raw_age = now_seconds - raw_timestamp
        if -MAX_FUTURE_SKEW_SECONDS <= raw_age <= MAX_SAMPLE_AGE_SECONDS:
            self._future_offsets.clear()
            self.offset_seconds = None
            return validate_pointcloud_timestamp(seconds, nanoseconds, now_seconds)
        if raw_age > MAX_SAMPLE_AGE_SECONDS:
            raise ValueError(
                "LiDAR point cloud is stale ({:.0f} ms old; maximum is {:.0f} ms).".format(
                    raw_age * 1000,
                    MAX_SAMPLE_AGE_SECONDS * 1000,
                )
            )

        offset = raw_timestamp - now_seconds
        if offset > SENSOR_CLOCK_MAX_OFFSET_SECONDS:
            self._future_offsets.clear()
            self.offset_seconds = None
            raise ValueError(
                "LiDAR point-cloud clock is {:.0f} ms ahead of ROS system time, "
                "beyond the supported offset.".format(offset * 1000)
            )
        if self._future_offsets and abs(offset - statistics.median(self._future_offsets)) > (
            SENSOR_CLOCK_MAX_JITTER_SECONDS
        ):
            self._future_offsets.clear()
            self.offset_seconds = None
        self._future_offsets.append(offset)
        if len(self._future_offsets) < SENSOR_CLOCK_STABLE_SAMPLES:
            raise ValueError(
                "Waiting for a stable LiDAR-to-ROS clock offset ({}/{} samples).".format(
                    len(self._future_offsets),
                    SENSOR_CLOCK_STABLE_SAMPLES,
                )
            )
        offset_median = statistics.median(self._future_offsets)
        offset_spread = max(self._future_offsets) - min(self._future_offsets)
        if offset_spread > SENSOR_CLOCK_MAX_JITTER_SECONDS:
            raise ValueError(
                "LiDAR-to-ROS clock offset is unstable ({:.0f} ms spread); "
                "clock synchronization cannot be verified.".format(offset_spread * 1000)
            )
        self.offset_seconds = offset_median
        corrected_timestamp = raw_timestamp - offset_median
        corrected_seconds = int(corrected_timestamp)
        corrected_nanoseconds = round(
            (corrected_timestamp - corrected_seconds) * 1_000_000_000
        )
        if corrected_nanoseconds >= 1_000_000_000:
            corrected_seconds += 1
            corrected_nanoseconds -= 1_000_000_000
        return validate_pointcloud_timestamp(
            corrected_seconds,
            corrected_nanoseconds,
            now_seconds,
        )


def format_tf_calibration_error(
    error: Exception,
    mount_parent_frame: str,
    sensor_frame: str,
    base_frame: str,
) -> str:
    error_message = str(error).rstrip(" .")
    return (
        "LiDAR sample could not be transformed/calibrated: {}. Live ROS TF must "
        "provide timestamp-valid transforms for the G1 mount ({} -> {}) and robot "
        "base ({} <- {}) at the point-cloud timestamp; verify a G1 TF/joint-state "
        "publisher is active. Do not substitute an assumed static transform."
    ).format(
        error_message,
        mount_parent_frame,
        sensor_frame,
        base_frame,
        sensor_frame,
    )


def transform_point_to_base(
    point: tuple[float, float, float],
    translation: tuple[float, float, float],
    rotation: tuple[float, float, float, float],
) -> tuple[float, float, float]:
    x, y, z = point
    tx, ty, tz = translation
    qx, qy, qz, qw = rotation
    values = (x, y, z, tx, ty, tz, qx, qy, qz, qw)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("LiDAR-to-base transform values must be finite.")
    quaternion_norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if quaternion_norm <= 1e-9:
        raise ValueError("LiDAR-to-base rotation quaternion is invalid.")
    qx, qy, qz, qw = (value / quaternion_norm for value in (qx, qy, qz, qw))
    cross_x = 2 * (qy * z - qz * y)
    cross_y = 2 * (qz * x - qx * z)
    cross_z = 2 * (qx * y - qy * x)
    return (
        x + qw * cross_x + qy * cross_z - qz * cross_y + tx,
        y + qw * cross_y + qz * cross_x - qx * cross_z + ty,
        z + qw * cross_z + qx * cross_y - qy * cross_x + tz,
    )


def footprint_clearance_m(
    x: float,
    y: float,
    front_extent_m: float,
    rear_extent_m: float,
    half_width_m: float,
) -> float | None:
    values = (x, y, front_extent_m, rear_extent_m, half_width_m)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Robot footprint and point coordinates must be finite.")
    if min(front_extent_m, rear_extent_m, half_width_m) <= 0:
        raise ValueError("Robot footprint extents must be greater than zero.")
    radius = math.hypot(x, y)
    if radius == 0 or x == 0:
        return None
    longitudinal_extent = front_extent_m if x > 0 else rear_extent_m
    boundary_candidates = [longitudinal_extent * radius / abs(x)]
    if y != 0:
        boundary_candidates.append(half_width_m * radius / abs(y))
    return max(0.0, radius - min(boundary_candidates))


def footprint_clear_range_m(
    front_extent_m: float,
    rear_extent_m: float,
    half_width_m: float,
    sensor_origin_x: float,
    sensor_origin_y: float,
    sector: str,
) -> float:
    values = (front_extent_m, rear_extent_m, half_width_m, sensor_origin_x, sensor_origin_y)
    if sector not in {"forward", "rear"} or not all(math.isfinite(value) for value in values):
        raise ValueError("Footprint clearance configuration is invalid.")
    if min(front_extent_m, rear_extent_m, half_width_m) <= 0:
        raise ValueError("Robot footprint extents must be greater than zero.")
    edge_x = front_extent_m if sector == "forward" else -rear_extent_m
    farthest_corner = max(
        math.hypot(edge_x - sensor_origin_x, edge_y - sensor_origin_y)
        for edge_y in (-half_width_m, half_width_m)
    )
    return max(0.0, MAX_DISTANCE_METERS - farthest_corner)


def pointcloud_ranges_array(points: object):
    import numpy as np

    values = np.asarray(points)
    fields = values.dtype.names
    if fields and all(axis in fields for axis in ("x", "y", "z")):
        return np.hypot(values["x"], values["y"])
    if values.ndim == 2 and values.shape[1] >= 3:
        return np.hypot(values[:, 0], values[:, 1])
    raise ValueError("Point cloud XYZ data must contain x, y, and z fields.")


def validate_pointcloud_timestamp(
    seconds: int,
    nanoseconds: int,
    now_seconds: float | None = None,
) -> datetime:
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, int)
        or isinstance(nanoseconds, bool)
        or not isinstance(nanoseconds, int)
        or seconds < 0
        or not 0 <= nanoseconds < 1_000_000_000
    ):
        raise ValueError("LiDAR point-cloud timestamp is invalid.")
    timestamp_seconds = seconds + nanoseconds / 1_000_000_000
    if timestamp_seconds <= 0:
        raise ValueError("LiDAR point-cloud timestamp is missing.")
    current_seconds = time.time() if now_seconds is None else now_seconds
    age_seconds = current_seconds - timestamp_seconds
    if age_seconds < -MAX_FUTURE_SKEW_SECONDS:
        raise ValueError(
            "LiDAR point-cloud timestamp is more than {:.0f} ms ahead of the host "
            "wall clock; verify G1, ROS, and LiDAR time synchronization.".format(
                -age_seconds * 1000
            )
        )
    if age_seconds > MAX_SAMPLE_AGE_SECONDS:
        raise ValueError(
            f"LiDAR point cloud is stale ({age_seconds * 1000:.0f} ms old; "
            f"maximum is {MAX_SAMPLE_AGE_SECONDS * 1000:.0f} ms)."
        )
    return datetime.fromtimestamp(timestamp_seconds, timezone.utc)


def _rotation_matrix(rotation: tuple[float, float, float, float]) -> tuple[tuple[float, float, float], ...]:
    qx, qy, qz, qw = rotation
    if not all(math.isfinite(value) for value in rotation):
        raise ValueError("LiDAR-to-base rotation quaternion must be finite.")
    quaternion_norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if quaternion_norm <= 1e-9:
        raise ValueError("LiDAR-to-base rotation quaternion is invalid.")
    qx, qy, qz, qw = (value / quaternion_norm for value in rotation)
    return (
        (1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)),
        (2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)),
        (2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)),
    )


def compose_transforms(
    parent_translation: tuple[float, float, float],
    parent_rotation: tuple[float, float, float, float],
    child_translation: tuple[float, float, float],
    child_rotation: tuple[float, float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float, float]]:
    """Compose parent<-intermediate and intermediate<-child transforms."""
    matrix = _rotation_matrix(parent_rotation)
    rotated_child = tuple(
        sum(matrix[row][column] * child_translation[column] for column in range(3))
        for row in range(3)
    )
    translation = tuple(
        parent_translation[index] + rotated_child[index] for index in range(3)
    )
    px, py, pz, pw = parent_rotation
    cx, cy, cz, cw = child_rotation
    rotation = (
        pw * cx + px * cw + py * cz - pz * cy,
        pw * cy - px * cz + py * cw + pz * cx,
        pw * cz + px * cy - py * cx + pz * cw,
        pw * cw - px * cx - py * cy - pz * cz,
    )
    _rotation_matrix(rotation)
    if not all(math.isfinite(value) for value in (*parent_translation, *child_translation)):
        raise ValueError("Transform translation must be finite.")
    return translation, rotation


def transform_points_to_base_array(
    points: object,
    translation: tuple[float, float, float],
    rotation: tuple[float, float, float, float],
):
    import numpy as np

    values = np.asarray(points)
    fields = values.dtype.names
    if fields and all(axis in fields for axis in ("x", "y", "z")):
        xyz = np.column_stack((values["x"], values["y"], values["z"]))
    elif values.ndim == 2 and values.shape[1] >= 3:
        xyz = values[:, :3]
    else:
        raise ValueError("Point cloud XYZ data must contain x, y, and z fields.")
    if not all(math.isfinite(value) for value in translation):
        raise ValueError("LiDAR-to-base translation must be finite.")
    matrix = np.asarray(_rotation_matrix(rotation), dtype=float)
    return xyz @ matrix.T + np.asarray(translation, dtype=float)


def select_footprint_distances_array(
    points: object,
    half_angle_degrees: float,
    minimum_height_m: float,
    maximum_height_m: float,
    front_extent_m: float,
    rear_extent_m: float,
    half_width_m: float,
    sensor_ranges_m: object | None = None,
) -> tuple[float | None, float | None, int]:
    import numpy as np

    if not 1 <= half_angle_degrees <= 45 or minimum_height_m >= maximum_height_m:
        raise ValueError("LiDAR sector and height limits are invalid.")
    if min(front_extent_m, rear_extent_m, half_width_m) <= 0 or not all(
        math.isfinite(value)
        for value in (front_extent_m, rear_extent_m, half_width_m)
    ):
        raise ValueError("Calibrated robot footprint extents must be finite and greater than zero.")
    xyz = np.asarray(points)
    if xyz.ndim != 2 or xyz.shape[1] < 3:
        raise ValueError("Transformed point cloud must contain XYZ columns.")
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    finite = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
    valid_count = int(np.count_nonzero(finite))
    if valid_count == 0:
        raise ValueError("Point cloud contains no finite XYZ returns.")

    radius = np.hypot(x, y)
    sensor_ranges = radius if sensor_ranges_m is None else np.asarray(sensor_ranges_m)
    if sensor_ranges.shape != radius.shape or not np.all(np.isfinite(sensor_ranges[finite])):
        raise ValueError("Point cloud sensor ranges are invalid.")
    tangent = math.tan(math.radians(half_angle_degrees))
    in_height = finite & (z >= minimum_height_m) & (z <= maximum_height_m)
    in_range = sensor_ranges <= MAX_DISTANCE_METERS
    front = in_height & in_range & (x > 0) & (np.abs(y) <= x * tangent)
    rear = in_height & in_range & (x < 0) & (np.abs(y) <= -x * tangent)
    half_width = max(half_width_m, 1e-9)
    lateral_boundary = np.divide(
        half_width * radius,
        np.abs(y),
        out=np.full_like(radius, np.inf, dtype=float),
        where=np.abs(y) > 1e-9,
    )
    front_boundary = np.minimum(front_extent_m * radius / np.maximum(x, 1e-9), lateral_boundary)
    rear_boundary = np.minimum(rear_extent_m * radius / np.maximum(-x, 1e-9), lateral_boundary)
    clearance = np.minimum(
        MAX_DISTANCE_METERS,
        np.maximum(0.0, radius - np.minimum(front_boundary, rear_boundary)),
    )
    front_distances = clearance[front]
    rear_distances = clearance[rear]
    return (
        float(np.min(front_distances)) if front_distances.size else None,
        float(np.min(rear_distances)) if rear_distances.size else None,
        valid_count,
    )


def select_sector_distances(
    points: Iterable[tuple[float, float, float]],
    half_angle_degrees: float,
    minimum_height_m: float,
    maximum_height_m: float,
) -> tuple[float | None, float | None]:
    tangent = math.tan(math.radians(half_angle_degrees))
    nearest_front: float | None = None
    nearest_rear: float | None = None
    for x, y, z in points:
        if not all(math.isfinite(value) for value in (x, y, z)):
            continue
        if z < minimum_height_m or z > maximum_height_m:
            continue
        if x > 0 and abs(y) <= x * tangent:
            distance = math.hypot(x, y)
            if distance <= MAX_DISTANCE_METERS and (nearest_front is None or distance < nearest_front):
                nearest_front = distance
        elif x < 0 and abs(y) <= -x * tangent:
            distance = math.hypot(x, y)
            if distance <= MAX_DISTANCE_METERS and (nearest_rear is None or distance < nearest_rear):
                nearest_rear = distance
    return nearest_front, nearest_rear


def select_forward_distance(
    points: Iterable[tuple[float, float, float]],
    half_angle_degrees: float,
    minimum_height_m: float,
    maximum_height_m: float,
) -> float | None:
    return select_sector_distances(
        points,
        half_angle_degrees,
        minimum_height_m,
        maximum_height_m,
    )[0]


def select_sector_distances_array(
    points: object,
    half_angle_degrees: float,
    minimum_height_m: float,
    maximum_height_m: float,
) -> tuple[float | None, float | None, int]:
    import numpy as np

    values = np.asarray(points)
    fields = values.dtype.names
    if fields and all(axis in fields for axis in ("x", "y", "z")):
        x, y, z = values["x"], values["y"], values["z"]
    elif values.ndim == 2 and values.shape[1] >= 3:
        x, y, z = values[:, 0], values[:, 1], values[:, 2]
    else:
        raise ValueError("Point cloud XYZ data must contain x, y, and z fields.")
    finite = np.isfinite(x) & np.isfinite(y) & np.isfinite(z)
    valid_count = int(np.count_nonzero(finite))
    if valid_count == 0:
        raise ValueError("Point cloud contains no finite XYZ returns.")

    tangent = math.tan(math.radians(half_angle_degrees))
    in_height = finite & (z >= minimum_height_m) & (z <= maximum_height_m)
    front = in_height & (x > 0) & (np.abs(y) <= x * tangent)
    rear = in_height & (x < 0) & (np.abs(y) <= -x * tangent)
    front_ranges = np.hypot(x[front], y[front])
    rear_ranges = np.hypot(x[rear], y[rear])
    front_ranges = front_ranges[front_ranges <= MAX_DISTANCE_METERS]
    rear_ranges = rear_ranges[rear_ranges <= MAX_DISTANCE_METERS]
    front_distance = float(np.min(front_ranges)) if front_ranges.size else None
    rear_distance = float(np.min(rear_ranges)) if rear_ranges.size else None
    return front_distance, rear_distance, valid_count


def _point_values(point: object) -> tuple[float, float, float]:
    names = getattr(getattr(point, "dtype", None), "names", None)
    if names:
        return float(point["x"]), float(point["y"]), float(point["z"])
    return float(point[0]), float(point[1]), float(point[2])


class SampleCache:
    def __init__(
        self,
        sensor_id: str,
        frame_id: str,
        max_ranges_m: dict[str, float] | None = None,
        source_specs: list[dict[str, object]] | None = None,
    ):
        self.sensor_id = sensor_id
        self.frame_id = frame_id
        self.max_ranges_m = max_ranges_m or {
            "forward": MAX_DISTANCE_METERS,
            "rear": MAX_DISTANCE_METERS,
        }
        self._lock = threading.Lock()
        specs = source_specs or [
            {
                "id": sensor_id,
                "topic": None,
                "frame_id": None,
                "coverage": ["forward", "rear"],
            }
        ]
        self._source_specs = {str(spec["id"]): dict(spec) for spec in specs}
        self._source_samples: dict[str, dict[str, object]] = {}
        self._source_errors: dict[str, str] = {}
        self._distances_m: dict[str, float | None] = {"forward": None, "rear": None}
        self._received_at: datetime | None = None
        self._received_monotonic: float | None = None
        self._sample_frame_id: str | None = None
        self._sensor_frame_id: str | None = None
        self._calibrated = False
        self._last_error: str | None = None
        self._cloud_count = 0
        self._calibration_status: dict[str, object] = {
            "ready": False,
            "status": "waiting_for_live_transform",
            "reason": "Provider has not verified a live sensor transform.",
        }

    def update(self, points: Iterable[object], frame_id: str, half_angle: float, min_z: float, max_z: float) -> None:
        front_distance, rear_distance = select_sector_distances(
            (_point_values(point) for point in points),
            half_angle,
            min_z,
            max_z,
        )
        self.update_distances(front_distance, rear_distance, frame_id)

    def update_distances(
        self,
        front_distance: float | None,
        rear_distance: float | None,
        frame_id: str,
        sensor_frame_id: str | None = None,
        captured_at: datetime | None = None,
        calibrated: bool = False,
        max_ranges_m: dict[str, float] | None = None,
    ) -> None:
        self.update_source_distances(
            self.sensor_id,
            front_distance,
            rear_distance,
            frame_id,
            sensor_frame_id,
            captured_at,
            calibrated,
            max_ranges_m,
        )

    def update_source_distances(
        self,
        source_id: str,
        front_distance: float | None,
        rear_distance: float | None,
        frame_id: str,
        sensor_frame_id: str | None = None,
        captured_at: datetime | None = None,
        calibrated: bool = False,
        max_ranges_m: dict[str, float] | None = None,
        transform: dict[str, object] | None = None,
        valid_points: int | None = None,
    ) -> None:
        if source_id not in self._source_specs:
            raise ValueError(f"Point-cloud source {source_id!r} is not configured.")
        captured_at = captured_at or datetime.now(timezone.utc)
        if captured_at.tzinfo is None:
            raise ValueError("Point-cloud capture timestamp must include a timezone.")
        received_at = datetime.now(timezone.utc)
        received_monotonic = time.monotonic()
        spec = self._source_specs[source_id]
        source_sample = {
            "distances_m": {"forward": front_distance, "rear": rear_distance},
            "captured_at": captured_at.astimezone(timezone.utc),
            "received_at": received_at,
            "received_monotonic": received_monotonic,
            "frame_id": frame_id,
            "sensor_frame_id": sensor_frame_id or frame_id,
            "calibrated": calibrated,
            "max_ranges_m": dict(max_ranges_m or self.max_ranges_m),
            "coverage": list(spec.get("coverage", ["forward", "rear"])),
            "transform": transform,
            "valid_points": valid_points,
        }
        with self._lock:
            self._distances_m = {"forward": front_distance, "rear": rear_distance}
            self._received_at = captured_at
            self._received_monotonic = received_monotonic
            self._sample_frame_id = frame_id
            self._sensor_frame_id = sensor_frame_id or frame_id
            self._calibrated = calibrated
            if max_ranges_m is not None:
                self.max_ranges_m = max_ranges_m
            self._last_error = None
            self._cloud_count += 1
            self._source_samples[source_id] = source_sample
            self._source_errors.pop(source_id, None)

    def mark_unavailable(self, reason: str, source_id: str | None = None) -> None:
        with self._lock:
            if source_id is None:
                self._last_error = reason
            else:
                if source_id not in self._source_specs:
                    raise ValueError(f"Point-cloud source {source_id!r} is not configured.")
                self._source_errors[source_id] = reason

    def update_calibration_status(self, status: dict[str, object]) -> None:
        with self._lock:
            self._calibration_status = dict(status)

    def current_calibration_status(self) -> dict[str, object]:
        with self._lock:
            status = dict(self._calibration_status)
        sources = self.source_status()
        status["sources"] = sources
        if status.get("ready") is True:
            if not any(source["contributing"] for source in sources):
                stale = any(source["status"] == "stale" for source in sources)
                reason = next(
                    (
                        source["error"]
                        for source in sources
                        if source["error"]
                    ),
                    "No fresh, transform-valid point-cloud source is contributing.",
                )
                status.update(
                    ready=False,
                    status="stale" if stale else "unavailable",
                    reason=reason,
                )
        return status

    def unavailable_reason(self, sector: str | None = None) -> str:
        sources = self.source_status(sector)
        if any(source["contributing"] for source in sources):
            return "Provider sample is temporarily unavailable."
        if all(source["status"] == "waiting_for_data" for source in sources):
            return "Provider has not received a point cloud yet."
        stale = next(
            (source for source in sources if source["status"] == "stale"),
            None,
        )
        if stale:
            age = stale.get("age_ms")
            return (
                "Latest point cloud is stale ({} ms old; maximum is {:.0f} ms).".format(
                    age if age is not None else "unknown",
                    MAX_SAMPLE_AGE_SECONDS * 1000,
                )
            )
        return next(
            (
                source["error"]
                for source in sources
                if isinstance(source.get("error"), str) and source["error"]
            ),
            "No fresh, transform-valid point-cloud source covers the requested sector.",
        )

    def source_status(self, sector: str | None = None) -> list[dict[str, object]]:
        if sector not in {None, "forward", "rear"}:
            raise ValueError("Distance sector must be forward or rear.")
        with self._lock:
            specs = {key: dict(value) for key, value in self._source_specs.items()}
            samples = {key: dict(value) for key, value in self._source_samples.items()}
            errors = dict(self._source_errors)
            global_error = self._last_error
        now = time.monotonic()
        now_utc = datetime.now(timezone.utc)
        eligible = {}
        results = {}
        for source_id, spec in specs.items():
            sample = samples.get(source_id)
            coverage = list(spec.get("coverage", ["forward", "rear"]))
            result: dict[str, object] = {
                "id": source_id,
                "topic": spec.get("topic"),
                "expected_frame_id": spec.get("frame_id"),
                "coverage": coverage,
                "model_mount": spec.get("model_mount") is True,
                "status": "waiting_for_data",
                "contributing": False,
                "age_ms": None,
                "receive_age_ms": None,
                "stamp_age_ms": None,
                "received_at": None if sample is None else sample["received_at"].isoformat(),
                "timestamp": None if sample is None else sample["captured_at"].isoformat(),
                "error": errors.get(source_id) or global_error,
            }
            if sample is None:
                if result["error"]:
                    result["status"] = "unavailable"
                else:
                    result["error"] = "No point-cloud sample received."
            elif errors.get(source_id) or global_error:
                result["status"] = "unavailable"
            elif sample["frame_id"] != self.frame_id:
                result["status"] = "frame_mismatch"
                result["error"] = (
                    f"Received point-cloud frame {sample['frame_id']!r}; "
                    f"expected {self.frame_id!r}."
                )
            else:
                receive_age = now - float(sample["received_monotonic"])
                stamp_age = (now_utc - sample["captured_at"]).total_seconds()
                result["receive_age_ms"] = round(receive_age * 1000)
                result["stamp_age_ms"] = round(stamp_age * 1000)
                result["age_ms"] = max(0, round(max(receive_age, stamp_age) * 1000))
                if receive_age < 0:
                    result["status"] = "invalid_clock"
                    result["error"] = "Provider monotonic clock moved backwards."
                elif stamp_age < -MAX_FUTURE_SKEW_SECONDS:
                    result["status"] = "invalid_timestamp"
                    result["error"] = "Point-cloud capture timestamp is in the future."
                elif receive_age > MAX_SAMPLE_AGE_SECONDS or stamp_age > MAX_SAMPLE_AGE_SECONDS:
                    result["status"] = "stale"
                    result["error"] = "Point-cloud sample is stale."
                elif sector is not None and sector not in coverage:
                    result["status"] = "outside_sector_coverage"
                    result["error"] = f"Configured source coverage does not include {sector}."
                else:
                    result["status"] = "ready"
                    result["error"] = None
                    eligible[source_id] = sample
            result["sensor_frame_id"] = None if sample is None else sample["sensor_frame_id"]
            result["transform"] = None if sample is None else sample["transform"]
            if isinstance(result["transform"], dict):
                result["calibration_source"] = result["transform"].get("calibration_source")
            result["valid_points"] = None if sample is None else sample["valid_points"]
            results[source_id] = result

        newest_capture = max(
            (sample["captured_at"] for sample in eligible.values()),
            default=None,
        )
        for source_id, sample in eligible.items():
            result = results[source_id]
            skew = (newest_capture - sample["captured_at"]).total_seconds()
            if skew > MAX_CLOUD_FUSION_SKEW_SECONDS:
                result["status"] = "timestamp_skew"
                result["error"] = (
                    "Cloud capture time differs from the newest usable source by "
                    "more than {:.0f} ms.".format(MAX_CLOUD_FUSION_SKEW_SECONDS * 1000)
                )
                continue
            result["contributing"] = True
        return [
            {
                key: value
                for key, value in result.items()
                if not key.startswith("_")
            }
            for result in results.values()
        ]

    def current_sample(self, sector: str = "forward") -> dict[str, object] | None:
        if sector not in {"forward", "rear"}:
            raise ValueError("Distance sector must be forward or rear.")
        statuses = self.source_status(sector)
        source_ids = [item["id"] for item in statuses if item["contributing"]]
        if not source_ids:
            return None
        with self._lock:
            source_samples = {key: dict(value) for key, value in self._source_samples.items()}
            specs = {key: dict(value) for key, value in self._source_specs.items()}
        contributing = [source_samples[source_id] for source_id in source_ids]
        distances = [sample["distances_m"][sector] for sample in contributing]
        observed_distances = [distance for distance in distances if distance is not None]
        distance = min(observed_distances) if observed_distances else None
        received_at = min(sample["received_at"] for sample in contributing)
        captured_at = min(sample["captured_at"] for sample in contributing)
        now_monotonic = time.monotonic()
        now_utc = datetime.now(timezone.utc)
        receive_age_ms = max(
            max(0, round((now_monotonic - sample["received_monotonic"]) * 1000))
            for sample in contributing
        )
        stamp_age_ms = max(
            round((now_utc - sample["captured_at"]).total_seconds() * 1000)
            for sample in contributing
        )
        age_ms = max(receive_age_ms, stamp_age_ms, 0)
        max_range_m = max(
            sample["max_ranges_m"][sector]
            for sample in contributing
        )
        primary = source_samples.get(self.sensor_id)
        sensor_frame_id = (
            primary["sensor_frame_id"]
            if primary and self.sensor_id in source_ids
            else contributing[0]["sensor_frame_id"]
        )
        calibrated = all(sample["calibrated"] for sample in contributing)
        return {
            "valid": True,
            "sector": sector,
            "distance_m": distance,
            "clear": distance is None,
            "max_range_m": max_range_m,
            "timestamp": captured_at.isoformat(),
            "received_at": received_at.isoformat(),
            "age_ms": age_ms,
            "receive_age_ms": receive_age_ms,
            "stamp_age_ms": stamp_age_ms,
            "sensor_id": self.sensor_id,
            "frame_id": self.frame_id,
            "sensor_frame_id": sensor_frame_id,
            "measurement": "footprint_clearance" if calibrated else "sensor_frame_range",
            "calibrated": calibrated,
            "source_ids": source_ids,
            "sources": [
                {
                    **status,
                    "coverage": specs[status["id"]].get("coverage", []),
                }
                for status in statuses
            ],
        }


def serve_http(
    cache: SampleCache,
    host: str,
    port: int,
    token: str,
    camera_cache: CameraFrameCache | None = None,
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed_path = urlsplit(self.path)
            if parsed_path.path not in {
                "/distance/front",
                "/distance/rear",
                "/healthz",
                "/calibration",
                "/camera/frame",
            }:
                self.send_error(404)
                return
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {token}"
            if not hmac.compare_digest(supplied, expected):
                self.send_error(401)
                return
            if parsed_path.path == "/camera/frame":
                if camera_cache is None:
                    self.send_error(503, "Camera frame relay is unavailable")
                    return
                try:
                    query = parse_qs(parsed_path.query, strict_parsing=True)
                    topics = query.get("topic", [])
                    if len(topics) != 1:
                        raise ValueError("Exactly one configured camera topic is required.")
                    payload = camera_cache.current_frame(topics[0])
                except (KeyError, ValueError) as error:
                    body = json.dumps({"error": str(error)}, separators=(",", ":")).encode("utf-8")
                    self.send_response(400)
                except LookupError as error:
                    body = json.dumps({"error": str(error)}, separators=(",", ":")).encode("utf-8")
                    self.send_response(503, "Camera frame unavailable")
                else:
                    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed_path.path == "/calibration":
                payload = cache.current_calibration_status()
                body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            sector = "rear" if parsed_path.path == "/distance/rear" else "forward"
            sample = cache.current_sample(sector)
            if sample is None:
                body = json.dumps(
                    {
                        "valid": False,
                        "sector": sector,
                        "error": cache.unavailable_reason(sector),
                    },
                    separators=(",", ":"),
                ).encode("utf-8")
                self.send_response(503, "LiDAR sample unavailable")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = json.dumps(sample, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    import rclpy
    from geometry_msgs.msg import TransformStamped
    from rclpy.node import Node
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs_py import point_cloud2
    from sensor_msgs.msg import Image, PointCloud2
    from rclpy.duration import Duration
    from rclpy.time import Time
    from tf2_ros import Buffer, TransformException, TransformListener
    from sensor_calibration import (
        DEFAULT_GEOMETRY_PATH,
        DEFAULT_URDF_PATH,
        automatic_calibration_model,
        compare_transforms,
    )

    topic = os.environ.get("G1_LIDAR_TOPIC", "/mid360/livox/lidar")
    sensor_id = os.environ["G1_DISTANCE_SENSOR_ID"]
    sensor_frame_id = os.environ["G1_DISTANCE_FRAME_ID"].strip()
    source_specs = parse_pointcloud_source_specs(
        topic,
        sensor_id,
        sensor_frame_id,
        os.environ.get("G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON"),
    )
    primary_source = source_specs[0]
    camera_configuration_error = None
    try:
        camera_source_specs = parse_camera_source_specs(
            os.environ.get("G1_CAMERA_TOPICS_JSON")
        )
    except ValueError as error:
        camera_source_specs = []
        camera_configuration_error = str(error)
    base_frame_id = os.environ.get("G1_DISTANCE_BASE_FRAME", "").strip()
    token = os.environ["G1_DISTANCE_PROVIDER_TOKEN"]
    host = os.environ.get("G1_DISTANCE_PROVIDER_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("G1_DISTANCE_PROVIDER_PORT", "8181"))
    half_angle = float(os.environ.get("G1_LIDAR_FORWARD_HALF_ANGLE_DEGREES", "15"))
    minimum_height = float(os.environ.get("G1_LIDAR_MINIMUM_HEIGHT_M", "-0.5"))
    maximum_height = float(os.environ.get("G1_LIDAR_MAXIMUM_HEIGHT_M", "1.5"))
    calibration_error = None
    try:
        calibration_model = automatic_calibration_model(
            os.getenv("G1_SENSOR_URDF_PATH", DEFAULT_URDF_PATH),
            os.getenv("G1_SENSOR_GEOMETRY_PATH", DEFAULT_GEOMETRY_PATH),
        )
        footprint = calibration_model["footprint"]
        sensor_mount = calibration_model["mount"]
        primary_source["model_mount"] = (
            sensor_frame_id == sensor_mount["sensor_frame"]
        )
        if base_frame_id != calibration_model["root_frame"]:
            calibration_error = (
                "G1_DISTANCE_BASE_FRAME {!r} must match the supported G1 model root {!r}."
            ).format(base_frame_id, calibration_model["root_frame"])
    except ValueError as error:
        calibration_model = None
        sensor_mount = None
        footprint = None
        calibration_error = f"Automatic G1 calibration model is unavailable: {error}."
    if not base_frame_id:
        calibration_error = "G1_DISTANCE_BASE_FRAME is required for automatic distance calibration."
    if not sensor_frame_id:
        calibration_error = "G1_DISTANCE_FRAME_ID is required for automatic distance calibration."
    if not 1 <= half_angle <= 45 or minimum_height >= maximum_height:
        raise ValueError("Invalid LiDAR forward-sector or height configuration.")
    class LidarNode(Node):
        def __init__(self) -> None:
            super().__init__("uni_edu_lidar_distance_provider")
            self.cache = SampleCache(
                sensor_id,
                base_frame_id or "unconfigured_base_frame",
                source_specs=source_specs,
            )
            self.camera_cache = CameraFrameCache(camera_source_specs)
            self.cache.update_calibration_status(
                {
                    "ready": False,
                    "status": "unavailable" if calibration_error else "waiting_for_live_transform",
                    "reason": calibration_error
                    or "Waiting for a fresh point cloud and the robot-root-to-mount transform.",
                    "model_fingerprint": (
                        calibration_model["model_fingerprint"] if calibration_model else None
                    ),
                    "footprint": footprint,
                    "transform": None,
                }
            )
            self.tf_buffer = Buffer()
            self.tf_listener = TransformListener(self.tf_buffer, self)
            self.received_first_cloud: set[str] = set()
            self.processed_clouds = 0
            self.last_diagnostic_cloud_count = 0
            self.last_diagnostic_at = time.monotonic()
            self.last_tf_warning_at = None
            self.clock_normalizers = {
                str(source["id"]): PointCloudClockNormalizer()
                for source in source_specs
            }
            self.reported_clock_offsets: set[str] = set()
            if camera_configuration_error:
                self.get_logger().warning(
                    f"Robot camera streaming is disabled by invalid configuration: {camera_configuration_error}"
                )
            if calibration_error:
                self.cache.mark_unavailable(calibration_error)
                self.get_logger().error(calibration_error)
            for source in source_specs:
                self.create_subscription(
                    PointCloud2,
                    str(source["topic"]),
                    lambda message, selected_source=source: self.on_cloud(
                        message, selected_source
                    ),
                    qos_profile_sensor_data,
                )
            for camera_source in camera_source_specs:
                self.create_subscription(
                    Image,
                    camera_source["topic"],
                    lambda message, selected_source=camera_source: self.on_image(
                        message, selected_source
                    ),
                    qos_profile_sensor_data,
                )

        def on_cloud(
            self,
            message: PointCloud2,
            source_spec: dict[str, object] = primary_source,
        ) -> None:
            callback_started = time.monotonic()
            source_id = str(source_spec["id"])
            source_topic = str(source_spec["topic"])
            expected_source_frame = str(source_spec["frame_id"])
            uses_model_mount = source_spec.get("model_mount") is True
            if source_id not in self.received_first_cloud:
                self.get_logger().info(
                    f"Received first point cloud from {source_topic}: frame={message.header.frame_id}, "
                    f"points={message.width * message.height}."
                )
                self.received_first_cloud.add(source_id)
            if calibration_error or footprint is None:
                reason = calibration_error or "Automatic G1 footprint geometry is unavailable."
                self.cache.mark_unavailable(reason)
                self.cache.update_calibration_status(
                    {
                        "ready": False,
                        "status": "unavailable",
                        "reason": reason,
                        "model_fingerprint": (
                            calibration_model["model_fingerprint"] if calibration_model else None
                        ),
                        "footprint": footprint,
                        "transform": None,
                    }
                )
                return
            source_frame = str(message.header.frame_id).strip()
            if source_frame != expected_source_frame:
                reason = (
                    f"Received point-cloud frame {source_frame!r} from {source_topic}; "
                    f"expected {expected_source_frame!r}."
                )
                self.cache.mark_unavailable(reason, source_id)
                return
            try:
                now_seconds = self.get_clock().now().nanoseconds / 1_000_000_000
                clock_normalizer = self.clock_normalizers[source_id]
                captured_at = clock_normalizer.normalize(
                    int(message.header.stamp.sec),
                    int(message.header.stamp.nanosec),
                    now_seconds,
                )
                if (
                    clock_normalizer.offset_seconds is not None
                    and source_id not in self.reported_clock_offsets
                ):
                    self.reported_clock_offsets.add(source_id)
                    self.get_logger().warning(
                        "Point-cloud source {} clock offset stabilized at {:.0f} ms; using corrected "
                        "capture stamps for TF lookup and preserving receipt-age checks.".format(
                            source_id,
                            clock_normalizer.offset_seconds * 1000,
                        )
                    )
                cloud_time = Time(
                    nanoseconds=round(captured_at.timestamp() * 1_000_000_000)
                )
                model_derived = False
                observed_mount = None
                mount_comparison = None
                if uses_model_mount:
                    candidate_mount = {
                        **sensor_mount,
                        "sensor_frame": source_frame,
                    }
                    try:
                        mount_transform: TransformStamped = self.tf_buffer.lookup_transform(
                            sensor_mount["parent_frame"],
                            source_frame,
                            cloud_time,
                            timeout=Duration(seconds=0.05),
                        )
                    except TransformException:
                        model_derived = True
                        observed_mount = candidate_mount
                        mount_comparison = {
                            "matches": True,
                            "translation_error_m": 0.0,
                            "rotation_error_rad": 0.0,
                        }
                        sensor_to_parent_translation = tuple(sensor_mount["translation_m"])
                        sensor_to_parent_rotation = tuple(sensor_mount["rotation_xyzw"])
                    else:
                        mount_translation = mount_transform.transform.translation
                        mount_rotation = mount_transform.transform.rotation
                        observed_mount = {
                            "parent_frame": mount_transform.header.frame_id,
                            "sensor_frame": mount_transform.child_frame_id,
                            "translation_m": [
                                float(mount_translation.x),
                                float(mount_translation.y),
                                float(mount_translation.z),
                            ],
                            "rotation_xyzw": [
                                float(mount_rotation.x),
                                float(mount_rotation.y),
                                float(mount_rotation.z),
                                float(mount_rotation.w),
                            ],
                        }
                        mount_comparison = compare_transforms(candidate_mount, observed_mount)
                        if not mount_comparison["matches"]:
                            self.cache.mark_unavailable(mount_comparison["reason"], source_id)
                            return
                        sensor_to_parent_translation = tuple(observed_mount["translation_m"])
                        sensor_to_parent_rotation = tuple(observed_mount["rotation_xyzw"])
                if model_derived:
                    if sensor_mount["parent_frame"] == base_frame_id:
                        translation = sensor_to_parent_translation
                        rotation = sensor_to_parent_rotation
                    else:
                        parent_transform: TransformStamped = self.tf_buffer.lookup_transform(
                            base_frame_id,
                            sensor_mount["parent_frame"],
                            cloud_time,
                            timeout=Duration(seconds=0.05),
                        )
                        parent_translation = parent_transform.transform.translation
                        parent_rotation = parent_transform.transform.rotation
                        translation, rotation = compose_transforms(
                            (
                                float(parent_translation.x),
                                float(parent_translation.y),
                                float(parent_translation.z),
                            ),
                            (
                                float(parent_rotation.x),
                                float(parent_rotation.y),
                                float(parent_rotation.z),
                                float(parent_rotation.w),
                            ),
                            sensor_to_parent_translation,
                            sensor_to_parent_rotation,
                        )
                elif source_frame == base_frame_id:
                    translation = (0.0, 0.0, 0.0)
                    rotation = (0.0, 0.0, 0.0, 1.0)
                else:
                    transform: TransformStamped = self.tf_buffer.lookup_transform(
                        base_frame_id,
                        source_frame,
                        cloud_time,
                        timeout=Duration(seconds=0.05),
                    )
                    vector = transform.transform.translation
                    quaternion = transform.transform.rotation
                    translation = (float(vector.x), float(vector.y), float(vector.z))
                    rotation = (
                        float(quaternion.x),
                        float(quaternion.y),
                        float(quaternion.z),
                        float(quaternion.w),
                    )
                points = point_cloud2.read_points(
                    message,
                    field_names=("x", "y", "z"),
                    skip_nans=False,
                )
                sensor_ranges = pointcloud_ranges_array(points)
                base_points = transform_points_to_base_array(points, translation, rotation)
                front_distance, rear_distance, valid_points = select_footprint_distances_array(
                    base_points,
                    half_angle,
                    minimum_height,
                    maximum_height,
                    footprint["front"],
                    footprint["rear"],
                    footprint["half_width"],
                    sensor_ranges,
                )
            except TransformException as error:
                reason = (
                    format_tf_calibration_error(
                        error,
                        sensor_mount["parent_frame"],
                        source_frame,
                        base_frame_id,
                    )
                    if uses_model_mount
                    else (
                        f"Point-cloud source {source_topic} could not be transformed "
                        f"from {source_frame!r} to {base_frame_id!r} at its capture time: {error}"
                    )
                )
                self.cache.mark_unavailable(reason, source_id)
                warning_at = time.monotonic()
                if should_log_tf_warning(self.last_tf_warning_at, warning_at):
                    self.get_logger().warning(reason)
                    self.last_tf_warning_at = warning_at
                return
            except (TypeError, ValueError, IndexError) as error:
                reason = f"Point-cloud source {source_topic} could not be transformed/calibrated: {error}"
                self.cache.mark_unavailable(reason, source_id)
                warning_at = time.monotonic()
                if should_log_tf_warning(self.last_tf_warning_at, warning_at):
                    self.get_logger().warning(reason)
                    self.last_tf_warning_at = warning_at
                return
            self.cache.update_calibration_status(
                {
                    "ready": True,
                    "status": "model_derived",
                    "reason": (
                        "Using the nominal URDF mount and model-derived footprint; "
                        "physical sensor mounting has not been independently verified."
                        if model_derived
                        else "Point cloud transformed to the G1 model root using timestamp-valid "
                        "TF; the model-derived footprint remains provisional until hardware validation."
                    ),
                    "model_fingerprint": calibration_model["model_fingerprint"],
                    "footprint": footprint,
                    "calibration_source": "model_derived",
                    "base_frame_id": base_frame_id,
                    "transform": None if observed_mount is None else {
                        "parent_frame": observed_mount["parent_frame"],
                        "sensor_frame": observed_mount["sensor_frame"],
                        "translation_m": observed_mount["translation_m"],
                        "rotation_xyzw": observed_mount["rotation_xyzw"],
                        "translation_error_m": mount_comparison.get("translation_error_m"),
                        "rotation_error_rad": mount_comparison.get("rotation_error_rad"),
                    },
                }
            )
            self.cache.update_source_distances(
                source_id,
                front_distance,
                rear_distance,
                base_frame_id,
                source_frame,
                captured_at,
                calibrated=True,
                max_ranges_m={
                    "forward": footprint_clear_range_m(
                        footprint["front"],
                        footprint["rear"],
                        footprint["half_width"],
                        translation[0],
                        translation[1],
                        "forward",
                    ),
                    "rear": footprint_clear_range_m(
                        footprint["front"],
                        footprint["rear"],
                        footprint["half_width"],
                        translation[0],
                        translation[1],
                        "rear",
                    ),
                },
                transform={
                    "target_frame": base_frame_id,
                    "source_frame": source_frame,
                    "translation_m": list(translation),
                    "rotation_xyzw": list(rotation),
                    "calibration_source": "model_derived" if model_derived else "live_tf",
                },
                valid_points=valid_points,
            )
            self.processed_clouds += 1
            now = time.monotonic()
            diagnostic_elapsed = now - self.last_diagnostic_at
            if diagnostic_elapsed >= 5:
                callback_ms = (now - callback_started) * 1000
                cloud_rate_hz = (self.processed_clouds - self.last_diagnostic_cloud_count) / diagnostic_elapsed
                self.get_logger().info(
                    f"Processed {self.processed_clouds} point clouds; latest has "
                    f"{valid_points} finite XYZ returns; rate={cloud_rate_hz:.1f} Hz; "
                    f"callback took {callback_ms:.1f} ms."
                )
                self.last_diagnostic_at = now
                self.last_diagnostic_cloud_count = self.processed_clouds

        def on_image(self, message: Image, source_spec: dict[str, str]) -> None:
            topic_name = source_spec["topic"]
            if not self.camera_cache.should_accept_image(topic_name):
                return
            try:
                now_seconds = self.get_clock().now().nanoseconds / 1_000_000_000
                captured_at = validate_pointcloud_timestamp(
                    int(message.header.stamp.sec),
                    int(message.header.stamp.nanosec),
                    now_seconds,
                )
                self.camera_cache.update_image(
                    topic_name,
                    str(message.header.frame_id).strip(),
                    captured_at,
                    str(message.encoding).lower(),
                    int(message.width),
                    int(message.height),
                    int(message.step),
                    message.data,
                )
            except (TypeError, ValueError, IndexError) as error:
                self.camera_cache.mark_unavailable(
                    topic_name,
                    f"Camera source {topic_name} is unavailable: {error}",
                )

    rclpy.init()
    node = LidarNode()
    server = serve_http(node.cache, host, port, token, node.camera_cache)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    node.get_logger().info(f"Listening to {topic}; read-only sample endpoint bound to {host}:{port}.")
    try:
        rclpy.spin(node)
    finally:
        server.shutdown()
        server.server_close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
