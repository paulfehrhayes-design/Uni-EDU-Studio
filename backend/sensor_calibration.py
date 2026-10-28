"""Candidate G1 sensor geometry and fail-closed calibration status."""

import math
import os
import hashlib
import xml.etree.ElementTree as ET
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
DEFAULT_URDF_PATH = os.path.join(
    REPO_ROOT,
    "g1_23dof.urdf.txt",
)
DEFAULT_GEOMETRY_PATH = os.path.join(
    REPO_ROOT,
    "vendor",
    "DUET",
    "src",
    "assets",
    "robots",
    "unitree_g1",
    "xmls",
    "g1_23dof.xml",
)
FALLBACK_GEOMETRY_PATH = os.path.join(
    os.path.dirname(__file__), "static", "g1", "g1.xml"
)
SENSOR_LINKS = {
    "mid360": "mid360_link",
    "d435": "d435_link",
}
TRANSFORM_TRANSLATION_TOLERANCE_M = 0.03
TRANSFORM_ROTATION_TOLERANCE_RAD = math.radians(3)
G1_MODEL_FOOTPRINT_ENVELOPE_M = {
    "front": 0.175,
    "rear": 0.175,
    "half_width": 0.225,
}


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


def _quaternion_multiply(left, right):
    w, x, y, z = left
    other_w, other_x, other_y, other_z = right
    return (
        w * other_w - x * other_x - y * other_y - z * other_z,
        w * other_x + x * other_w + y * other_z - z * other_y,
        w * other_y - x * other_z + y * other_w + z * other_x,
        w * other_z + x * other_y - y * other_x + z * other_w,
    )


def _rotate_point(rotation, point):
    w, x, y, z = rotation
    px, py, pz = point
    return (
        (1 - 2 * (y * y + z * z)) * px + 2 * (x * y - z * w) * py + 2 * (x * z + y * w) * pz,
        2 * (x * y + z * w) * px + (1 - 2 * (x * x + z * z)) * py + 2 * (y * z - x * w) * pz,
        2 * (x * z - y * w) * px + 2 * (y * z + x * w) * py + (1 - 2 * (x * x + y * y)) * pz,
    )


def _mjcf_body_pose(body):
    position = _numbers(body.get("pos", "0 0 0"), 3, "G1 body position")
    if body.get("quat"):
        quaternion = _numbers(body.get("quat"), 4, "G1 body quaternion")
        norm = math.sqrt(sum(value * value for value in quaternion))
        if norm <= 1e-9:
            raise ValueError("G1 body quaternion has zero magnitude.")
        return position, tuple(value / norm for value in quaternion)
    if body.get("euler"):
        roll, pitch, yaw = _numbers(body.get("euler"), 3, "G1 body Euler rotation")
        return position, _quaternion_from_rpy(roll, pitch, yaw)
    return position, (1.0, 0.0, 0.0, 0.0)


def _mjcf_default_geom_attributes(root):
    classes = {}

    def visit(default, inherited):
        attributes = dict(inherited)
        geom = default.find("geom")
        if geom is not None:
            attributes.update(geom.attrib)
        class_name = default.get("class")
        if class_name:
            classes[class_name] = attributes
        for child in default.findall("default"):
            visit(child, attributes)

    for default in root.findall("default"):
        visit(default, {})
    return classes


def derive_g1_footprint(geometry_path=DEFAULT_GEOMETRY_PATH):
    """Derive a conservative G1 footprint from model foot collisions."""
    try:
        root = ET.parse(geometry_path).getroot()
    except (OSError, ET.ParseError) as error:
        raise ValueError("Could not read supported G1 collision model: {}".format(error)) from error
    geom_defaults = _mjcf_default_geom_attributes(root)
    world = root.find("worldbody")
    pelvis = (
        next(
            (body for body in world.findall("body") if body.get("name") == "pelvis"),
            None,
        )
        if world is not None
        else None
    )
    if pelvis is None:
        raise ValueError("Supported G1 collision model has no pelvis root.")

    bounds = []

    def visit(body, parent_position, parent_rotation):
        local_position, local_rotation = _mjcf_body_pose(body)
        rotated_position = _rotate_point(parent_rotation, local_position)
        position = tuple(a + b for a, b in zip(parent_position, rotated_position))
        rotation = _quaternion_multiply(parent_rotation, local_rotation)
        for geom in body.findall("geom"):
            name = geom.get("name", "")
            if not name.startswith(("left_foot", "right_foot")) or "collision" not in name:
                continue
            attributes = {
                **geom_defaults.get(geom.get("class", ""), {}),
                **geom.attrib,
            }
            if attributes.get("type") != "capsule" or not attributes.get("fromto"):
                raise ValueError("G1 foot collision {} is not a supported capsule.".format(name))
            endpoints = _numbers(attributes.get("fromto"), 6, "G1 foot collision endpoints")
            radius = _numbers(attributes.get("size"), 1, "G1 foot collision radius")[0]
            if radius <= 0:
                raise ValueError("G1 foot collision {} has a non-positive radius.".format(name))
            for offset in (0, 3):
                endpoint = tuple(endpoints[offset : offset + 3])
                local_geom_position = _numbers(
                    attributes.get("pos", "0 0 0"), 3, "G1 foot collision position"
                )
                endpoint = tuple(a + b for a, b in zip(endpoint, local_geom_position))
                point = _rotate_point(rotation, endpoint)
                bounds.append(
                    {
                        "x_min": position[0] + point[0] - radius,
                        "x_max": position[0] + point[0] + radius,
                        "y_min": position[1] + point[1] - radius,
                        "y_max": position[1] + point[1] + radius,
                    }
                )
        for child in body.findall("body"):
            visit(child, position, rotation)

    visit(pelvis, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0))
    if not bounds:
        raise ValueError("Supported G1 collision model has no foot collision geometry.")
    model_bounds = {
        "front": max(bound["x_max"] for bound in bounds),
        "rear": max(-bound["x_min"] for bound in bounds),
        "half_width": max(
            max(abs(bound["y_min"]), abs(bound["y_max"])) for bound in bounds
        ),
    }
    footprint = {
        key: max(model_bounds[key], minimum)
        for key, minimum in G1_MODEL_FOOTPRINT_ENVELOPE_M.items()
    }
    return {
        **footprint,
        "source": os.path.basename(geometry_path),
        "model_bounds_m": model_bounds,
        "method": "G1 foot collision geometry with a conservative G1 EDU footprint envelope",
    }


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


def load_robot_root_frame(urdf_path=DEFAULT_URDF_PATH):
    try:
        root = ET.parse(urdf_path).getroot()
    except (OSError, ET.ParseError) as error:
        raise ValueError("Could not read supported G1 robot description: {}".format(error)) from error
    links = {
        link.get("name", "").strip()
        for link in root.findall("link")
        if link.get("name", "").strip()
    }
    child_links = set()
    for joint in root.findall("joint"):
        child = joint.find("child")
        if child is not None:
            child_name = child.get("link", "").strip()
            if child_name:
                child_links.add(child_name)
    root_links = links - child_links
    if len(root_links) != 1:
        raise ValueError(
            "Supported G1 model must have exactly one root link; found {}.".format(
                len(root_links)
            )
        )
    return next(iter(root_links))


def load_actuated_joint_count(urdf_path=DEFAULT_URDF_PATH):
    try:
        root = ET.parse(urdf_path).getroot()
    except (OSError, ET.ParseError) as error:
        raise ValueError("Could not read supported G1 robot description: {}".format(error)) from error
    return sum(
        joint.get("type") in {"revolute", "continuous", "prismatic"}
        for joint in root.findall("joint")
    )


def _model_fingerprint(urdf_path, geometry_path):
    digest = hashlib.sha256()
    for path in (urdf_path, geometry_path):
        try:
            with open(path, "rb") as source:
                digest.update(source.read())
        except OSError as error:
            raise ValueError("Could not fingerprint G1 calibration model: {}".format(error)) from error
    return digest.hexdigest()


def automatic_calibration_model(urdf_path=None, geometry_path=None):
    configured_urdf = urdf_path or os.getenv("G1_SENSOR_URDF_PATH", DEFAULT_URDF_PATH)
    configured_geometry = geometry_path or os.getenv(
        "G1_SENSOR_GEOMETRY_PATH", DEFAULT_GEOMETRY_PATH
    )
    path_warnings = []
    urdf_path = configured_urdf
    geometry_path = configured_geometry
    if not os.path.isfile(urdf_path) and os.path.isfile(DEFAULT_URDF_PATH):
        urdf_path = DEFAULT_URDF_PATH
        path_warnings.append(
            "Configured G1 URDF path is unavailable; using the bundled G1 EDU 23-DOF URDF."
        )
    if not os.path.isfile(geometry_path) and os.path.isfile(DEFAULT_GEOMETRY_PATH):
        geometry_path = DEFAULT_GEOMETRY_PATH
        path_warnings.append(
            "Configured G1 geometry path is unavailable; using the bundled G1 EDU 23-DOF collision model."
        )
    if not os.path.isfile(geometry_path) and os.path.isfile(FALLBACK_GEOMETRY_PATH):
        geometry_path = FALLBACK_GEOMETRY_PATH
        path_warnings.append(
            "The G1 EDU 23-DOF collision model is unavailable; using the legacy bundled G1 collision model."
        )
    if not os.path.isfile(urdf_path):
        raise ValueError("Could not locate the supported G1 EDU 23-DOF URDF.")
    if not os.path.isfile(geometry_path):
        raise ValueError("Could not locate a supported G1 EDU collision geometry model.")
    actuated_joint_count = load_actuated_joint_count(urdf_path)
    if actuated_joint_count != 23:
        raise ValueError(
            "Supported G1 EDU robot description must have 23 actuated joints; found {}.".format(
                actuated_joint_count
            )
        )
    mounts = load_candidate_sensor_mounts(urdf_path)
    root_frame = load_robot_root_frame(urdf_path)
    footprint = derive_g1_footprint(geometry_path)
    mount = mounts.get("mid360")
    if not mount or not mount.get("available"):
        raise ValueError("Supported G1 model has no usable MID-360 mount.")
    return {
        "model_fingerprint": _model_fingerprint(urdf_path, geometry_path),
        "mount": mount,
        "root_frame": root_frame,
        "actuated_joint_count": actuated_joint_count,
        "footprint": footprint,
        "path_warnings": path_warnings,
    }


def _calibration_cache_enabled(environment=None):
    if environment is None:
        environment = os.environ
    return environment.get("G1_SENSOR_AUTO_CALIBRATION_PERSIST", "0") == "1"


def _calibration_cache_path(environment=None):
    if environment is None:
        environment = os.environ
    if not _calibration_cache_enabled(environment):
        return None
    configured = environment.get(
        "G1_SENSOR_CALIBRATION_CACHE_PATH",
        os.path.join(
            os.path.expanduser("~/.config"),
            "uni-edu-studio",
            "sensor-calibration.json",
        ),
    ).strip()
    if not configured:
        return None
    return os.path.abspath(os.path.expanduser(configured))


def _read_persisted_calibration(environment=None):
    cache_path = _calibration_cache_path(environment)
    if not cache_path:
        return None
    try:
        with open(cache_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if not payload.get("ready"):
        return None
    return payload


def _write_persisted_calibration(status, environment=None):
    cache_path = _calibration_cache_path(environment)
    if not cache_path or not isinstance(status, dict):
        return
    try:
        directory = os.path.dirname(cache_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as handle:
            json.dump(status, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except OSError:
        return


def _live_provider_calibration_report(environment, timeout=0.5):
    provider_url = environment.get("G1_DISTANCE_PROVIDER_URL", "").strip()
    token = environment.get("G1_DISTANCE_PROVIDER_TOKEN", "").strip()
    if not provider_url or not token:
        return None, "Automatic calibration is waiting for the configured LiDAR provider."
    parsed_url = urlsplit(provider_url)
    provider_path = parsed_url.path.rstrip("/")
    distance_suffixes = ("/distance/front", "/distance/rear")
    distance_suffix = next(
        (suffix for suffix in distance_suffixes if provider_path.endswith(suffix)),
        None,
    )
    if not distance_suffix:
        return None, "LiDAR provider URL must end in /distance/front or /distance/rear."
    calibration_path = provider_path[: -len(distance_suffix)] + "/calibration"
    request = urllib.request.Request(
        urlunsplit(
            (
                parsed_url.scheme,
                parsed_url.netloc,
                calibration_path,
                "",
                "",
            )
        ),
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return None, "Could not read live automatic calibration status: {}".format(error)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, "LiDAR provider returned invalid calibration status: {}".format(error)
    if not isinstance(payload, dict):
        return None, "LiDAR provider calibration status must be a JSON object."
    return payload, None


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


def _live_report_matches_model(model, report):
    if not isinstance(report, dict) or report.get("ready") is not True:
        return False
    if report.get("model_fingerprint") != model["model_fingerprint"]:
        return False
    transform = report.get("transform")
    if not isinstance(transform, dict):
        return False
    mount = model["mount"]
    if transform.get("parent_frame") != mount["parent_frame"] or not isinstance(
        transform.get("sensor_frame"), str
    ) or not transform["sensor_frame"].strip():
        return False
    translation_error = transform.get("translation_error_m")
    rotation_error = transform.get("rotation_error_rad")
    if (
        isinstance(translation_error, bool)
        or not isinstance(translation_error, (int, float))
        or not math.isfinite(translation_error)
        or isinstance(rotation_error, bool)
        or not isinstance(rotation_error, (int, float))
        or not math.isfinite(rotation_error)
        or translation_error > TRANSFORM_TRANSLATION_TOLERANCE_M
        or rotation_error > TRANSFORM_ROTATION_TOLERANCE_RAD
    ):
        return False
    footprint = report.get("footprint")
    if not isinstance(footprint, dict):
        return False
    return all(
        not isinstance(footprint.get(key), bool)
        and isinstance(footprint.get(key), (int, float))
        and math.isfinite(footprint[key])
        and math.isclose(
            footprint[key],
            model["footprint"][key],
            rel_tol=0,
            abs_tol=1e-6,
        )
        for key in ("front", "rear", "half_width")
    )


def calibration_status(
    env=None,
    urdf_path=None,
    geometry_path=None,
    live_report=None,
):
    environment = os.environ if env is None else env
    urdf_path = urdf_path or environment.get("G1_SENSOR_URDF_PATH", DEFAULT_URDF_PATH)
    geometry_path = geometry_path or environment.get(
        "G1_SENSOR_GEOMETRY_PATH", DEFAULT_GEOMETRY_PATH
    )
    try:
        model = automatic_calibration_model(urdf_path, geometry_path)
        model_error = None
    except ValueError as error:
        model = None
        model_error = str(error)
    report_verified = False
    persisted_status = None
    if model_error:
        reason = model_error
    else:
        path_warnings = model["path_warnings"]
        configured_base_frame = environment.get("G1_DISTANCE_BASE_FRAME", model["root_frame"]).strip()
        mount_confirmed = environment.get("G1_LIDAR_MOUNT_CONFIRMED") == "1"
        persisted_status = _read_persisted_calibration(environment)
        persisted_valid = (
            isinstance(persisted_status, dict)
            and persisted_status.get("ready") is True
            and persisted_status.get("model_fingerprint") == model["model_fingerprint"]
            and persisted_status.get("root_frame") == model["root_frame"]
        )
        if persisted_valid:
            mount_confirmed = True
        if configured_base_frame != model["root_frame"]:
            reason = (
                "Distance base frame {!r} is not the supported G1 model root {!r}."
            ).format(configured_base_frame, model["root_frame"])
        else:
            report_error = None
            if persisted_valid and live_report is None:
                live_report = persisted_status
            elif live_report is None:
                live_report, report_error = _live_provider_calibration_report(environment)
            if report_error:
                reason = report_error
            elif not isinstance(live_report, dict):
                reason = "LiDAR provider calibration status must be a JSON object."
            elif live_report.get("model_fingerprint") != model["model_fingerprint"]:
                reason = "Live calibration evidence was produced by a different G1 model."
            elif live_report.get("ready") is True and _live_report_matches_model(model, live_report):
                report_verified = True
                reason = (
                    live_report.get("reason")
                    or "Live ROS transform matches the nominal G1 model mount; distances use model-derived geometry."
                )
            elif live_report.get("ready") is True:
                reason = (
                    "LiDAR provider marked calibration ready without a matching live transform "
                    "and model-derived footprint."
                )
            else:
                reason = live_report.get(
                    "reason",
                    "Waiting for a fresh LiDAR sample and a matching live G1 sensor transform.",
                )
        if path_warnings:
            reason = "{} {}".format(reason, " ".join(path_warnings))
        if report_verified and mount_confirmed:
            _write_persisted_calibration(
                {
                    "ready": True,
                    "status": "verified",
                    "calibration_source": "live_transform_match",
                    "reason": reason,
                    "model_fingerprint": model["model_fingerprint"],
                    "root_frame": model["root_frame"],
                    "footprint": model["footprint"],
                    "transform": (live_report or {}).get("transform"),
                },
                environment,
            )
    ready = bool(model and report_verified)
    mounts = {} if not model else {"mid360": model["mount"]}
    missing_footprint = [] if model else ["automatic G1 footprint geometry"]
    return {
        "status": (
            "unavailable" if model_error
            else "model_derived" if ready and not mount_confirmed
            else "verified" if ready
            else "awaiting_live_validation"
        ),
        "ready": ready,
        "configuration_present": model is not None,
        "model": os.path.basename(urdf_path),
        "geometry_model": None if not model else model["footprint"]["source"],
        "actuated_joint_count": (
            None if not model else model["actuated_joint_count"]
        ),
        "root_frame": None if not model else model["root_frame"],
        "candidate_mounts": mounts,
        "physical_mount_confirmed": bool(
            environment.get("G1_LIDAR_MOUNT_CONFIRMED") == "1"
            or (
                isinstance(persisted_status, dict)
                and persisted_status.get("ready") is True
                and persisted_status.get("model_fingerprint") == (model["model_fingerprint"] if model else None)
            )
        ),
        "footprint": None if not model else model["footprint"],
        "model_path_warnings": [] if not model else model["path_warnings"],
        "model_fingerprint": None if not model else model["model_fingerprint"],
        "axis_confirmed": ready,
        "calibration_confirmed": ready,
        "missing_footprint": missing_footprint,
        "reason": reason,
        "calibration_method": "model_derived_footprint_and_live_ros_transform_check",
        "calibration_source": "model_derived" if ready and not mount_confirmed else "live_transform_match",
        "verification_note": (
            "Footprint dimensions are derived from the G1 EDU 23-DOF model. "
            "The sensor mount still requires explicit physical confirmation; a live "
            "ROS transform check is model-based and is not independent LiDAR-camera "
            "extrinsic calibration or supervised hardware acceptance."
        ),
        "live_transform": (
            live_report.get("transform") if isinstance(live_report, dict) else None
        ),
        "persisted_calibration": persisted_status,
    }


if __name__ == "__main__":
    print(json.dumps(automatic_calibration_model(), indent=2, sort_keys=True))
