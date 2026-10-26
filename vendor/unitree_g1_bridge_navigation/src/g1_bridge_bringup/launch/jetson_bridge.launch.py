from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription(
        [
            DeclareLaunchArgument("cmd_vel_topic", default_value="/cmd_vel"),
            DeclareLaunchArgument(
                "request_topic", default_value="/api/sport/request"
            ),
            DeclareLaunchArgument("lowstate_topic", default_value="lowstate"),
            DeclareLaunchArgument("joint_layout", default_value="g1_29dof"),
            DeclareLaunchArgument("imu_frame_id", default_value="base_imu_link"),
            DeclareLaunchArgument("publish_rate_hz", default_value="20.0"),
            DeclareLaunchArgument("command_timeout_sec", default_value="0.5"),
            DeclareLaunchArgument("command_duration_sec", default_value="0.6"),
            DeclareLaunchArgument("auto_start", default_value="false"),
            DeclareLaunchArgument("max_linear_x", default_value="0.5"),
            DeclareLaunchArgument("max_linear_y", default_value="0.3"),
            DeclareLaunchArgument("max_angular_z", default_value="0.8"),
            Node(
                package="g1_bridge_bringup",
                executable="g1_cmd_vel_bridge",
                name="g1_cmd_vel_bridge",
                output="screen",
                parameters=[
                    {
                        "cmd_vel_topic": LaunchConfiguration("cmd_vel_topic"),
                        "request_topic": LaunchConfiguration("request_topic"),
                        "publish_rate_hz": LaunchConfiguration("publish_rate_hz"),
                        "command_timeout_sec": LaunchConfiguration(
                            "command_timeout_sec"
                        ),
                        "command_duration_sec": LaunchConfiguration(
                            "command_duration_sec"
                        ),
                        "auto_start": LaunchConfiguration("auto_start"),
                        "max_linear_x": LaunchConfiguration("max_linear_x"),
                        "max_linear_y": LaunchConfiguration("max_linear_y"),
                        "max_angular_z": LaunchConfiguration("max_angular_z"),
                    }
                ],
            ),
            Node(
                package="g1_bridge_bringup",
                executable="g1_low_state_bridge",
                name="g1_low_state_bridge",
                output="screen",
                parameters=[
                    {
                        "source_topic": LaunchConfiguration("lowstate_topic"),
                        "joint_layout": LaunchConfiguration("joint_layout"),
                        "imu_frame_id": LaunchConfiguration("imu_frame_id"),
                    }
                ],
            ),
        ]
    )
