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
MAX_DISTANCE_METERS = 40.0


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
    def __init__(self, sensor_id: str, frame_id: str):
        self.sensor_id = sensor_id
        self.frame_id = frame_id
        self._lock = threading.Lock()
        self._distances_m: dict[str, float | None] = {"forward": None, "rear": None}
        self._received_at: datetime | None = None
        self._received_monotonic: float | None = None
        self._sample_frame_id: str | None = None
        self._cloud_count = 0

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
    ) -> None:
        with self._lock:
            self._distances_m = {"forward": front_distance, "rear": rear_distance}
            self._received_at = datetime.now(timezone.utc)
            self._received_monotonic = time.monotonic()
            self._sample_frame_id = frame_id
            self._cloud_count += 1

    def unavailable_reason(self) -> str:
        with self._lock:
            received_at = self._received_at
            received_monotonic = self._received_monotonic
            frame_id = self._sample_frame_id
            cloud_count = self._cloud_count
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
        if received_at is None or received_monotonic is None or frame_id != self.frame_id:
            return None
        age = time.monotonic() - received_monotonic
        if age < 0 or age > MAX_SAMPLE_AGE_SECONDS:
            return None
        return {
            "valid": True,
            "sector": sector,
            "distance_m": distance,
            "clear": distance is None,
            "max_range_m": MAX_DISTANCE_METERS,
            "timestamp": received_at.isoformat(),
            "sensor_id": self.sensor_id,
            "frame_id": frame_id,
        }


def serve_http(cache: SampleCache, host: str, port: int, token: str) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path not in {"/distance/front", "/distance/rear", "/healthz"}:
                self.send_error(404)
                return
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {token}"
            if not hmac.compare_digest(supplied, expected):
                self.send_error(401)
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
    from rclpy.node import Node
    from rclpy.qos import qos_profile_sensor_data
    from sensor_msgs_py import point_cloud2
    from sensor_msgs.msg import PointCloud2

    topic = os.environ.get("G1_LIDAR_TOPIC", "/mid360/livox/lidar")
    sensor_id = os.environ["G1_DISTANCE_SENSOR_ID"]
    frame_id = os.environ["G1_DISTANCE_FRAME_ID"]
    token = os.environ["G1_DISTANCE_PROVIDER_TOKEN"]
    host = os.environ.get("G1_DISTANCE_PROVIDER_BIND_HOST", "127.0.0.1")
    port = int(os.environ.get("G1_DISTANCE_PROVIDER_PORT", "8181"))
    half_angle = float(os.environ.get("G1_LIDAR_FORWARD_HALF_ANGLE_DEGREES", "15"))
    minimum_height = float(os.environ.get("G1_LIDAR_MINIMUM_HEIGHT_M", "-0.5"))
    maximum_height = float(os.environ.get("G1_LIDAR_MAXIMUM_HEIGHT_M", "1.5"))
    if not 1 <= half_angle <= 45 or minimum_height >= maximum_height:
        raise ValueError("Invalid LiDAR forward-sector or height configuration.")

    class LidarNode(Node):
        def __init__(self) -> None:
            super().__init__("uni_edu_lidar_distance_provider")
            self.cache = SampleCache(sensor_id, frame_id)
            self.received_first_cloud = False
            self.processed_clouds = 0
            self.last_diagnostic_at = time.monotonic()
            self.create_subscription(PointCloud2, topic, self.on_cloud, qos_profile_sensor_data)

        def on_cloud(self, message: PointCloud2) -> None:
            callback_started = time.monotonic()
            if not self.received_first_cloud:
                self.get_logger().info(
                    f"Received first point cloud: frame={message.header.frame_id}, "
                    f"points={message.width * message.height}."
                )
                self.received_first_cloud = True
            try:
                points = point_cloud2.read_points(
                    message,
                    field_names=("x", "y", "z"),
                    skip_nans=False,
                )
                front_distance, rear_distance, valid_points = select_sector_distances_array(
                    points,
                    half_angle,
                    minimum_height,
                    maximum_height,
                )
            except ValueError as error:
                self.get_logger().warning(f"Rejected invalid point cloud: {error}")
                return
            self.cache.update_distances(front_distance, rear_distance, message.header.frame_id)
            self.processed_clouds += 1
            now = time.monotonic()
            if now - self.last_diagnostic_at >= 5:
                callback_ms = (now - callback_started) * 1000
                self.get_logger().info(
                    f"Processed {self.processed_clouds} point clouds; latest has "
                    f"{valid_points} finite XYZ returns; callback took {callback_ms:.1f} ms."
                )
                self.last_diagnostic_at = now

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
