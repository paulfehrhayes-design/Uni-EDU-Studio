#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROS_DISTRO="${G1_LIDAR_ROS_DISTRO:-}"
if [[ "$ROS_DISTRO" != "foxy" && "$ROS_DISTRO" != "humble" ]]; then
  echo "G1_LIDAR_ROS_DISTRO must be foxy or humble." >&2
  exit 1
fi
source "/opt/ros/$ROS_DISTRO/setup.bash"
source "$G1_LIDAR_ROS_WS/install/setup.bash"

exec ros2 launch "$PROJECT_DIR/backend/ros/mid360_launch.py" \
  "config_path:=$G1_LIDAR_CONFIG_PATH" \
  "frame_id:=$G1_DISTANCE_FRAME_ID"
