from __future__ import annotations

import ipaddress
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

BRIDGE_TIMEOUT_SECONDS = 0.5
SCAN_STATUS_TIMEOUT_SECONDS = 3.0
SCAN_POINTCLOUD_TIMEOUT_SECONDS = 15.0
NAVIGATION_PLAN_TIMEOUT_SECONDS = 65.0
MAX_LOCALIZATION_AGE_SECONDS = 1.0
MAX_POINTCLOUD_AGE_SECONDS = 1.5
MAX_MAP_CELLS = 100_000_000
MAX_PREVIEW_MAP_CELLS = 250_000
MAX_NAVIGATION_WAYPOINTS = 20
MAX_NAVIGATION_PREVIEW_POINTS = 50_000
MAX_SCAN_POINTS = 300_000


class NavigationBridgeError(RuntimeError):
    pass


def _bridge_configuration() -> tuple[str, str]:
    base_url = os.getenv("G1_NAV_BRIDGE_URL", "").strip().rstrip("/")
    token = os.getenv("G1_NAV_BRIDGE_TOKEN", "").strip()
    parsed = urlparse(base_url)
    if not base_url or not token:
        raise NavigationBridgeError(
            "LiDAR navigation bridge is not configured; set G1_NAV_BRIDGE_URL and G1_NAV_BRIDGE_TOKEN."
        )
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise NavigationBridgeError("LiDAR navigation bridge URL must be a valid HTTP(S) URL without embedded credentials.")
    if parsed.query or parsed.fragment:
        raise NavigationBridgeError("LiDAR navigation bridge URL must not contain a query or fragment.")
    if parsed.scheme == "http":
        try:
            is_loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            is_loopback = parsed.hostname.lower() == "localhost"
        if not is_loopback:
            raise NavigationBridgeError("LiDAR navigation bridge must use HTTPS unless it is bound to localhost.")
    return base_url, token


def _get_json(
    base_url: str,
    token: str,
    path: str,
    timeout: float = BRIDGE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    try:
        response = httpx.get(
            f"{base_url}{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=timeout,
            follow_redirects=False,
        )
    except httpx.HTTPError as error:
        raise NavigationBridgeError(f"LiDAR navigation bridge could not be reached: {error}") from error
    if response.status_code != 200:
        raise NavigationBridgeError(f"LiDAR navigation bridge {path} returned HTTP {response.status_code}.")
    try:
        payload = response.json()
    except ValueError as error:
        raise NavigationBridgeError(f"LiDAR navigation bridge {path} returned invalid JSON.") from error
    if not isinstance(payload, dict):
        raise NavigationBridgeError(f"LiDAR navigation bridge {path} must return a JSON object.")
    return payload


def _post_json(
    base_url: str,
    token: str,
    path: str,
    payload: dict[str, Any],
    timeout: float = BRIDGE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    try:
        response = httpx.post(
            f"{base_url}{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            json=payload,
            timeout=timeout,
            follow_redirects=False,
        )
    except httpx.HTTPError as error:
        raise NavigationBridgeError(f"LiDAR navigation bridge could not be reached: {error}") from error
    if response.status_code not in {200, 202}:
        raise NavigationBridgeError(
            f"LiDAR navigation bridge {path} returned HTTP {response.status_code}."
        )
    try:
        result = response.json()
    except ValueError as error:
        raise NavigationBridgeError(f"LiDAR navigation bridge {path} returned invalid JSON.") from error
    if not isinstance(result, dict):
        raise NavigationBridgeError(f"LiDAR navigation bridge {path} must return a JSON object.")
    return result


def _navigation_operation_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", value):
        raise NavigationBridgeError("Navigation operation ID is invalid.")
    return value


def _scan_job_id(value: Any) -> str:
    if not isinstance(value, str):
        raise NavigationBridgeError("LiDAR scan job ID is invalid.")
    try:
        return str(uuid.UUID(value))
    except ValueError as error:
        raise NavigationBridgeError("LiDAR scan job ID is invalid.") from error


def _timestamp(value: Any, name: str) -> datetime:
    if not isinstance(value, str):
        raise NavigationBridgeError(f"Navigation bridge {name} must be an ISO-8601 timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise NavigationBridgeError(f"Navigation bridge {name} is invalid.") from error
    if parsed.tzinfo is None:
        raise NavigationBridgeError(f"Navigation bridge {name} must include a timezone.")
    return parsed.astimezone(timezone.utc)


def _finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise NavigationBridgeError(f"Navigation bridge {name} must be a finite number.")
    return float(value)


def _validate_status(payload: dict[str, Any], now: datetime) -> dict[str, Any]:
    localization = payload.get("localization")
    if not isinstance(localization, dict):
        raise NavigationBridgeError("Navigation bridge status must include localization metadata.")
    frame_id = localization.get("frame_id")
    if not isinstance(frame_id, str) or not frame_id.strip() or len(frame_id) > 128:
        raise NavigationBridgeError("Navigation bridge localization frame_id is invalid.")
    pose = localization.get("pose")
    if not isinstance(pose, dict):
        raise NavigationBridgeError("Navigation bridge localization pose is invalid.")
    x = _finite_number(pose.get("x"), "localization pose x")
    y = _finite_number(pose.get("y"), "localization pose y")
    yaw = _finite_number(pose.get("yaw_rad"), "localization pose yaw_rad")
    timestamp = _timestamp(localization.get("timestamp"), "localization timestamp")
    age_seconds = (now.astimezone(timezone.utc) - timestamp).total_seconds()
    if age_seconds < -0.1:
        raise NavigationBridgeError("Navigation bridge localization timestamp is in the future.")
    if age_seconds > MAX_LOCALIZATION_AGE_SECONDS:
        raise NavigationBridgeError(
            f"Navigation bridge localization is stale ({age_seconds * 1000:.0f} ms old; maximum is {MAX_LOCALIZATION_AGE_SECONDS * 1000:.0f} ms)."
        )
    localization_ready = localization.get("ready") is True
    pointcloud_age_ms = payload.get("pointcloud_age_ms")
    if (
        isinstance(pointcloud_age_ms, bool)
        or not isinstance(pointcloud_age_ms, (int, float))
        or not math.isfinite(float(pointcloud_age_ms))
        or pointcloud_age_ms < 0
        or pointcloud_age_ms > MAX_POINTCLOUD_AGE_SECONDS * 1000
    ):
        raise NavigationBridgeError("Navigation bridge MID-360 point-cloud stream is missing or stale.")
    pointcloud_ready = payload.get("pointcloud_ready") is True
    planner_ready = payload.get("planner_ready") is True
    bridge_ready = payload.get("ready") is True
    return {
        "ready": bridge_ready and localization_ready and planner_ready and pointcloud_ready,
        "bridgeReady": bridge_ready,
        "pointcloudReady": pointcloud_ready,
        "pointcloudAgeMs": round(float(pointcloud_age_ms)),
        "localization": {
            "ready": localization_ready,
            "frame_id": frame_id,
            "pose": {"x": x, "y": y, "yaw_rad": yaw},
            "timestamp": timestamp.isoformat(),
            "age_ms": max(0, round(age_seconds * 1000)),
        },
        "plannerReady": planner_ready,
    }


def _validate_map(payload: dict[str, Any], frame_id: str) -> dict[str, Any]:
    map_id = payload.get("map_id")
    version = payload.get("version")
    map_frame = payload.get("frame_id")
    if not isinstance(map_id, str) or not map_id.strip() or len(map_id) > 128:
        raise NavigationBridgeError("Navigation bridge map_id is invalid.")
    if not isinstance(version, str) or not version.strip() or len(version) > 128:
        raise NavigationBridgeError("Navigation bridge map version is invalid.")
    if map_frame != frame_id:
        raise NavigationBridgeError("Navigation bridge map frame does not match the localization frame.")
    resolution = _finite_number(payload.get("resolution_m"), "map resolution_m")
    if not 0.005 <= resolution <= 1:
        raise NavigationBridgeError("Navigation bridge map resolution must be between 0.005 and 1 meter.")
    width = payload.get("width")
    height = payload.get("height")
    if (
        isinstance(width, bool) or not isinstance(width, int) or width < 1
        or isinstance(height, bool) or not isinstance(height, int) or height < 1
        or width * height > MAX_MAP_CELLS
    ):
        raise NavigationBridgeError("Navigation bridge map dimensions are invalid or too large.")
    origin = payload.get("origin")
    if not isinstance(origin, dict):
        raise NavigationBridgeError("Navigation bridge map origin is invalid.")
    origin_x = _finite_number(origin.get("x"), "map origin x")
    origin_y = _finite_number(origin.get("y"), "map origin y")
    origin_yaw = _finite_number(origin.get("yaw_rad", 0), "map origin yaw_rad")
    updated_at = _timestamp(payload.get("updated_at"), "map updated_at")
    return {
        "map_id": map_id,
        "version": version,
        "frame_id": map_frame,
        "resolution_m": resolution,
        "width": width,
        "height": height,
        "origin": {"x": origin_x, "y": origin_y, "yaw_rad": origin_yaw},
        "updated_at": updated_at.isoformat(),
    }


def _validate_occupancy(payload: dict[str, Any], metadata: dict[str, Any]) -> list[int]:
    data = payload.get("data")
    expected_cells = metadata["width"] * metadata["height"]
    if expected_cells > MAX_PREVIEW_MAP_CELLS:
        raise NavigationBridgeError(
            f"Navigation map has {expected_cells} cells; preview limit is {MAX_PREVIEW_MAP_CELLS}."
        )
    if not isinstance(data, list) or len(data) != expected_cells:
        raise NavigationBridgeError("Navigation occupancy data length does not match map dimensions.")
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < -1 or value > 100
        for value in data
    ):
        raise NavigationBridgeError("Navigation occupancy values must be integers from -1 through 100.")
    return data


def _validate_route_targets(
    snapshot: dict[str, Any],
    map_id: str,
    version: str,
    frame_id: str,
    waypoints: list[dict[str, Any]],
) -> list[dict[str, float]]:
    metadata = snapshot["map"]
    if (map_id, version, frame_id) != (
        metadata["map_id"],
        metadata["version"],
        metadata["frame_id"],
    ):
        raise NavigationBridgeError("Navigation map changed; reload the map before starting a route.")
    if not isinstance(waypoints, list) or not 1 <= len(waypoints) <= MAX_NAVIGATION_WAYPOINTS:
        raise NavigationBridgeError(
            f"Navigation routes must contain between 1 and {MAX_NAVIGATION_WAYPOINTS} waypoints."
        )

    map_data = snapshot["data"]
    resolution = metadata["resolution_m"]
    origin = metadata["origin"]
    cosine = math.cos(origin["yaw_rad"])
    sine = math.sin(origin["yaw_rad"])
    normalized: list[dict[str, float]] = []
    for index, waypoint in enumerate(waypoints, start=1):
        if not isinstance(waypoint, dict):
            raise NavigationBridgeError(f"Navigation waypoint {index} must be an object.")
        x = _finite_number(waypoint.get("x"), f"waypoint {index} x")
        y = _finite_number(waypoint.get("y"), f"waypoint {index} y")
        dx = x - origin["x"]
        dy = y - origin["y"]
        map_x = cosine * dx + sine * dy
        map_y = -sine * dx + cosine * dy
        column = math.floor(map_x / resolution)
        row = math.floor(map_y / resolution)
        if not (0 <= column < metadata["width"] and 0 <= row < metadata["height"]):
            raise NavigationBridgeError(f"Navigation waypoint {index} is outside the current map.")
        occupancy = map_data[row * metadata["width"] + column]
        if occupancy < 0 or occupancy >= 65:
            raise NavigationBridgeError(
                f"Navigation waypoint {index} must be in known free space (occupancy below 65)."
            )
        normalized.append({"x": x, "y": y})
    return normalized


def navigation_start_route(
    map_id: str,
    version: str,
    frame_id: str,
    waypoints: list[dict[str, Any]],
    operation_id: str,
    now: datetime | None = None,
    on_dispatch: Callable[[], None] | None = None,
) -> dict[str, Any]:
    if os.getenv("G1_NAV_EXECUTION_ENABLED", "").strip() != "1":
        raise NavigationBridgeError(
            "Navigation execution is disabled; set G1_NAV_EXECUTION_ENABLED=1 after commissioning the ROS/Nav2 gateway."
        )
    snapshot = navigation_map_snapshot(now=now)
    if not snapshot.get("ready"):
        raise NavigationBridgeError(snapshot.get("error") or "Navigation map is not ready.")
    route = _validate_route_targets(snapshot, map_id, version, frame_id, waypoints)
    base_url, token = _bridge_configuration()
    requested_operation_id = _navigation_operation_id(operation_id)
    if on_dispatch:
        on_dispatch()
    result = _post_json(
        base_url,
        token,
        "/api/v1/navigation/goal",
        {
            "map_id": map_id,
            "version": version,
            "frame_id": frame_id,
            "operation_id": requested_operation_id,
            "goals": [
                {"x": waypoint["x"], "y": waypoint["y"], "yaw_rad": 0.0}
                for waypoint in route
            ],
        },
    )
    operation_id = _navigation_operation_id(result.get("operation_id"))
    if operation_id != requested_operation_id:
        raise NavigationBridgeError("Navigation gateway returned a different operation ID.")
    status = result.get("status")
    if status not in {"accepted", "starting", "running", "succeeded", "canceled", "failed", "uncertain"}:
        raise NavigationBridgeError("Navigation gateway did not accept the route.")
    return {"operation_id": operation_id, "status": status}


def navigation_plan_route(
    map_id: str,
    version: str,
    frame_id: str,
    waypoints: list[dict[str, Any]],
    now: datetime | None = None,
) -> dict[str, Any]:
    snapshot = navigation_map_snapshot(now=now)
    if not snapshot.get("ready"):
        raise NavigationBridgeError(snapshot.get("error") or "Navigation map is not ready.")
    route = _validate_route_targets(snapshot, map_id, version, frame_id, waypoints)
    base_url, token = _bridge_configuration()
    result = _post_json(
        base_url,
        token,
        "/api/v1/navigation/plan",
        {
            "map_id": map_id,
            "version": version,
            "frame_id": frame_id,
            "goals": [
                {"x": waypoint["x"], "y": waypoint["y"], "yaw_rad": 0.0}
                for waypoint in route
            ],
        },
        timeout=NAVIGATION_PLAN_TIMEOUT_SECONDS,
    )
    if (
        result.get("map_id") != map_id
        or result.get("version") != version
        or result.get("frame_id") != frame_id
    ):
        raise NavigationBridgeError("Navigation gateway planned a route against a different map or frame.")
    planner_id = result.get("planner_id")
    if not isinstance(planner_id, str) or not planner_id.strip() or len(planner_id) > 128:
        raise NavigationBridgeError("Navigation gateway returned an invalid planner ID.")
    raw_path = result.get("path")
    if not isinstance(raw_path, list) or not 1 <= len(raw_path) <= MAX_NAVIGATION_PREVIEW_POINTS:
        raise NavigationBridgeError("Navigation gateway returned an empty or oversized route preview.")
    path = []
    for index, point in enumerate(raw_path):
        if not isinstance(point, dict):
            raise NavigationBridgeError(f"Navigation gateway route preview point {index + 1} is invalid.")
        path.append({
            axis: _finite_number(point.get(axis), f"route preview point {index + 1} {axis}")
            for axis in ("x", "y")
        })
    return {
        "map_id": map_id,
        "version": version,
        "frame_id": frame_id,
        "planner_id": planner_id,
        "path": path,
    }


def navigation_operation_status(operation_id: str) -> dict[str, Any]:
    safe_id = _navigation_operation_id(operation_id)
    base_url, token = _bridge_configuration()
    result = _get_json(base_url, token, f"/api/v1/navigation/operations/{safe_id}")
    if result.get("operation_id") != safe_id:
        raise NavigationBridgeError("Navigation gateway returned a different operation ID.")
    if result.get("status") not in {
        "accepted", "starting", "running", "cancel_requested",
        "succeeded", "canceled", "failed", "uncertain",
    }:
        raise NavigationBridgeError("Navigation gateway returned an invalid operation status.")
    return result


def navigation_cancel_route(operation_id: str) -> dict[str, Any]:
    safe_id = _navigation_operation_id(operation_id)
    base_url, token = _bridge_configuration()
    result = _post_json(
        base_url,
        token,
        f"/api/v1/navigation/operations/{safe_id}/cancel",
        {},
    )
    if result.get("operation_id") != safe_id or result.get("status") not in {
        "cancel_requested", "canceled", "failed", "succeeded",
    }:
        raise NavigationBridgeError("Navigation gateway did not confirm a cancellation request.")
    return result


def navigation_start_scan() -> dict[str, Any]:
    base_url, token = _bridge_configuration()
    result = _post_json(base_url, token, "/api/v1/scans/start", {})
    job_id = _scan_job_id(result.get("job_id"))
    if result.get("status") != "scanning":
        raise NavigationBridgeError("LiDAR gateway did not confirm that scan capture started.")
    return _validated_scan_status(result, job_id)


def _validated_scan_status(result: dict[str, Any], job_id: str) -> dict[str, Any]:
    if result.get("job_id") != job_id or result.get("status") not in {
        "scanning", "completed", "failed", "canceled",
    }:
        raise NavigationBridgeError("LiDAR gateway returned an invalid scan job status.")
    rotation_status = result.get("rotation_status")
    if rotation_status not in {
        "submitted", "rotating", "completed", "failed", "canceled",
        "cancel_requested", "uncertain",
    }:
        raise NavigationBridgeError("LiDAR gateway returned an invalid scan rotation status.")
    rotation_radians = result.get("rotation_radians", 0.0)
    if (
        isinstance(rotation_radians, bool)
        or not isinstance(rotation_radians, (int, float))
        or not math.isfinite(float(rotation_radians))
        or not 0 <= float(rotation_radians) <= 100
    ):
        raise NavigationBridgeError("LiDAR gateway returned an invalid scan rotation measurement.")
    point_count = result.get("point_count", 0)
    if isinstance(point_count, bool) or not isinstance(point_count, int) or not 0 <= point_count <= MAX_SCAN_POINTS:
        raise NavigationBridgeError("LiDAR gateway returned an invalid scan point count.")
    preview_points = result.get("preview_points", [])
    if not isinstance(preview_points, list) or len(preview_points) > 1_000:
        raise NavigationBridgeError("LiDAR gateway returned an invalid scan preview.")
    normalized_preview = []
    for index, point in enumerate(preview_points):
        if not isinstance(point, dict):
            raise NavigationBridgeError(f"LiDAR gateway returned an invalid scan preview point {index + 1}.")
        normalized_preview.append({
            axis: _finite_number(point.get(axis), f"scan preview point {index + 1} {axis}")
            for axis in ("x", "y", "z")
        })
    return {
        "job_id": job_id,
        "status": result["status"],
        "rotation_status": rotation_status,
        "rotation_radians": float(rotation_radians),
        "point_count": point_count,
        "preview_points": normalized_preview,
        "error": result.get("error"),
        "frame_id": result.get("frame_id"),
        "map_id": result.get("map_id"),
        "map_version": result.get("map_version"),
        "updated_at": result.get("updated_at"),
    }


def navigation_scan_status(job_id: str) -> dict[str, Any]:
    safe_id = _scan_job_id(job_id)
    base_url, token = _bridge_configuration()
    result = _get_json(
        base_url,
        token,
        f"/api/v1/scans/{safe_id}",
        timeout=SCAN_STATUS_TIMEOUT_SECONDS,
    )
    return _validated_scan_status(result, safe_id)


def navigation_scan_pointcloud(job_id: str) -> dict[str, Any]:
    safe_id = _scan_job_id(job_id)
    base_url, token = _bridge_configuration()
    result = _get_json(
        base_url,
        token,
        f"/api/v1/scans/{safe_id}/pointcloud",
        timeout=SCAN_POINTCLOUD_TIMEOUT_SECONDS,
    )
    if result.get("job_id") != safe_id:
        raise NavigationBridgeError("LiDAR gateway returned a different scan job ID.")
    frame_id = result.get("frame_id")
    if not isinstance(frame_id, str) or not frame_id.strip() or len(frame_id) > 128:
        raise NavigationBridgeError("LiDAR scan point cloud frame_id is invalid.")
    points = result.get("points")
    if not isinstance(points, list) or len(points) > MAX_SCAN_POINTS:
        raise NavigationBridgeError("LiDAR scan point cloud is invalid or exceeds the point limit.")
    normalized_points = []
    for index, point in enumerate(points):
        if not isinstance(point, dict):
            raise NavigationBridgeError(f"LiDAR scan point {index + 1} is invalid.")
        normalized_points.append({
            axis: _finite_number(point.get(axis), f"scan point {index + 1} {axis}")
            for axis in ("x", "y", "z")
        })
    captured_at = _timestamp(result.get("captured_at"), "scan capture time")
    return {
        "job_id": safe_id,
        "frame_id": frame_id,
        "captured_at": captured_at.isoformat(),
        "point_count": len(normalized_points),
        "points": normalized_points,
    }


def navigation_scan_map_snapshot(job_id: str) -> dict[str, Any]:
    safe_id = _scan_job_id(job_id)
    base_url, token = _bridge_configuration()
    payload = _get_json(
        base_url,
        token,
        f"/api/v1/scans/{safe_id}/map",
        timeout=SCAN_POINTCLOUD_TIMEOUT_SECONDS,
    )
    frame_id = payload.get("frame_id")
    metadata = _validate_map(payload, frame_id)
    data = _validate_occupancy(payload, metadata)
    return {"ready": True, "map": metadata, "data": data}


def navigation_complete_scan(job_id: str) -> dict[str, Any]:
    safe_id = _scan_job_id(job_id)
    base_url, token = _bridge_configuration()
    result = _post_json(base_url, token, f"/api/v1/scans/{safe_id}/complete", {})
    if result.get("job_id") != safe_id or result.get("status") not in {"completed", "failed"}:
        raise NavigationBridgeError("LiDAR gateway did not confirm scan completion.")
    return result


def navigation_cancel_scan(job_id: str) -> dict[str, Any]:
    safe_id = _scan_job_id(job_id)
    base_url, token = _bridge_configuration()
    result = _post_json(base_url, token, f"/api/v1/scans/{safe_id}/cancel", {})
    return _validated_scan_status(result, safe_id)


def navigation_bridge_status(now: datetime | None = None) -> dict[str, Any]:
    try:
        base_url, token = _bridge_configuration()
        current_time = now or datetime.now(timezone.utc)
        if current_time.tzinfo is None:
            raise ValueError("Navigation bridge validation time must include a timezone.")
        status_payload = _get_json(base_url, token, "/api/v1/status")
        status = _validate_status(status_payload, current_time)
        map_payload = _get_json(base_url, token, "/api/v1/map/metadata")
        map_metadata = _validate_map(map_payload, status["localization"]["frame_id"])
        return {
            "status": "ready" if status["ready"] else "unavailable",
            **status,
            "map": map_metadata,
            "error": None if status["ready"] else (
                "MID-360 point-cloud stream is not fresh."
                if not status["pointcloudReady"]
                else "Bridge, localization, or planner is not ready."
            ),
        }
    except NavigationBridgeError as error:
        return {
            "status": "unavailable",
            "ready": False,
            "bridgeReady": False,
            "localization": {"ready": False},
            "plannerReady": False,
            "map": None,
            "error": str(error),
        }


def navigation_map_snapshot(now: datetime | None = None) -> dict[str, Any]:
    try:
        base_url, token = _bridge_configuration()
        current_time = now or datetime.now(timezone.utc)
        if current_time.tzinfo is None:
            raise ValueError("Navigation bridge validation time must include a timezone.")
        status = _validate_status(
            _get_json(base_url, token, "/api/v1/status"),
            current_time,
        )
        if not status["ready"]:
            raise NavigationBridgeError("Bridge, localization, or planner is not ready.")
        payload = _get_json(base_url, token, "/api/v1/map")
        metadata = _validate_map(payload, status["localization"]["frame_id"])
        data = _validate_occupancy(payload, metadata)
        return {"ready": True, "map": metadata, "data": data}
    except NavigationBridgeError as error:
        return {"ready": False, "map": None, "data": [], "error": str(error)}
