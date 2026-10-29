"""Bounded confidence-gated alignment for saved and active occupancy maps."""

from __future__ import annotations

import math
from typing import Any

MAX_ALIGNMENT_INPUT_CELLS = 1_000_000
MAX_ALIGNMENT_SIDE_CELLS = 128
OCCUPIED_THRESHOLD = 65
MIN_OVERLAP_RATIO = 0.6
MIN_MATCH_SCORE = 0.5
MIN_UNIQUE_MARGIN = 0.05
COARSE_ANGLE_STEP_DEGREES = 10
FINE_ANGLE_STEP_DEGREES = 2
PEAK_TRANSLATION_SEPARATION_M = 0.5
PEAK_ANGLE_SEPARATION_DEGREES = 8


class MapAlignmentError(ValueError):
    pass


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise MapAlignmentError(f"Map alignment {label} must be a finite number.")
    return float(value)


def _map_parts(snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[int]]:
    if not isinstance(snapshot, dict):
        raise MapAlignmentError("Map alignment input must be an object.")
    metadata = snapshot.get("map")
    data = snapshot.get("data")
    if not isinstance(metadata, dict) or not isinstance(data, list):
        raise MapAlignmentError("Map alignment requires map metadata and occupancy data.")
    width = metadata.get("width")
    height = metadata.get("height")
    if (
        isinstance(width, bool)
        or not isinstance(width, int)
        or width < 1
        or isinstance(height, bool)
        or not isinstance(height, int)
        or height < 1
        or width * height > MAX_ALIGNMENT_INPUT_CELLS
        or len(data) != width * height
    ):
        raise MapAlignmentError("Map alignment dimensions or occupancy length are invalid or too large.")
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value < -1 or value > 100
        for value in data
    ):
        raise MapAlignmentError("Map alignment occupancy values must be integers from -1 through 100.")
    resolution = _finite_number(metadata.get("resolution_m"), "resolution")
    if not 0.005 <= resolution <= 1:
        raise MapAlignmentError("Map alignment resolution is outside the supported range.")
    origin = metadata.get("origin")
    if not isinstance(origin, dict):
        raise MapAlignmentError("Map alignment origin is invalid.")
    _finite_number(origin.get("x"), "origin x")
    _finite_number(origin.get("y"), "origin y")
    _finite_number(origin.get("yaw_rad", 0), "origin yaw")
    return metadata, data


def _resample_occupancy(
    metadata: dict[str, Any],
    data: list[int],
    resolution_m: float,
):
    import numpy as np

    source = np.asarray(data, dtype=np.int16).reshape(metadata["height"], metadata["width"])
    source_resolution = float(metadata["resolution_m"])
    output_width = max(1, math.ceil(metadata["width"] * source_resolution / resolution_m))
    output_height = max(1, math.ceil(metadata["height"] * source_resolution / resolution_m))
    occupied = np.zeros((output_height, output_width), dtype=bool)
    known = np.zeros((output_height, output_width), dtype=bool)

    for output_row in range(output_height):
        row_start = math.floor(output_row * resolution_m / source_resolution)
        row_end = min(
            metadata["height"],
            max(row_start + 1, math.ceil((output_row + 1) * resolution_m / source_resolution)),
        )
        for output_column in range(output_width):
            column_start = math.floor(output_column * resolution_m / source_resolution)
            column_end = min(
                metadata["width"],
                max(column_start + 1, math.ceil((output_column + 1) * resolution_m / source_resolution)),
            )
            block = source[row_start:row_end, column_start:column_end]
            occupied[output_row, output_column] = bool(np.any(block >= OCCUPIED_THRESHOLD))
            known[output_row, output_column] = bool(np.any(block >= 0))
    return occupied & known, known


def _rotate_grid(occupied, known, angle_rad: float):
    import numpy as np

    source_height, source_width = occupied.shape
    cosine = math.cos(angle_rad)
    sine = math.sin(angle_rad)
    output_width = max(1, math.ceil(abs(source_width * cosine) + abs(source_height * sine)))
    output_height = max(1, math.ceil(abs(source_height * cosine) + abs(source_width * sine)))
    source_center_x = (source_width - 1) / 2
    source_center_y = (source_height - 1) / 2
    output_center_x = (output_width - 1) / 2
    output_center_y = (output_height - 1) / 2
    output_rows, output_columns = np.indices((output_height, output_width), dtype=float)
    source_columns = (
        cosine * (output_columns - output_center_x)
        + sine * (output_rows - output_center_y)
        + source_center_x
    )
    source_rows = (
        -sine * (output_columns - output_center_x)
        + cosine * (output_rows - output_center_y)
        + source_center_y
    )
    source_columns = np.rint(source_columns).astype(int)
    source_rows = np.rint(source_rows).astype(int)
    inside = (
        (source_columns >= 0)
        & (source_columns < source_width)
        & (source_rows >= 0)
        & (source_rows < source_height)
    )
    rotated_known = np.zeros((output_height, output_width), dtype=bool)
    rotated_occupied = np.zeros((output_height, output_width), dtype=bool)
    rotated_known[inside] = known[source_rows[inside], source_columns[inside]]
    rotated_occupied[inside] = occupied[source_rows[inside], source_columns[inside]]
    return rotated_occupied & rotated_known, rotated_known, (source_center_x, source_center_y), (
        output_center_x,
        output_center_y,
    )


def _correlate(target, source, fft_shape):
    import numpy as np

    flipped = source[::-1, ::-1]
    product = np.fft.rfftn(target, fft_shape, axes=(0, 1)) * np.fft.rfftn(
        flipped,
        fft_shape,
        axes=(0, 1),
    )
    result = np.fft.irfftn(product, fft_shape, axes=(0, 1))
    full_height = target.shape[0] + source.shape[0] - 1
    full_width = target.shape[1] + source.shape[1] - 1
    return np.maximum(result[:full_height, :full_width], 0)


def _candidate_peaks(
    source_occupied,
    source_known,
    target_occupied,
    target_known,
    angle_rad: float,
    resolution_m: float,
    top_k: int = 5,
) -> list[dict[str, float]]:
    import numpy as np

    rotated_occupied, rotated_known, source_center, rotated_center = _rotate_grid(
        source_occupied,
        source_known,
        angle_rad,
    )
    fft_shape = tuple(
        1 << (size - 1).bit_length()
        for size in (
            target_known.shape[0] + rotated_known.shape[0] - 1,
            target_known.shape[1] + rotated_known.shape[1] - 1,
        )
    )
    overlap = _correlate(target_known, rotated_known, fft_shape)
    intersection = _correlate(target_occupied, rotated_occupied, fft_shape)
    target_occupied_overlap = _correlate(target_occupied, rotated_known, fft_shape)
    source_occupied_overlap = _correlate(target_known, rotated_occupied, fft_shape)
    union = target_occupied_overlap + source_occupied_overlap - intersection
    ratio_denominator = min(float(source_known.sum()), float(target_known.sum()))
    minimum_overlap = max(8, math.ceil(MIN_OVERLAP_RATIO * ratio_denominator))
    valid = (overlap >= minimum_overlap) & (union > 0)
    ratio = overlap / max(ratio_denominator, 1)
    scores = np.full(overlap.shape, -1.0, dtype=float)
    scores[valid] = intersection[valid] / union[valid]

    peaks = []
    separation_cells = max(1, math.ceil(PEAK_TRANSLATION_SEPARATION_M / resolution_m))
    for _ in range(top_k):
        flat_index = int(np.argmax(scores))
        score = float(scores.flat[flat_index])
        if score < 0:
            break
        row, column = np.unravel_index(flat_index, scores.shape)
        shift_x = column - (rotated_known.shape[1] - 1)
        shift_y = row - (rotated_known.shape[0] - 1)
        cosine = math.cos(angle_rad)
        sine = math.sin(angle_rad)
        tx_cells = rotated_center[0] + shift_x - (
            cosine * source_center[0] - sine * source_center[1]
        )
        ty_cells = rotated_center[1] + shift_y - (
            sine * source_center[0] + cosine * source_center[1]
        )
        peaks.append(
            {
                "score": score,
                "overlap_ratio": min(1.0, float(ratio[row, column])),
                "rotation_rad": angle_rad,
                "translation_x_m": tx_cells * resolution_m,
                "translation_y_m": ty_cells * resolution_m,
            }
        )
        row_start = max(0, row - separation_cells)
        row_end = min(scores.shape[0], row + separation_cells + 1)
        column_start = max(0, column - separation_cells)
        column_end = min(scores.shape[1], column + separation_cells + 1)
        scores[row_start:row_end, column_start:column_end] = -1
    return peaks


def _rotation_distance(left: float, right: float) -> float:
    return abs((left - right + math.pi) % (2 * math.pi) - math.pi)


def align_occupancy_maps(
    reference_snapshot: dict[str, Any],
    active_snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Estimate reference-local to active-local SE(2), rejecting weak/ambiguous matches."""
    import numpy as np

    reference_metadata, reference_data = _map_parts(reference_snapshot)
    active_metadata, active_data = _map_parts(active_snapshot)
    maximum_extent = max(
        reference_metadata["width"] * reference_metadata["resolution_m"],
        reference_metadata["height"] * reference_metadata["resolution_m"],
        active_metadata["width"] * active_metadata["resolution_m"],
        active_metadata["height"] * active_metadata["resolution_m"],
    )
    alignment_resolution = max(
        float(reference_metadata["resolution_m"]),
        float(active_metadata["resolution_m"]),
        maximum_extent / MAX_ALIGNMENT_SIDE_CELLS,
    )
    reference_occupied, reference_known = _resample_occupancy(
        reference_metadata,
        reference_data,
        alignment_resolution,
    )
    active_occupied, active_known = _resample_occupancy(
        active_metadata,
        active_data,
        alignment_resolution,
    )
    if min(int(reference_occupied.sum()), int(active_occupied.sum())) < 8:
        raise MapAlignmentError("Map alignment requires at least eight known occupied cells in each map.")

    coarse_angles = [
        math.radians(degrees)
        for degrees in range(-180, 180, COARSE_ANGLE_STEP_DEGREES)
    ]
    candidates = []
    for angle in coarse_angles:
        candidates.extend(
            _candidate_peaks(
                reference_occupied,
                reference_known,
                active_occupied,
                active_known,
                angle,
                alignment_resolution,
            )
        )
    if not candidates:
        raise MapAlignmentError("No map alignment candidate has sufficient known-cell overlap.")
    coarse_best = max(candidates, key=lambda candidate: candidate["score"])
    center_degrees = math.degrees(coarse_best["rotation_rad"])
    fine_angles = [
        math.radians(center_degrees + offset)
        for offset in range(-COARSE_ANGLE_STEP_DEGREES, COARSE_ANGLE_STEP_DEGREES + 1, FINE_ANGLE_STEP_DEGREES)
    ]
    for angle in fine_angles:
        candidates.extend(
            _candidate_peaks(
                reference_occupied,
                reference_known,
                active_occupied,
                active_known,
                angle,
                alignment_resolution,
            )
        )

    candidates.sort(key=lambda candidate: candidate["score"], reverse=True)
    best = candidates[0]
    distinct = []
    for candidate in candidates[1:]:
        translation_distance = math.hypot(
            candidate["translation_x_m"] - best["translation_x_m"],
            candidate["translation_y_m"] - best["translation_y_m"],
        )
        angle_distance = _rotation_distance(candidate["rotation_rad"], best["rotation_rad"])
        if (
            translation_distance >= PEAK_TRANSLATION_SEPARATION_M
            or angle_distance >= math.radians(PEAK_ANGLE_SEPARATION_DEGREES)
        ):
            distinct.append(candidate)
            break
    second_score = distinct[0]["score"] if distinct else 0.0
    unique_margin = best["score"] - second_score
    if best["overlap_ratio"] < MIN_OVERLAP_RATIO:
        raise MapAlignmentError(
            "Map alignment overlap is too small ({:.0%}; require {:.0%}).".format(
                best["overlap_ratio"], MIN_OVERLAP_RATIO
            )
        )
    if best["score"] < MIN_MATCH_SCORE:
        raise MapAlignmentError(
            "Map alignment confidence is too low ({:.3f}; require {:.3f}).".format(
                best["score"], MIN_MATCH_SCORE
            )
        )
    if unique_margin < MIN_UNIQUE_MARGIN:
        raise MapAlignmentError(
            "Map alignment is ambiguous (best/next margin {:.3f}; require {:.3f}).".format(
                unique_margin, MIN_UNIQUE_MARGIN
            )
        )
    return {
        "ready": True,
        "algorithm": "bounded_occupancy_fft_se2_v1",
        "score": best["score"],
        "overlap_ratio": best["overlap_ratio"],
        "unique_margin": unique_margin,
        "rotation_rad": best["rotation_rad"],
        "translation_m": {
            "x": best["translation_x_m"],
            "y": best["translation_y_m"],
        },
        "alignment_resolution_m": alignment_resolution,
    }


def transform_pose_between_maps(
    pose: dict[str, Any],
    reference_map: dict[str, Any],
    active_map: dict[str, Any],
    alignment: dict[str, Any],
) -> dict[str, float]:
    reference_metadata, _ = _map_parts(reference_map)
    active_metadata, _ = _map_parts(active_map)
    reference_origin = reference_metadata["origin"]
    active_origin = active_metadata["origin"]
    reference_yaw = float(reference_origin.get("yaw_rad", 0.0))
    active_yaw = float(active_origin.get("yaw_rad", 0.0))
    x = _finite_number(pose.get("x"), "saved pose x")
    y = _finite_number(pose.get("y"), "saved pose y")
    yaw = _finite_number(pose.get("yaw_rad"), "saved pose yaw")
    delta_x = x - float(reference_origin["x"])
    delta_y = y - float(reference_origin["y"])
    reference_local_x = math.cos(reference_yaw) * delta_x + math.sin(reference_yaw) * delta_y
    reference_local_y = -math.sin(reference_yaw) * delta_x + math.cos(reference_yaw) * delta_y
    rotation = _finite_number(alignment.get("rotation_rad"), "rotation")
    translation = alignment.get("translation_m")
    if not isinstance(translation, dict):
        raise MapAlignmentError("Map alignment translation is invalid.")
    translated_x = (
        math.cos(rotation) * reference_local_x
        - math.sin(rotation) * reference_local_y
        + _finite_number(translation.get("x"), "translation x")
    )
    translated_y = (
        math.sin(rotation) * reference_local_x
        + math.cos(rotation) * reference_local_y
        + _finite_number(translation.get("y"), "translation y")
    )
    active_x = float(active_origin["x"]) + math.cos(active_yaw) * translated_x - math.sin(active_yaw) * translated_y
    active_y = float(active_origin["y"]) + math.sin(active_yaw) * translated_x + math.cos(active_yaw) * translated_y
    return {
        "x": active_x,
        "y": active_y,
        "yaw_rad": yaw - reference_yaw + rotation + active_yaw,
    }