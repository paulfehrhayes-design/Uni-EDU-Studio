#!/usr/bin/env bash
set -euo pipefail

MAP_STEM="${1:-/home/unitree/ws_slam/maps/map}"

if ! command -v ros2 >/dev/null 2>&1; then
  echo "ros2 is not in PATH. Source ROS 2 and the workspace first." >&2
  exit 1
fi

if ! ros2 pkg prefix nav2_map_server >/dev/null 2>&1; then
  echo "nav2_map_server is not installed. Install ros-humble-nav2-map-server first." >&2
  exit 1
fi

mkdir -p "$(dirname "${MAP_STEM}")"
ros2 run nav2_map_server map_saver_cli -f "${MAP_STEM}" --ros-args -p save_map_timeout:=10.0
