#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROS_DISTRO="${G1_LIDAR_ROS_DISTRO:-}"
if [[ "$ROS_DISTRO" != "foxy" && "$ROS_DISTRO" != "humble" ]]; then
  echo "G1_LIDAR_ROS_DISTRO must be foxy or humble." >&2
  exit 1
fi
source "/opt/ros/$ROS_DISTRO/setup.bash"

exec /usr/bin/python3 "$PROJECT_DIR/backend/ros_lidar_provider.py"
