"""Candidate G1 sensor geometry and fail-closed calibration status."""

import math
import os
import xml.etree.ElementTree as ET


DEFAULT_URDF_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "g1_23dof.urdf.txt",
)
SENSOR_LINKS = {
    "mid360": "mid360_link",
    "d435": "d435_link",
}
TRANSFORM_TRANSLATION_TOLERANCE_M = 0.03
TRANSFORM_ROTATION_TOLERANCE_RAD = math.radians(3)


def _numbers(value, count, label):
    if value is None:
        return (0.0,) * count
    try:
        values = tuple(float(item) for item in value.split())
    except ValueError as error:
        raise ValueError("{} contains a non-numeric value.".format(label)) from error
    if len(values) != count or not all(math.isfinite(item) for item in values):
        raise ValueError("{} must contain {} finite values.".format(label, count))
    return values


def _quaternion_from_rpy(roll, pitch, yaw):
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    return (
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    )


def load_candidate_sensor_mounts(urdf_path=DEFAULT_URDF_PATH):
    """Return fixed URDF sensor mounts as candidates, never as verified extrinsics."""
    try:
        root = ET.parse(urdf_path).getroot()
    except (OSError, ET.ParseError) as error:
        raise ValueError("Could not read supported G1 robot description: {}".format(error)) from error

    joints = {}
    for joint in root.findall("joint"):
        child = joint.find("child")
        parent = joint.find("parent")
        if child is None or parent is None:
            continue
        joints[child.get("link", "")] = joint

    mounts = {}
    for sensor_id, link_name in SENSOR_LINKS.items():
        joint = joints.get(link_name)
        if joint is None:
            mounts[sensor_id] = {
                "available": False,
                "status": "missing",
                "reason": "The G1 model has no fixed mount joint for {}.".format(sensor_id),
            }
            continue
        if joint.get("type") != "fixed":
            mounts[sensor_id] = {
                "available": False,
                "status": "unsupported",
                "reason": "The {} mount joint is not fixed; model geometry cannot supply a static candidate.".format(
                    sensor_id
                ),
            }
            continue
        origin = joint.find("origin")
        try:
            xyz = _numbers(origin.get("xyz") if origin is not None else None, 3, "Mount translation")
            rpy = _numbers(origin.get("rpy") if origin is not None else None, 3, "Mount rotation")
        except ValueError as error:
            mounts[sensor_id] = {
                "available": False,
                "status": "invalid",
                "reason": str(error),
            }
            continue
        parent = joint.find("parent")
        mounts[sensor_id] = {
            "available": True,
            "status": "candidate_unverified",
            "parent_frame": parent.get("link", ""),
            "sensor_frame": link_name,
            "translation_m": list(xyz),
            "rpy_rad": list(rpy),
            "rotation_xyzw": list(_quaternion_from_rpy(*rpy)),
            "source": os.path.basename(urdf_path),
            "reason": "Candidate from the repository G1 URDF; it is not proof of the installed sensor mount.",
        }
    return mounts


def compare_transforms(candidate, observed):
    """Compare finite transforms expressed with the same parent/child frame labels."""
    if not isinstance(candidate, dict) or not isinstance(observed, dict):
        return {"matches": False, "reason": "Both candidate and live TF transforms are required."}
    if (
        candidate.get("parent_frame") != observed.get("parent_frame")
        or candidate.get("sensor_frame") != observed.get("sensor_frame")
    ):
        return {
            "matches": False,
            "reason": "Candidate and live TF frame labels do not match.",
        }
    try:
        candidate_xyz = _numbers(
            " ".join(map(str, candidate["translation_m"])), 3, "Candidate translation"
        )
        observed_xyz = _numbers(
            " ".join(map(str, observed["translation_m"])), 3, "Observed translation"
        )
        candidate_q = _numbers(
            " ".join(map(str, candidate["rotation_xyzw"])), 4, "Candidate quaternion"
        )
        observed_q = _numbers(
            " ".join(map(str, observed["rotation_xyzw"])), 4, "Observed quaternion"
        )
    except (KeyError, TypeError, ValueError) as error:
        return {"matches": False, "reason": "Transform values are invalid: {}".format(error)}

    translation_error = math.sqrt(
        sum((left - right) ** 2 for left, right in zip(candidate_xyz, observed_xyz))
    )
    candidate_norm = math.sqrt(sum(value * value for value in candidate_q))
    observed_norm = math.sqrt(sum(value * value for value in observed_q))
    if candidate_norm <= 1e-9 or observed_norm <= 1e-9:
        return {"matches": False, "reason": "A transform quaternion has zero magnitude."}
    dot = abs(
        sum(
            (left / candidate_norm) * (right / observed_norm)
            for left, right in zip(candidate_q, observed_q)
        )
    )
    rotation_error = 2 * math.acos(min(1.0, dot))
    matches = (
        translation_error <= TRANSFORM_TRANSLATION_TOLERANCE_M
        and rotation_error <= TRANSFORM_ROTATION_TOLERANCE_RAD
    )
    return {
        "matches": matches,
        "translation_error_m": translation_error,
        "rotation_error_rad": rotation_error,
        "reason": (
            "Candidate agrees with live TF within configured tolerances."
            if matches
            else "Candidate and live TF differ beyond configured tolerances."
        ),
    }


def calibration_status(env=None, urdf_path=DEFAULT_URDF_PATH):
    environment = os.environ if env is None else env
    try:
        mounts = load_candidate_sensor_mounts(urdf_path)
        model_error = None
    except ValueError as error:
        mounts = {}
        model_error = str(error)
    axis_confirmed = environment.get("G1_LIDAR_AXIS_CONFIRMED", "0").strip() == "1"
    calibration_confirmed = (
        environment.get("G1_DISTANCE_CALIBRATION_CONFIRMED", "0").strip() == "1"
    )
    required_footprint = (
        "G1_DISTANCE_FOOTPRINT_FRONT_M",
        "G1_DISTANCE_FOOTPRINT_REAR_M",
        "G1_DISTANCE_FOOTPRINT_HALF_WIDTH_M",
    )
    missing_footprint = [
        name for name in required_footprint if not environment.get(name, "").strip()
    ]
    configuration_present = (
        axis_confirmed and calibration_confirmed and not missing_footprint
    )
    if model_error:
        reason = model_error
    elif not axis_confirmed:
        reason = "LiDAR axis/coordinate convention has not been verified."
    elif not calibration_confirmed:
        reason = (
            "Sensor-to-base transform and footprint have not passed calibration validation."
        )
    elif missing_footprint:
        reason = "Verified robot footprint dimensions are missing: {}.".format(
            ", ".join(missing_footprint)
        )
    else:
        reason = (
            "Saved calibration flags and footprint are present, but no live transform "
            "comparison or independent calibration validation is available."
        )
    return {
        "status": "configured_unverified" if configuration_present else "unverified",
        "ready": False,
        "configuration_present": configuration_present,
        "model": os.path.basename(urdf_path),
        "candidate_mounts": mounts,
        "axis_confirmed": axis_confirmed,
        "calibration_confirmed": calibration_confirmed,
        "missing_footprint": missing_footprint,
        "reason": reason,
        "verification_note": (
            "No model candidate or saved flag alone validates installed hardware."
        ),
    }
