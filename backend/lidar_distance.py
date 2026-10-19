from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import httpx

MAX_SAMPLE_AGE_SECONDS = 0.5
MAX_FUTURE_SKEW_SECONDS = 0.1
MAX_DISTANCE_METERS = 40.0
PROVIDER_TIMEOUT_SECONDS = 0.25


class DistanceSensorError(RuntimeError):
    pass


def _provider_configuration(sector: str) -> tuple[str, str, str, str]:
    if sector not in {"forward", "rear"}:
        raise ValueError("Distance sector must be forward or rear.")
    if os.getenv("G1_LIDAR_AXIS_CONFIRMED", "1").strip() != "1":
        raise DistanceSensorError(
            "MID-360 axis alignment is unconfirmed; physical distance conditions are disabled."
        )
    url_variable = "G1_DISTANCE_PROVIDER_URL" if sector == "forward" else "G1_DISTANCE_REAR_PROVIDER_URL"
    url = os.getenv(url_variable, "").strip()
    token = os.getenv("G1_DISTANCE_PROVIDER_TOKEN", "").strip()
    sensor_id = os.getenv("G1_DISTANCE_SENSOR_ID", "").strip()
    frame_id = os.getenv("G1_DISTANCE_FRAME_ID", "").strip()
    if not all((url, token, sensor_id, frame_id)):
        raise DistanceSensorError(
            f"MID-360 {sector}-sector distance provider is not configured; set its URL, service token, sensor ID, and frame ID."
        )
    if not url.startswith(("http://", "https://")):
        raise DistanceSensorError("MID-360 distance provider URL must use HTTP or HTTPS.")
    return url, token, sensor_id, frame_id


def _parse_timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise DistanceSensorError("MID-360 sample timestamp must be an ISO-8601 string.")
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise DistanceSensorError("MID-360 sample timestamp is invalid.") from error
    if timestamp.tzinfo is None:
        raise DistanceSensorError("MID-360 sample timestamp must include a timezone.")
    return timestamp.astimezone(timezone.utc)


def get_distance_sample(sector: str, now: datetime | None = None) -> dict[str, Any]:
    url, token, expected_sensor_id, expected_frame_id = _provider_configuration(sector)
    expected_provider_sector = "forward" if sector == "forward" else "rear"
    try:
        response = httpx.get(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=PROVIDER_TIMEOUT_SECONDS,
            follow_redirects=False,
        )
    except httpx.HTTPError as error:
        raise DistanceSensorError(f"MID-360 distance provider could not be reached: {error}") from error
    if response.status_code != 200:
        raise DistanceSensorError(f"MID-360 {sector}-sector distance provider returned HTTP {response.status_code}.")
    try:
        payload = response.json()
    except ValueError as error:
        raise DistanceSensorError(f"MID-360 {sector}-sector distance provider returned invalid JSON.") from error
    if not isinstance(payload, dict) or payload.get("valid") is not True:
        raise DistanceSensorError(f"MID-360 provider did not report a valid {sector}-sector sample.")
    if payload.get("sector") != expected_provider_sector:
        raise DistanceSensorError(f"MID-360 provider sample is not from the configured {sector} sector.")
    if payload.get("sensor_id") != expected_sensor_id:
        raise DistanceSensorError("MID-360 sample sensor ID does not match the configured sensor.")
    if payload.get("frame_id") != expected_frame_id:
        raise DistanceSensorError("MID-360 sample frame does not match the configured frame.")

    distance = payload.get("distance_m")
    clear = payload.get("clear") is True
    if distance is None and clear and payload.get("max_range_m") == MAX_DISTANCE_METERS:
        distance_m = None
    else:
        if isinstance(distance, bool) or not isinstance(distance, (int, float)):
            raise DistanceSensorError("MID-360 sample distance must be numeric meters.")
        distance_m = float(distance)
        if not 0 < distance_m <= MAX_DISTANCE_METERS or clear:
            raise DistanceSensorError(
                f"MID-360 sample distance must be greater than 0 and at most {MAX_DISTANCE_METERS:g} meters."
            )

    timestamp = _parse_timestamp(payload.get("timestamp"))
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        raise ValueError("Sample validation time must include a timezone.")
    age_seconds = (current_time.astimezone(timezone.utc) - timestamp).total_seconds()
    if age_seconds < -MAX_FUTURE_SKEW_SECONDS:
        raise DistanceSensorError("MID-360 sample timestamp is in the future.")
    if age_seconds > MAX_SAMPLE_AGE_SECONDS:
        raise DistanceSensorError(
            f"MID-360 sample is stale ({age_seconds * 1000:.0f} ms old; maximum is {MAX_SAMPLE_AGE_SECONDS * 1000:.0f} ms)."
        )

    return {
        "sector": sector,
        "distance_m": distance_m,
        "clear": clear,
        "max_range_m": MAX_DISTANCE_METERS,
        "timestamp": timestamp.isoformat(),
        "age_ms": max(0, round(age_seconds * 1000)),
        "sensor_id": expected_sensor_id,
        "frame_id": expected_frame_id,
    }


def get_front_distance_sample(now: datetime | None = None) -> dict[str, Any]:
    return get_distance_sample("forward", now)


def get_rear_distance_sample(now: datetime | None = None) -> dict[str, Any]:
    return get_distance_sample("rear", now)


def distance_sensor_status() -> dict[str, Any]:
    try:
        sample = get_front_distance_sample()
    except DistanceSensorError as error:
        forward_status = {"status": "unavailable", "ready": False, "error": str(error)}
    else:
        forward_status = {
            "status": "ready",
            "ready": True,
            "maxSampleAgeMs": MAX_SAMPLE_AGE_SECONDS * 1000,
            **sample,
        }
    try:
        rear_sample = get_rear_distance_sample()
    except DistanceSensorError as error:
        rear_status = {"status": "unavailable", "ready": False, "error": str(error)}
    else:
        rear_status = {
            "status": "ready",
            "ready": True,
            "maxSampleAgeMs": MAX_SAMPLE_AGE_SECONDS * 1000,
            **rear_sample,
        }
    return {**forward_status, "rear": rear_status}
