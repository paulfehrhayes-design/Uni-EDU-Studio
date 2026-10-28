"""Standalone authenticated HTTP gateway for ROS 2 Humble/Nav2 navigation.

Deployment: run this module on the navigation host after sourcing the ROS 2
Humble and workspace setup files, with Nav2 publishing ``/map``, a TF
``map -> base_link`` transform, a ComputePathThroughPoses action server
(default ``/compute_path_through_poses``), a NavigateThroughPoses action
server (default ``/navigate_through_poses``), and the Nav2 Spin behavior
server (default ``/spin``). Install the ROS 2 Python packages
``rclpy``, ``nav2_msgs``, ``nav_msgs``, ``geometry_msgs``, ``action_msgs``,
``tf2_ros``, ``sensor_msgs``, and ``sensor_msgs_py`` from the supported ROS
installation. Set
``G1_NAV_GATEWAY_TOKEN`` to a strong secret before starting it.

The HTTP listener binds to 127.0.0.1 by default. Set
``G1_NAV_GATEWAY_HOST``/``G1_NAV_GATEWAY_PORT`` only for a deliberately
configured deployment; non-loopback HTTP should be protected by a trusted
network and TLS reverse proxy. The gateway sends goals only to Nav2; it does
not publish ``cmd_vel`` or call a G1 bridge/stop service. A full LiDAR scan
uses Nav2's Spin action and its existing velocity path; it does not create a
second command publisher. A cancel request
remains pending until Nav2 reports a terminal action result.

Configuration overrides are ``G1_NAV_ACTION_NAME`` (default
``/navigate_through_poses``), ``G1_NAV_PLAN_ACTION_NAME`` (default
``/compute_path_through_poses``), ``G1_NAV_PLANNER_ID`` (default
``GridBased``), ``G1_NAV_PLAN_TIMEOUT_SECONDS`` (1–60, default 15),
``G1_NAV_SPIN_ACTION_NAME`` (default ``/spin``), ``G1_NAV_MAP_TOPIC`` (``/map``),
``G1_NAV_POINTCLOUD_TOPICS`` (comma-separated; defaults to
``G1_NAV_POINTCLOUD_TOPIC`` or ``/mid360/livox/lidar``),
``G1_NAV_MAP_FRAME`` (``map``), ``G1_NAV_BASE_FRAME`` (``base_link``),
``G1_NAV_MAP_ID`` (``nav2-map``), and
``G1_NAV_OCCUPIED_THRESHOLD`` (65, valid values 1 through 100). Unknown
occupancy (``-1``) is always rejected; cells at or above the configured
threshold are occupied. Map versions are SHA-256 identities of the current
map metadata and all occupancy cells.

All routes require ``Authorization: Bearer <G1_NAV_GATEWAY_TOKEN>``.
``GET /api/v1/status`` reports action-server, map, TF, and per-sensor point-cloud readiness;
``GET /api/v1/map/metadata`` and ``GET /api/v1/map`` return the current
map and identity. Route previews use
``POST /api/v1/navigation/plan`` and Nav2's ComputePathThroughPoses action;
this endpoint never sends a movement goal. Submit for motion with
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
MAX_PREVIEW_PATH_POSES = 50_000
MAX_SCAN_POINTS = 300_000
MAX_LIVE_OBSTACLE_POINTS = 2_500
MIN_COMPLETED_SCAN_POINTS = 1_000
MAX_REQUEST_BYTES = 64 * 1024
MAX_OPERATIONS = 500
DEFAULT_OCCUPIED_THRESHOLD = 65
TERMINAL_STATES = {"succeeded", "failed", "canceled", "rejected"}
SCAN_ROTATION_RADIANS = 2 * math.pi
SCAN_ROTATION_TOLERANCE_RADIANS = 0.15
SCAN_SENSOR_MAX_AGE_SECONDS = 1.5
SCAN_MAP_MAX_AGE_SECONDS = 2.0
POINTCLOUD_MAX_FUTURE_SKEW_SECONDS = 0.1
POINTCLOUD_RATE_WINDOW_SECONDS = 5.0
MAX_POINTCLOUD_TOPICS = 16
POINTCLOUD_MESSAGE_TYPE = "sensor_msgs/msg/PointCloud2"


def _aggregate_pointcloud_health(
    sources: list[dict[str, Any]],
    *,
    now_monotonic: float | None = None,
) -> dict[str, Any]:
    """Return the freshest healthy point-cloud signal across all configured sensors.

    The live map and route planning should continue whenever any configured sensor is
    still fresh. A single missing or stale source must never force a hard failure for
    the entire planner stack when the remaining sensors still provide usable coverage.
    """
    now = time.monotonic() if now_monotonic is None else now_monotonic
    fresh_sources: list[dict[str, Any]] = []
    freshest_received_monotonic: float | None = None
    for source in sources:
        if not isinstance(source, dict):
            continue
        received_monotonic = source.get("received_monotonic")
        if received_monotonic is None:
            continue
        ready = bool(source.get("ready")) and now - float(received_monotonic) <= SCAN_SENSOR_MAX_AGE_SECONDS
        if ready:
            fresh_sources.append({**source, "ready": True})
            if freshest_received_monotonic is None or float(received_monotonic) > freshest_received_monotonic:
                freshest_received_monotonic = float(received_monotonic)
    age_ms = None
    if fresh_sources:
        age_ms = min(
            int(round((now - float(source["received_monotonic"])) * 1000))
            for source in fresh_sources
            if isinstance(source.get("received_monotonic"), (int, float))
        )
    return {
        "ready": bool(fresh_sources),
        "age_ms": age_ms,
        "latest_received_monotonic": freshest_received_monotonic,
        "fresh_sources": fresh_sources,
    }


class GatewayConfigurationError(ValueError):
    """Raised for invalid startup configuration."""


def validate_estop_health(
    healthy: bool | None,
    age_seconds: float | None,
    max_age_seconds: float,
) -> dict[str, Any]:
    if healthy is None or age_seconds is None:
        return {"ready": False, "age_ms": None, "error": "E-stop health has not been reported."}
    if (
        not math.isfinite(age_seconds)
        or age_seconds < 0
        or age_seconds > max_age_seconds
    ):
        return {
            "ready": False,
            "age_ms": round(max(0.0, age_seconds) * 1000) if math.isfinite(age_seconds) else None,
            "error": "E-stop health signal is stale.",
        }
    if not healthy:
        return {
            "ready": False,
            "age_ms": round(age_seconds * 1000),
            "error": "E-stop is engaged or the safety circuit is unhealthy.",
        }
    return {"ready": True, "age_ms": round(age_seconds * 1000), "error": None}


def validate_pointcloud_timestamp(
    seconds: int,
    nanoseconds: int,
    now_seconds: float | None = None,
) -> float:
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, int)
        or isinstance(nanoseconds, bool)
        or not isinstance(nanoseconds, int)
        or seconds < 0
        or not 0 <= nanoseconds < 1_000_000_000
    ):
        raise ValueError("LiDAR point-cloud timestamp is invalid.")
    stamp_seconds = seconds + nanoseconds / 1_000_000_000
    if stamp_seconds <= 0:
        raise ValueError("LiDAR point-cloud timestamp is missing.")
    current_seconds = time.time() if now_seconds is None else now_seconds
    age_seconds = current_seconds - stamp_seconds
    if age_seconds < -POINTCLOUD_MAX_FUTURE_SKEW_SECONDS:
        raise ValueError("LiDAR point-cloud timestamp is in the future.")
    if age_seconds > SCAN_SENSOR_MAX_AGE_SECONDS:
        raise ValueError(
            f"LiDAR point-cloud timestamp is stale ({age_seconds * 1000:.0f} ms old; "
            f"maximum is {SCAN_SENSOR_MAX_AGE_SECONDS * 1000:.0f} ms)."
        )
    return max(0.0, age_seconds)


def controller_ownership_ready(owner: str, confirmed: bool) -> bool:
    return owner == "nav2_via_single_unitree_bridge" and confirmed is True


def pointcloud_topics_for_runtime(
    topic_types: list[tuple[str, list[str]]],
    configured_topics: list[str],
    maximum: int = MAX_POINTCLOUD_TOPICS,
) -> tuple[list[str], int]:
    topics = list(dict.fromkeys(configured_topics))
    candidates = sorted({
        name
        for name, message_types in topic_types
        if POINTCLOUD_MESSAGE_TYPE in message_types and isinstance(name, str) and name.startswith("/")
    } - set(topics))
    available_slots = max(0, maximum - len(topics))
    topics.extend(candidates[:available_slots])
    return topics, max(0, len(candidates) - available_slots)


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
    spin_action_name = os.getenv("G1_NAV_SPIN_ACTION_NAME", "/spin").strip()
    plan_action_name = os.getenv(
        "G1_NAV_PLAN_ACTION_NAME", "/compute_path_through_poses"
    ).strip()
    map_topic = os.getenv("G1_NAV_MAP_TOPIC", "/map").strip()
    pointcloud_topics_value = os.getenv("G1_NAV_POINTCLOUD_TOPICS", "").strip()
    legacy_pointcloud_topic = os.getenv("G1_NAV_POINTCLOUD_TOPIC", "").strip()
    auto_discover_pointcloud_topics = not pointcloud_topics_value and not legacy_pointcloud_topic
    pointcloud_topics = (
        [topic.strip() for topic in pointcloud_topics_value.split(",") if topic.strip()]
        if pointcloud_topics_value
        else [legacy_pointcloud_topic or "/mid360/livox/lidar"]
    )
    local_costmap_topic = os.getenv(
        "G1_NAV_LOCAL_COSTMAP_TOPIC", "/local_costmap/costmap"
    ).strip()
    map_frame = os.getenv("G1_NAV_MAP_FRAME", "map").strip()
    base_frame = os.getenv("G1_NAV_BASE_FRAME", "base_link").strip()
    map_id = os.getenv("G1_NAV_MAP_ID", "nav2-map").strip()
    locomotion_owner = os.getenv("G1_NAV_LOCOMOTION_OWNER", "unverified").strip()
    if not all((
        action_name, spin_action_name, plan_action_name, map_topic,
        *pointcloud_topics, local_costmap_topic, map_frame, base_frame, map_id, locomotion_owner,
    )):
        raise GatewayConfigurationError("Action, map, frame, and map ID settings cannot be empty.")
    if (
        len(pointcloud_topics) > MAX_POINTCLOUD_TOPICS
        or len(set(pointcloud_topics)) != len(pointcloud_topics)
        or any(
            not topic.startswith("/")
            or any(not part or not all(character.isalnum() or character == "_" for character in part) for part in topic[1:].split("/"))
            for topic in pointcloud_topics
        )
    ):
        raise GatewayConfigurationError(
            f"G1_NAV_POINTCLOUD_TOPICS must contain at most {MAX_POINTCLOUD_TOPICS} unique absolute ROS topic names."
        )
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
        "spin_action_name": spin_action_name,
        "plan_action_name": plan_action_name,
        "planner_id": os.getenv("G1_NAV_PLANNER_ID", "GridBased").strip() or "GridBased",
        "plan_timeout_seconds": _env_int("G1_NAV_PLAN_TIMEOUT_SECONDS", 15, 1, 60),
        "scan_rotation_timeout_seconds": _env_int(
            "G1_NAV_SCAN_ROTATION_TIMEOUT_SECONDS", 180, 30, 300
        ),
        "map_topic": map_topic,
        "pointcloud_topics": pointcloud_topics,
        "auto_discover_pointcloud_topics": auto_discover_pointcloud_topics,
        "local_costmap_topic": local_costmap_topic,
        "live_avoidance_enabled": os.getenv(
            "G1_NAV_LIVE_AVOIDANCE_ENABLED", "0"
        ).strip() == "1",
        "map_frame": map_frame,
        "base_frame": base_frame,
        "robot_healthy_topic": os.getenv("G1_NAV_ROBOT_HEALTHY_TOPIC", "").strip(),
        "robot_health_max_age_seconds": _env_int("G1_NAV_ROBOT_HEALTH_MAX_AGE_MS", 1000, 100, 5000) / 1000,
        "estop_healthy_topic": os.getenv("G1_NAV_ESTOP_HEALTHY_TOPIC", "").strip(),
        "estop_max_age_seconds": _env_int("G1_NAV_ESTOP_MAX_AGE_MS", 1000, 100, 5000) / 1000,
        "map_id": map_id,
        "occupied_threshold": threshold,
        "locomotion_owner": locomotion_owner,
        "controller_ownership_confirmed": os.getenv(
            "G1_NAV_CONTROLLER_OWNERSHIP_CONFIRMED", "0"
        ).strip() == "1",
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


def accumulate_scan_rotation(rotation_radians: float, previous_yaw: float, current_yaw: float) -> float:
    delta = math.atan2(
        math.sin(current_yaw - previous_yaw),
        math.cos(current_yaw - previous_yaw),
    )
    return rotation_radians + delta


def scan_rotation_complete(rotation_radians: float) -> bool:
    return (
        math.isfinite(rotation_radians)
        and abs(rotation_radians) >= SCAN_ROTATION_RADIANS - SCAN_ROTATION_TOLERANCE_RADIANS
    )


def _make_ros_node(config: dict[str, Any]):
    """Import ROS only on launch, allowing syntax inspection without ROS."""
    import rclpy
    from action_msgs.msg import GoalStatus
    from geometry_msgs.msg import PoseStamped
    from nav2_msgs.action import ComputePathThroughPoses, NavigateThroughPoses, Spin
    from nav_msgs.msg import OccupancyGrid
    from rclpy.action import ActionClient
    from rclpy.node import Node
    from rclpy.duration import Duration
    from rclpy.time import Time
    from sensor_msgs.msg import PointCloud2
    from sensor_msgs_py import point_cloud2
    from std_msgs.msg import Bool
    from tf2_ros import Buffer, TransformException, TransformListener

    class NavigationGatewayNode(Node):
        def __init__(self):
            super().__init__("uni_edu_navigation_gateway")
            self._rclpy = rclpy
            self._goal_status = GoalStatus
            self._pose_stamped = PoseStamped
            self._navigate_action = NavigateThroughPoses
            self._spin_action = Spin
            self._plan_action = ComputePathThroughPoses
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
            self.pointcloud_sources: dict[str, dict[str, Any]] = {
                topic: {
                    "received_monotonic": None,
                    "frame_id": None,
                    "stamp_age_ms": None,
                    "rate_started_monotonic": time.monotonic(),
                    "rate_window_count": 0,
                    "count": 0,
                    "rate_hz": None,
                    "callback_duration_ms": None,
                }
                for topic in config["pointcloud_topics"]
            }
            self.pointcloud_discovery_truncated = 0
            self.pointcloud_discovery_error: str | None = None
            self.pointcloud_received_monotonic: float | None = None
            self.local_costmap: dict[str, Any] | None = None
            self.local_costmap_received_monotonic: float | None = None
            self.local_costmap_error: str | None = None
            self.estop_healthy: bool | None = None
            self.estop_received_monotonic: float | None = None
            self.robot_healthy: bool | None = None
            self.robot_health_received_monotonic: float | None = None
            self.action_client = ActionClient(self, NavigateThroughPoses, config["action_name"])
            self.spin_action_client = ActionClient(self, Spin, config["spin_action_name"])
            self.plan_action_client = ActionClient(
                self, ComputePathThroughPoses, config["plan_action_name"]
            )
            self.plan_lock = threading.Lock()
            self.tf_buffer = Buffer()
            self.tf_listener = TransformListener(self.tf_buffer, self)
            self.map_subscription = self.create_subscription(
                OccupancyGrid, config["map_topic"], self._map_callback, 10
            )
            self.pointcloud_subscriptions: dict[str, Any] = {}
            for topic in config["pointcloud_topics"]:
                self._subscribe_pointcloud(topic)
            self.local_costmap_subscription = self.create_subscription(
                OccupancyGrid, config["local_costmap_topic"], self._local_costmap_callback, 10
            )
            self.estop_subscription = (
                self.create_subscription(
                    Bool, config["estop_healthy_topic"], self._estop_callback, 10
                )
                if config["estop_healthy_topic"] else None
            )
            self.robot_health_subscription = (
                self.create_subscription(
                    Bool, config["robot_healthy_topic"], self._robot_health_callback, 10
                )
                if config["robot_healthy_topic"] else None
            )
            self.scan_health_timer = self.create_timer(0.05, self._scan_health_tick)
            self.pointcloud_discovery_timer = (
                self.create_timer(2.0, self._discover_pointcloud_sources)
                if config["auto_discover_pointcloud_topics"] else None
            )

        def _subscribe_pointcloud(self, topic: str) -> None:
            if topic in self.pointcloud_subscriptions:
                return
            self.pointcloud_subscriptions[topic] = self.create_subscription(
                PointCloud2,
                topic,
                lambda message, source_topic=topic: self._pointcloud_callback(message, source_topic),
                10,
            )

        def _discover_pointcloud_sources(self) -> None:
            try:
                topics, truncated = pointcloud_topics_for_runtime(
                    self.get_topic_names_and_types(),
                    self.config["pointcloud_topics"],
                )
            except Exception as error:
                self.pointcloud_discovery_error = "Could not inspect live point-cloud topics: {}".format(error)
                return
            existing = set(self.config["pointcloud_topics"])
            now = time.monotonic()
            for topic in topics:
                if topic in existing:
                    continue
                with self.lock:
                    self.pointcloud_sources[topic] = {
                        "received_monotonic": None,
                        "frame_id": None,
                        "stamp_age_ms": None,
                        "rate_started_monotonic": now,
                        "rate_window_count": 0,
                        "count": 0,
                        "rate_hz": None,
                        "callback_duration_ms": None,
                    }
                self._subscribe_pointcloud(topic)
            self.config["pointcloud_topics"] = topics
            self.pointcloud_discovery_truncated = truncated
            self.pointcloud_discovery_error = None

        def _estop_callback(self, message):
            with self.lock:
                self.estop_healthy = bool(message.data)
                self.estop_received_monotonic = time.monotonic()

        def _robot_health_callback(self, message):
            with self.lock:
                self.robot_healthy = bool(message.data)
                self.robot_health_received_monotonic = time.monotonic()

        def _estop_snapshot(self) -> dict[str, Any]:
            with self.lock:
                healthy = self.estop_healthy
                received_monotonic = self.estop_received_monotonic
            if not self.config["estop_healthy_topic"]:
                return {"ready": False, "age_ms": None, "error": "E-stop health topic is not configured."}
            age_seconds = time.monotonic() - received_monotonic if received_monotonic is not None else None
            return validate_estop_health(
                healthy,
                age_seconds,
                self.config["estop_max_age_seconds"],
            )

        def _robot_health_snapshot(self) -> dict[str, Any]:
            with self.lock:
                healthy = self.robot_healthy
                received_monotonic = self.robot_health_received_monotonic
            if not self.config["robot_healthy_topic"]:
                return {"ready": False, "age_ms": None, "error": "Robot-control health topic is not configured."}
            age_seconds = time.monotonic() - received_monotonic if received_monotonic is not None else None
            return validate_estop_health(
                healthy,
                age_seconds,
                self.config["robot_health_max_age_seconds"],
            )

        def _motion_health_snapshot(self) -> dict[str, Any]:
            estop = self._estop_snapshot()
            robot = self._robot_health_snapshot()
            return {
                "ready": estop["ready"] and robot["ready"],
                "estop": estop,
                "robot": robot,
                "error": estop["error"] or robot["error"],
            }

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

        def _pointcloud_callback(self, message, source_topic):
            callback_started = time.monotonic()
            source_frame = str(message.header.frame_id).strip()
            if not source_frame:
                return
            try:
                stamp_age_seconds = validate_pointcloud_timestamp(
                    int(message.header.stamp.sec),
                    int(message.header.stamp.nanosec),
                )
            except (TypeError, ValueError) as error:
                self.get_logger().warning(f"Skipping invalid or stale LiDAR cloud: {error}")
                return
            with self.lock:
                scan_id = self.active_scan_id
                scan = self.scans.get(scan_id) if scan_id else None
            if not scan or scan["state"] != "scanning":
                try:
                    if source_frame != self.config["map_frame"]:
                        self.tf_buffer.lookup_transform(
                            self.config["map_frame"],
                            source_frame,
                            Time.from_msg(message.header.stamp),
                            timeout=Duration(seconds=0.1),
                        )
                except (self._transform_exception, TypeError, ValueError) as error:
                    self.get_logger().warning(
                        f"Skipping LiDAR readiness sample without a valid map transform: {error}"
                    )
                    return
                self._record_pointcloud(
                    source_topic,
                    source_frame,
                    stamp_age_seconds,
                    time.monotonic() - callback_started,
                )
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
                self._record_pointcloud(
                    source_topic,
                    source_frame,
                    stamp_age_seconds,
                    time.monotonic() - callback_started,
                )
                voxels = scan["voxels"]
                for x, y, z in points:
                    key = (math.floor(x / 0.05), math.floor(y / 0.05), math.floor(z / 0.05))
                    if key in voxels or len(voxels) >= MAX_SCAN_POINTS:
                        continue
                    voxels[key] = (x, y, z)
                scan["last_cloud_monotonic"] = time.monotonic()
                scan["updated_at"] = _utc_now()

        def _record_pointcloud(
            self,
            source_topic: str,
            source_frame: str,
            stamp_age_seconds: float,
            callback_duration_seconds: float,
        ) -> None:
            now = time.monotonic()
            with self.lock:
                source = self.pointcloud_sources[source_topic]
                source["received_monotonic"] = now
                source["frame_id"] = source_frame
                source["stamp_age_ms"] = stamp_age_seconds * 1000
                source["callback_duration_ms"] = callback_duration_seconds * 1000
                source["count"] += 1
                source["rate_window_count"] += 1
                elapsed = now - source["rate_started_monotonic"]
                if elapsed >= POINTCLOUD_RATE_WINDOW_SECONDS:
                    source["rate_hz"] = source["rate_window_count"] / elapsed
                    source["rate_started_monotonic"] = now
                    source["rate_window_count"] = 0

        def _pointcloud_snapshot(self) -> dict[str, Any]:
            now = time.monotonic()
            with self.lock:
                sources = [
                    {
                        "topic": topic,
                        "frame_id": source["frame_id"],
                        "ready": source["received_monotonic"] is not None
                        and now - source["received_monotonic"] <= SCAN_SENSOR_MAX_AGE_SECONDS,
                        "age_ms": round((now - source["received_monotonic"]) * 1000)
                        if source["received_monotonic"] is not None else None,
                        "stamp_age_ms": round(source["stamp_age_ms"], 1)
                        if source["stamp_age_ms"] is not None else None,
                        "count": source["count"],
                        "rate_hz": source["rate_hz"],
                        "callback_duration_ms": round(source["callback_duration_ms"], 1)
                        if source["callback_duration_ms"] is not None else None,
                    }
                    for topic, source in self.pointcloud_sources.items()
                ]
            for source in sources:
                if not source["ready"]:
                    source["error"] = "No recent transform-valid point cloud from this sensor."
            health = _aggregate_pointcloud_health(sources, now_monotonic=now)
            self.pointcloud_received_monotonic = health["latest_received_monotonic"]
            fresh_sources = health["fresh_sources"]
            return {
                "ready": health["ready"],
                "age_ms": health["age_ms"],
                "sources": sources,
            }

        def _scan_health_tick(self):
            motion_health = self._motion_health_snapshot()
            if not motion_health["ready"]:
                with self.lock:
                    operation_id = self.active_operation_id
                    operation = self.operations.get(operation_id) if operation_id else None
                    scan_id = self.active_scan_id
                    scan = self.scans.get(scan_id) if scan_id else None
                reason = motion_health["error"] or "Robot motion health is unavailable."
                if operation and operation["state"] not in TERMINAL_STATES:
                    try:
                        self.cancel_operation(operation_id)
                    except GatewayHTTPError as error:
                        self.get_logger().error(
                            f"E-stop health failed during navigation; cancellation is unconfirmed and locomotion remains locked: {error}"
                        )
                if (
                    scan
                    and scan["state"] == "scanning"
                    and scan.get("rotation_status") not in {"cancel_requested", "uncertain"}
                ):
                    self._abort_scan(scan_id, f"{reason} Scan rotation cancellation requested.")
                    return
            with self.lock:
                scan_id = self.active_scan_id
                scan = self.scans.get(scan_id) if scan_id else None
                if not scan or scan["state"] != "scanning":
                    return
                if scan.get("rotation_status") in {
                    "completed", "cancel_requested", "uncertain",
                }:
                    return
                last_cloud_monotonic = scan.get("last_cloud_monotonic", scan["created_monotonic"])
            now = time.monotonic()
            if now - last_cloud_monotonic > SCAN_SENSOR_MAX_AGE_SECONDS:
                self._abort_scan(scan_id, "LiDAR point-cloud data became stale during the rotation.")
                return
            if self.grid_received_monotonic is None or now - self.grid_received_monotonic > SCAN_MAP_MAX_AGE_SECONDS:
                self._abort_scan(scan_id, "The SLAM occupancy map became stale during the rotation.")
                return
            localization = self._localization_snapshot()
            if not localization.get("ready"):
                self._abort_scan(
                    scan_id,
                    localization.get("error") or "Robot localization became unavailable during the rotation.",
                )
                return
            yaw = localization["pose"]["yaw_rad"]
            with self.lock:
                scan = self.scans.get(scan_id)
                if not scan or scan["state"] != "scanning" or scan.get("rotation_status") == "completed":
                    return
                previous_yaw = scan.get("last_yaw")
                if previous_yaw is not None:
                    scan["rotation_radians"] = accumulate_scan_rotation(
                        scan["rotation_radians"], previous_yaw, yaw
                    )
                scan["last_yaw"] = yaw
                scan["updated_at"] = _utc_now()

        def _abort_scan(self, job_id: str, reason: str) -> None:
            with self.lock:
                scan = self.scans.get(job_id)
                if not scan or scan["state"] != "scanning":
                    return
                scan["failure_reason"] = reason
                scan["rotation_status"] = "cancel_requested"
                scan["error"] = reason
                scan["updated_at"] = _utc_now()
                handle = scan.get("_goal_handle")
                if handle is None:
                    scan["rotation_status"] = "uncertain"
                    scan["error"] = f"{reason} Nav2 has not confirmed the rotation goal state."
                    return
            try:
                future = handle.cancel_goal_async()
                future.add_done_callback(lambda completed, scan_id=job_id: self._scan_cancel_response(scan_id, completed))
            except Exception as error:
                with self.lock:
                    scan = self.scans.get(job_id)
                    if scan and scan["state"] == "scanning":
                        scan["rotation_status"] = "uncertain"
                        scan["error"] = f"{reason} Nav2 cancellation could not be confirmed: {error}"
                        scan["updated_at"] = _utc_now()

        def _scan_goal_response(self, job_id: str, future: Any) -> None:
            try:
                handle = future.result()
            except Exception as error:
                with self.lock:
                    scan = self.scans.get(job_id)
                    if scan and scan["state"] == "scanning":
                        scan["rotation_status"] = "uncertain"
                        scan["error"] = f"Nav2 Spin goal response is unknown: {error}"
                        scan["updated_at"] = _utc_now()
                return
            with self.lock:
                scan = self.scans.get(job_id)
                if scan is None:
                    return
                if not handle.accepted:
                    self._finish_scan_locked(scan, "failed", "Nav2 rejected the in-place rotation.")
                    return
                scan["_goal_handle"] = handle
                cancel_requested = scan["rotation_status"] in {"cancel_requested", "uncertain"}
                if not cancel_requested:
                    scan["rotation_status"] = "rotating"
                    scan["updated_at"] = _utc_now()
            result_future = handle.get_result_async()
            result_future.add_done_callback(
                lambda completed, scan_id=job_id: self._scan_result_callback(scan_id, completed)
            )
            if cancel_requested:
                try:
                    cancel_future = handle.cancel_goal_async()
                    cancel_future.add_done_callback(
                        lambda completed, scan_id=job_id: self._scan_cancel_response(scan_id, completed)
                    )
                except Exception as error:
                    with self.lock:
                        scan = self.scans.get(job_id)
                        if scan and scan["state"] == "scanning":
                            scan["rotation_status"] = "uncertain"
                            scan["error"] = f"Nav2 cancellation could not be confirmed: {error}"

        def _scan_cancel_response(self, job_id: str, future: Any) -> None:
            try:
                response = future.result()
                accepted = bool(response.goals_canceling)
            except Exception as error:
                accepted = False
                message = f"Nav2 cancellation acknowledgement failed: {error}"
            else:
                message = "Nav2 has not acknowledged cancellation."
            if accepted:
                return
            with self.lock:
                scan = self.scans.get(job_id)
                if scan and scan["state"] == "scanning":
                    scan["rotation_status"] = "uncertain"
                    scan["error"] = f"{scan.get('failure_reason') or 'Scan cancellation requested.'} {message}"
                    scan["updated_at"] = _utc_now()

        def _scan_result_callback(self, job_id: str, future: Any) -> None:
            try:
                wrapped = future.result()
                result = wrapped.result
                status = int(wrapped.status)
                if not hasattr(result, "error_code"):
                    raise ValueError("Nav2 Spin result did not include its error code.")
                error_code = int(result.error_code)
                error_message = str(getattr(result, "error_msg", "") or "")
            except Exception as error:
                with self.lock:
                    scan = self.scans.get(job_id)
                    if scan and scan["state"] == "scanning":
                        scan["rotation_status"] = "uncertain"
                        scan["error"] = f"Nav2 Spin terminal result is unknown: {error}"
                        scan["updated_at"] = _utc_now()
                return
            with self.lock:
                scan = self.scans.get(job_id)
                if not scan or scan["state"] != "scanning":
                    return
                if scan.get("failure_reason"):
                    self._finish_scan_locked(scan, "failed", scan["failure_reason"])
                elif scan.get("rotation_status") == "cancel_requested":
                    self._finish_scan_locked(
                        scan,
                        "canceled",
                        "The teacher canceled the 360-degree scan.",
                    )
                elif status == self._goal_status.STATUS_CANCELED:
                    state = "failed" if scan.get("failure_reason") else "canceled"
                    message = scan.get("failure_reason") or "The teacher canceled the 360-degree scan."
                    self._finish_scan_locked(scan, state, message)
                elif status != self._goal_status.STATUS_SUCCEEDED or error_code != 0:
                    self._finish_scan_locked(
                        scan,
                        "failed",
                        error_message or f"Nav2 Spin failed (status {status}, error {error_code}).",
                    )
                elif not scan_rotation_complete(scan["rotation_radians"]):
                    self._finish_scan_locked(
                        scan,
                        "failed",
                        f"Measured rotation was only {abs(scan['rotation_radians']):.2f} radians; a complete 360-degree turn was not confirmed.",
                    )
                else:
                    scan["rotation_status"] = "completed"
                    scan["updated_at"] = _utc_now()

        def _finish_scan_locked(self, scan: dict[str, Any], state: str, error: str | None) -> None:
            scan["state"] = state
            scan["rotation_status"] = state
            scan["error"] = error
            scan["updated_at"] = _utc_now()
            scan["completed_at"] = scan["updated_at"]
            if self.active_scan_id == scan["job_id"]:
                self.active_scan_id = None

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
                "rotation_status": scan.get("rotation_status"),
                "rotation_radians": abs(scan.get("rotation_radians", 0.0)),
                "error": scan.get("error"),
                "preview_points": [
                    {"x": point[0], "y": point[1], "z": point[2]}
                    for point in preview
                ],
            }

        def start_scan(self) -> dict[str, Any]:
            with self.lock:
                if not controller_ownership_ready(
                    self.config["locomotion_owner"],
                    self.config["controller_ownership_confirmed"],
                ):
                    raise GatewayHTTPError(
                        503,
                        "Single-controller ownership is not commissioned; no scan motion was started.",
                    )
                motion_health = self._motion_health_snapshot()
                if not motion_health["ready"]:
                    raise GatewayHTTPError(503, motion_health["error"] or "Robot motion health is unavailable.")
                if self.grid is None:
                    raise GatewayHTTPError(503, "A valid SLAM OccupancyGrid is required before scanning.")
                if (
                    self.grid_received_monotonic is None
                    or time.monotonic() - self.grid_received_monotonic > SCAN_MAP_MAX_AGE_SECONDS
                ):
                    raise GatewayHTTPError(503, "The SLAM occupancy map is stale; refresh it before scanning.")
                pointcloud_sources = [
                    source for source in self._pointcloud_snapshot()["sources"]
                    if source["ready"] and source["frame_id"]
                ]
                if not pointcloud_sources:
                    raise GatewayHTTPError(
                        503,
                        "No configured point-cloud sensor is currently fresh and transform-valid. "
                        "Navigation can still use the live map and Nav2 costmap; a 3D scan needs at least one sensor.",
                    )
                if not self.spin_action_client.server_is_ready():
                    raise GatewayHTTPError(503, "Nav2 Spin action server is not ready; no scan motion was started.")
                localization = self._localization_snapshot()
                if not localization.get("ready"):
                    raise GatewayHTTPError(
                        503,
                        localization.get("error") or "Fresh robot localization is required before scanning.",
                    )
                transformable_sources = []
                for source in pointcloud_sources:
                    try:
                        self.tf_buffer.lookup_transform(
                            self.config["map_frame"],
                            source["frame_id"],
                            Time(),
                            timeout=Duration(seconds=0.1),
                        )
                    except (self._transform_exception, TypeError, ValueError):
                        continue
                    transformable_sources.append(source)
                if not transformable_sources:
                    raise GatewayHTTPError(
                        503,
                        "No live point-cloud sensor has a valid map transform; unavailable sensors were skipped.",
                    )
                if self.active_operation_id:
                    raise GatewayHTTPError(409, "Cannot scan while a Nav2 route owns locomotion.")
                if self.active_scan_id:
                    active = self.scans.get(self.active_scan_id)
                    if active and active["state"] == "scanning":
                        raise GatewayHTTPError(409, "A LiDAR scan is already active.")
                job_id = str(uuid.uuid4())
                now = _utc_now()
                pose = localization["pose"]
                self.scans[job_id] = {
                    "job_id": job_id,
                    "state": "scanning",
                    "rotation_status": "submitted",
                    "rotation_radians": 0.0,
                    "last_yaw": pose["yaw_rad"],
                    "created_monotonic": time.monotonic(),
                    "last_cloud_monotonic": time.monotonic(),
                    "frame_id": self.config["map_frame"],
                    "created_at": now,
                    "updated_at": now,
                    "voxels": {},
                    "_goal_handle": None,
                }
                self.active_scan_id = job_id
                scan = self.scans[job_id]
                goal = self._spin_action.Goal()
                goal.target_yaw = SCAN_ROTATION_RADIANS
                goal.time_allowance = Duration(
                    seconds=self.config["scan_rotation_timeout_seconds"]
                ).to_msg()
                try:
                    future = self.spin_action_client.send_goal_async(goal)
                    future.add_done_callback(
                        lambda completed, scan_id=job_id: self._scan_goal_response(scan_id, completed)
                    )
                except Exception as error:
                    scan["rotation_status"] = "uncertain"
                    scan["error"] = f"Nav2 Spin submission outcome is unknown: {error}"
                return self._public_scan(scan)

        def complete_scan(self, job_id: str) -> dict[str, Any]:
            with self.lock:
                scan = self.scans.get(job_id)
                if scan is None:
                    raise GatewayHTTPError(404, "LiDAR scan job was not found.")
                if scan["state"] != "scanning":
                    return self._public_scan(scan)
                if scan.get("rotation_status") != "completed":
                    raise GatewayHTTPError(
                        409,
                        "A complete, successful Nav2 360-degree rotation is required before finalizing the scan.",
                    )
                now = time.monotonic()
                if now - scan.get("last_cloud_monotonic", 0.0) > SCAN_SENSOR_MAX_AGE_SECONDS:
                    scan["state"] = "failed"
                    scan["rotation_status"] = "failed"
                    scan["error"] = "MID-360 point-cloud data became stale before scan validation."
                elif (
                    self.grid_received_monotonic is None
                    or now - self.grid_received_monotonic > SCAN_MAP_MAX_AGE_SECONDS
                ):
                    scan["state"] = "failed"
                    scan["rotation_status"] = "failed"
                    scan["error"] = "The SLAM occupancy map became stale before scan validation."
                elif not self._localization_snapshot().get("ready"):
                    scan["state"] = "failed"
                    scan["rotation_status"] = "failed"
                    scan["error"] = "Fresh robot localization is required to validate the completed scan."
                if scan["state"] != "failed":
                    if len(scan["voxels"]) < MIN_COMPLETED_SCAN_POINTS:
                        scan["state"] = "failed"
                        scan["rotation_status"] = "failed"
                        scan["error"] = (
                            f"Scan has {len(scan['voxels'])} unique points; at least "
                            f"{MIN_COMPLETED_SCAN_POINTS} are required. Check sensor coverage and try again."
                        )
                    else:
                        grid = self.grid
                        if grid is None:
                            scan["state"] = "failed"
                            scan["rotation_status"] = "failed"
                            scan["error"] = "The SLAM occupancy map is no longer available."
                        else:
                            scan["state"] = "completed"
                            scan["rotation_status"] = "completed"
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
                    if scan.get("rotation_status") == "completed":
                        scan["state"] = "canceled"
                        scan["rotation_status"] = "canceled"
                        scan["error"] = "The teacher canceled the scan before map validation."
                        scan["updated_at"] = _utc_now()
                        scan["completed_at"] = scan["updated_at"]
                        if self.active_scan_id == job_id:
                            self.active_scan_id = None
                        return self._public_scan(scan)
                    scan["rotation_status"] = "cancel_requested"
                    scan["updated_at"] = _utc_now()
                    handle = scan.get("_goal_handle")
                    if handle is None:
                        scan["error"] = "Waiting for Nav2 to confirm the Spin goal before cancellation."
                    else:
                        try:
                            future = handle.cancel_goal_async()
                            future.add_done_callback(
                                lambda completed, scan_id=job_id: self._scan_cancel_response(scan_id, completed)
                            )
                        except Exception as error:
                            scan["rotation_status"] = "uncertain"
                            scan["error"] = f"Nav2 cancellation could not be confirmed: {error}"
                elif scan["state"] not in {"canceled", "failed", "completed"}:
                    raise GatewayHTTPError(409, "The scan is not in a cancelable state.")
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
                if scan["state"] != "completed":
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

        def _local_costmap_callback(self, message):
            info = message.info
            frame = str(message.header.frame_id).strip()
            width, height = int(info.width), int(info.height)
            resolution = float(info.resolution)
            if (
                not frame
                or width < 1
                or height < 1
                or width * height > MAX_MAP_CELLS
                or len(message.data) != width * height
                or not math.isfinite(resolution)
                or resolution <= 0
            ):
                with self.lock:
                    self.local_costmap_error = "Nav2 local costmap has invalid dimensions, data, or frame."
                return
            try:
                stamp_age_seconds = validate_pointcloud_timestamp(
                    int(message.header.stamp.sec),
                    int(message.header.stamp.nanosec),
                )
                if frame == self.config["map_frame"]:
                    translation = (0.0, 0.0, 0.0)
                    rotation = type("IdentityRotation", (), {
                        "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0,
                    })()
                else:
                    transform = self.tf_buffer.lookup_transform(
                        self.config["map_frame"],
                        frame,
                        Time.from_msg(message.header.stamp),
                        timeout=Duration(seconds=0.1),
                    )
                    translation = (
                        float(transform.transform.translation.x),
                        float(transform.transform.translation.y),
                        float(transform.transform.translation.z),
                    )
                    rotation = transform.transform.rotation
                origin = info.origin
                origin_x = float(origin.position.x)
                origin_y = float(origin.position.y)
                origin_yaw = _yaw_from_quaternion(origin.orientation)
                transform_yaw = _yaw_from_quaternion(rotation)
                if not all(math.isfinite(value) for value in (
                    origin_x, origin_y, origin_yaw, transform_yaw, *translation,
                )):
                    raise ValueError("Nav2 local costmap transform is non-finite.")
                raw_data = tuple(int(cell) for cell in message.data)
                if any(cell < -1 or cell > 100 for cell in raw_data):
                    raise ValueError("Nav2 local costmap occupancy values must be between -1 and 100.")

                cell_count = width * height
                stride = max(1, math.ceil(cell_count / MAX_LIVE_OBSTACLE_POINTS))
                origin_cosine = math.cos(origin_yaw)
                origin_sine = math.sin(origin_yaw)
                points = []
                for index in range(0, cell_count, stride):
                    if raw_data[index] < self.config["occupied_threshold"]:
                        continue
                    column = index % width
                    row = index // width
                    local_x = (column + 0.5) * resolution
                    local_y = (row + 0.5) * resolution
                    frame_x = origin_x + origin_cosine * local_x - origin_sine * local_y
                    frame_y = origin_y + origin_sine * local_x + origin_cosine * local_y
                    mapped_x, mapped_y, _ = self._rotate_point(
                        (frame_x, frame_y, 0.0), rotation
                    )
                    points.append({
                        "x": mapped_x + translation[0],
                        "y": mapped_y + translation[1],
                    })
                snapshot = {
                    "ready": True,
                    "frame_id": self.config["map_frame"],
                    "age_ms": round(stamp_age_seconds * 1000),
                    "points": points,
                    "updated_at": _utc_now(),
                }
            except (self._transform_exception, TypeError, ValueError, IndexError) as error:
                with self.lock:
                    self.local_costmap_error = str(error)
                return
            with self.lock:
                self.local_costmap = snapshot
                self.local_costmap_received_monotonic = time.monotonic()
                self.local_costmap_error = None

        def _local_costmap_snapshot(self) -> dict[str, Any]:
            with self.lock:
                snapshot = self.local_costmap
                received = self.local_costmap_received_monotonic
                error = self.local_costmap_error
            age_seconds = time.monotonic() - received if received is not None else math.inf
            ready = snapshot is not None and age_seconds <= SCAN_SENSOR_MAX_AGE_SECONDS
            return {
                "ready": ready,
                "frame_id": snapshot["frame_id"] if ready else self.config["map_frame"],
                "age_ms": round(age_seconds * 1000) if math.isfinite(age_seconds) else None,
                "points": snapshot["points"] if ready else [],
                "updated_at": snapshot["updated_at"] if ready else None,
                "error": None if ready else error or "Nav2 local costmap is missing or stale.",
            }

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
            motion_health = self._motion_health_snapshot()
            live_obstacles = self._local_costmap_snapshot()
            pointcloud_status = self._pointcloud_snapshot()
            with self.lock:
                grid = self.grid
                grid_age = (
                    time.monotonic() - self.grid_received_monotonic
                    if self.grid_received_monotonic is not None else math.inf
                )
                active = self.operations.get(self.active_operation_id) if self.active_operation_id else None
            map_ready = grid is not None and grid_age <= SCAN_MAP_MAX_AGE_SECONDS
            pointcloud_ready = pointcloud_status["ready"]
            action_ready = self.action_client.server_is_ready()
            ready = bool(map_ready and localization["ready"] and action_ready)
            ownership_ready = controller_ownership_ready(
                self.config["locomotion_owner"],
                self.config["controller_ownership_confirmed"],
            )
            motion_ready = bool(ready and motion_health["ready"] and ownership_ready)
            map_metadata = self._metadata(grid) if grid else None
            ready_sources = [source for source in pointcloud_status["sources"] if source["ready"]]
            source_count = len(pointcloud_status["sources"])
            return {
                "ready": ready,
                "status": "ready" if ready else "unavailable",
                "motion_ready": motion_ready,
                "live_avoidance_ready": bool(
                    self.config["live_avoidance_enabled"] and live_obstacles["ready"]
                ),
                "live_obstacles": live_obstacles,
                "estop": motion_health["estop"],
                "robot_health": motion_health["robot"],
                "planner_ready": bool(map_ready and action_ready),
                "action_server_ready": action_ready,
                "map_ready": map_ready,
                "map_age_ms": round(max(0.0, grid_age) * 1000) if math.isfinite(grid_age) else None,
                "pointcloud_ready": pointcloud_ready,
                "pointcloud_age_ms": pointcloud_status["age_ms"],
                "pointcloud_sources": pointcloud_status["sources"],
                "localization": localization,
                "map": map_metadata,
                "diagnostics": {
                    "topics": {
                        "pointcloud": ", ".join(self.config["pointcloud_topics"]),
                        "pointcloud_sources": self.config["pointcloud_topics"],
                        "map": self.config["map_topic"],
                        "local_costmap": self.config["local_costmap_topic"],
                    },
                    "frames": {
                        "pointcloud": ", ".join(sorted({
                            source["frame_id"] for source in ready_sources if source["frame_id"]
                        })) or None,
                        "map": self.config["map_frame"],
                        "base": self.config["base_frame"],
                    },
                    "pointcloud": {
                        "ready": pointcloud_ready,
                        "ready_sources": len(ready_sources),
                        "configured_sources": source_count,
                        "discovery_truncated": self.pointcloud_discovery_truncated,
                        "discovery_error": self.pointcloud_discovery_error,
                        "count": sum(source["count"] for source in pointcloud_status["sources"]),
                        "rate_hz": sum(source["rate_hz"] or 0 for source in ready_sources)
                        if ready_sources else None,
                        "age_ms": pointcloud_status["age_ms"],
                        "sources": pointcloud_status["sources"],
                    },
                    "map": {
                        "occupied_threshold": self.config["occupied_threshold"],
                        "metadata": map_metadata,
                        "age_ms": round(max(0.0, grid_age) * 1000)
                        if math.isfinite(grid_age) else None,
                    },
                    "local_costmap": {
                        "ready": live_obstacles["ready"],
                        "age_ms": live_obstacles["age_ms"],
                        "obstacle_count": len(live_obstacles["points"]),
                        "live_avoidance_enabled": self.config["live_avoidance_enabled"],
                    },
                    "actions": {
                        "navigation": action_ready,
                        "route_preview": self.plan_action_client.server_is_ready(),
                        "spin": self.spin_action_client.server_is_ready(),
                    },
                    "controller": {
                        "owner": self.config["locomotion_owner"],
                        "ownership_confirmed": self.config["controller_ownership_confirmed"],
                        "ready": ownership_ready,
                    },
                },
                "active_operation": self._public_operation(active) if active else None,
                "scan_rotation_ready": self.spin_action_client.server_is_ready(),
                "route_preview_ready": self.plan_action_client.server_is_ready(),
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

        def plan_route(self, request: Any) -> dict[str, Any]:
            if not isinstance(request, dict):
                raise GatewayHTTPError(400, "Request body must be a JSON object.")
            if not self.plan_lock.acquire(blocking=False):
                raise GatewayHTTPError(409, "A route preview is already being calculated.")
            try:
                with self.lock:
                    grid = self.grid
                    if grid is None:
                        raise GatewayHTTPError(503, "No valid map is available yet.")
                    if (
                        self.grid_received_monotonic is None
                        or time.monotonic() - self.grid_received_monotonic > SCAN_MAP_MAX_AGE_SECONDS
                    ):
                        raise GatewayHTTPError(503, "The SLAM occupancy map is stale; no route was planned.")
                    if request.get("map_id") != grid["map_id"]:
                        raise GatewayHTTPError(409, "map_id does not match the current map.")
                    if request.get("version") != grid["version"]:
                        raise GatewayHTTPError(409, "Map version is stale; fetch the current map and retry.")
                    if request.get("frame_id") != grid["frame_id"] or grid["frame_id"] != self.config["map_frame"]:
                        raise GatewayHTTPError(409, "frame_id must exactly match the current map frame.")
                    goals = request.get("goals")
                    planner_mode = request.get("planner_mode", "live")
                    if planner_mode not in {"live", "static"}:
                        raise GatewayHTTPError(400, "planner_mode must be 'live' or 'static'.")
                    if planner_mode == "live":
                        live_obstacles = self._local_costmap_snapshot()
                        if not self.config["live_avoidance_enabled"] or not live_obstacles["ready"]:
                            raise GatewayHTTPError(
                                503,
                                "Live adaptive navigation requires a fresh Nav2 local costmap and commissioned obstacle avoidance.",
                            )
                    if not isinstance(goals, list) or not goals or len(goals) > MAX_GOALS:
                        raise GatewayHTTPError(400, f"goals must contain between 1 and {MAX_GOALS} poses.")
                    valid_goals = []
                    for index, goal in enumerate(goals):
                        if not isinstance(goal, dict):
                            raise GatewayHTTPError(400, f"Goal {index + 1} must be an object.")
                        try:
                            x = _finite_number(goal.get("x"), f"goal {index + 1} x")
                            y = _finite_number(goal.get("y"), f"goal {index + 1} y")
                            yaw = _finite_number(goal.get("yaw_rad", 0.0), f"goal {index + 1} yaw_rad")
                        except ValueError as error:
                            raise GatewayHTTPError(400, str(error)) from error
                        if abs(x) > 1_000_000 or abs(y) > 1_000_000 or abs(yaw) > 1_000_000:
                            raise GatewayHTTPError(400, f"Goal {index + 1} exceeds numeric bounds.")
                        if not self._cell_is_free(grid, x, y):
                            raise GatewayHTTPError(
                                422, f"Goal {index + 1} is outside the map, unknown, or occupied."
                            )
                        valid_goals.append((x, y, yaw))
                    map_id = grid["map_id"]
                    map_version = grid["version"]
                    frame_id = grid["frame_id"]

                if (
                    self.pointcloud_received_monotonic is None
                    or time.monotonic() - self.pointcloud_received_monotonic > SCAN_SENSOR_MAX_AGE_SECONDS
                ):
                    raise GatewayHTTPError(503, "The MID-360 point-cloud stream is stale; no route was planned.")
                if self.active_operation_id:
                    operation = self.operations.get(self.active_operation_id)
                    if operation and operation["state"] not in TERMINAL_STATES:
                        raise GatewayHTTPError(409, "Cannot preview a route while Nav2 is executing another route.")
                if self.active_scan_id:
                    scan = self.scans.get(self.active_scan_id)
                    if scan and scan["state"] == "scanning":
                        raise GatewayHTTPError(409, "Cannot preview a route while a LiDAR scan is active.")
                if not self.plan_action_client.server_is_ready():
                    raise GatewayHTTPError(503, "Nav2 ComputePathThroughPoses action server is not ready.")
                localization = self._localization_snapshot()
                if not localization.get("ready"):
                    raise GatewayHTTPError(
                        503, localization.get("error") or "Fresh localization is required for route preview."
                    )

                goal_message = self._plan_action.Goal()
                goal_message.use_start = False
                goal_message.planner_id = self.config["planner_id"]
                for x, y, yaw in valid_goals:
                    pose = self._pose_stamped()
                    pose.header.frame_id = frame_id
                    pose.header.stamp = self.get_clock().now().to_msg()
                    pose.pose.position.x = x
                    pose.pose.position.y = y
                    pose.pose.orientation.z = math.sin(yaw / 2.0)
                    pose.pose.orientation.w = math.cos(yaw / 2.0)
                    goal_message.goals.append(pose)

                goal_future = self.plan_action_client.send_goal_async(goal_message)
                goal_ready = threading.Event()
                goal_future.add_done_callback(lambda _future: goal_ready.set())
                deadline = time.monotonic() + self.config["plan_timeout_seconds"]
                remaining = max(0.0, deadline - time.monotonic())
                if not goal_ready.wait(remaining):
                    raise GatewayHTTPError(504, "Nav2 did not respond to the route preview request in time.")
                try:
                    goal_handle = goal_future.result()
                except Exception as error:
                    raise GatewayHTTPError(503, f"Nav2 route preview response failed: {error}") from error
                if not goal_handle.accepted:
                    raise GatewayHTTPError(422, "Nav2 planner rejected the route preview.")

                result_future = goal_handle.get_result_async()
                result_ready = threading.Event()
                result_future.add_done_callback(lambda _future: result_ready.set())
                remaining = max(0.0, deadline - time.monotonic())
                if not result_ready.wait(remaining):
                    try:
                        goal_handle.cancel_goal_async()
                    except Exception as error:
                        self.get_logger().error(f"Timed-out route preview cancellation failed: {error}")
                    raise GatewayHTTPError(504, "Nav2 route preview timed out; no movement goal was sent.")
                try:
                    wrapped = result_future.result()
                    if int(wrapped.status) != self._goal_status.STATUS_SUCCEEDED:
                        raise GatewayHTTPError(422, "Nav2 could not find a valid path through the selected goals.")
                    path = wrapped.result.path
                except GatewayHTTPError:
                    raise
                except Exception as error:
                    raise GatewayHTTPError(503, f"Nav2 route preview result failed: {error}") from error

                if str(path.header.frame_id).strip() != frame_id:
                    raise GatewayHTTPError(503, "Nav2 preview path frame does not match the current map.")
                if not path.poses or len(path.poses) > MAX_PREVIEW_PATH_POSES:
                    raise GatewayHTTPError(422, "Nav2 returned an empty or oversized route preview.")
                points = []
                for index, pose in enumerate(path.poses):
                    if str(pose.header.frame_id).strip() != frame_id:
                        raise GatewayHTTPError(
                            503, f"Nav2 preview pose {index + 1} does not use the current map frame."
                        )
                    x = float(pose.pose.position.x)
                    y = float(pose.pose.position.y)
                    if not math.isfinite(x) or not math.isfinite(y):
                        raise GatewayHTTPError(503, f"Nav2 preview pose {index + 1} is not finite.")
                    points.append({"x": x, "y": y})
                with self.lock:
                    if self.grid is None or self.grid["version"] != map_version:
                        raise GatewayHTTPError(409, "Map changed while calculating route preview; refresh and retry.")
                return {
                    "map_id": map_id,
                    "version": map_version,
                    "frame_id": frame_id,
                    "planner_id": self.config["planner_id"],
                    "path": points,
                }
            finally:
                self.plan_lock.release()

        def submit_route(self, request: Any) -> dict[str, Any]:
            if not isinstance(request, dict):
                raise GatewayHTTPError(400, "Request body must be a JSON object.")
            with self.lock:
                grid = self.grid
                if grid is None:
                    raise GatewayHTTPError(503, "No valid map is available yet.")
                if (
                    self.grid_received_monotonic is None
                    or time.monotonic() - self.grid_received_monotonic > SCAN_MAP_MAX_AGE_SECONDS
                ):
                    raise GatewayHTTPError(503, "The SLAM occupancy map is stale; no navigation route was started.")
                if (
                    self.pointcloud_received_monotonic is None
                    or time.monotonic() - self.pointcloud_received_monotonic > SCAN_SENSOR_MAX_AGE_SECONDS
                ):
                    raise GatewayHTTPError(503, "The MID-360 point-cloud stream is stale; no navigation route was started.")
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
                if self.active_scan_id is not None:
                    scan = self.scans.get(self.active_scan_id)
                    if scan and scan["state"] not in {"completed", "failed", "canceled"}:
                        raise GatewayHTTPError(409, "A 360-degree LiDAR scan owns locomotion.")
                motion_health = self._motion_health_snapshot()
                if not motion_health["ready"]:
                    raise GatewayHTTPError(503, motion_health["error"] or "Robot motion health is unavailable.")
                if not controller_ownership_ready(
                    self.config["locomotion_owner"],
                    self.config["controller_ownership_confirmed"],
                ):
                    raise GatewayHTTPError(
                        503,
                        "Single-controller ownership is not commissioned; no navigation route was started.",
                    )
                if not self.action_client.server_is_ready():
                    raise GatewayHTTPError(503, "Nav2 NavigateThroughPoses action server is not ready.")
                start_localization = self._localization_snapshot()
                if not start_localization.get("ready") or start_localization.get("frame_id") != grid["frame_id"]:
                    raise GatewayHTTPError(503, "Fresh localization in the active map frame is required before route execution.")
                start_pose = start_localization["pose"]

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
                    "planner_mode": planner_mode,
                    "goals": [
                        {"x": x, "y": y, "yaw_rad": yaw}
                        for x, y, yaw in valid_goals
                    ],
                    "path_trace": [{
                        **start_pose,
                        "frame_id": start_localization["frame_id"],
                    }],
                    "path_trace_truncated": False,
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

        def _feedback_callback(self, operation_id: str, feedback: Any) -> None:
            with self.lock:
                operation = self.operations.get(operation_id)
                if operation and operation["state"] in {"submitted", "running"}:
                    operation["state"] = "running"
                    operation["updated_at"] = _utc_now()
                    current_pose = getattr(feedback.feedback, "current_pose", None)
                    if current_pose is not None:
                        position = current_pose.pose.position
                        orientation = current_pose.pose.orientation
                        x = float(position.x)
                        y = float(position.y)
                        qz = float(orientation.z)
                        qw = float(orientation.w)
                        frame_id = str(current_pose.header.frame_id)
                        if all(math.isfinite(value) for value in (x, y, qz, qw)):
                            yaw_rad = math.atan2(2.0 * qw * qz, 1.0 - 2.0 * qz * qz)
                            sample = {
                                "x": x,
                                "y": y,
                                "yaw_rad": yaw_rad,
                                "frame_id": frame_id,
                            }
                            operation["current_pose"] = sample
                            if frame_id != operation["frame_id"]:
                                operation["path_trace_error"] = "Nav2 feedback frame does not match the route frame."
                            else:
                                trace = operation["path_trace"]
                                previous = trace[-1] if trace else None
                                moved = previous is None or math.hypot(
                                    x - previous["x"], y - previous["y"]
                                ) >= 0.05
                                turned = previous is None or abs(
                                    (yaw_rad - previous["yaw_rad"] + math.pi) % (2 * math.pi) - math.pi
                                ) >= 0.08
                                if moved or turned:
                                    if len(trace) < 2_000:
                                        trace.append(sample)
                                    else:
                                        operation["path_trace_truncated"] = True

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
                elif self.command == "POST" and path == "/api/v1/navigation/plan":
                    self._json(200, node.plan_route(self._body()))
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
