"""
Unitree G1 GLIM マッピング用 Launch ファイル

livox_ros_driver2 を PointCloud2 形式で起動し、GLIM (Docker or ネイティブ) で
受信してマッピングを行う。

GLIM は Docker コンテナまたは PPA パッケージで別途起動する。
このlaunchファイルは LiDAR ドライバ + RViz2 の起動のみを担当。

Usage:
  # 1) LiDAR ドライバ + RViz2 を起動
  source ~/workspace/sakai/g1_lidar/setup_env.bash
  ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_glim.launch.py

  # 2) 別ターミナルで GLIM を起動 (Docker)
  bash ~/workspace/sakai/g1_lidar/scripts/run_glim.bash

  # 3) GLIM ネイティブの場合
  ros2 run glim_ros glim_rosnode --ros-args \\
      -p config_path:=$HOME/workspace/sakai/g1_lidar/glim_config
"""
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    pkg_dir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    default_config = os.path.join(pkg_dir, 'config', 'MID360_G1_config.json')
    default_rviz = os.path.join(
        pkg_dir, 'livox_ros_driver2', 'config', 'display_point_cloud_ROS2.rviz'
    )

    config_arg = DeclareLaunchArgument(
        'config', default_value=default_config,
        description='Path to MID360 config JSON'
    )
    rviz_arg = DeclareLaunchArgument(
        'rviz', default_value='true',
        description='Launch RViz2 for visualization'
    )
    publish_freq_arg = DeclareLaunchArgument(
        'publish_freq', default_value='10.0',
        description='LiDAR publish frequency (Hz)'
    )

    livox_driver = Node(
        package='livox_ros_driver2',
        executable='livox_ros_driver2_node',
        name='livox_lidar_publisher_glim',
        output='screen',
        parameters=[
            {'xfer_format': 0},
            {'multi_topic': 0},
            {'data_src': 0},
            {'publish_freq': 10.0},
            {'output_data_type': 0},
            {'frame_id': 'livox_frame'},
            {'user_config_path': LaunchConfiguration('config')},
        ],
    )

    rviz_node = Node(
        package='rviz2',
        executable='rviz2',
        name='rviz2',
        arguments=['-d', default_rviz],
        condition=IfCondition(LaunchConfiguration('rviz')),
    )

    return LaunchDescription([
        config_arg,
        rviz_arg,
        publish_freq_arg,
        livox_driver,
        rviz_node,
    ])
