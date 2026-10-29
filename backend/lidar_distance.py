from __future__ import annotations

import os
import time
import math
from datetime import datetime, timezone
from typing import Any

import httpx

try:
    from .sensor_calibration import calibration_status
except ImportError:
    from sensor_calibration import calibration_status

MAX_SAMPLE_AGE_SECONDS = 0.5
MAX_FUTURE_SKEW_SECONDS = 0.1
MAX_DISTANCE_METERS = 40.0
PROVIDER_TIMEOUT_SECONDS = 0.25
PROVIDER_503_RETRIES = 2
PROVIDER_RETRY_DELAY_SECONDS = 0.05


class DistanceSensorError(RuntimeError):
    pass


def _provider_configuration(sector: str) -> tuple[str, str, str, str, str]:
    if sector not in {"forward", "rear"}:
        raise ValueError("Distance sector must be forward or rear.")
    url_variable = "G1_DISTANCE_PROVIDER_URL" if sector == "forward" else "G1_DISTANCE_REAR_PROVIDER_URL"
    url = os.getenv(url_variable, "").strip()
    token = os.getenv("G1_DISTANCE_PROVIDER_TOKEN", "").strip()
    sensor_id = os.getenv("G1_DISTANCE_SENSOR_ID", "").strip()
    sensor_frame_id = os.getenv("G1_DISTANCE_FRAME_ID", "").strip()
    base_frame_id = os.getenv("G1_DISTANCE_BASE_FRAME", "").strip()
    if not all((url, token, sensor_id, sensor_frame_id, base_frame_id)):
        raise DistanceSensorError(
            f"MID-360 {sector}-sector distance provider is not configured; set its URL, service token, sensor ID, sensor frame, and robot base frame."
        )
    if not url.startswith(("http://", "https://")):
        raise DistanceSensorError("MID-360 distance provider URL must use HTTP or HTTPS.")
    calibration = calibration_status()
    if calibration.get("ready") is not True:
        status = calibration.get("status", "unverified")
        reason = calibration.get("reason", "Calibration evidence is incomplete.")
        raise DistanceSensorError(
            f"MID-360 calibration is {status}: {reason} Physical distance conditions are disabled."
        )
    return url, token, sensor_id, sensor_frame_id, base_frame_id


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


def _validate_fused_sources(
    payload: dict[str, Any],
    sector: str,
    expected_sensor_frame_id: str,
    expected_base_frame_id: str,
) -> list[dict[str, Any]]:
    sources = payload.get("sources")
    source_ids = payload.get("source_ids")
    if (
        not isinstance(sources, list)
        or not sources
        or not isinstance(source_ids, list)
        or not source_ids
        or any(not isinstance(source_id, str) or not source_id for source_id in source_ids)
        or len(set(source_ids)) != len(source_ids)
    ):
        raise DistanceSensorError("MID-360 fused sample has no source diagnostics.")
    configured_ids = set()
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str):
            raise DistanceSensorError("MID-360 fused sample contains an invalid source record.")
        source_id = source["id"]
        if source_id in configured_ids:
            raise DistanceSensorError("MID-360 fused sample contains duplicate source IDs.")
        configured_ids.add(source_id)

    contributing = []
    for source in sources:
        if source.get("contributing") is not True:
            continue
        frame_id = source.get("sensor_frame_id")
        expected_frame_id = source.get("expected_frame_id")
        coverage = source.get("coverage")
        transform = source.get("transform")
        if (
            source.get("status") != "ready"
            or not isinstance(frame_id, str)
            or not frame_id
            or expected_frame_id != frame_id
            or not isinstance(coverage, list)
            or sector not in coverage
            or not isinstance(transform, dict)
            or transform.get("target_frame") != expected_base_frame_id
            or transform.get("source_frame") != frame_id
        ):
            raise DistanceSensorError("MID-360 fused sample contains an invalid contributing source.")
        ages = [source.get("age_ms"), source.get("receive_age_ms"), source.get("stamp_age_ms")]
        if any(
            isinstance(age_ms, bool)
            or not isinstance(age_ms, (int, float))
            or not math.isfinite(float(age_ms))
            or not 0 <= float(age_ms) <= MAX_SAMPLE_AGE_SECONDS * 1000
            for age_ms in ages
        ):
            raise DistanceSensorError("MID-360 fused source sample is stale or has an invalid age.")
        calibration_source = transform.get("calibration_source")
        if calibration_source == "model_derived":
            if (
                source.get("model_mount") is not True
                or source["id"] != os.getenv("G1_DISTANCE_SENSOR_ID", "").strip()
                or frame_id != expected_sensor_frame_id
            ):
                raise DistanceSensorError(
                    "MID-360 model-mount fallback is not valid for this source ID/frame."
                )
        elif calibration_source != "live_tf":
            raise DistanceSensorError("MID-360 fused source has no valid transform provenance.")
        contributing.append(source)

    if not contributing or set(source_ids) != {source["id"] for source in contributing}:
        raise DistanceSensorError("MID-360 fused sample has no consistent contributing sources.")
    return contributing


def get_distance_sample(sector: str, now: datetime | None = None) -> dict[str, Any]:
    url, token, expected_sensor_id, expected_sensor_frame_id, expected_base_frame_id = _provider_configuration(sector)
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
    for attempt in range(PROVIDER_503_RETRIES):
        if response.status_code != 503:
            break
        time.sleep(PROVIDER_RETRY_DELAY_SECONDS)
        try:
            response = httpx.get(
                url,
                headers=response.request.headers,
                timeout=PROVIDER_TIMEOUT_SECONDS,
                follow_redirects=False,
            )
        except httpx.HTTPError as error:
            raise DistanceSensorError(f"MID-360 distance provider could not be reached: {error}") from error
    if response.status_code != 200:
        try:
            unavailable = response.json()
        except ValueError:
            unavailable = {}
        provider_error = unavailable.get("error") if isinstance(unavailable, dict) else None
        detail = f": {provider_error}" if isinstance(provider_error, str) and provider_error else ""
        raise DistanceSensorError(
            f"MID-360 {sector}-sector distance provider returned HTTP {response.status_code}{detail}."
        )
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
    fused_sources = None
    if "sources" in payload or "source_ids" in payload:
        fused_sources = _validate_fused_sources(
            payload,
            expected_provider_sector,
            expected_sensor_frame_id,
            expected_base_frame_id,
        )
    elif payload.get("sensor_frame_id") != expected_sensor_frame_id:
        raise DistanceSensorError("MID-360 sample sensor frame does not match the configured frame.")
    if payload.get("frame_id") != expected_base_frame_id:
        raise DistanceSensorError("MID-360 measurement frame does not match the configured robot base frame.")
    if payload.get("measurement") != "footprint_clearance" or payload.get("calibrated") is not True:
        raise DistanceSensorError("MID-360 provider did not report a calibrated robot-footprint clearance.")

    maximum_range = payload.get("max_range_m")
    if (
        isinstance(maximum_range, bool)
        or not isinstance(maximum_range, (int, float))
        or not math.isfinite(float(maximum_range))
        or not 0 < float(maximum_range) <= MAX_DISTANCE_METERS
    ):
        raise DistanceSensorError("MID-360 sample maximum measurement range is invalid.")
    maximum_range_m = float(maximum_range)
    distance = payload.get("distance_m")
    clear = payload.get("clear") is True
    if distance is None and clear:
        distance_m = None
    else:
        if isinstance(distance, bool) or not isinstance(distance, (int, float)):
            raise DistanceSensorError("MID-360 sample distance must be numeric meters.")
        distance_m = float(distance)
        if not 0 <= distance_m <= MAX_DISTANCE_METERS or clear:
            raise DistanceSensorError(
                f"MID-360 footprint clearance must be at least 0 and at most {MAX_DISTANCE_METERS:g} meters."
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
        "max_range_m": maximum_range_m,
        "timestamp": timestamp.isoformat(),
        "age_ms": max(0, round(age_seconds * 1000)),
        "sensor_id": expected_sensor_id,
        "sensor_frame_id": (
            payload.get("sensor_frame_id", expected_sensor_frame_id)
            if fused_sources
            else expected_sensor_frame_id
        ),
        "frame_id": expected_base_frame_id,
        "measurement": "footprint_clearance",
        "calibrated": True,
        "source_ids": [source["id"] for source in fused_sources] if fused_sources else [expected_sensor_id],
        "sources": fused_sources,
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
