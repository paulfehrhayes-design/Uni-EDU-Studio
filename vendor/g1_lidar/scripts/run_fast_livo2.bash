#!/bin/bash
# Run Fast-LIVO2 in a Docker container (ROS2 Humble).
#
# Prerequisites:
#   1. Docker image built: bash scripts/run_fast_livo2.bash build
#   2. livox_ros_driver2 publishing /livox/lidar and /livox/imu (from host)
#   3. (Optional) realsense2_camera publishing /camera/color/image_raw
#
# Usage:
#   bash scripts/run_fast_livo2.bash             # LiDAR+IMU only
#   bash scripts/run_fast_livo2.bash camera       # LiDAR+IMU+Camera (full LIVO)
#   bash scripts/run_fast_livo2.bash bash         # Interactive shell
#   bash scripts/run_fast_livo2.bash build        # Build the Docker image only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
CONFIG_DIR="$PROJECT_DIR/fast_livo2_config"
DDS_XML="$PROJECT_DIR/docker/fastdds_no_shm.xml"
IMAGE_NAME="fast_livo2_g1"

MODE="${1:-lidar}"

case "$MODE" in
  build)
    echo "[Fast-LIVO2] Building Docker image..."
    docker build \
      -f "$PROJECT_DIR/docker/Dockerfile.fast_livo2" \
      -t "$IMAGE_NAME" \
      "$PROJECT_DIR/docker"
    echo "[Fast-LIVO2] Build complete: $IMAGE_NAME"
    exit 0
    ;;
  bash|shell)
    CMD="bash"
    echo "[Fast-LIVO2] Starting interactive shell..."
    ;;
  camera|full|livo)
    CMD="ros2 run fast_livo fastlivo_mapping --ros-args --params-file /fast_livo2_ws/config_g1/mid360_d435i_g1.yaml --params-file /fast_livo2_ws/config_g1/camera_d435i_g1.yaml"
    echo "[Fast-LIVO2] Starting with LiDAR + IMU + Camera..."
    ;;
  lidar|run|*)
    CMD="ros2 run fast_livo fastlivo_mapping --ros-args --params-file /fast_livo2_ws/config_g1/mid360_lidar_only_g1.yaml --params-file /fast_livo2_ws/config_g1/camera_d435i_g1.yaml"
    echo "[Fast-LIVO2] Starting with LiDAR + IMU only..."
    ;;
esac

docker run --rm \
  --net=host \
  --ipc=host \
  -e ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-0}" \
  -e FASTRTPS_DEFAULT_PROFILES_FILE=/config/fastdds_no_shm.xml \
  -v "$(realpath "$CONFIG_DIR")":/fast_livo2_ws/config_g1:ro \
  -v "$(realpath "$DDS_XML")":/config/fastdds_no_shm.xml:ro \
  "$IMAGE_NAME" \
  $CMD
