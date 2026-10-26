from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    params_file = LaunchConfiguration("params_file")

    return LaunchDescription(
        [
            DeclareLaunchArgument(
                "params_file",
                default_value=PathJoinSubstitution(
                    [FindPackageShare("g1_nav_bridge"), "config", "nav_bridge.yaml"]
                ),
                description="Path to nav_bridge parameters file",
            ),
            Node(
                package="g1_nav_bridge",
                executable="cmdvel_to_sport",
                name="cmdvel_to_sport",
                output="screen",
                parameters=[params_file],
            ),
        ]
    )
