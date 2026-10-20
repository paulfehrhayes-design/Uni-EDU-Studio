from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription(
        [
            DeclareLaunchArgument("config_path"),
            DeclareLaunchArgument("frame_id", default_value="livox_frame"),
            DeclareLaunchArgument("pointcloud_topic", default_value="/mid360/livox/lidar"),
            DeclareLaunchArgument("publish_freq", default_value="20.0"),
            Node(
                package="livox_ros_driver2",
                executable="livox_ros_driver2_node",
                name="livox_lidar_publisher",
                namespace="mid360",
                output="screen",
                remappings=[("livox/lidar", LaunchConfiguration("pointcloud_topic"))],
                parameters=[
                    {
                        "xfer_format": 0,
                        "multi_topic": 0,
                        "data_src": 0,
                        "publish_freq": LaunchConfiguration("publish_freq"),
                        "output_data_type": 0,
                        "frame_id": LaunchConfiguration("frame_id"),
                        "user_config_path": LaunchConfiguration("config_path"),
                    }
                ],
            ),
        ]
    )
