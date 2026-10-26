#!/bin/bash
# Run GLIM in a Docker container with G1 LiDAR configuration.
#
# Prerequisites:
#   1. Docker installed
#   2. GLIM config files in glim_config/ (run scripts/setup_glim_config.bash first)
#   3. livox_ros_driver2 publishing on /livox/lidar and /livox/imu
#
# Usage:
#   bash scripts/run_glim.bash          # CPU mode (default)
#   bash scripts/run_glim.bash gpu      # GPU/CUDA mode
#   bash scripts/run_glim.bash ppa      # Native PPA install (no Docker)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
CONFIG_DIR="$PROJECT_DIR/glim_config"
DDS_XML="$PROJECT_DIR/docker/fastdds_no_shm.xml"

MODE="${1:-cpu}"

if [ ! -f "$CONFIG_DIR/config_ros.json" ]; then
  echo "[ERROR] GLIM config not found. Run: bash scripts/setup_glim_config.bash"
  exit 1
fi

case "$MODE" in
  gpu|cuda)
    IMAGE="koide3/glim_ros2:jazzy_cuda13.1"
    GPU_FLAGS="--gpus all"
    echo "[GLIM] Starting with GPU acceleration ($IMAGE)"
    ;;
  cpu)
    IMAGE="koide3/glim_ros2:jazzy"
    GPU_FLAGS=""
    echo "[GLIM] Starting in CPU mode ($IMAGE)"
    ;;
  ppa|native)
    echo "[GLIM] Starting native (PPA) installation..."
    echo "  If not installed: curl -s https://koide3.github.io/ppa/setup_ppa.sh | sudo bash"
    echo "                    sudo apt install ros-jazzy-glim-ros"
    exec ros2 run glim_ros glim_rosnode --ros-args \
      -p config_path:="$CONFIG_DIR"
    ;;
  *)
    echo "Usage: $0 [cpu|gpu|ppa]"
    exit 1
    ;;
esac

docker run --rm \
  --net=host \
  --ipc=host \
  ${GPU_FLAGS} \
  -e ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-0}" \
  -e FASTRTPS_DEFAULT_PROFILES_FILE=/config/fastdds_no_shm.xml \
  -v "$(realpath "$CONFIG_DIR")":/glim/config:ro \
  -v "$(realpath "$DDS_XML")":/config/fastdds_no_shm.xml:ro \
  "$IMAGE" \
  ros2 run glim_ros glim_rosnode --ros-args \
    -p config_path:=/glim/config
