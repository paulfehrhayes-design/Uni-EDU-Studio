#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source /opt/ros/humble/setup.bash

exec /usr/bin/python3 "$PROJECT_DIR/backend/ros_lidar_provider.py"
