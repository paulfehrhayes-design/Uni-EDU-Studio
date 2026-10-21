"""Read-only discovery of ROS camera streams and USB RealSense devices."""

import math
import os
import re
import shutil
import subprocess

try:
    from .sensor_discovery import (
        MAX_FUTURE_SKEW_SECONDS,
        MAX_SAMPLE_AGE_SECONDS,
        _ros_prefix,
        _run,
    )
except ImportError:
    from sensor_discovery import (
        MAX_FUTURE_SKEW_SECONDS,
        MAX_SAMPLE_AGE_SECONDS,
        _ros_prefix,
        _run,
    )

IMAGE_TYPE = "sensor_msgs/msg/Image"
CAMERA_INFO_TYPE = "sensor_msgs/msg/CameraInfo"
CAMERA_NAME_PATTERN = re.compile(
    r"camera|realsense|d435|unitree|rgb|depth", re.IGNORECASE
)
UNITREE_NAME_PATTERN = re.compile(r"unitree|utcamera|ut_camera", re.IGNORECASE)


def _usb_cameras(root="/sys/bus/usb/devices"):
    devices = []
    diagnostics = []
    try:
        entries = os.scandir(root)
    except FileNotFoundError:
        return devices, diagnostics
    except OSError as error:
        return devices, ["Could not inspect USB camera devices: {}".format(error)]
    with entries:
        for entry in entries:
            try:
                with open(os.path.join(entry.path, "idVendor"), encoding="ascii") as source:
                    vendor_id = source.read().strip().lower()
            except OSError:
                continue
            if vendor_id != "8086":
                continue
            fields = {}
            for key in ("idProduct", "product", "serial", "manufacturer"):
                try:
                    with open(os.path.join(entry.path, key), encoding="utf-8") as source:
                        fields[key] = source.read().strip()
                except OSError:
                    fields[key] = ""
            label = " ".join(
                (fields["manufacturer"], fields["product"], fields["idProduct"])
            ).strip()
            recognized = bool(
                re.search(r"realsense|d435i|d435", label, re.IGNORECASE)
            )
            devices.append(
                {
                    "usb_path": entry.name,
                    "vendor_id": vendor_id,
                    "product_id": fields["idProduct"].lower() or None,
                    "product": fields["product"] or None,
                    "serial": fields["serial"] or None,
                    "recognized_realsense": recognized,
                    "status": "device_detected" if recognized else "unidentified_intel_usb",
                }
            )
    return devices, diagnostics


def _parse_topic_list(text):
    topics = []
    for line in text.splitlines():
        match = re.match(r"^\s*(/\S+)\s+\[([^\]]+)\]\s*$", line)
        if match:
            topics.append({"name": match.group(1), "type": match.group(2)})
    return topics


def _camera_header_sample(text, now_seconds):
    frame_match = re.search(r"^\s*frame_id:\s*(.*?)\s*$", text, re.MULTILINE)
    seconds_match = re.search(r"^\s*sec:\s*(-?\d+)\s*$", text, re.MULTILINE)
    nanoseconds_match = re.search(
        r"^\s*nanosec:\s*(-?\d+)\s*$", text, re.MULTILINE
    )
    if not frame_match or not seconds_match or not nanoseconds_match:
        return {
            "frame_id": None,
            "fresh": False,
            "age_ms": None,
            "error": "Camera topic header has an invalid frame or timestamp.",
        }
    frame_id = frame_match.group(1).strip().strip("\"'")
    seconds = int(seconds_match.group(1))
    nanoseconds = int(nanoseconds_match.group(1))
    if not frame_id or seconds < 0 or not 0 <= nanoseconds < 1_000_000_000:
        return {
            "frame_id": frame_id or None,
            "fresh": False,
            "age_ms": None,
            "error": "Camera topic header has an invalid frame or timestamp.",
        }
    age_seconds = now_seconds - (seconds + nanoseconds / 1_000_000_000)
    fresh = -MAX_FUTURE_SKEW_SECONDS <= age_seconds <= MAX_SAMPLE_AGE_SECONDS
    if age_seconds < -MAX_FUTURE_SKEW_SECONDS:
        error = "Camera topic timestamp is in the future."
    elif age_seconds > MAX_SAMPLE_AGE_SECONDS:
        error = "Camera topic sample is stale ({:.0f} ms old).".format(
            age_seconds * 1000
        )
    else:
        error = None
    return {
        "frame_id": frame_id,
        "fresh": fresh,
        "age_ms": age_seconds * 1000,
        "error": error,
    }


def _camera_intrinsics(text):
    values = re.findall(
        r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?", text
    )
    try:
        matrix = [float(value) for value in values]
    except ValueError:
        matrix = []
    if (
        len(matrix) != 9
        or not all(math.isfinite(value) for value in matrix)
        or matrix[0] <= 0
        or matrix[4] <= 0
    ):
        return None
    return {
        "fx_px": matrix[0],
        "fy_px": matrix[4],
        "cx_px": matrix[2],
        "cy_px": matrix[5],
    }


def _camera_topics(ros_prefix, runner, now_seconds):
    output, error = _run(
        ros_prefix + ["topic", "list", "-t"], timeout=3.0, runner=runner
    )
    if error:
        return [], "Could not inspect ROS camera topics: {}".format(error)
    topics = _parse_topic_list(output)
    camera_topics = []
    for topic in topics:
        if (
            topic["type"] not in {IMAGE_TYPE, CAMERA_INFO_TYPE}
            or not CAMERA_NAME_PATTERN.search(topic["name"])
        ):
            continue
        sample = {
            "name": topic["name"],
            "type": topic["type"],
            "frame_id": None,
            "fresh": False,
            "age_ms": None,
            "intrinsics": None,
            "error": None,
        }
        header, header_error = _run(
            ros_prefix
            + ["topic", "echo", "--once", topic["name"], "--field", "header"],
            timeout=2.0,
            runner=runner,
        )
        if header_error:
            sample["error"] = "Could not read camera topic header: {}".format(header_error)
        else:
            sample.update(_camera_header_sample(header, now_seconds))
        if topic["type"] == CAMERA_INFO_TYPE:
            matrix_text, matrix_error = _run(
                ros_prefix
                + ["topic", "echo", "--once", topic["name"], "--field", "k"],
                timeout=2.0,
                runner=runner,
            )
            if matrix_error:
                sample["error"] = sample["error"] or (
                    "Could not read CameraInfo intrinsics: {}".format(matrix_error)
                )
            else:
                sample["intrinsics"] = _camera_intrinsics(matrix_text)
                if sample["intrinsics"] is None:
                    sample["error"] = sample["error"] or (
                        "CameraInfo has no valid finite 3x3 intrinsic matrix."
                    )
        camera_topics.append(sample)
    return camera_topics, None


def _camera_result(source_id, source_type, topics, devices, reason):
    images = [topic for topic in topics if topic["type"] == IMAGE_TYPE]
    fresh_images = [topic for topic in images if topic["fresh"]]
    camera_info = [topic for topic in topics if topic["type"] == CAMERA_INFO_TYPE]
    valid_camera_info = [
        topic for topic in camera_info
        if topic["fresh"]
        and topic["intrinsics"] is not None
        and any(
            image["frame_id"] == topic["frame_id"]
            for image in fresh_images
        )
    ]
    available = bool(fresh_images)
    return {
        "id": source_id,
        "type": source_type,
        "available": available,
        "ready": available and bool(valid_camera_info),
        "status": "ready" if available and valid_camera_info else (
            "stream_without_verified_intrinsics" if available else "unavailable"
        ),
        "devices": devices,
        "image_topics": images,
        "camera_info_topics": camera_info,
        "intrinsics_available": bool(valid_camera_info),
        "intrinsics": valid_camera_info[0]["intrinsics"] if valid_camera_info else None,
        "reason": (
            "Fresh image stream and frame-matched CameraInfo intrinsics detected."
            if available and valid_camera_info
            else "Fresh image stream detected; fresh frame-matched CameraInfo intrinsics are not yet available."
            if available
            else reason
        ),
    }


def discover_camera_sources(
    env=None,
    runner=None,
    now_seconds=None,
    usb_root="/sys/bus/usb/devices",
    ros2_executable=None,
    which=shutil.which,
):
    environment = dict(os.environ if env is None else env)
    ros_prefix = [ros2_executable] if ros2_executable else None
    ros_error = None
    if ros_prefix is None:
        ros_prefix, _distro, ros_error = _ros_prefix(environment, which=which)
    topics = []
    if ros_prefix is not None:
        import time

        camera_topics, topic_error = _camera_topics(
            ros_prefix,
            runner,
            time.time() if now_seconds is None else now_seconds,
        )
        topics = camera_topics
        ros_error = topic_error

    usb_devices, usb_diagnostics = _usb_cameras(usb_root)
    realsense_devices = [
        device for device in usb_devices if device["recognized_realsense"]
    ]
    unitree_topics = [
        topic
        for topic in topics
        if UNITREE_NAME_PATTERN.search(topic["name"])
    ]
    realsense_topics = [
        topic
        for topic in topics
        if re.search(r"realsense|d435|camera", topic["name"], re.IGNORECASE)
        and not UNITREE_NAME_PATTERN.search(topic["name"])
    ]

    sources = {
        "unitree": _camera_result(
            "unitree_camera",
            "unitree_ros_camera",
            unitree_topics,
            [],
            (
                "No fresh Unitree ROS camera image stream is visible. The onboard "
                "Unitree camera transport is not available through this ROS interface."
            ),
        ),
        "realsense": _camera_result(
            "usb_realsense",
            "realsense_ros2",
            realsense_topics,
            realsense_devices,
            (
                "No fresh RealSense image stream is visible."
                if realsense_devices
                else "No supported Intel RealSense USB device was identified."
            ),
        ),
    }
    diagnostics = list(usb_diagnostics)
    if ros_error:
        diagnostics.append(ros_error)
    for source in sources.values():
        diagnostics.extend(
            topic["error"]
            for topic in source["image_topics"] + source["camera_info_topics"]
            if topic["error"]
        )
    diagnostics.extend(
        "Intel USB device {} is not identified as a RealSense camera.".format(
            device["usb_path"]
        )
        for device in usb_devices
        if not device["recognized_realsense"]
    )
    return {
        "sources": sources,
        "available": any(source["available"] for source in sources.values()),
        "diagnostics": diagnostics,
        "freshness_limits_ms": {
            "maximum_age": MAX_SAMPLE_AGE_SECONDS * 1000,
            "maximum_future_skew": MAX_FUTURE_SKEW_SECONDS * 1000,
        },
    }
