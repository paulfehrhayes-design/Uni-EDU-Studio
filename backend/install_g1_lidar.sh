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
  echo "Automatic LiDAR setup supports Ubuntu 20.04 or 22.04. Detected ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi
case "${VERSION_ID:-}" in
  20.04)
    if [[ "${G1_LIDAR_ROS_DISTRO:-humble}" == "foxy" ]]; then
      ROS_DISTRO_REQUIRED="foxy"
      ROS_RUNTIME="host"
      ROS_UBUNTU_CODENAME="focal"
    else
      ROS_DISTRO_REQUIRED="humble"
      ROS_RUNTIME="container"
    fi
    ;;
  22.04) ROS_DISTRO_REQUIRED="humble"; ROS_RUNTIME="host"; ROS_UBUNTU_CODENAME="jammy" ;;
  *)
    echo "Automatic LiDAR setup supports Ubuntu 20.04 with ROS 2 Humble in a container (or Foxy natively), or Ubuntu 22.04 with ROS 2 Humble. Detected ${PRETTY_NAME:-unknown}." >&2
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
elif [[ "$ROS_DISTRO_REQUIRED" == "foxy" ]]; then
  echo "ROS 2 Foxy reached end of life in 2023; this uses its Ubuntu 20.04 packages and will not receive upstream security updates." >&2
fi
ARCH="$(dpkg --print-architecture)"
if [[ "$ARCH" != "amd64" && "$ARCH" != "arm64" ]]; then
  echo "Unsupported Ubuntu architecture for this installer: $ARCH" >&2
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
  echo "Building the native-architecture ROS 2 Humble container with the Livox MID-360 driver."
  sudo docker build --pull -t uni-edu-lidar-humble:local \
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
    set +u
    source "/opt/ros/$ROS_DISTRO_REQUIRED/setup.bash"
    set -u
    cd "$ROS_WS/src/livox_ros_driver2"
    ./build.sh "$([[ "$ROS_DISTRO_REQUIRED" == "foxy" ]] && echo ROS2 || echo humble)"
  )
fi

mkdir -p "$CONFIG_DIR" "$USER_UNIT_DIR"
chmod 700 "$CONFIG_DIR"
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
G1_LIDAR_ROS_RUNTIME=$ROS_RUNTIME
G1_DISTANCE_PROVIDER_PORT=8181
G1_LIDAR_FORWARD_HALF_ANGLE_DEGREES=15
G1_LIDAR_MINIMUM_HEIGHT_M=-0.5
G1_LIDAR_MAXIMUM_HEIGHT_M=1.5
EOF
chmod 600 "$ENV_FILE"

if [[ "$ROS_RUNTIME" == "container" ]]; then
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
ExecStart=/usr/bin/docker run --rm --name uni-edu-lidar-driver --network host --env-file $ENV_FILE -v $CONFIG_FILE:/config/MID360_config.json:ro uni-edu-lidar-humble:local ros2 launch /opt/uni-edu/ros/mid360_launch.py config_path:=/config/MID360_config.json frame_id:=livox_frame
ExecStop=/usr/bin/docker stop --time 10 uni-edu-lidar-driver
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  sudo tee /etc/systemd/system/uni-edu-lidar-provider.service >/dev/null <<EOF
[Unit]
Description=Uni EDU read-only MID-360 distance provider container
After=network-online.target docker.service uni-edu-lidar-driver.service
Wants=network-online.target
Requires=docker.service uni-edu-lidar-driver.service

[Service]
Type=simple
ExecStart=/usr/bin/docker run --rm --name uni-edu-lidar-provider --network host --env-file $ENV_FILE uni-edu-lidar-humble:local python3 /opt/uni-edu/ros_lidar_provider.py
ExecStop=/usr/bin/docker stop --time 10 uni-edu-lidar-provider
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable uni-edu-lidar-driver.service uni-edu-lidar-provider.service
  sudo systemctl restart uni-edu-lidar-driver.service uni-edu-lidar-provider.service
else
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
fi

touch "$INSTALL_MARKER"
chmod 600 "$INSTALL_MARKER"
echo "MID-360 driver and read-only HTTP provider are configured using ROS 2 $ROS_DISTRO_REQUIRED ($ROS_RUNTIME)."
echo "Review $CONFIG_FILE and verify the NIC/device addresses before relying on sensor data."
echo "The installer enables sensor data only; it does not install or start a ROS locomotion bridge."
