"""
Unitree G1 Fast-LIVO2 マッピング用 Launch ファイル

LiDAR-Inertial-Visual 融合 SLAM。
  1. livox_ros_driver2 (CustomMsg形式)
  2. realsense2_camera (D435i RGB ストリーム)
  3. RViz2 (可視化)

Fast-LIVO2 本体は Docker コンテナ内で実行する:
  bash scripts/run_fast_livo2.bash

Usage:
  source ~/workspace/sakai/g1_lidar/setup_env.bash
  ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_fast_livo2.launch.py
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
    camera_arg = DeclareLaunchArgument(
        'camera', default_value='true',
        description='Launch RealSense D435i camera node'
    )

    # livox_ros_driver2: PointCloud2 for Fast-LIVO2 compatibility
    livox_driver = Node(
        package='livox_ros_driver2',
        executable='livox_ros_driver2_node',
        name='livox_lidar_publisher_livo2',
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

    # Intel RealSense D435i
    realsense_node = Node(
        package='realsense2_camera',
        executable='realsense2_camera_node',
        name='realsense2_camera',
        namespace='camera',
        output='screen',
        parameters=[
            {'enable_color': True},
            {'enable_depth': False},
            {'enable_infra1': False},
            {'enable_infra2': False},
            {'rgb_camera.profile': '1280x720x30'},
            {'enable_gyro': False},
            {'enable_accel': False},
        ],
        condition=IfCondition(LaunchConfiguration('camera')),
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
        camera_arg,
        livox_driver,
        realsense_node,
        rviz_node,
    ])
