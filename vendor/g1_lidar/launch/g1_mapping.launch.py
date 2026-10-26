"""
Unitree G1 マッピング用 Launch ファイル
  1. livox_ros_driver2 (CustomMsg形式, /livox/custom_msg にパブリッシュ)
  2. FAST_LIO (SLAMマッピング → PCD保存)
  3. RViz2 (可視化)

Usage:
  source ~/workspace/sakai/g1_lidar/setup_env.bash
  ros2 launch ~/workspace/sakai/g1_lidar/launch/g1_mapping.launch.py
"""
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch.conditions import IfCondition
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    pkg_dir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    config_json = os.path.join(pkg_dir, 'config', 'MID360_G1_config.json')

    fast_lio_share = get_package_share_directory('fast_lio')
    fast_lio_config = os.path.join(fast_lio_share, 'config', 'mid360.yaml')
    fast_lio_rviz = os.path.join(fast_lio_share, 'rviz', 'fastlio.rviz')

    rviz_arg = DeclareLaunchArgument(
        'rviz', default_value='true',
        description='Launch RViz2'
    )

    # xfer_format=1 → CustomMsg, topic: /livox/custom_msg
    livox_driver = Node(
        package='livox_ros_driver2',
        executable='livox_ros_driver2_node',
        name='livox_lidar_publisher_mapping',
        output='screen',
        parameters=[
            {'xfer_format': 1},
            {'multi_topic': 0},
            {'data_src': 0},
            {'publish_freq': 10.0},
            {'output_data_type': 0},
            {'frame_id': 'livox_frame'},
            {'user_config_path': config_json},
        ],
        remappings=[
            ('/livox/lidar', '/livox/custom_msg'),
        ]
    )

    fast_lio_node = Node(
        package='fast_lio',
        executable='fastlio_mapping',
        parameters=[fast_lio_config, {'use_sim_time': False}],
        output='screen'
    )

    rviz_node = Node(
        package='rviz2',
        executable='rviz2',
        arguments=['-d', fast_lio_rviz],
        condition=IfCondition(LaunchConfiguration('rviz')),
    )

    return LaunchDescription([
        rviz_arg,
        livox_driver,
        fast_lio_node,
        rviz_node,
    ])
