#!/bin/bash
# Download GLIM default config files that are not customized for G1.
# config_ros.json and config_sensors.json are maintained locally with G1-specific settings.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/../glim_config"

REPO_RAW="https://raw.githubusercontent.com/koide3/glim/master/config"

DEFAULTS=(
  config.json
  config_preprocess.json
  config_odometry_cpu.json
  config_odometry_gpu.json
  config_odometry_ct.json
  config_sub_mapping_cpu.json
  config_sub_mapping_gpu.json
  config_sub_mapping_passthrough.json
  config_global_mapping_cpu.json
  config_global_mapping_gpu.json
  config_global_mapping_pose_graph.json
  config_logging.json
  config_viewer.json
)

echo "Downloading GLIM default configs to $CONFIG_DIR ..."
for f in "${DEFAULTS[@]}"; do
  if [ -f "$CONFIG_DIR/$f" ]; then
    echo "  [SKIP] $f (already exists)"
  else
    curl -sL "$REPO_RAW/$f" -o "$CONFIG_DIR/$f"
    echo "  [OK]   $f"
  fi
done

echo ""
echo "Done. G1-specific files (config_ros.json, config_sensors.json) are not overwritten."
echo "Edit them in: $CONFIG_DIR/"
