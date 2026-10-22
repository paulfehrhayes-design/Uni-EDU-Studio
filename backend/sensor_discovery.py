"""Read-only discovery and diagnostics for G1 LiDAR setup."""

import ipaddress
import json
import os
import platform
import re
import selectors
import shlex
import shutil
import subprocess
import time

MAX_SAMPLE_AGE_SECONDS = 0.5
MAX_FUTURE_SKEW_SECONDS = 0.1
MAX_TOPIC_SAMPLE_BYTES = 65536
LIDAR_NAME_PATTERN = re.compile(
    r"lidar|livox|mid.?360|utlidar|point.?cloud", re.IGNORECASE
)
POINTCLOUD_TYPE = "sensor_msgs/msg/PointCloud2"
ROS_TOPIC_PATTERN = re.compile(r"^/[A-Za-z0-9_/]+$")


def _run(command, timeout=2.0, runner=None):
    execute = runner or subprocess.run
    try:
        result = execute(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None, "command timed out"
    except OSError as error:
        return None, str(error)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        return None, detail or "command exited unsuccessfully"
    return result.stdout, None


def _topic_sample_complete(text, include_camera_intrinsics=False):
    header_complete = all(
        re.search(pattern, text, re.MULTILINE)
        for pattern in (
            r"^\s*frame_id:\s*.*$",
            r"^\s*sec:\s*-?\d+\s*$",
            r"^\s*nanosec:\s*-?\d+\s*$",
        )
    )
    if not header_complete or not include_camera_intrinsics:
        return header_complete
    matrix = re.search(
        r"^\s*k:\s*\n((?:\s*-\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s*\n){9})",
        text,
        re.MULTILINE,
    )
    return matrix is not None


def _read_topic_sample(ros_prefix, topic_name, runner=None, timeout=2.0, include_camera_intrinsics=False):
    """Read only the first useful portion of a ROS topic echo without CLI flags."""
    if not ROS_TOPIC_PATTERN.fullmatch(topic_name):
        return None, "ROS topic name is invalid."
    command = ros_prefix + [
        "topic",
        "echo",
        topic_name,
        "--qos-reliability",
        "best_effort",
        "--qos-durability",
        "volatile",
    ]
    if runner is not None:
        return _run(command, timeout=timeout, runner=runner)

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
    except OSError as error:
        return None, str(error)

    output = bytearray()
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline and len(output) < MAX_TOPIC_SAMPLE_BYTES:
            events = selector.select(max(0, deadline - time.monotonic()))
            if not events:
                break
            chunk = os.read(process.stdout.fileno(), min(4096, MAX_TOPIC_SAMPLE_BYTES - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            text = output.decode("utf-8", errors="replace")
            if _topic_sample_complete(text, include_camera_intrinsics):
                return text, None
    finally:
        selector.close()
        if process.poll() is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                process.wait()
        if process.stdout:
            process.stdout.close()

    text = output.decode("utf-8", errors="replace")
    if _topic_sample_complete(text, include_camera_intrinsics):
        return text, None
    if len(output) >= MAX_TOPIC_SAMPLE_BYTES:
        return None, "ROS topic sample exceeded the bounded read size before its header was complete."
    return None, "No complete ROS topic sample arrived before the discovery timeout."


def _read_os_release(path="/etc/os-release"):
    values = {}
    try:
        with open(path, encoding="utf-8") as source:
            lines = source.read().splitlines()
    except OSError as error:
        return values, "Could not read operating system metadata: {}".format(error)
    for line in lines:
        if "=" not in line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        try:
            parsed = shlex.split(value, posix=True)
        except ValueError:
            continue
        values[key] = parsed[0] if parsed else ""
    return values, None


def _read_saved_environment(path):
    values = {}
    try:
        with open(path, encoding="utf-8") as source:
            lines = source.read().splitlines()
    except FileNotFoundError:
        return values, None
    except OSError as error:
        return values, "Could not read saved LiDAR configuration: {}".format(error)
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values, None


def _ros_prefix(env, which=shutil.which):
    executable = which("ros2")
    if executable:
        return [executable], env.get("ROS_DISTRO", "unknown"), None
    ros_root = "/opt/ros"
    if not os.path.isdir(ros_root):
        return None, None, "ROS 2 CLI is unavailable."
    try:
        distros = sorted(
            name
            for name in os.listdir(ros_root)
            if os.path.isfile(os.path.join(ros_root, name, "setup.bash"))
        )
    except OSError as error:
        return None, None, "Could not inspect ROS installations: {}".format(error)
    if not distros:
        return None, None, "ROS 2 CLI is unavailable."
    distro = env.get("ROS_DISTRO")
    if distro not in distros:
        distro = distros[0]
    setup_file = os.path.join(ros_root, distro, "setup.bash")
    command = [
        "bash",
        "-c",
        'source "$1" >/dev/null 2>&1 && shift && exec ros2 "$@"',
        "sensor-discovery",
        setup_file,
    ]
    return command, distro, None


def _parse_topic_list(text):
    topics = []
    for line in text.splitlines():
        match = re.match(r"^\s*(/\S+)\s+\[([^\]]+)\]\s*$", line)
        if match:
            topics.append({"name": match.group(1), "type": match.group(2)})
    return topics


def _parse_pointcloud_header(text, now_seconds):
    frame_match = re.search(r"^\s*frame_id:\s*(.*?)\s*$", text, re.MULTILINE)
    seconds_match = re.search(r"^\s*sec:\s*(-?\d+)\s*$", text, re.MULTILINE)
    nanoseconds_match = re.search(r"^\s*nanosec:\s*(-?\d+)\s*$", text, re.MULTILINE)
    if not frame_match or not seconds_match or not nanoseconds_match:
        return {
            "frame_id": None,
            "fresh": False,
            "age_ms": None,
            "error": "Could not read frame and acquisition timestamp from the PointCloud2 header.",
        }
    frame_id = frame_match.group(1).strip().strip("\"'")
    seconds = int(seconds_match.group(1))
    nanoseconds = int(nanoseconds_match.group(1))
    if not frame_id or seconds < 0 or not 0 <= nanoseconds < 1_000_000_000:
        return {
            "frame_id": frame_id or None,
            "fresh": False,
            "age_ms": None,
            "error": "PointCloud2 header has an invalid frame or timestamp.",
        }
    timestamp = seconds + nanoseconds / 1_000_000_000
    if timestamp <= 0:
        return {
            "frame_id": frame_id,
            "fresh": False,
            "age_ms": None,
            "error": "PointCloud2 acquisition timestamp is missing.",
        }
    age = now_seconds - timestamp
    if age < -MAX_FUTURE_SKEW_SECONDS:
        error = "PointCloud2 acquisition timestamp is in the future."
    elif age > MAX_SAMPLE_AGE_SECONDS:
        error = "PointCloud2 sample is stale ({:.0f} ms old; maximum is {:.0f} ms).".format(
            age * 1000,
            MAX_SAMPLE_AGE_SECONDS * 1000,
        )
    else:
        error = None
    return {
        "frame_id": frame_id,
        "fresh": error is None,
        "age_ms": max(0, round(age * 1000)),
        "error": error,
    }


def _discover_interfaces(runner, ip_executable):
    if not ip_executable:
        return [], "The ip command is unavailable; active sensor-network interfaces cannot be inspected."
    output, error = _run([ip_executable, "-4", "-j", "address", "show", "up"], runner=runner)
    if error:
        return [], "Could not inspect active IPv4 interfaces: {}".format(error)
    try:
        raw_interfaces = json.loads(output)
    except (TypeError, ValueError) as error:
        return [], "Could not parse active IPv4 interfaces: {}".format(error)
    interfaces = []
    for raw in raw_interfaces:
        addresses = []
        for item in raw.get("addr_info", []):
            if item.get("family") != "inet":
                continue
            try:
                address = ipaddress.IPv4Interface(
                    "{}/{}".format(item["local"], item["prefixlen"])
                )
            except (KeyError, ipaddress.AddressValueError, ValueError):
                continue
            if not address.ip.is_loopback:
                addresses.append(str(address))
        if addresses:
            interfaces.append({"name": raw.get("ifname", ""), "addresses": addresses})
    return interfaces, None


def _discover_services(runner, systemctl_executable):
    services = {}
    if not systemctl_executable:
        return services, ["The systemctl command is unavailable; service state could not be checked."]
    diagnostics = []
    for scope, scope_args in (
        ("system", []),
        ("user", ["--user"]),
    ):
        for service in ("uni-edu-lidar-driver.service", "uni-edu-lidar-provider.service"):
            command = [systemctl_executable] + scope_args + [
                "show",
                "--property=ActiveState",
                "--value",
                service,
            ]
            output, error = _run(command, runner=runner)
            state = output.strip() if not error and output else "unknown"
            if state not in {
                "active",
                "reloading",
                "inactive",
                "failed",
                "activating",
                "deactivating",
                "maintenance",
            }:
                detail = error or (output or "").strip() or "unrecognized service state"
                state = "unknown"
                diagnostics.append(
                    "Could not inspect {} {}: {}".format(scope, service, detail)
                )
            services["{}:{}".format(scope, service)] = state
    return services, diagnostics


def _discover_driver_processes(proc_root="/proc"):
    processes = []
    try:
        entries = os.scandir(proc_root)
    except OSError as error:
        return processes, ["Could not inspect running processes for an existing Livox driver: {}".format(error)]
    with entries:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                with open(os.path.join(entry.path, "cmdline"), "rb") as command_line:
                    arguments = command_line.read().decode("utf-8", "replace").split("\0")
            except OSError:
                continue
            if not any("livox_ros_driver2" in argument.lower() for argument in arguments):
                continue
            executable = os.path.basename(arguments[0]) if arguments and arguments[0] else "unknown"
            processes.append({"pid": entry.name, "executable": executable})
    return processes, []


def discover_sensors(
    env=None,
    runner=None,
    now_seconds=None,
    os_release_path="/etc/os-release",
    ros2_executable=None,
    ip_executable=None,
    systemctl_executable=None,
    proc_root="/proc",
):
    environment = dict(os.environ if env is None else env)
    config_home = environment.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config"
    )
    saved_path = os.path.join(
        config_home,
        "uni-edu-studio",
        "lidar.env",
    )
    saved, saved_error = _read_saved_environment(saved_path)
    host_ip = environment.get("G1_LIDAR_HOST_IP") or saved.get("G1_LIDAR_HOST_IP", "")
    device_ip = environment.get("G1_LIDAR_DEVICE_IP") or saved.get("G1_LIDAR_DEVICE_IP", "")

    os_release, os_error = _read_os_release(os_release_path)
    ip_executable = ip_executable or shutil.which("ip")
    systemctl_executable = systemctl_executable or shutil.which("systemctl")
    interfaces, interface_error = _discover_interfaces(runner, ip_executable)

    host_interface = None
    device_network_matches = False
    network_error = None
    try:
        host_address = ipaddress.IPv4Address(host_ip) if host_ip else None
        device_address = ipaddress.IPv4Address(device_ip) if device_ip else None
        if host_address is not None:
            for interface in interfaces:
                for value in interface["addresses"]:
                    current = ipaddress.IPv4Interface(value)
                    if current.ip == host_address:
                        host_interface = interface["name"]
                        if device_address is not None and device_address in current.network:
                            device_network_matches = True
        if host_ip and host_interface is None:
            network_error = "Configured MID-360 host address {} is not assigned to an active interface.".format(
                host_ip
            )
        elif host_ip and device_ip and host_interface and not device_network_matches:
            network_error = "Configured MID-360 device address {} is not on the active subnet for {}.".format(
                device_ip,
                host_ip,
            )
        elif not host_ip or not device_ip:
            network_error = (
                "Direct Livox setup needs a verified host NIC address and MID-360 address; "
                "neither value will be guessed."
            )
    except ipaddress.AddressValueError as error:
        network_error = "Configured MID-360 network address is invalid: {}".format(error)

    ros_prefix = [ros2_executable] if ros2_executable else None
    ros_distro = environment.get("ROS_DISTRO", "unknown")
    ros_error = None
    if ros_prefix is None:
        ros_prefix, ros_distro, ros_error = _ros_prefix(environment)
    ros_distro = ros_distro or "unknown"
    topics = []
    pointclouds = []
    ros_topics_error = ros_error
    current_time = time.time() if now_seconds is None else now_seconds
    if ros_prefix is not None:
        topic_output, command_error = _run(
            ros_prefix + ["topic", "list", "-t"],
            timeout=3.0,
            runner=runner,
        )
        if command_error:
            ros_topics_error = "Could not inspect ROS 2 topics: {}".format(command_error)
        else:
            topics = _parse_topic_list(topic_output)
            for topic in topics:
                if (
                    topic["type"] != POINTCLOUD_TYPE
                    or not LIDAR_NAME_PATTERN.search(topic["name"])
                ):
                    continue
                header_output, header_error = _read_topic_sample(
                    ros_prefix,
                    topic["name"],
                    runner=runner,
                    timeout=2.0,
                )
                sample = (
                    _parse_pointcloud_header(header_output, current_time)
                    if not header_error
                    else {
                        "frame_id": None,
                        "fresh": False,
                        "age_ms": None,
                        "error": "Could not read PointCloud2 header: {}".format(header_error),
                    }
                )
                pointclouds.append(dict(topic, **sample))

    services, service_diagnostics = _discover_services(runner, systemctl_executable)
    driver_processes, process_diagnostics = _discover_driver_processes(proc_root)
    active_driver = any(
        state == "active" and key.endswith(":uni-edu-lidar-driver.service")
        for key, state in services.items()
    ) or bool(driver_processes)
    matching_pointclouds = [
        sample for sample in pointclouds if LIDAR_NAME_PATTERN.search(sample["name"])
    ]
    fresh_pointclouds = [sample for sample in matching_pointclouds if sample["fresh"]]
    sensor_named_topics = [
        topic for topic in topics if LIDAR_NAME_PATTERN.search(topic["name"])
    ]
    pointcloud_topics = [
        topic for topic in topics if topic["type"] == POINTCLOUD_TYPE
    ]
    saved_topic_name = saved.get("G1_LIDAR_TOPIC", "").strip()
    saved_sensor_frame = saved.get("G1_DISTANCE_FRAME_ID", "").strip()
    saved_pointcloud = next(
        (
            topic
            for topic in sensor_named_topics
            if topic["name"] == saved_topic_name
            and topic["type"] == POINTCLOUD_TYPE
        ),
        None,
    )

    if len(fresh_pointclouds) == 1:
        selected = fresh_pointclouds[0]
        unitree_name = re.search(r"unitree|utlidar", selected["name"], re.IGNORECASE)
        method = "unitree_ros_pointcloud" if unitree_name else "existing_ros_pointcloud"
        connection = {
            "method": method,
            "ready": True,
            "driver_required": False,
            "sensor_id": "unitree-lidar" if unitree_name else "ros-pointcloud",
            "topic": selected["name"],
            "message_type": selected["type"],
            "frame_id": selected["frame_id"],
            "reason": "A fresh ROS 2 PointCloud2 stream was detected; no Livox driver will be started.",
        }
    elif len(fresh_pointclouds) > 1:
        connection = {
            "method": "ambiguous",
            "ready": False,
            "driver_required": False,
            "reason": "Multiple fresh LiDAR PointCloud2 streams were detected; select the intended source explicitly.",
        }
    elif saved_pointcloud and saved_sensor_frame:
        connection = {
            "method": "existing_ros_pointcloud_unverified",
            "ready": False,
            "driver_required": False,
            "sensor_id": saved.get("G1_DISTANCE_SENSOR_ID", "mid360-front"),
            "topic": saved_pointcloud["name"],
            "message_type": saved_pointcloud["type"],
            "frame_id": saved_sensor_frame,
            "reason": (
                "The saved LiDAR PointCloud2 topic still exists, but no complete fresh "
                "message was received. The existing source can be reused for diagnostics; "
                "distance remains unavailable until live data and calibration are verified."
            ),
        }
    elif sensor_named_topics or pointcloud_topics:
        topic = sensor_named_topics[0] if sensor_named_topics else pointcloud_topics[0]
        connection = {
            "method": "unsupported_existing_sensor_topic",
            "ready": False,
            "driver_required": False,
            "topic": topic["name"],
            "message_type": topic["type"],
            "reason": (
                "A LiDAR-named ROS topic exists, but no fresh compatible "
                "sensor_msgs/msg/PointCloud2 stream was verified."
                if sensor_named_topics
                else "A PointCloud2 stream exists, but its LiDAR identity is ambiguous; no driver will be started."
            ),
        }
    elif active_driver:
        connection = {
            "method": "existing_driver",
            "ready": False,
            "driver_required": False,
            "sensor_id": saved.get("G1_DISTANCE_SENSOR_ID", "mid360-front"),
            "processes": driver_processes,
            "reason": "A Uni-EDU LiDAR driver service/process is already active; it will not be duplicated. No fresh compatible PointCloud2 stream was verified.",
        }
    elif host_interface and device_network_matches:
        connection = {
            "method": "direct_livox",
            "ready": False,
            "driver_required": True,
            "sensor_id": "mid360-front",
            "host_interface": host_interface,
            "host_ip": host_ip,
            "device_ip": device_ip,
            "reason": "The configured MID-360 network is valid; the direct Livox driver can be installed, but sensor presence is not yet verified.",
        }
    else:
        connection = {
            "method": "unavailable",
            "ready": False,
            "driver_required": False,
            "reason": network_error or "No supported fresh LiDAR point-cloud source was detected.",
        }

    diagnostics = []
    if saved_error:
        diagnostics.append(saved_error)
    if os_error:
        diagnostics.append(os_error)
    if interface_error:
        diagnostics.append(interface_error)
    if ros_topics_error:
        diagnostics.append(ros_topics_error)
    diagnostics.extend(service_diagnostics)
    diagnostics.extend(process_diagnostics)
    diagnostics.extend(sample["error"] for sample in pointclouds if sample["error"])

    return {
        "platform": {
            "os_id": os_release.get("ID", "unknown"),
            "os_version": os_release.get("VERSION_ID", "unknown"),
            "architecture": platform.machine(),
            "ros_distro": ros_distro,
        },
        "network": {
            "interfaces": interfaces,
            "host_ip": host_ip or None,
            "device_ip": device_ip or None,
            "host_interface": host_interface,
            "direct_network_valid": bool(host_interface and device_network_matches),
            "error": network_error or interface_error,
        },
        "services": services,
        "driver_processes": driver_processes,
        "ros": {
            "available": ros_prefix is not None and ros_topics_error is None,
            "topics": topics,
            "pointclouds": pointclouds,
            "error": ros_topics_error,
        },
        "connection": connection,
        "diagnostics": diagnostics,
    }


def main():
    report = discover_sensors()
    print(json.dumps(report, indent=2, sort_keys=True))
    connection = report["connection"]
    return 0 if connection["ready"] or connection["driver_required"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
