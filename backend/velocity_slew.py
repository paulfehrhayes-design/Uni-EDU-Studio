from __future__ import annotations

import math
import os
from dataclasses import dataclass


LINEAR_ACCELERATION_ENV = "G1_MAX_LINEAR_ACCELERATION_MPS2"
YAW_ACCELERATION_ENV = "G1_MAX_YAW_ACCELERATION_RADPS2"
DEFAULT_LINEAR_ACCELERATION_MPS2 = 0.3
DEFAULT_YAW_ACCELERATION_RADPS2 = 0.6
MAX_LINEAR_ACCELERATION_MPS2 = 0.8
MAX_YAW_ACCELERATION_RADPS2 = 1.5


@dataclass(frozen=True)
class VelocitySlewLimits:
    linear_mps2: float = DEFAULT_LINEAR_ACCELERATION_MPS2
    yaw_radps2: float = DEFAULT_YAW_ACCELERATION_RADPS2


def _read_limit(name: str, default: float, maximum: float) -> float:
    configured = os.getenv(name)
    if configured is None:
        return default
    try:
        value = float(configured)
    except ValueError as error:
        raise ValueError(f"{name} must be a finite number between 0 and {maximum}.") from error
    if not math.isfinite(value) or value <= 0 or value > maximum:
        raise ValueError(f"{name} must be a finite number greater than 0 and at most {maximum}.")
    return value


def configured_velocity_slew_limits() -> VelocitySlewLimits:
    return VelocitySlewLimits(
        linear_mps2=_read_limit(
            LINEAR_ACCELERATION_ENV,
            DEFAULT_LINEAR_ACCELERATION_MPS2,
            MAX_LINEAR_ACCELERATION_MPS2,
        ),
        yaw_radps2=_read_limit(
            YAW_ACCELERATION_ENV,
            DEFAULT_YAW_ACCELERATION_RADPS2,
            MAX_YAW_ACCELERATION_RADPS2,
        ),
    )


def _slew_axis(current: float, target: float, max_delta: float) -> float:
    if current * target < 0:
        delta = min(abs(current), max_delta)
        return math.copysign(abs(current) - delta, current) if abs(current) > delta else 0.0
    difference = target - current
    if abs(difference) <= max_delta:
        return target
    return current + math.copysign(max_delta, difference)


def slew_velocity(
    current: tuple[float, float, float],
    target: tuple[float, float, float],
    elapsed_seconds: float,
    limits: VelocitySlewLimits,
) -> tuple[float, float, float]:
    if not math.isfinite(elapsed_seconds) or elapsed_seconds < 0:
        raise ValueError("Velocity slew elapsed time must be finite and non-negative.")
    if any(not math.isfinite(value) for value in (*current, *target)):
        raise ValueError("Velocity slew inputs must be finite.")
    return (
        _slew_axis(current[0], target[0], limits.linear_mps2 * elapsed_seconds),
        _slew_axis(current[1], target[1], limits.linear_mps2 * elapsed_seconds),
        _slew_axis(current[2], target[2], limits.yaw_radps2 * elapsed_seconds),
    )
