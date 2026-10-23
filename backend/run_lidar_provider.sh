#!/usr/bin/env bash
set -eo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROS_DISTRO="${G1_LIDAR_ROS_DISTRO:-}"
ROS_RUNTIME="${G1_LIDAR_ROS_RUNTIME:-host}"
if [[ "$ROS_RUNTIME" != "host" ]]; then
  echo "The $ROS_DISTRO LiDAR runtime is managed by its system container service." >&2
  exit 1
fi
if [[ "$ROS_DISTRO" != "humble" ]]; then
  echo "G1_LIDAR_ROS_DISTRO must be humble." >&2
  exit 1
fi
source "/opt/ros/$ROS_DISTRO/setup.bash"
source "${G1_LIDAR_STATE_WS:-$HOME/uni-edu-g1-state-ws}/install/setup.bash"

set -u
exec ros2 launch "$PROJECT_DIR/backend/ros/g1_sensor_runtime.launch.py"
