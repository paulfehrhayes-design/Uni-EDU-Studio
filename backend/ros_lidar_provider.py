from __future__ import annotations

import hmac
import json
import math
import os
import threading
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
        self._sample_frame_id: str | None = None

    def update(self, points: Iterable[object], frame_id: str, half_angle: float, min_z: float, max_z: float) -> None:
        front_distance, rear_distance = select_sector_distances(
            (_point_values(point) for point in points),
            half_angle,
            min_z,
            max_z,
        )
        with self._lock:
            self._distances_m = {"forward": front_distance, "rear": rear_distance}
            self._received_at = datetime.now(timezone.utc)
            self._sample_frame_id = frame_id

    def current_sample(self, sector: str = "forward") -> dict[str, object] | None:
        if sector not in {"forward", "rear"}:
            raise ValueError("Distance sector must be forward or rear.")
        with self._lock:
            distance = self._distances_m[sector]
            received_at = self._received_at
            frame_id = self._sample_frame_id
        if received_at is None or frame_id != self.frame_id:
            return None
        age = (datetime.now(timezone.utc) - received_at).total_seconds()
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
                self.send_error(503, f"No fresh {sector}-sector LiDAR sample is available.")
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
            self.create_subscription(PointCloud2, topic, self.on_cloud, qos_profile_sensor_data)

        def on_cloud(self, message: PointCloud2) -> None:
            if not self.received_first_cloud:
                self.get_logger().info(
                    f"Received first point cloud: frame={message.header.frame_id}, "
                    f"points={message.width * message.height}."
                )
                self.received_first_cloud = True
            self.cache.update(
                point_cloud2.read_points(
                    message,
                    field_names=("x", "y", "z"),
                    skip_nans=True,
                ),
                message.header.frame_id,
                half_angle,
                minimum_height,
                maximum_height,
            )

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
