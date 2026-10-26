#!/usr/bin/python3
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    config_dir = os.path.join(project_dir, "fast_livo2_config")

    config_cmd = os.path.join(config_dir, "mid360_lidar_only_g1.yaml")
    cam_config_cmd = os.path.join(config_dir, "camera_d435i_g1.yaml")

    return LaunchDescription([
        DeclareLaunchArgument("use_rviz", default_value="True"),
        DeclareLaunchArgument("params_file", default_value=config_cmd),
        DeclareLaunchArgument("cam_params_file", default_value=cam_config_cmd),

        Node(
            package="fast_livo",
            executable="fastlivo_mapping",
            name="laserMapping",
            parameters=[
                LaunchConfiguration("params_file"),
                LaunchConfiguration("cam_params_file"),
                {"use_sim_time": False},
            ],
            output="screen",
        ),

        Node(
            condition=IfCondition(LaunchConfiguration("use_rviz")),
            package="rviz2",
            executable="rviz2",
            name="rviz2",
            arguments=["-d", os.path.join(project_dir, "rviz", "fastlivo2_view.rviz")],
            output="screen",
        ),
    ])
