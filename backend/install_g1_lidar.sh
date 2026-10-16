#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROS_WS="${G1_LIDAR_ROS_WS:-$HOME/uni-edu-lidar-ws}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/uni-edu-studio"
CONFIG_FILE="$CONFIG_DIR/MID360_config.json"
ENV_FILE="$CONFIG_DIR/lidar.env"
INSTALL_MARKER="$CONFIG_DIR/lidar-installed"
USER_UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$CONFIG_DIR"
rm -f "$INSTALL_MARKER"

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot identify the host operating system; stopping without installing ROS." >&2
  exit 1
fi
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "Automatic LiDAR setup supports Ubuntu 20.04 with ROS 2 Foxy or Ubuntu 22.04 with ROS 2 Humble. Detected ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi
case "${VERSION_ID:-}" in
  20.04) ROS_DISTRO_REQUIRED="foxy"; ROS_BUILD_ARGUMENT="ROS2"; ROS_UBUNTU_CODENAME="focal" ;;
  22.04) ROS_DISTRO_REQUIRED="humble"; ROS_BUILD_ARGUMENT="humble"; ROS_UBUNTU_CODENAME="jammy" ;;
  *)
    echo "Automatic LiDAR setup supports Ubuntu 20.04 with ROS 2 Foxy or Ubuntu 22.04 with ROS 2 Humble. Detected ${PRETTY_NAME:-unknown}." >&2
    exit 1
    ;;
esac
if [[ -n "${G1_LIDAR_ROS_DISTRO:-}" && "$G1_LIDAR_ROS_DISTRO" != "$ROS_DISTRO_REQUIRED" ]]; then
  echo "Ubuntu ${VERSION_ID} is supported with ROS 2 ${ROS_DISTRO_REQUIRED^}, not ${G1_LIDAR_ROS_DISTRO}." >&2
  exit 1
fi
echo "Configuring ROS 2 ${ROS_DISTRO_REQUIRED^} for Ubuntu ${VERSION_ID}."
if [[ "$ROS_DISTRO_REQUIRED" == "foxy" ]]; then
  echo "ROS 2 Foxy reached end of life in 2023; this uses its Ubuntu 20.04 packages and will not receive upstream security updates." >&2
fi
ARCH="$(dpkg --print-architecture)"
if [[ "$ARCH" != "amd64" && "$ARCH" != "arm64" ]]; then
  echo "Unsupported Ubuntu architecture for this installer: $ARCH" >&2
  exit 1
fi

if [[ -e "$ROS_WS" && ! -f "$ROS_WS/.uni-edu-lidar-workspace" ]]; then
  if [[ -n "$(find "$ROS_WS" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    echo "Refusing to use non-empty ROS workspace without this installer's ownership marker: $ROS_WS" >&2
    echo "Set G1_LIDAR_ROS_WS to a new, dedicated workspace directory." >&2
    exit 1
  fi
fi
mkdir -p "$ROS_WS/src"
touch "$ROS_WS/.uni-edu-lidar-workspace"
if [[ -n "$(find "$ROS_WS/src" -mindepth 1 -maxdepth 1 ! -name livox_ros_driver2 -print -quit)" ]]; then
  echo "The dedicated LiDAR workspace contains another ROS package; refusing to let the Livox build script clear its build/install directories." >&2
  exit 1
fi

read -r -p "IPv4 address of the PC2 NIC physically connected to MID-360: " G1_LIDAR_HOST_IP
read -r -p "MID-360 IPv4 address on that sensor network: " G1_LIDAR_DEVICE_IP
read -r -p "Is the LiDAR x-axis aligned with the robot's forward direction? [y/N] " FORWARD_AXIS_CONFIRMED
if [[ "$FORWARD_AXIS_CONFIRMED" != "y" && "$FORWARD_AXIS_CONFIRMED" != "Y" ]]; then
  echo "Configure and verify the sensor extrinsic transform before enabling distance conditionals." >&2
  exit 1
fi
python3 - "$G1_LIDAR_HOST_IP" "$G1_LIDAR_DEVICE_IP" <<'PY'
import ipaddress
import re
import subprocess
import sys

try:
    host = ipaddress.IPv4Address(sys.argv[1])
    device = ipaddress.IPv4Address(sys.argv[2])
except ipaddress.AddressValueError as error:
    raise SystemExit(f"The Livox host and device addresses must be valid IPv4 addresses: {error}")

try:
    addresses = subprocess.run(
        ["ip", "-4", "-o", "address", "show", "up"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
except (OSError, subprocess.CalledProcessError) as error:
    raise SystemExit(f"Could not inspect active host network addresses with ip: {error}")

host_networks = []
for line in addresses.splitlines():
    match = re.search(r"\binet\s+(\S+)", line)
    if not match:
        continue
    interface = ipaddress.IPv4Interface(match.group(1))
    if interface.ip == host:
        host_networks.append(interface.network)

if not host_networks:
    raise SystemExit(
        f"Host address {host} is not assigned to an active local interface. "
        "Configure and activate the MID-360 NIC before installing the driver."
    )
if not any(device in network for network in host_networks):
    networks = ", ".join(map(str, host_networks))
    raise SystemExit(
        f"MID-360 address {device} is not in the subnet of host address {host} "
        f"({networks}). Verify the NIC and sensor network settings."
    )
PY

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
  python3-colcon-common-extensions git cmake build-essential

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
  source "/opt/ros/$ROS_DISTRO_REQUIRED/setup.bash"
  cd "$ROS_WS/src/livox_ros_driver2"
  ./build.sh "$ROS_BUILD_ARGUMENT"
)

mkdir -p "$CONFIG_DIR" "$USER_UNIT_DIR"
chmod 700 "$CONFIG_DIR"
if [[ ! -f "$CONFIG_FILE" ]]; then
  cp "$ROS_WS/src/livox_ros_driver2/config/MID360_config.json" "$CONFIG_FILE"
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

TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
umask 077
cat > "$ENV_FILE" <<EOF
G1_DISTANCE_PROVIDER_URL=http://127.0.0.1:8181/distance/front
G1_DISTANCE_REAR_PROVIDER_URL=http://127.0.0.1:8181/distance/rear
G1_DISTANCE_PROVIDER_TOKEN=$TOKEN
G1_DISTANCE_SENSOR_ID=mid360-front
G1_DISTANCE_FRAME_ID=livox_frame
G1_LIDAR_TOPIC=/mid360/livox/lidar
G1_LIDAR_CONFIG_PATH=$CONFIG_FILE
G1_LIDAR_ROS_WS=$ROS_WS
G1_LIDAR_ROS_DISTRO=$ROS_DISTRO_REQUIRED
G1_DISTANCE_PROVIDER_PORT=8181
G1_LIDAR_FORWARD_HALF_ANGLE_DEGREES=15
G1_LIDAR_MINIMUM_HEIGHT_M=-0.5
G1_LIDAR_MAXIMUM_HEIGHT_M=1.5
EOF
chmod 600 "$ENV_FILE"

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

cat > "$USER_UNIT_DIR/uni-edu-lidar-provider.service" <<EOF
[Unit]
Description=Uni EDU read-only MID-360 distance provider
Requires=uni-edu-lidar-driver.service
After=uni-edu-lidar-driver.service

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

touch "$INSTALL_MARKER"
chmod 600 "$INSTALL_MARKER"
echo "MID-360 driver and read-only HTTP provider are configured."
echo "Review $CONFIG_FILE and verify the NIC/device addresses before relying on sensor data."
echo "The installer enables sensor data only; it does not install or start a ROS locomotion bridge."
