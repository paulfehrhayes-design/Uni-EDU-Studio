"""Standalone authenticated HTTP gateway for ROS 2 Humble/Nav2 navigation.

Deployment: run this module on the navigation host after sourcing the ROS 2
Humble and workspace setup files, with Nav2 publishing ``/map``, a TF
``map -> base_link`` transform, and a NavigateThroughPoses action server
(default ``/navigate_through_poses``). Install the ROS 2 Python packages
``rclpy``, ``nav2_msgs``, ``nav_msgs``, ``geometry_msgs``, ``action_msgs``,
``tf2_ros``, ``sensor_msgs``, and ``sensor_msgs_py`` from the supported ROS
installation. Set
``G1_NAV_GATEWAY_TOKEN`` to a strong secret before starting it.

The HTTP listener binds to 127.0.0.1 by default. Set
``G1_NAV_GATEWAY_HOST``/``G1_NAV_GATEWAY_PORT`` only for a deliberately
configured deployment; non-loopback HTTP should be protected by a trusted
network and TLS reverse proxy. The gateway sends goals only to Nav2; it does
not publish ``cmd_vel`` or call a G1 bridge/stop service. A cancel request
remains pending until Nav2 reports a terminal action result.

Configuration overrides are ``G1_NAV_ACTION_NAME`` (default
``/navigate_through_poses``), ``G1_NAV_MAP_TOPIC`` (``/map``),
``G1_NAV_POINTCLOUD_TOPIC`` (``/mid360/livox/lidar``),
``G1_NAV_MAP_FRAME`` (``map``), ``G1_NAV_BASE_FRAME`` (``base_link``),
``G1_NAV_MAP_ID`` (``nav2-map``), and
``G1_NAV_OCCUPIED_THRESHOLD`` (65, valid values 1 through 100). Unknown
occupancy (``-1``) is always rejected; cells at or above the configured
threshold are occupied. Map versions are SHA-256 identities of the current
map metadata and all occupancy cells.

All routes require ``Authorization: Bearer <G1_NAV_GATEWAY_TOKEN>``.
``GET /api/v1/status`` reports action-server, map, and TF readiness;
``GET /api/v1/map/metadata`` and ``GET /api/v1/map`` return the current
map and identity. Submit with
``POST /api/v1/navigation/goal`` using JSON
``{"map_id":"…","version":"…","frame_id":"map","goals":[{"x":1.0,"y":2.0,"yaw_rad":0.0}]}``.
Each goal must be a finite map-frame x/y/yaw pose in a known, unoccupied map
cell; routes contain at most 20 goals. Submission returns HTTP 202 and an
operation ID. Poll ``GET /api/v1/navigation/operations/{id}``; request stop
with ``POST /api/v1/navigation/operations/{id}/cancel`` and continue polling
until Nav2's terminal result changes the state to ``canceled`` (or another
terminal state). Routes are never started automatically.

No ROS installation or robot is available in this development environment.
This module has not been hardware-tested; syntax validation is not evidence
of DDS, Nav2, localization, or physical motion connectivity.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urlsplit


MAX_GOALS = 20
MAX_MAP_CELLS = 4_000_000
MAX_MAP_PREVIEW_CELLS = 250_000
MAX_SCAN_POINTS = 300_000
MIN_COMPLETED_SCAN_POINTS = 1_000
MAX_REQUEST_BYTES = 64 * 1024
MAX_OPERATIONS = 500
DEFAULT_OCCUPIED_THRESHOLD = 65
TERMINAL_STATES = {"succeeded", "failed", "canceled", "rejected"}


class GatewayConfigurationError(ValueError):
    """Raised for invalid startup configuration."""


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise GatewayConfigurationError(f"{name} must be an integer.") from error
    if not minimum <= value <= maximum:
        raise GatewayConfigurationError(f"{name} must be between {minimum} and {maximum}.")
    return value


def _configuration() -> dict[str, Any]:
    token = os.getenv("G1_NAV_GATEWAY_TOKEN", "").strip()
    if len(token) < 24:
        raise GatewayConfigurationError(
            "Set G1_NAV_GATEWAY_TOKEN to a secret of at least 24 characters before starting."
        )
    host = os.getenv("G1_NAV_GATEWAY_HOST", "127.0.0.1").strip()
    if not host:
        raise GatewayConfigurationError("G1_NAV_GATEWAY_HOST cannot be empty.")
    action_name = os.getenv("G1_NAV_ACTION_NAME", "/navigate_through_poses").strip()
    map_topic = os.getenv("G1_NAV_MAP_TOPIC", "/map").strip()
    pointcloud_topic = os.getenv("G1_NAV_POINTCLOUD_TOPIC", "/mid360/livox/lidar").strip()
    map_frame = os.getenv("G1_NAV_MAP_FRAME", "map").strip()
    base_frame = os.getenv("G1_NAV_BASE_FRAME", "base_link").strip()
    map_id = os.getenv("G1_NAV_MAP_ID", "nav2-map").strip()
    if not all((action_name, map_topic, pointcloud_topic, map_frame, base_frame, map_id)):
        raise GatewayConfigurationError("Action, map, frame, and map ID settings cannot be empty.")
    try:
        threshold = float(os.getenv("G1_NAV_OCCUPIED_THRESHOLD", str(DEFAULT_OCCUPIED_THRESHOLD)))
    except ValueError as error:
        raise GatewayConfigurationError("G1_NAV_OCCUPIED_THRESHOLD must be numeric.") from error
    if not math.isfinite(threshold) or not 1 <= threshold <= 100:
        raise GatewayConfigurationError("G1_NAV_OCCUPIED_THRESHOLD must be between 1 and 100.")
    return {
        "token": token,
        "host": host,
        "port": _env_int("G1_NAV_GATEWAY_PORT", 8282, 1, 65535),
        "action_name": action_name,
        "map_topic": map_topic,
        "pointcloud_topic": pointcloud_topic,
        "map_frame": map_frame,
        "base_frame": base_frame,
        "map_id": map_id,
        "occupied_threshold": threshold,
    }


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number.")
    return result


def _yaw_from_quaternion(quaternion: Any) -> float:
    x, y, z, w = (float(quaternion.x), float(quaternion.y),
                  float(quaternion.z), float(quaternion.w))
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def _make_ros_node(config: dict[str, Any]):
    """Import ROS only on launch, allowing syntax inspection without ROS."""
    import rclpy
    from action_msgs.msg import GoalStatus
    from geometry_msgs.msg import PoseStamped
    from nav2_msgs.action import NavigateThroughPoses
    from nav_msgs.msg import OccupancyGrid
    from rclpy.action import ActionClient
    from rclpy.node import Node
    from rclpy.duration import Duration
    from rclpy.time import Time
    from sensor_msgs.msg import PointCloud2
    from sensor_msgs_py import point_cloud2
    from tf2_ros import Buffer, TransformException, TransformListener

    class NavigationGatewayNode(Node):
        def __init__(self):
            super().__init__("uni_edu_navigation_gateway")
            self._rclpy = rclpy
            self._goal_status = GoalStatus
            self._pose_stamped = PoseStamped
            self._navigate_action = NavigateThroughPoses
            self._transform_exception = TransformException
            self.config = config
            self.lock = threading.RLock()
            self.grid: dict[str, Any] | None = None
            self.grid_received_monotonic: float | None = None
            self.localization: dict[str, Any] | None = None
            self.operations: dict[str, dict[str, Any]] = {}
            self.active_operation_id: str | None = None
            self.scans: dict[str, dict[str, Any]] = {}
            self.active_scan_id: str | None = None
            self.action_client = ActionClient(self, NavigateThroughPoses, config["action_name"])
            self.tf_buffer = Buffer()
            self.tf_listener = TransformListener(self.tf_buffer, self)
            self.map_subscription = self.create_subscription(
                OccupancyGrid, config["map_topic"], self._map_callback, 10
            )
            self.pointcloud_subscription = self.create_subscription(
                PointCloud2, config["pointcloud_topic"], self._pointcloud_callback, 10
            )

        @staticmethod
        def _rotate_point(point: tuple[float, float, float], rotation: Any) -> tuple[float, float, float]:
            x, y, z = point
            qx, qy, qz, qw = (
                float(rotation.x), float(rotation.y),
                float(rotation.z), float(rotation.w),
            )
            tx = 2.0 * (qy * z - qz * y)
            ty = 2.0 * (qz * x - qx * z)
            tz = 2.0 * (qx * y - qy * x)
            return (
                x + qw * tx + (qy * tz - qz * ty),
                y + qw * ty + (qz * tx - qx * tz),
                z + qw * tz + (qx * ty - qy * tx),
            )

        def _pointcloud_callback(self, message):
            with self.lock:
                scan_id = self.active_scan_id
                scan = self.scans.get(scan_id) if scan_id else None
            if not scan or scan["state"] != "scanning":
                return
            source_frame = str(message.header.frame_id).strip()
            if not source_frame:
                return
            try:
                if source_frame == self.config["map_frame"]:
                    translation = (0.0, 0.0, 0.0)
                    rotation = type("IdentityRotation", (), {
                        "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0,
                    })()
                else:
                    transform = self.tf_buffer.lookup_transform(
                        self.config["map_frame"],
                        source_frame,
                        Time.from_msg(message.header.stamp),
                        timeout=Duration(seconds=0.1),
                    )
                    vector = transform.transform.translation
                    translation = (float(vector.x), float(vector.y), float(vector.z))
                    rotation = transform.transform.rotation
                raw_points = point_cloud2.read_points(
                    message, field_names=("x", "y", "z"), skip_nans=True
                )
                estimated_count = max(1, int(message.width) * int(message.height))
                stride = max(1, math.ceil(estimated_count / 5_000))
                points = []
                for index, point in enumerate(raw_points):
                    if index % stride:
                        continue
                    if hasattr(point, "dtype") and point.dtype.names:
                        xyz = tuple(float(point[axis]) for axis in ("x", "y", "z"))
                    else:
                        xyz = tuple(float(value) for value in point[:3])
                    if not all(math.isfinite(value) for value in xyz):
                        continue
                    rx, ry, rz = self._rotate_point(xyz, rotation)
                    mapped = (
                        rx + translation[0],
                        ry + translation[1],
                        rz + translation[2],
                    )
                    points.append(mapped)
            except (self._transform_exception, TypeError, ValueError, IndexError) as error:
                self.get_logger().warning(f"Skipping LiDAR cloud without a valid map transform: {error}")
                return
            with self.lock:
                scan = self.scans.get(scan_id)
                if not scan or scan["state"] != "scanning":
                    return
                voxels = scan["voxels"]
                for x, y, z in points:
                    key = (math.floor(x / 0.05), math.floor(y / 0.05), math.floor(z / 0.05))
                    if key in voxels or len(voxels) >= MAX_SCAN_POINTS:
                        continue
                    voxels[key] = (x, y, z)
                scan["updated_at"] = _utc_now()

        @staticmethod
        def _public_scan(scan: dict[str, Any]) -> dict[str, Any]:
            voxel_count = len(scan["voxels"])
            stride = max(1, math.ceil(voxel_count / 1_000))
            preview = [
                point for index, point in enumerate(scan["voxels"].values())
                if index % stride == 0
            ]
            return {
                "job_id": scan["job_id"],
                "status": scan["state"],
                "frame_id": scan["frame_id"],
                "created_at": scan["created_at"],
                "updated_at": scan["updated_at"],
                "completed_at": scan.get("completed_at"),
                "point_count": voxel_count,
                "map_id": scan.get("map_id"),
                "map_version": scan.get("map_version"),
                "error": scan.get("error"),
                "preview_points": [
                    {"x": point[0], "y": point[1], "z": point[2]}
                    for point in preview
                ],
            }

        def start_scan(self) -> dict[str, Any]:
            with self.lock:
                if self.grid is None:
                    raise GatewayHTTPError(503, "A valid SLAM OccupancyGrid is required before scanning.")
                if self.active_operation_id:
                    raise GatewayHTTPError(409, "Cannot scan while a Nav2 route owns locomotion.")
                if self.active_scan_id:
                    active = self.scans.get(self.active_scan_id)
                    if active and active["state"] == "scanning":
                        raise GatewayHTTPError(409, "A LiDAR scan is already active.")
                job_id = str(uuid.uuid4())
                now = _utc_now()
                self.scans[job_id] = {
                    "job_id": job_id,
                    "state": "scanning",
                    "frame_id": self.config["map_frame"],
                    "created_at": now,
                    "updated_at": now,
                    "voxels": {},
                }
                self.active_scan_id = job_id
                return self._public_scan(self.scans[job_id])

        def complete_scan(self, job_id: str) -> dict[str, Any]:
            with self.lock:
                scan = self.scans.get(job_id)
                if scan is None:
                    raise GatewayHTTPError(404, "LiDAR scan job was not found.")
                if scan["state"] != "scanning":
                    return self._public_scan(scan)
                if len(scan["voxels"]) < MIN_COMPLETED_SCAN_POINTS:
                    scan["state"] = "failed"
                    scan["error"] = (
                        f"Scan has {len(scan['voxels'])} unique points; at least "
                        f"{MIN_COMPLETED_SCAN_POINTS} are required. Sweep the sensor around the room and try again."
                    )
                else:
                    grid = self.grid
                    if grid is None:
                        scan["state"] = "failed"
                        scan["error"] = "The SLAM occupancy map is no longer available."
                    else:
                        scan["state"] = "completed"
                        scan["map_id"] = grid["map_id"]
                        scan["map_version"] = grid["version"]
                        scan["map_snapshot"] = {
                            **self._metadata(grid),
                            "data": list(grid["data"]),
                        }
                scan["updated_at"] = _utc_now()
                scan["completed_at"] = scan["updated_at"]
                if self.active_scan_id == job_id:
                    self.active_scan_id = None
                return self._public_scan(scan)

        def cancel_scan(self, job_id: str) -> dict[str, Any]:
            with self.lock:
                scan = self.scans.get(job_id)
                if scan is None:
                    raise GatewayHTTPError(404, "LiDAR scan job was not found.")
                if scan["state"] == "scanning":
                    scan["state"] = "canceled"
                    scan["updated_at"] = _utc_now()
                    scan["completed_at"] = scan["updated_at"]
                if self.active_scan_id == job_id:
                    self.active_scan_id = None
                return self._public_scan(scan)

        def scan_snapshot(self, job_id: str) -> dict[str, Any]:
            with self.lock:
                scan = self.scans.get(job_id)
                if scan is None:
                    raise GatewayHTTPError(404, "LiDAR scan job was not found.")
                return self._public_scan(scan)

        def scan_pointcloud_snapshot(self, job_id: str) -> dict[str, Any]:
            with self.lock:
                scan = self.scans.get(job_id)
                if scan is None:
                    raise GatewayHTTPError(404, "LiDAR scan job was not found.")
                if scan["state"] not in {"scanning", "completed"}:
                    raise GatewayHTTPError(409, "A completed scan point cloud is not available.")
                points = [
                    {"x": point[0], "y": point[1], "z": point[2]}
                    for point in scan["voxels"].values()
                ]
                return {
                    "job_id": job_id,
                    "frame_id": scan["frame_id"],
                    "captured_at": scan.get("completed_at") or scan["updated_at"],
                    "points": points,
                }

        def scan_map_snapshot(self, job_id: str) -> dict[str, Any]:
            with self.lock:
                scan = self.scans.get(job_id)
                if scan is None:
                    raise GatewayHTTPError(404, "LiDAR scan job was not found.")
                if scan["state"] != "completed" or "map_snapshot" not in scan:
                    raise GatewayHTTPError(409, "A completed scan map snapshot is not available.")
                return dict(scan["map_snapshot"])

        def _map_callback(self, message):
            info = message.info
            frame = str(message.header.frame_id).strip()
            width, height = int(info.width), int(info.height)
            if (not frame or frame != self.config["map_frame"]
                    or width < 1 or height < 1 or width * height > MAX_MAP_CELLS
                    or len(message.data) != width * height
                    or not math.isfinite(float(info.resolution)) or info.resolution <= 0):
                self.get_logger().warning("Ignoring /map message with invalid dimensions, data, or frame.")
                return
            data = tuple(int(cell) for cell in message.data)
            if any(cell < -1 or cell > 100 for cell in data):
                self.get_logger().warning("Ignoring /map message with occupancy outside [-1, 100].")
                return
            origin = info.origin
            origin_x = float(origin.position.x)
            origin_y = float(origin.position.y)
            origin_yaw = _yaw_from_quaternion(origin.orientation)
            if not all(math.isfinite(value) for value in (origin_x, origin_y, origin_yaw)):
                self.get_logger().warning("Ignoring /map message with a non-finite origin.")
                return
            grid = {
                "map_id": self.config["map_id"],
                "frame_id": frame,
                "resolution_m": float(info.resolution),
                "width": width,
                "height": height,
                "origin": {
                    "x": origin_x,
                    "y": origin_y,
                    "yaw_rad": origin_yaw,
                },
                "data": data,
                "updated_at": _utc_now(),
            }
            identity = {
                key: grid[key] for key in
                ("map_id", "frame_id", "resolution_m", "width", "height", "origin")
            }
            # Hash complete cell contents so changed maps cannot share a version.
            digest = hashlib.sha256(
                json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
                + bytes((value + 1) for value in data)
            ).hexdigest()
            grid["version"] = digest
            with self.lock:
                self.grid = grid
                self.grid_received_monotonic = time.monotonic()

        def _localization_snapshot(self) -> dict[str, Any]:
            try:
                transform = self.tf_buffer.lookup_transform(
                    self.config["map_frame"], self.config["base_frame"], rclpy.time.Time()
                )
            except TransformException as error:
                with self.lock:
                    self.localization = None
                return {"ready": False, "error": f"TF localization unavailable: {error}"}
            header_frame = str(transform.header.frame_id).strip()
            child_frame = str(transform.child_frame_id).strip()
            if header_frame != self.config["map_frame"] or child_frame != self.config["base_frame"]:
                with self.lock:
                    self.localization = None
                return {"ready": False, "error": "TF returned frames different from the configured map/base frames."}
            translation = transform.transform.translation
            rotation = transform.transform.rotation
            stamp = transform.header.stamp
            transform_timestamp = float(stamp.sec) + float(stamp.nanosec) / 1_000_000_000
            age_seconds = time.time() - transform_timestamp
            if transform_timestamp <= 0 or age_seconds < -0.1 or age_seconds > 1.0:
                with self.lock:
                    self.localization = None
                return {
                    "ready": False,
                    "error": f"TF localization is stale or has an invalid timestamp ({age_seconds:.3f} s old).",
                }
            pose = {
                "x": float(translation.x),
                "y": float(translation.y),
                "yaw_rad": _yaw_from_quaternion(rotation),
            }
            if not all(math.isfinite(number) for number in pose.values()):
                with self.lock:
                    self.localization = None
                return {"ready": False, "error": "TF localization contains non-finite values."}
            snapshot = {
                "ready": True,
                "frame_id": header_frame,
                "base_frame": child_frame,
                "pose": pose,
                "timestamp": datetime.fromtimestamp(transform_timestamp, timezone.utc).isoformat(),
            }
            with self.lock:
                self.localization = snapshot
            return snapshot

        def status_snapshot(self) -> dict[str, Any]:
            localization = self._localization_snapshot()
            with self.lock:
                grid = self.grid
                active = self.operations.get(self.active_operation_id) if self.active_operation_id else None
            map_ready = grid is not None
            action_ready = self.action_client.server_is_ready()
            ready = bool(map_ready and localization["ready"] and action_ready)
            return {
                "ready": ready,
                "status": "ready" if ready else "unavailable",
                "planner_ready": bool(map_ready and action_ready),
                "action_server_ready": action_ready,
                "map_ready": map_ready,
                "localization": localization,
                "map": self._metadata(grid) if grid else None,
                "active_operation": self._public_operation(active) if active else None,
            }

        @staticmethod
        def _metadata(grid: dict[str, Any]) -> dict[str, Any]:
            return {key: grid[key] for key in (
                "map_id", "version", "frame_id", "resolution_m",
                "width", "height", "origin", "updated_at",
            )}

        @staticmethod
        def _public_operation(operation: dict[str, Any] | None) -> dict[str, Any] | None:
            if operation is None:
                return None
            result = {key: value for key, value in operation.items() if not key.startswith("_")}
            state = result.pop("state", "failed")
            result["operation_id"] = result.pop("id")
            result["status"] = {
                "queued": "accepted",
                "submitted": "accepted",
                "canceling": "cancel_requested",
                "rejected": "failed",
                "submission_unconfirmed": "uncertain",
                "result_unavailable": "uncertain",
            }.get(state, state)
            return result

        def map_snapshot(self) -> dict[str, Any]:
            with self.lock:
                grid = self.grid
            if grid is None:
                raise GatewayHTTPError(503, "No valid OccupancyGrid has been received on the configured map topic.")
            if grid["width"] * grid["height"] > MAX_MAP_PREVIEW_CELLS:
                raise GatewayHTTPError(
                    413,
                    f"Map has more than {MAX_MAP_PREVIEW_CELLS} cells; configure a downsampled Nav2 map for the app.",
                )
            return {**self._metadata(grid), "data": list(grid["data"])}

        def _cell_is_free(self, grid: dict[str, Any], x: float, y: float) -> bool:
            origin = grid["origin"]
            dx, dy = x - origin["x"], y - origin["y"]
            yaw = origin["yaw_rad"]
            local_x = math.cos(yaw) * dx + math.sin(yaw) * dy
            local_y = -math.sin(yaw) * dx + math.cos(yaw) * dy
            column = math.floor(local_x / grid["resolution_m"])
            row = math.floor(local_y / grid["resolution_m"])
            if not (0 <= column < grid["width"] and 0 <= row < grid["height"]):
                return False
            occupancy = grid["data"][row * grid["width"] + column]
            return 0 <= occupancy < self.config["occupied_threshold"]

        def submit_route(self, request: Any) -> dict[str, Any]:
            if not isinstance(request, dict):
                raise GatewayHTTPError(400, "Request body must be a JSON object.")
            with self.lock:
                grid = self.grid
                if grid is None:
                    raise GatewayHTTPError(503, "No valid map is available yet.")
                if request.get("map_id") != grid["map_id"]:
                    raise GatewayHTTPError(409, "map_id does not match the current map.")
                if request.get("version") != grid["version"]:
                    raise GatewayHTTPError(409, "Map version is stale; fetch current map metadata and resubmit.")
                if request.get("frame_id") != grid["frame_id"] or grid["frame_id"] != self.config["map_frame"]:
                    raise GatewayHTTPError(409, "frame_id must exactly match the current map frame.")
                goals = request.get("goals")
                if not isinstance(goals, list) or not goals or len(goals) > MAX_GOALS:
                    raise GatewayHTTPError(400, f"goals must contain between 1 and {MAX_GOALS} poses.")
                valid_goals = []
                for index, goal in enumerate(goals):
                    if not isinstance(goal, dict) or set(goal) != {"x", "y", "yaw_rad"}:
                        raise GatewayHTTPError(
                            400, f"Goal {index} must contain exactly x, y, and yaw_rad."
                        )
                    try:
                        x = _finite_number(goal["x"], f"goal {index} x")
                        y = _finite_number(goal["y"], f"goal {index} y")
                        yaw = _finite_number(goal["yaw_rad"], f"goal {index} yaw_rad")
                    except ValueError as error:
                        raise GatewayHTTPError(400, str(error)) from error
                    if abs(x) > 1_000_000 or abs(y) > 1_000_000 or abs(yaw) > 1_000_000:
                        raise GatewayHTTPError(400, f"Goal {index} exceeds numeric bounds.")
                    if not self._cell_is_free(grid, x, y):
                        raise GatewayHTTPError(
                            422, f"Goal {index} is outside the map, unknown, or occupied."
                        )
                    valid_goals.append((x, y, yaw))
                requested_id = request.get("operation_id")
                try:
                    requested_id = str(uuid.UUID(requested_id))
                except (TypeError, ValueError, AttributeError) as error:
                    raise GatewayHTTPError(400, "operation_id must be a UUID.") from error
                previous = self.operations.get(requested_id)
                if previous:
                    same_goals = previous.get("goals") == [
                        {"x": x, "y": y, "yaw_rad": yaw} for x, y, yaw in valid_goals
                    ]
                    if (
                        previous["map_id"] != grid["map_id"]
                        or previous["version"] != grid["version"]
                        or previous["frame_id"] != grid["frame_id"]
                        or not same_goals
                    ):
                        raise GatewayHTTPError(409, "operation_id was already used for a different route.")
                    return self._public_operation(previous)
                if self.active_operation_id is not None:
                    active = self.operations.get(self.active_operation_id)
                    if active and active["state"] not in TERMINAL_STATES:
                        raise GatewayHTTPError(409, "A navigation route is already active.")
                    self.active_operation_id = None
                if not self.action_client.server_is_ready():
                    raise GatewayHTTPError(503, "Nav2 NavigateThroughPoses action server is not ready.")

                operation_id = requested_id
                operation = {
                    "id": operation_id,
                    "state": "queued",
                    "created_at": _utc_now(),
                    "updated_at": _utc_now(),
                    "map_id": grid["map_id"],
                    "version": grid["version"],
                    "frame_id": grid["frame_id"],
                    "goal_count": len(valid_goals),
                    "goals": [
                        {"x": x, "y": y, "yaw_rad": yaw}
                        for x, y, yaw in valid_goals
                    ],
                    "cancel_requested": False,
                    "_goal_handle": None,
                }
                self.operations[operation_id] = operation
                self.active_operation_id = operation_id
                self._prune_operations()
                goal_message = self._navigate_action.Goal()
                for x, y, yaw in valid_goals:
                    pose = self._pose_stamped()
                    pose.header.frame_id = grid["frame_id"]
                    pose.header.stamp = self.get_clock().now().to_msg()
                    pose.pose.position.x = x
                    pose.pose.position.y = y
                    pose.pose.orientation.z = math.sin(yaw / 2.0)
                    pose.pose.orientation.w = math.cos(yaw / 2.0)
                    goal_message.poses.append(pose)
                operation["state"] = "submitted"
                operation["updated_at"] = _utc_now()
                try:
                    future = self.action_client.send_goal_async(
                        goal_message,
                        feedback_callback=lambda feedback, op_id=operation_id:
                        self._feedback_callback(op_id, feedback),
                    )
                    future.add_done_callback(
                        lambda completed, op_id=operation_id: self._goal_response(op_id, completed)
                    )
                except Exception as error:
                    self._mark_uncertain(
                        operation_id, "submission_unconfirmed",
                        f"Nav2 submission outcome is unknown: {error}",
                    )
                    return self._public_operation(operation)
                return self._public_operation(operation)

        def _feedback_callback(self, operation_id: str, _feedback: Any) -> None:
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation and operation["state"] in {"submitted", "running"}:
                    operation["state"] = "running"
                    operation["updated_at"] = _utc_now()

        def _goal_response(self, operation_id: str, future: Any) -> None:
            try:
                handle = future.result()
            except Exception as error:
                self._mark_uncertain(
                    operation_id, "submission_unconfirmed",
                    f"Nav2 goal response is unknown: {error}",
                )
                return
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation is None:
                    return
                if not handle.accepted:
                    self._finish(operation_id, "rejected", "Nav2 rejected the route.")
                    return
                operation["_goal_handle"] = handle
                operation["state"] = "running"
                operation["updated_at"] = _utc_now()
                cancel_requested = operation["cancel_requested"]
            result_future = handle.get_result_async()
            result_future.add_done_callback(
                lambda completed, op_id=operation_id: self._result_callback(op_id, completed)
            )
            if cancel_requested:
                self._request_nav2_cancel(operation_id, handle)

        def _request_nav2_cancel(self, operation_id: str, handle: Any) -> None:
            try:
                future = handle.cancel_goal_async()
                future.add_done_callback(
                    lambda completed, op_id=operation_id: self._cancel_response(op_id, completed)
                )
            except Exception as error:
                with self.lock:
                    operation = self.operations.get(operation_id)
                    if operation and operation["state"] not in TERMINAL_STATES:
                        operation["cancel_error"] = f"Nav2 cancel request failed: {error}"
                        operation["updated_at"] = _utc_now()

        def _cancel_response(self, operation_id: str, future: Any) -> None:
            try:
                response = future.result()
                accepted = bool(response.goals_canceling)
            except Exception as error:
                accepted = False
                message = f"Nav2 cancel acknowledgement failed: {error}"
            else:
                message = "Nav2 has not acknowledged cancellation."
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation and operation["state"] not in TERMINAL_STATES and not accepted:
                    operation["cancel_error"] = message
                    operation["updated_at"] = _utc_now()

        def _result_callback(self, operation_id: str, future: Any) -> None:
            try:
                wrapped = future.result()
                result = wrapped.result
                status = int(wrapped.status)
                message = getattr(result, "error_msg", "")
            except Exception as error:
                self._mark_uncertain(
                    operation_id, "result_unavailable",
                    f"Nav2 terminal result is unavailable: {error}",
                )
                return
            if status == self._goal_status.STATUS_SUCCEEDED:
                self._finish(operation_id, "succeeded", message or None)
            elif status == self._goal_status.STATUS_CANCELED:
                self._finish(operation_id, "canceled", message or None)
            elif status == self._goal_status.STATUS_ABORTED:
                self._finish(operation_id, "failed", message or "Nav2 terminated the route without success.")
            else:
                self._mark_uncertain(
                    operation_id, "result_unavailable",
                    message or f"Nav2 returned non-terminal status {status}; awaiting terminal confirmation.",
                )

        def _mark_uncertain(self, operation_id: str, state: str, message: str) -> None:
            # Keep the active slot reserved until a terminal Nav2 result is known.
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation is None or operation["state"] in TERMINAL_STATES:
                    return
                operation["state"] = state
                operation["updated_at"] = _utc_now()
                operation["message"] = str(message)[:1000]

        def _finish(self, operation_id: str, state: str, message: str | None) -> None:
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation is None or operation["state"] in TERMINAL_STATES:
                    return
                operation["state"] = state
                operation["updated_at"] = _utc_now()
                if message:
                    operation["message"] = str(message)[:1000]
                operation["_goal_handle"] = None
                if self.active_operation_id == operation_id:
                    self.active_operation_id = None

        def operation_snapshot(self, operation_id: str) -> dict[str, Any]:
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation is None:
                    raise GatewayHTTPError(404, "Navigation operation was not found.")
                return self._public_operation(operation)

        def cancel_operation(self, operation_id: str) -> dict[str, Any]:
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation is None:
                    raise GatewayHTTPError(404, "Navigation operation was not found.")
                if operation["state"] in TERMINAL_STATES:
                    return self._public_operation(operation)
                if operation["cancel_requested"]:
                    return self._public_operation(operation)
                handle = operation.get("_goal_handle")
                if handle is None and operation["state"] == "submission_unconfirmed":
                    raise GatewayHTTPError(
                        409, "Nav2 submission is unconfirmed and no goal handle is available to cancel."
                    )
                operation["cancel_requested"] = True
                operation["state"] = "canceling"
                operation["updated_at"] = _utc_now()
            if handle is not None:
                self._request_nav2_cancel(operation_id, handle)
            return self.operation_snapshot(operation_id)

        def _prune_operations(self) -> None:
            if len(self.operations) <= MAX_OPERATIONS:
                return
            terminal = [
                operation_id for operation_id, operation in self.operations.items()
                if operation["state"] in TERMINAL_STATES
            ]
            while len(self.operations) > MAX_OPERATIONS and terminal:
                del self.operations[terminal.pop(0)]

    return NavigationGatewayNode()


class GatewayHTTPError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _make_handler(node: Any, token: str):
    class NavigationGatewayHandler(BaseHTTPRequestHandler):
        server_version = "UniEDUNavigationGateway/1"

        def log_message(self, format_string: str, *args: Any) -> None:
            # Avoid logging authorization headers or request bodies.
            self.server.logger.info("HTTP " + format_string % args)

        def _json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            scheme, separator, supplied = header.partition(" ")
            if not separator or scheme.lower() != "bearer":
                return False
            return hmac.compare_digest(supplied.strip(), token)

        def _body(self) -> Any:
            raw_length = self.headers.get("Content-Length", "")
            try:
                length = int(raw_length)
            except ValueError as error:
                raise GatewayHTTPError(400, "Content-Length must be a valid integer.") from error
            if length < 1 or length > MAX_REQUEST_BYTES:
                raise GatewayHTTPError(413, f"Request body must be between 1 and {MAX_REQUEST_BYTES} bytes.")
            try:
                return json.loads(self.rfile.read(length))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise GatewayHTTPError(400, "Request body must be valid UTF-8 JSON.") from error

        def _dispatch(self) -> None:
            if not self._authorized():
                body = json.dumps(
                    {"error": "A valid bearer token is required."},
                    separators=(",", ":"),
                ).encode("utf-8")
                self.send_response(401)
                self.send_header("WWW-Authenticate", "Bearer")
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            parsed = urlsplit(self.path)
            path = parsed.path
            try:
                if self.command == "GET" and path == "/api/v1/status":
                    self._json(200, node.status_snapshot())
                elif self.command == "GET" and path == "/api/v1/map/metadata":
                    with node.lock:
                        grid = node.grid
                    if grid is None:
                        raise GatewayHTTPError(503, "No valid map is available yet.")
                    self._json(200, node._metadata(grid))
                elif self.command == "GET" and path == "/api/v1/map":
                    self._json(200, node.map_snapshot())
                elif self.command == "POST" and path == "/api/v1/scans/start":
                    self._body_optional()
                    self._json(202, node.start_scan())
                elif self.command == "POST" and path == "/api/v1/navigation/goal":
                    operation = node.submit_route(self._body())
                    self._json(202, operation)
                else:
                    parts = [unquote(part) for part in path.strip("/").split("/")]
                    if (len(parts) == 4 and parts[:3] == ["api", "v1", "scans"]
                            and self.command == "GET"):
                        self._json(200, node.scan_snapshot(parts[3]))
                    elif (len(parts) == 5 and parts[:3] == ["api", "v1", "scans"]
                          and parts[4] == "pointcloud" and self.command == "GET"):
                        self._json(200, node.scan_pointcloud_snapshot(parts[3]))
                    elif (len(parts) == 5 and parts[:3] == ["api", "v1", "scans"]
                          and parts[4] == "map" and self.command == "GET"):
                        self._json(200, node.scan_map_snapshot(parts[3]))
                    elif (len(parts) == 5 and parts[:3] == ["api", "v1", "scans"]
                          and parts[4] == "complete" and self.command == "POST"):
                        self._body_optional()
                        self._json(200, node.complete_scan(parts[3]))
                    elif (len(parts) == 5 and parts[:3] == ["api", "v1", "scans"]
                          and parts[4] == "cancel" and self.command == "POST"):
                        self._body_optional()
                        self._json(200, node.cancel_scan(parts[3]))
                    elif (len(parts) == 5 and parts[:3] == ["api", "v1", "navigation"]
                            and parts[3] == "operations" and self.command == "GET"):
                        self._json(200, node.operation_snapshot(parts[4]))
                    elif (len(parts) == 6 and parts[:3] == ["api", "v1", "navigation"]
                          and parts[3] == "operations" and parts[5] == "cancel"
                          and self.command == "POST"):
                        self._body_optional()
                        self._json(202, node.cancel_operation(parts[4]))
                    else:
                        self._json(404, {"error": "Endpoint not found."})
            except GatewayHTTPError as error:
                self._json(error.status, {"error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as error:
                self.server.logger.exception("Navigation gateway request failed.")
                self._json(500, {"error": f"Internal gateway error: {type(error).__name__}."})

        def _body_optional(self) -> None:
            if int(self.headers.get("Content-Length", "0") or "0") > 0:
                self._body()

        def do_GET(self) -> None:
            self._dispatch()

        def do_POST(self) -> None:
            self._dispatch()

    return NavigationGatewayHandler


def main() -> None:
    import rclpy

    config = _configuration()
    rclpy.init()
    node = _make_ros_node(config)
    executor = rclpy.executors.SingleThreadedExecutor()
    executor.add_node(node)
    ros_thread = threading.Thread(target=executor.spin, name="navigation-ros", daemon=True)
    ros_thread.start()
    server = ThreadingHTTPServer(
        (config["host"], config["port"]), _make_handler(node, config["token"])
    )
    server.daemon_threads = True
    server.logger = node.get_logger()
    node.get_logger().info(
        f"Navigation HTTP gateway listening on {config['host']}:{config['port']}; "
        f"action={config['action_name']} map={config['map_topic']}."
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        executor.shutdown()
        node.destroy_node()
        rclpy.shutdown()
        ros_thread.join(timeout=2.0)


if __name__ == "__main__":
    main()
