from __future__ import annotations

import hmac
import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable

MAX_SAMPLE_AGE_SECONDS = 0.5
MAX_FUTURE_SKEW_SECONDS = 0.1
MAX_DISTANCE_METERS = 40.0


def format_tf_calibration_error(
    error: Exception,
    mount_parent_frame: str,
    sensor_frame: str,
    base_frame: str,
) -> str:
    return (
        "LiDAR sample could not be transformed/calibrated: {}. Live ROS TF must "
        "provide timestamp-valid transforms for the G1 mount ({} -> {}) and robot "
        "base ({} <- {}) at the point-cloud timestamp; verify a G1 TF/joint-state "
        "publisher is active. Do not substitute an assumed static transform."
    ).format(
        error,
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
    ):
        self.sensor_id = sensor_id
        self.frame_id = frame_id
        self.max_ranges_m = max_ranges_m or {
            "forward": MAX_DISTANCE_METERS,
            "rear": MAX_DISTANCE_METERS,
        }
        self._lock = threading.Lock()
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
        with self._lock:
            self._distances_m = {"forward": front_distance, "rear": rear_distance}
            self._received_at = captured_at or datetime.now(timezone.utc)
            acquisition_age = max(
                0.0,
                (datetime.now(timezone.utc) - self._received_at).total_seconds(),
            )
            self._received_monotonic = time.monotonic() - acquisition_age
            self._sample_frame_id = frame_id
            self._sensor_frame_id = sensor_frame_id or frame_id
            self._calibrated = calibrated
            if max_ranges_m is not None:
                self.max_ranges_m = max_ranges_m
            self._last_error = None
            self._cloud_count += 1

    def mark_unavailable(self, reason: str) -> None:
        with self._lock:
            self._last_error = reason

    def update_calibration_status(self, status: dict[str, object]) -> None:
        with self._lock:
            self._calibration_status = dict(status)

    def current_calibration_status(self) -> dict[str, object]:
        with self._lock:
            status = dict(self._calibration_status)
            received_monotonic = self._received_monotonic
            last_error = self._last_error
        if status.get("ready") is True:
            if last_error:
                status.update(ready=False, status="unavailable", reason=last_error)
            elif (
                received_monotonic is None
                or time.monotonic() - received_monotonic > MAX_SAMPLE_AGE_SECONDS
            ):
                status.update(
                    ready=False,
                    status="stale",
                    reason="Live LiDAR calibration evidence is stale.",
                )
        return status

    def unavailable_reason(self) -> str:
        with self._lock:
            received_at = self._received_at
            received_monotonic = self._received_monotonic
            frame_id = self._sample_frame_id
            cloud_count = self._cloud_count
            last_error = self._last_error
        if last_error:
            return last_error
        if cloud_count == 0 or received_at is None or received_monotonic is None:
            return "Provider has not received a point cloud yet."
        if frame_id != self.frame_id:
            return f"Received point-cloud frame {frame_id!r}; expected {self.frame_id!r}."
        age_seconds = time.monotonic() - received_monotonic
        if age_seconds < 0:
            return "Provider monotonic clock moved backwards; sample freshness cannot be verified."
        if age_seconds > MAX_SAMPLE_AGE_SECONDS:
            return (
                f"Latest point cloud is stale ({age_seconds * 1000:.0f} ms old; "
                f"maximum is {MAX_SAMPLE_AGE_SECONDS * 1000:.0f} ms)."
            )
        return "Provider sample is temporarily unavailable."

    def current_sample(self, sector: str = "forward") -> dict[str, object] | None:
        if sector not in {"forward", "rear"}:
            raise ValueError("Distance sector must be forward or rear.")
        with self._lock:
            distance = self._distances_m[sector]
            received_at = self._received_at
            received_monotonic = self._received_monotonic
            frame_id = self._sample_frame_id
            sensor_frame_id = self._sensor_frame_id
            calibrated = self._calibrated
            max_range_m = self.max_ranges_m[sector]
            last_error = self._last_error
        if last_error or received_at is None or received_monotonic is None or frame_id != self.frame_id:
            return None
        age = time.monotonic() - received_monotonic
        if age < 0 or age > MAX_SAMPLE_AGE_SECONDS:
            return None
        return {
            "valid": True,
            "sector": sector,
            "distance_m": distance,
            "clear": distance is None,
            "max_range_m": max_range_m,
            "timestamp": received_at.isoformat(),
            "age_ms": max(0, round(age * 1000)),
            "sensor_id": self.sensor_id,
            "frame_id": frame_id,
            "sensor_frame_id": sensor_frame_id,
            "measurement": "footprint_clearance" if calibrated else "sensor_frame_range",
            "calibrated": calibrated,
        }


def serve_http(cache: SampleCache, host: str, port: int, token: str) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path not in {
                "/distance/front",
                "/distance/rear",
                "/healthz",
                "/calibration",
            }:
                self.send_error(404)
                return
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {token}"
            if not hmac.compare_digest(supplied, expected):
                self.send_error(401)
                return
            if self.path == "/calibration":
                payload = cache.current_calibration_status()
                body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            sector = "rear" if self.path == "/distance/rear" else "forward"
            sample = cache.current_sample(sector)
            if sample is None:
                body = json.dumps(
                    {
                        "valid": False,
                        "sector": sector,
                        "error": cache.unavailable_reason(),
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
    from sensor_msgs.msg import PointCloud2
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
            )
            self.cache.update_calibration_status(
                {
                    "ready": False,
                    "status": "waiting_for_live_transform",
                    "reason": calibration_error
                    or "Waiting for a fresh point cloud and live G1 sensor transform.",
                    "model_fingerprint": (
                        calibration_model["model_fingerprint"] if calibration_model else None
                    ),
                    "footprint": footprint,
                    "transform": None,
                }
            )
            self.tf_buffer = Buffer()
            self.tf_listener = TransformListener(self.tf_buffer, self)
            self.received_first_cloud = False
            self.processed_clouds = 0
            self.last_diagnostic_cloud_count = 0
            self.last_diagnostic_at = time.monotonic()
            if calibration_error:
                self.cache.mark_unavailable(calibration_error)
                self.get_logger().error(calibration_error)
            self.create_subscription(PointCloud2, topic, self.on_cloud, qos_profile_sensor_data)

        def on_cloud(self, message: PointCloud2) -> None:
            callback_started = time.monotonic()
            if not self.received_first_cloud:
                self.get_logger().info(
                    f"Received first point cloud: frame={message.header.frame_id}, "
                    f"points={message.width * message.height}."
                )
                self.received_first_cloud = True
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
            if source_frame != sensor_frame_id:
                reason = f"Received point-cloud frame {source_frame!r}; expected {sensor_frame_id!r}."
                self.cache.mark_unavailable(reason)
                self.cache.update_calibration_status(
                    {
                        "ready": False,
                        "status": "frame_mismatch",
                        "reason": reason,
                        "model_fingerprint": calibration_model["model_fingerprint"],
                        "footprint": footprint,
                        "transform": None,
                    }
                )
                return
            try:
                captured_at = validate_pointcloud_timestamp(
                    int(message.header.stamp.sec),
                    int(message.header.stamp.nanosec),
                )
                mount_transform: TransformStamped = self.tf_buffer.lookup_transform(
                    sensor_mount["parent_frame"],
                    source_frame,
                    Time.from_msg(message.header.stamp),
                    timeout=Duration(seconds=0.05),
                )
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
                candidate_mount = {
                    **sensor_mount,
                    "sensor_frame": source_frame,
                }
                mount_comparison = compare_transforms(
                    candidate_mount, observed_mount
                )
                if not mount_comparison["matches"]:
                    reason = mount_comparison["reason"]
                    self.cache.mark_unavailable(reason)
                    self.cache.update_calibration_status(
                        {
                            "ready": False,
                            "status": "transform_mismatch",
                            "reason": reason,
                            "model_fingerprint": calibration_model["model_fingerprint"],
                            "footprint": footprint,
                            "transform": {
                                "translation_error_m": mount_comparison.get("translation_error_m"),
                                "rotation_error_rad": mount_comparison.get("rotation_error_rad"),
                            },
                        }
                    )
                    return
                if source_frame == base_frame_id:
                    translation = (0.0, 0.0, 0.0)
                    rotation = (0.0, 0.0, 0.0, 1.0)
                else:
                    transform: TransformStamped = self.tf_buffer.lookup_transform(
                        base_frame_id,
                        source_frame,
                        Time.from_msg(message.header.stamp),
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
                reason = format_tf_calibration_error(
                    error,
                    sensor_mount["parent_frame"],
                    source_frame,
                    base_frame_id,
                )
                self.cache.mark_unavailable(reason)
                self.cache.update_calibration_status(
                    {
                        "ready": False,
                        "status": "unavailable",
                        "reason": reason,
                        "model_fingerprint": calibration_model["model_fingerprint"],
                        "footprint": footprint,
                        "transform": None,
                    }
                )
                self.get_logger().warning(reason)
                return
            except (TypeError, ValueError, IndexError) as error:
                reason = f"LiDAR sample could not be transformed/calibrated: {error}"
                self.cache.mark_unavailable(reason)
                self.cache.update_calibration_status(
                    {
                        "ready": False,
                        "status": "unavailable",
                        "reason": reason,
                        "model_fingerprint": calibration_model["model_fingerprint"],
                        "footprint": footprint,
                        "transform": None,
                    }
                )
                self.get_logger().warning(reason)
                return
            self.cache.update_calibration_status(
                {
                    "ready": True,
                    "status": "verified",
                    "reason": (
                        "Live sensor transform matches the supported G1 mount geometry; "
                        "footprint was derived automatically from the G1 collision model."
                    ),
                    "model_fingerprint": calibration_model["model_fingerprint"],
                    "footprint": footprint,
                    "transform": {
                        "parent_frame": observed_mount["parent_frame"],
                        "sensor_frame": observed_mount["sensor_frame"],
                        "translation_m": observed_mount["translation_m"],
                        "rotation_xyzw": observed_mount["rotation_xyzw"],
                        "translation_error_m": mount_comparison["translation_error_m"],
                        "rotation_error_rad": mount_comparison["rotation_error_rad"],
                    },
                }
            )
            self.cache.update_distances(
                front_distance,
                rear_distance,
                base_frame_id,
                sensor_frame_id,
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

    rclpy.init()
    node = LidarNode()
    server = serve_http(node.cache, host, port, token)
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
