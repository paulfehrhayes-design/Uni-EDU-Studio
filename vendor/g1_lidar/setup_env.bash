#!/bin/bash
# Unitree G1 LiDAR 環境セットアップスクリプト
# Usage: source setup_env.bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ROS2 Jazzy
source /opt/ros/jazzy/setup.bash

# ビルド済みワークスペース
if [ -f "$SCRIPT_DIR/ros2_ws/install/setup.bash" ]; then
    source "$SCRIPT_DIR/ros2_ws/install/setup.bash"
    echo "[OK] ROS2 workspace loaded (livox_ros_driver2, fast_lio, open3d_loc)"
else
    echo "[WARN] ros2_ws/install/setup.bash not found. Run build first."
fi

# ライブラリパス
export LD_LIBRARY_PATH="$SCRIPT_DIR/Livox-SDK2/build/sdk_core:$SCRIPT_DIR/open3d-devel-linux-x86_64-cxx11-abi-0.18.0/lib:${LD_LIBRARY_PATH}"
export LIVOX_SDK2_PATH="$SCRIPT_DIR/Livox-SDK2"

echo "[OK] G1 LiDAR environment ready"
echo ""
echo "--- Quick Commands ---"
echo "  1) 点群可視化のみ:"
echo "     ros2 launch $SCRIPT_DIR/launch/g1_lidar_viz.launch.py"
echo ""
echo "  2) FAST_LIO マッピング (LiDAR + SLAM):"
echo "     ros2 launch $SCRIPT_DIR/launch/g1_mapping.launch.py"
echo ""
echo "  3) FAST_LIO + open3d_loc ローカリゼーション:"
echo "     ros2 launch open3d_loc localization_3d_g1.launch.py"
echo ""
echo "  4) GLIM マッピング (GPU加速 LiDAR SLAM):"
echo "     ros2 launch $SCRIPT_DIR/launch/g1_glim.launch.py   # ドライバ起動"
echo "     bash $SCRIPT_DIR/scripts/run_glim.bash              # GLIM Docker起動"
echo ""
echo "  5) Fast-LIVO2 マッピング (LiDAR+IMU+カメラ融合SLAM):"
echo "     ros2 launch $SCRIPT_DIR/launch/g1_fast_livo2.launch.py  # ドライバ起動"
echo "     bash $SCRIPT_DIR/scripts/run_fast_livo2.bash            # LIVO2 Docker起動"
echo ""
echo "  Check topics:"
echo "     ros2 topic list"
