"""
Launch file for Unitree G1 LiDAR (Livox MID-360) point cloud visualization.

Launches:
  1. livox_ros_driver2 node - publishes point cloud from MID-360
  2. rviz2 - visualizes the point cloud

Usage:
  ros2 launch g1_lidar_viz.launch.py
  ros2 launch g1_lidar_viz.launch.py config:=/path/to/MID360_config.json
  ros2 launch g1_lidar_viz.launch.py rviz:=false
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
    default_rviz = os.path.join(pkg_dir, 'livox_ros_driver2', 'config', 'display_point_cloud_ROS2.rviz')

    config_arg = DeclareLaunchArgument(
        'config', default_value=default_config,
        description='Path to MID360 config JSON'
    )
    rviz_arg = DeclareLaunchArgument(
        'rviz', default_value='true',
        description='Launch RViz2 for visualization'
    )

    xfer_format   = 0    # 0 = PointCloud2 (standard), 1 = CustomMsg
    multi_topic   = 0
    data_src      = 0
    publish_freq  = 10.0
    output_type   = 0
    frame_id      = 'livox_frame'

    livox_driver = Node(
        package='livox_ros_driver2',
        executable='livox_ros_driver2_node',
        name='livox_lidar_publisher',
        output='screen',
        parameters=[
            {'xfer_format': xfer_format},
            {'multi_topic': multi_topic},
            {'data_src': data_src},
            {'publish_freq': publish_freq},
            {'output_data_type': output_type},
            {'frame_id': frame_id},
            {'user_config_path': LaunchConfiguration('config')},
        ]
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
        livox_driver,
        rviz_node,
    ])
