#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROS_WS="${G1_LIDAR_ROS_WS:-$HOME/uni-edu-lidar-ws}"
STATE_WS="${G1_LIDAR_STATE_WS:-$HOME/uni-edu-g1-state-ws}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/uni-edu-studio"
CONFIG_FILE="$CONFIG_DIR/MID360_config.json"
ENV_FILE="$CONFIG_DIR/lidar.env"
INSTALL_MARKER="$CONFIG_DIR/lidar-installed"
USER_UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$CONFIG_DIR"

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot identify the host operating system; stopping without installing ROS." >&2
  exit 1
fi
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "Automatic LiDAR setup supports Ubuntu 20.04 or 22.04. Detected ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi
case "${VERSION_ID:-}" in
  20.04) ROS_DISTRO_REQUIRED="humble"; ROS_RUNTIME="container" ;;
  22.04) ROS_DISTRO_REQUIRED="humble"; ROS_RUNTIME="host"; ROS_UBUNTU_CODENAME="jammy" ;;
  *)
    echo "Automatic LiDAR setup supports Ubuntu 20.04 with ROS 2 Humble in a container, or Ubuntu 22.04 with ROS 2 Humble. Detected ${PRETTY_NAME:-unknown}." >&2
    exit 1
    ;;
esac
if [[ -n "${G1_LIDAR_ROS_DISTRO:-}" && "$G1_LIDAR_ROS_DISTRO" != "$ROS_DISTRO_REQUIRED" ]]; then
  echo "Ubuntu ${VERSION_ID} is configured for ROS 2 ${ROS_DISTRO_REQUIRED^} using runtime '$ROS_RUNTIME', not ${G1_LIDAR_ROS_DISTRO}." >&2
  exit 1
fi
echo "Configuring ROS 2 ${ROS_DISTRO_REQUIRED^} for Ubuntu ${VERSION_ID} using the $ROS_RUNTIME runtime."
if [[ "$ROS_RUNTIME" == "container" ]]; then
  if [[ "$PROJECT_DIR$CONFIG_FILE$ENV_FILE" =~ [[:space:]] ]]; then
    echo "Container setup requires project and configuration paths without whitespace." >&2
    exit 1
  fi
fi
ARCH="$(dpkg --print-architecture)"
if [[ "$ARCH" != "amd64" && "$ARCH" != "arm64" ]]; then
  echo "Unsupported Ubuntu architecture for this installer: $ARCH" >&2
  exit 1
fi

SAVED_HOST_IP=""
SAVED_DEVICE_IP=""
SAVED_BASE_FRAME=""
SAVED_FRONT_EXTENT=""
SAVED_REAR_EXTENT=""
SAVED_HALF_WIDTH=""
SAVED_LIDAR_TOPIC=""
SAVED_SENSOR_FRAME=""
SAVED_MOUNT_CONFIRMED=""
SAVED_SENSOR_ID=""
SAVED_EXTRA_POINTCLOUD_SOURCES_JSON=""
SAVED_CAMERA_TOPICS_JSON=""
SAVED_PUBLISH_FREQ=""
SAVED_AXIS_CONFIRMED=""
SAVED_CALIBRATION_CONFIRMED=""
if [[ -f "$ENV_FILE" ]]; then
  SAVED_HOST_IP="$(awk -F= '$1 == "G1_LIDAR_HOST_IP" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_DEVICE_IP="$(awk -F= '$1 == "G1_LIDAR_DEVICE_IP" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_BASE_FRAME="$(awk -F= '$1 == "G1_DISTANCE_BASE_FRAME" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_FRONT_EXTENT="$(awk -F= '$1 == "G1_DISTANCE_FOOTPRINT_FRONT_M" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_REAR_EXTENT="$(awk -F= '$1 == "G1_DISTANCE_FOOTPRINT_REAR_M" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_HALF_WIDTH="$(awk -F= '$1 == "G1_DISTANCE_FOOTPRINT_HALF_WIDTH_M" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_LIDAR_TOPIC="$(awk -F= '$1 == "G1_LIDAR_TOPIC" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_SENSOR_FRAME="$(awk -F= '$1 == "G1_DISTANCE_FRAME_ID" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_MOUNT_CONFIRMED="$(awk -F= '$1 == "G1_LIDAR_MOUNT_CONFIRMED" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_SENSOR_ID="$(awk -F= '$1 == "G1_DISTANCE_SENSOR_ID" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_EXTRA_POINTCLOUD_SOURCES_JSON="$(awk -F= '$1 == "G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_CAMERA_TOPICS_JSON="$(awk -F= '$1 == "G1_CAMERA_TOPICS_JSON" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_PUBLISH_FREQ="$(awk -F= '$1 == "G1_LIDAR_PUBLISH_FREQ" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_AXIS_CONFIRMED="$(awk -F= '$1 == "G1_LIDAR_AXIS_CONFIRMED" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
  SAVED_CALIBRATION_CONFIRMED="$(awk -F= '$1 == "G1_DISTANCE_CALIBRATION_CONFIRMED" {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
fi
DISCOVERY_STATUS=0
if DISCOVERY_JSON="$(python3 "$PROJECT_DIR/backend/sensor_discovery.py")"; then
  :
else
  DISCOVERY_STATUS=$?
fi
if [[ -z "$DISCOVERY_JSON" ]]; then
  echo "Sensor discovery failed before producing diagnostics." >&2
  exit 1
fi
discovery_value() {
  printf '%s' "$DISCOVERY_JSON" | python3 -c '
import json
import sys

value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value.get(key) if isinstance(value, dict) else None
if isinstance(value, bool):
    print("1" if value else "0")
elif value is not None:
    print(value)
' "$1"
}
CONNECTION_METHOD="$(discovery_value connection.method)"
CONNECTION_REASON="$(discovery_value connection.reason)"
DRIVER_REQUIRED="$(discovery_value connection.driver_required)"
DISCOVERED_TOPIC="$(discovery_value connection.topic)"
DISCOVERED_FRAME="$(discovery_value connection.frame_id)"
DISCOVERED_SENSOR_ID="$(discovery_value connection.sensor_id)"
G1_LIDAR_HOST_IP="${G1_LIDAR_HOST_IP:-${SAVED_HOST_IP:-$(discovery_value network.host_ip)}}"
G1_LIDAR_DEVICE_IP="${G1_LIDAR_DEVICE_IP:-${SAVED_DEVICE_IP:-$(discovery_value network.device_ip)}}"
G1_LIDAR_TOPIC="${G1_LIDAR_TOPIC:-${SAVED_LIDAR_TOPIC:-$DISCOVERED_TOPIC}}"
G1_DISTANCE_SENSOR_ID="${G1_DISTANCE_SENSOR_ID:-${DISCOVERED_SENSOR_ID:-${SAVED_SENSOR_ID:-mid360-front}}}"
G1_LIDAR_LOWSTATE_TOPIC="${G1_LIDAR_LOWSTATE_TOPIC:-/lowstate}"
G1_LIDAR_MOUNT_CONFIRMED="${G1_LIDAR_MOUNT_CONFIRMED:-${SAVED_MOUNT_CONFIRMED:-0}}"
G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON="${G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON:-${SAVED_EXTRA_POINTCLOUD_SOURCES_JSON:-[]}}"
CAMERA_DISCOVERY_JSON="$(PYTHONPATH="$PROJECT_DIR/backend" python3 -c 'import json; from camera_discovery import discover_camera_sources; print(json.dumps(discover_camera_sources()))' 2>/dev/null || printf '{}')"
DISCOVERED_CAMERA_TOPICS_JSON="$(printf '%s' "$CAMERA_DISCOVERY_JSON" | python3 -c '
import json
import sys

report = json.load(sys.stdin)
topics = []
for source in report.get("sources", {}).values():
  for topic in source.get("image_topics", []):
    if topic.get("fresh") and topic.get("frame_id") and topic.get("type") == "sensor_msgs/msg/Image":
      topics.append({"topic": topic["name"], "frame_id": topic["frame_id"]})
print(json.dumps(topics[:8], separators=(",", ":")))
')"
G1_CAMERA_TOPICS_JSON="${G1_CAMERA_TOPICS_JSON:-${SAVED_CAMERA_TOPICS_JSON:-$DISCOVERED_CAMERA_TOPICS_JSON}}"
G1_LIDAR_PUBLISH_FREQ="${G1_LIDAR_PUBLISH_FREQ:-${SAVED_PUBLISH_FREQ:-20.0}}"
CALIBRATION_MODEL_JSON="$(
  PYTHONPATH="$PROJECT_DIR/backend" python3 -c \
    'import json; from sensor_calibration import automatic_calibration_model; print(json.dumps(automatic_calibration_model()))'
)"
model_value() {
  printf '%s' "$CALIBRATION_MODEL_JSON" | python3 -c '
import json
import sys

value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value.get(key) if isinstance(value, dict) else None
if value is None:
    raise SystemExit("Automatic G1 calibration model is missing " + sys.argv[1])
print(value)
' "$1"
}
MODEL_SENSOR_FRAME="$(model_value mount.sensor_frame)"
MODEL_ROOT_FRAME="$(model_value root_frame)"
if [[ -n "${G1_DISTANCE_BASE_FRAME:-}" ]]; then
  :
elif [[ -n "$SAVED_BASE_FRAME" && "$SAVED_BASE_FRAME" != "base_link" ]]; then
  G1_DISTANCE_BASE_FRAME="$SAVED_BASE_FRAME"
else
  G1_DISTANCE_BASE_FRAME="$MODEL_ROOT_FRAME"
  if [[ "$SAVED_BASE_FRAME" == "base_link" ]]; then
    echo "Migrating the unsupported saved base_link distance frame to the supported model root $MODEL_ROOT_FRAME."
  fi
fi
if [[ "$G1_DISTANCE_BASE_FRAME" != "$MODEL_ROOT_FRAME" ]]; then
  echo "G1_DISTANCE_BASE_FRAME must be the supported G1 model root '$MODEL_ROOT_FRAME' for footprint-relative distance readings." >&2
  exit 1
fi
if [[ "$CONNECTION_METHOD" == "direct_livox" ]]; then
  G1_DISTANCE_FRAME_ID="${G1_DISTANCE_FRAME_ID:-$MODEL_SENSOR_FRAME}"
else
  G1_DISTANCE_FRAME_ID="${G1_DISTANCE_FRAME_ID:-${DISCOVERED_FRAME:-${SAVED_SENSOR_FRAME:-$MODEL_SENSOR_FRAME}}}"
fi
AXIS_CONFIRMED=1
CALIBRATION_CONFIRMED=1
FRONT_EXTENT_M="$(model_value footprint.front)"
REAR_EXTENT_M="$(model_value footprint.rear)"
HALF_WIDTH_M="$(model_value footprint.half_width)"

echo "Sensor discovery method: $CONNECTION_METHOD"
echo "Sensor discovery: $CONNECTION_REASON"
python3 - "$DISCOVERY_JSON" <<'PY'
import json
import sys

report = json.loads(sys.argv[1])
for diagnostic in report["diagnostics"]:
    print("Discovery diagnostic: {}".format(diagnostic), file=sys.stderr)
for topic in report["ros"]["pointclouds"]:
    state = "fresh" if topic["fresh"] else "unavailable"
    print(
        "PointCloud2 {}: topic={}, type={}, frame={}, age_ms={}, diagnostic={}".format(
            state,
            topic["name"],
            topic["type"],
            topic["frame_id"],
            topic["age_ms"],
            topic["error"],
        )
    )
PY

if [[ "$CONNECTION_METHOD" != "direct_livox" &&
      "$CONNECTION_METHOD" != "existing_ros_pointcloud" &&
      "$CONNECTION_METHOD" != "existing_ros_pointcloud_unverified" &&
      "$CONNECTION_METHOD" != "unitree_ros_pointcloud" &&
      "$CONNECTION_METHOD" != "existing_driver" ]]; then
  echo "LiDAR setup stopped: $CONNECTION_REASON" >&2
  if [[ "$DISCOVERY_STATUS" != "0" ]]; then
    echo "Run backend/sensor_discovery.py for full diagnostics." >&2
  fi
  exit 1
fi
if [[ "$CONNECTION_METHOD" == "existing_driver" &&
      ( -z "$G1_LIDAR_TOPIC" || -z "$G1_DISTANCE_FRAME_ID" ) ]]; then
  echo "An existing driver is active, but its saved PointCloud2 topic/frame are unavailable. No second driver will be started." >&2
  exit 1
fi
if [[ "$CONNECTION_METHOD" == "direct_livox" ]]; then
  if [[ -z "$G1_LIDAR_HOST_IP" || -z "$G1_LIDAR_DEVICE_IP" ]]; then
    echo "Direct Livox setup requires verified host and device addresses. Set G1_LIDAR_HOST_IP and G1_LIDAR_DEVICE_IP; defaults will not be guessed." >&2
    exit 1
  fi
  if [[ "$ROS_RUNTIME" == "host" && -e "$ROS_WS" && ! -f "$ROS_WS/.uni-edu-lidar-workspace" ]]; then
    if [[ -n "$(find "$ROS_WS" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
      echo "Refusing to use non-empty ROS workspace without this installer's ownership marker: $ROS_WS" >&2
      echo "Set G1_LIDAR_ROS_WS to a new, dedicated workspace directory." >&2
      exit 1
    fi
  fi
  if [[ "$ROS_RUNTIME" == "host" ]]; then
    mkdir -p "$ROS_WS/src"
    touch "$ROS_WS/.uni-edu-lidar-workspace"
    if [[ -n "$(find "$ROS_WS/src" -mindepth 1 -maxdepth 1 ! -name livox_ros_driver2 -print -quit)" ]]; then
      echo "The dedicated LiDAR workspace contains another ROS package; refusing to let the Livox build script clear its build/install directories." >&2
      exit 1
    fi
  fi
elif [[ -z "$G1_LIDAR_TOPIC" || -z "$G1_DISTANCE_FRAME_ID" ]]; then
  echo "A compatible existing LiDAR stream was detected, but its topic or frame is not available. No duplicate Livox driver will be started." >&2
  exit 1
fi

if [[ ! "$G1_LIDAR_TOPIC" =~ ^/[A-Za-z0-9_/-]+$ ]]; then
  echo "Discovered/configured LiDAR topic is not a valid fully qualified ROS topic name." >&2
  exit 1
fi
for address in "$G1_LIDAR_HOST_IP" "$G1_LIDAR_DEVICE_IP"; do
  if [[ -n "$address" ]] &&
     ! python3 -c 'import ipaddress, sys; ipaddress.IPv4Address(sys.argv[1])' "$address" >/dev/null 2>&1; then
    echo "Configured sensor-network addresses must be valid IPv4 addresses." >&2
    exit 1
  fi
done
if [[ ! "$G1_DISTANCE_FRAME_ID" =~ ^[A-Za-z][A-Za-z0-9_/]*$ ]]; then
  echo "Discovered/configured LiDAR frame ID is not a valid ROS frame name." >&2
  exit 1
fi
if [[ ! "$G1_LIDAR_LOWSTATE_TOPIC" =~ ^/[A-Za-z][A-Za-z0-9_/]*$ ]]; then
  echo "G1_LIDAR_LOWSTATE_TOPIC must be a fully qualified ROS topic name." >&2
  exit 1
fi
if [[ -n "$G1_DISTANCE_BASE_FRAME" && ! "$G1_DISTANCE_BASE_FRAME" =~ ^[A-Za-z][A-Za-z0-9_/]*$ ]]; then
  echo "Configured robot base frame is not a valid ROS frame name." >&2
  exit 1
fi
if [[ ! "$G1_DISTANCE_SENSOR_ID" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
  echo "Configured sensor ID contains invalid characters." >&2
  exit 1
fi
G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON="$(
  PYTHONPATH="$PROJECT_DIR/backend" python3 - \
    "$G1_LIDAR_TOPIC" "$G1_DISTANCE_SENSOR_ID" "$G1_DISTANCE_FRAME_ID" \
    "$G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON" <<'PY'
import json
import sys

from ros_lidar_provider import parse_pointcloud_source_specs

sources = parse_pointcloud_source_specs(*sys.argv[1:])
print(json.dumps(sources[1:], separators=(",", ":")))
PY
)"
G1_CAMERA_TOPICS_JSON="$(
  PYTHONPATH="$PROJECT_DIR/backend" python3 - "$G1_CAMERA_TOPICS_JSON" <<'PY'
import json
import sys

from ros_lidar_provider import parse_camera_source_specs

print(json.dumps(parse_camera_source_specs(sys.argv[1]), separators=(",", ":")))
PY
)"
if [[ "$AXIS_CONFIRMED" != "0" && "$AXIS_CONFIRMED" != "1" ]] ||
   [[ "$CALIBRATION_CONFIRMED" != "0" && "$CALIBRATION_CONFIRMED" != "1" ]] ||
   [[ "$G1_LIDAR_MOUNT_CONFIRMED" != "0" && "$G1_LIDAR_MOUNT_CONFIRMED" != "1" ]]; then
  echo "Calibration and physical mount confirmation settings must be either 0 or 1." >&2
  exit 1
fi
for value in "$FRONT_EXTENT_M" "$REAR_EXTENT_M" "$HALF_WIDTH_M"; do
  if [[ -n "$value" ]] &&
     ! python3 -c 'import math, sys; value = float(sys.argv[1]); sys.exit(0 if math.isfinite(value) and value > 0 else 1)' "$value" >/dev/null 2>&1; then
    echo "Configured footprint dimensions must be finite positive meters." >&2
    exit 1
  fi
done
if [[ "$CALIBRATION_CONFIRMED" == "1" ]]; then
  if [[ "$AXIS_CONFIRMED" != "1" || -z "$G1_DISTANCE_BASE_FRAME" ]]; then
    echo "Distance calibration cannot be enabled without confirmed axis alignment and an explicit base frame." >&2
    exit 1
  fi
  for value in "$FRONT_EXTENT_M" "$REAR_EXTENT_M" "$HALF_WIDTH_M"; do
    if ! python3 -c 'import math, sys; value = float(sys.argv[1]); sys.exit(0 if math.isfinite(value) and value > 0 else 1)' "$value" >/dev/null 2>&1; then
      echo "Confirmed distance calibration requires saved or explicit positive footprint dimensions in meters; no measurements are guessed." >&2
      exit 1
    fi
  done
fi
if ! python3 -c 'import math, sys; value = float(sys.argv[1]); sys.exit(0 if math.isfinite(value) and 0.5 <= value <= 100 else 1)' "$G1_LIDAR_PUBLISH_FREQ" >/dev/null 2>&1; then
  echo "G1_LIDAR_PUBLISH_FREQ must be a finite value between 0.5 and 100 Hz." >&2
  exit 1
fi
if [[ "$ROS_RUNTIME" == "container" && "$DRIVER_REQUIRED" == "1" &&
      "$PROJECT_DIR$CONFIG_FILE$ENV_FILE" =~ [[:space:]] ]]; then
  echo "Container setup requires project and configuration paths without whitespace." >&2
  exit 1
fi

if [[ "$ROS_RUNTIME" == "container" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Installing Ubuntu's Docker engine package. This requires sudo and does not change the JetPack image."
    sudo apt-get update
    sudo apt-get install -y docker.io
  fi
  sudo systemctl enable --now docker
  if ! sudo docker info >/dev/null 2>&1; then
    echo "Docker is installed but its daemon is unavailable." >&2
    exit 1
  fi
  DOCKER_ROOT="$(sudo docker info --format '{{.DockerRootDir}}')"
  AVAILABLE_BYTES="$(df -PB1 "$DOCKER_ROOT" | awk 'NR == 2 {print $4}')"
  if [[ ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]] || (( AVAILABLE_BYTES < 8589934592 )); then
    echo "At least 8 GiB of free space is required on Docker's storage filesystem at $DOCKER_ROOT." >&2
    exit 1
  fi
  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    echo "Building the ROS 2 Humble runtime and required Livox driver; the first build may take several minutes."
  else
    echo "Building the lightweight ROS 2 Humble sensor runtime; reusing the detected ROS point-cloud source without building a Livox driver."
  fi
  sudo docker build --pull=false --build-arg "INSTALL_LIVOX_DRIVER=$DRIVER_REQUIRED" \
    -t uni-edu-lidar-humble:local \
    -f "$PROJECT_DIR/backend/ros/docker/Dockerfile" "$PROJECT_DIR"
else
  if [[ ! -f "/opt/ros/$ROS_DISTRO_REQUIRED/setup.bash" ]]; then
    echo "Installing ROS 2 ${ROS_DISTRO_REQUIRED^} on Ubuntu ${VERSION_ID}. This uses apt and requires sudo."
    sudo apt-get update
    sudo apt-get install -y software-properties-common curl
    sudo add-apt-repository -y universe
    sudo curl -fsSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key \
      -o /usr/share/keyrings/ros-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu $ROS_UBUNTU_CODENAME main" \
      | sudo tee /etc/apt/sources.list.d/ros2.list >/dev/null
    sudo apt-get update
  fi
  sudo apt-get update
  sudo apt-get install -y "ros-${ROS_DISTRO_REQUIRED}-ros-base" \
    "ros-${ROS_DISTRO_REQUIRED}-rmw-cyclonedds-cpp" \
    "ros-${ROS_DISTRO_REQUIRED}-sensor-msgs-py" \
    "ros-${ROS_DISTRO_REQUIRED}-robot-state-publisher" \
    "ros-${ROS_DISTRO_REQUIRED}-rosidl-default-generators" \
    "ros-${ROS_DISTRO_REQUIRED}-rosidl-generator-dds-idl" \
    "ros-${ROS_DISTRO_REQUIRED}-std-msgs" \
    "ros-${ROS_DISTRO_REQUIRED}-tf2-ros" \
    python3-colcon-common-extensions git cmake build-essential

  mkdir -p "$STATE_WS"
  (
    set +u
    source "/opt/ros/$ROS_DISTRO_REQUIRED/setup.bash"
    set -u
    cd "$STATE_WS"
    colcon build --base-paths "$PROJECT_DIR/backend/ros/unitree_hg" \
      --packages-select unitree_hg
  )

  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    if [[ ! -d "$HOME/Livox-SDK2/.git" ]]; then
      git clone --depth 1 https://github.com/Livox-SDK/Livox-SDK2.git "$HOME/Livox-SDK2"
    fi
    cmake -S "$HOME/Livox-SDK2" -B "$HOME/Livox-SDK2/build"
    cmake --build "$HOME/Livox-SDK2/build" --parallel
    sudo cmake --install "$HOME/Livox-SDK2/build"
    sudo ldconfig

    if [[ ! -d "$ROS_WS/src/livox_ros_driver2/.git" ]]; then
      git clone --depth 1 https://github.com/Livox-SDK/livox_ros_driver2.git \
        "$ROS_WS/src/livox_ros_driver2"
    fi
    (
      set +u
      source "/opt/ros/$ROS_DISTRO_REQUIRED/setup.bash"
      set -u
      cd "$ROS_WS/src/livox_ros_driver2"
      ./build.sh humble
    )
  fi
fi

mkdir -p "$CONFIG_DIR" "$USER_UNIT_DIR"
chmod 700 "$CONFIG_DIR"
if [[ "$DRIVER_REQUIRED" == "1" ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    if [[ "$ROS_RUNTIME" == "container" ]]; then
      CONFIG_TEMP="$CONFIG_FILE.tmp.$$"
      if ! sudo docker run --rm uni-edu-lidar-humble:local \
        cat /opt/livox_ws/src/livox_ros_driver2/config/MID360_config.json > "$CONFIG_TEMP"; then
        rm -f "$CONFIG_TEMP"
        exit 1
      fi
      mv "$CONFIG_TEMP" "$CONFIG_FILE"
    else
      cp "$ROS_WS/src/livox_ros_driver2/config/MID360_config.json" "$CONFIG_FILE"
    fi
  fi
  G1_LIDAR_HOST_IP="$G1_LIDAR_HOST_IP" G1_LIDAR_DEVICE_IP="$G1_LIDAR_DEVICE_IP" \
    CONFIG_FILE="$CONFIG_FILE" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["CONFIG_FILE"])
config = json.loads(path.read_text(encoding="utf-8"))
host = os.environ["G1_LIDAR_HOST_IP"]
device = os.environ["G1_LIDAR_DEVICE_IP"]
host_info = config["MID360"]["host_net_info"]
for field in ("cmd_data_ip", "push_msg_ip", "point_data_ip", "imu_data_ip"):
    host_info[field] = host
config["lidar_configs"][0]["ip"] = device
path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
PY
  chmod 600 "$CONFIG_FILE"
fi

TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
SENSOR_URDF_PATH="$PROJECT_DIR/g1_23dof.urdf.txt"
SENSOR_GEOMETRY_PATH="$PROJECT_DIR/vendor/DUET/src/assets/robots/unitree_g1/xmls/g1_23dof.xml"
umask 077
cat > "$ENV_FILE" <<EOF
G1_DISTANCE_PROVIDER_URL=http://127.0.0.1:8181/distance/front
G1_DISTANCE_REAR_PROVIDER_URL=http://127.0.0.1:8181/distance/rear
G1_LIDAR_AXIS_CONFIRMED=$AXIS_CONFIRMED
G1_DISTANCE_CALIBRATION_CONFIRMED=$CALIBRATION_CONFIRMED
G1_DISTANCE_PROVIDER_TOKEN=$TOKEN
G1_DISTANCE_SENSOR_ID=$G1_DISTANCE_SENSOR_ID
G1_DISTANCE_FRAME_ID=$G1_DISTANCE_FRAME_ID
G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON=$G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON
G1_CAMERA_TOPICS_JSON=$G1_CAMERA_TOPICS_JSON
G1_DISTANCE_BASE_FRAME=$G1_DISTANCE_BASE_FRAME
G1_LIDAR_MOUNT_CONFIRMED=$G1_LIDAR_MOUNT_CONFIRMED
G1_LIDAR_LOWSTATE_TOPIC=$G1_LIDAR_LOWSTATE_TOPIC
G1_DISTANCE_FOOTPRINT_FRONT_M=$FRONT_EXTENT_M
G1_DISTANCE_FOOTPRINT_REAR_M=$REAR_EXTENT_M
G1_DISTANCE_FOOTPRINT_HALF_WIDTH_M=$HALF_WIDTH_M
G1_SENSOR_URDF_PATH=$SENSOR_URDF_PATH
G1_SENSOR_GEOMETRY_PATH=$SENSOR_GEOMETRY_PATH
G1_LIDAR_TOPIC=$G1_LIDAR_TOPIC
G1_LIDAR_CONFIG_PATH=$CONFIG_FILE
G1_LIDAR_ROS_WS=$ROS_WS
G1_LIDAR_STATE_WS=$STATE_WS
G1_LIDAR_ROS_DISTRO=$ROS_DISTRO_REQUIRED
G1_LIDAR_ROS_RUNTIME=$ROS_RUNTIME
G1_LIDAR_DRIVER_REQUIRED=$DRIVER_REQUIRED
G1_LIDAR_CONNECTION_METHOD=$CONNECTION_METHOD
G1_LIDAR_HOST_IP=$G1_LIDAR_HOST_IP
G1_LIDAR_DEVICE_IP=$G1_LIDAR_DEVICE_IP
G1_LIDAR_PUBLISH_FREQ=$G1_LIDAR_PUBLISH_FREQ
G1_DISTANCE_PROVIDER_PORT=8181
G1_LIDAR_FORWARD_HALF_ANGLE_DEGREES=15
G1_LIDAR_MINIMUM_HEIGHT_M=-0.5
G1_LIDAR_MAXIMUM_HEIGHT_M=1.5
FASTDDS_BUILTIN_TRANSPORTS=UDPv4
EOF
chmod 600 "$ENV_FILE"

if [[ "$ROS_RUNTIME" == "container" ]]; then
  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    for service in uni-edu-lidar-driver.service uni-edu-lidar-provider.service; do
      if [[ -f "$USER_UNIT_DIR/$service" ]]; then
        if systemctl --user is-active --quiet "$service"; then
          systemctl --user stop "$service"
        fi
        if systemctl --user is-enabled --quiet "$service"; then
          systemctl --user disable "$service"
        fi
      fi
    done
    systemctl --user daemon-reload
    sudo tee /etc/systemd/system/uni-edu-lidar-driver.service >/dev/null <<EOF
[Unit]
Description=Uni EDU MID-360 ROS 2 Humble container
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
  ExecStart=/usr/bin/docker run --rm --name uni-edu-lidar-driver --network host --env-file $ENV_FILE -v $CONFIG_FILE:/config/MID360_config.json:ro uni-edu-lidar-humble:local ros2 launch /opt/uni-edu/ros/mid360_launch.py config_path:=/config/MID360_config.json frame_id:=$G1_DISTANCE_FRAME_ID pointcloud_topic:=$G1_LIDAR_TOPIC publish_freq:=$G1_LIDAR_PUBLISH_FREQ
ExecStop=/usr/bin/docker stop --time 10 uni-edu-lidar-driver
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  fi
  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    PROVIDER_DEPENDENCIES="After=network-online.target docker.service uni-edu-lidar-driver.service
Wants=network-online.target
Requires=docker.service uni-edu-lidar-driver.service"
  else
    PROVIDER_DEPENDENCIES="After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service"
  fi
  sudo tee /etc/systemd/system/uni-edu-lidar-provider.service >/dev/null <<EOF
[Unit]
Description=Uni EDU read-only MID-360 distance provider container
$PROVIDER_DEPENDENCIES

[Service]
Type=simple
ExecStart=/usr/bin/docker run --rm --name uni-edu-lidar-provider --network host --env-file $ENV_FILE --env G1_SENSOR_URDF_PATH=/opt/uni-edu/g1_23dof.urdf.txt --env G1_SENSOR_GEOMETRY_PATH=/opt/uni-edu/g1_23dof.xml uni-edu-lidar-humble:local ros2 launch /opt/uni-edu/ros/g1_sensor_runtime.launch.py
ExecStop=/usr/bin/docker stop --time 10 uni-edu-lidar-provider
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    sudo systemctl enable uni-edu-lidar-driver.service
    sudo systemctl restart uni-edu-lidar-driver.service
  else
    echo "Reusing the detected ROS point-cloud source; no Livox driver service will be started."
  fi
  if [[ "$AXIS_CONFIRMED" == "1" && "$CALIBRATION_CONFIRMED" == "1" ]]; then
    sudo systemctl enable uni-edu-lidar-provider.service
    sudo systemctl restart uni-edu-lidar-provider.service
  else
    sudo systemctl disable uni-edu-lidar-provider.service >/dev/null 2>&1 || true
    sudo systemctl stop uni-edu-lidar-provider.service >/dev/null 2>&1 || true
  fi
else
  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    for service in uni-edu-lidar-driver.service uni-edu-lidar-provider.service; do
      if [[ -f "/etc/systemd/system/$service" ]]; then
        if sudo systemctl is-active --quiet "$service"; then
          sudo systemctl stop "$service"
        fi
        if sudo systemctl is-enabled --quiet "$service"; then
          sudo systemctl disable "$service"
        fi
      fi
    done
    sudo systemctl daemon-reload
    cat > "$USER_UNIT_DIR/uni-edu-lidar-driver.service" <<EOF
[Unit]
Description=Uni EDU MID-360 ROS 2 driver
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$PROJECT_DIR/backend/run_lidar_driver.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  fi
  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    PROVIDER_DEPENDENCIES="Requires=uni-edu-lidar-driver.service
After=uni-edu-lidar-driver.service"
  else
    PROVIDER_DEPENDENCIES="After=network-online.target"
  fi
  cat > "$USER_UNIT_DIR/uni-edu-lidar-provider.service" <<EOF
[Unit]
Description=Uni EDU read-only MID-360 distance provider
$PROVIDER_DEPENDENCIES

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$PROJECT_DIR/backend/run_lidar_provider.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  if [[ "$DRIVER_REQUIRED" == "1" ]]; then
    systemctl --user enable uni-edu-lidar-driver.service
    systemctl --user restart uni-edu-lidar-driver.service
  fi
  if [[ "$AXIS_CONFIRMED" == "1" && "$CALIBRATION_CONFIRMED" == "1" ]]; then
    systemctl --user enable uni-edu-lidar-provider.service
    systemctl --user restart uni-edu-lidar-provider.service
  else
    systemctl --user disable --now uni-edu-lidar-provider.service
  fi
fi

touch "$INSTALL_MARKER"
chmod 600 "$INSTALL_MARKER"
if [[ "$DRIVER_REQUIRED" == "1" ]]; then
  echo "Direct MID-360 Livox driver is configured using ROS 2 $ROS_DISTRO_REQUIRED ($ROS_RUNTIME)."
else
  echo "Using the detected existing ROS point-cloud source; no Livox driver was installed or started."
fi
if [[ "$AXIS_CONFIRMED" == "1" && "$CALIBRATION_CONFIRMED" == "1" ]]; then
  echo "The read-only G1 state bridge and distance provider are configured for the $G1_DISTANCE_BASE_FRAME model root."
else
  echo "Physical distance conditions remain disabled until axis alignment, base transform, and metric footprint calibration are explicitly verified."
fi
if [[ "$G1_LIDAR_MOUNT_CONFIRMED" != "1" ]]; then
  echo "MID-360 mount is not physically confirmed; distance readings use the nominal G1 model mount and are labeled model-derived until checked on hardware."
fi
if [[ "$DRIVER_REQUIRED" == "1" ]]; then
  echo "The configured network was validated, but hardware presence still needs on-device verification. Review $CONFIG_FILE."
fi
echo "The installer enables sensor data only; it does not install or start a ROS locomotion bridge."
