from __future__ import annotations

import math
import threading
import time
from datetime import datetime, timezone
from typing import Any

try:
    from .ros.g1_joint_state import JOINT_MOTOR_INDICES
except ImportError:
    from ros.g1_joint_state import JOINT_MOTOR_INDICES

LOW_STATE_MAX_AGE_MS = 250


def _finite_vector(values: Any, label: str) -> list[float]:
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        raise ValueError(f"G1 LowState {label} must contain three values.")
    vector = [float(value) for value in values]
    if any(not math.isfinite(value) for value in vector):
        raise ValueError(f"G1 LowState {label} contains a non-finite value.")
    return vector


def extract_g1_low_state(message: Any) -> dict[str, Any]:
    motor_states = getattr(message, "motor_state", None)
    if not isinstance(motor_states, (list, tuple)) or len(motor_states) <= max(
        index for _, index in JOINT_MOTOR_INDICES
    ):
        raise ValueError("G1 LowState has too few motor measurements for the supported 23-DoF model.")

    motors = []
    for index, motor in enumerate(motor_states):
        try:
            values = {
                "index": index,
                "q": float(motor.q),
                "dq": float(motor.dq),
                "tau_est": float(motor.tau_est),
            }
        except (AttributeError, TypeError, ValueError) as error:
            raise ValueError(f"G1 LowState motor {index} is missing a numeric measurement.") from error
        if any(not math.isfinite(values[key]) for key in ("q", "dq", "tau_est")):
            raise ValueError(f"G1 LowState motor {index} contains a non-finite measurement.")
        motors.append(values)

    imu_state = getattr(message, "imu_state", None)
    if imu_state is None:
        raise ValueError("G1 LowState is missing IMU measurements.")
    return {
        "motor_count": len(motors),
        "motor_state": motors,
        "imu_state": {
            "rpy": _finite_vector(imu_state.rpy, "IMU RPY"),
            "gyroscope": _finite_vector(imu_state.gyroscope, "IMU gyroscope"),
            "accelerometer": _finite_vector(imu_state.accelerometer, "IMU accelerometer"),
        },
    }


class G1LowStateCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sample: dict[str, Any] | None = None
        self._received_monotonic: float | None = None
        self._received_at: str | None = None
        self._error: str | None = None

    def update(self, message: Any) -> None:
        try:
            sample = extract_g1_low_state(message)
        except (AttributeError, TypeError, ValueError) as error:
            with self._lock:
                self._error = str(error)
            return
        with self._lock:
            self._sample = sample
            self._received_monotonic = time.monotonic()
            self._received_at = datetime.now(timezone.utc).isoformat()
            self._error = None

    def mark_unavailable(self, reason: str) -> None:
        with self._lock:
            self._error = reason

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            sample = self._sample
            received_monotonic = self._received_monotonic
            received_at = self._received_at
            error = self._error
        if error:
            return {"status": "unavailable", "reason": error}
        if sample is None or received_monotonic is None or received_at is None:
            return {
                "status": "unavailable",
                "reason": "Waiting for the first Unitree rt/lowstate message.",
            }

        age_ms = max(0, round((time.monotonic() - received_monotonic) * 1000))
        if age_ms > LOW_STATE_MAX_AGE_MS:
            return {
                "status": "unavailable",
                "reason": f"Latest Unitree rt/lowstate sample is stale ({age_ms} ms old).",
                "received_at": received_at,
                "age_ms": age_ms,
            }
        return {
            "status": "available",
            "source": "unitree_sdk2py:rt/lowstate",
            "received_at": received_at,
            "age_ms": age_ms,
            **sample,
        }

    @staticmethod
    def joint_mapping() -> list[dict[str, Any]]:
        return [
            {"joint_name": name, "motor_index": index}
            for name, index in JOINT_MOTOR_INDICES
        ]
