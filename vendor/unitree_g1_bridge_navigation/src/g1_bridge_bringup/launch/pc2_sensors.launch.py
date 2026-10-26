import json
from pathlib import Path

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, OpaqueFunction
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def launch_setup(context, *args, **kwargs):
    livox_host_ip = LaunchConfiguration("livox_host_ip").perform(context)
    livox_lidar_ip = LaunchConfiguration("livox_lidar_ip").perform(context)
    livox_publish_freq = float(
        LaunchConfiguration("livox_publish_freq").perform(context)
    )
    livox_xfer_format = int(
        LaunchConfiguration("livox_xfer_format").perform(context)
    )
    livox_multi_topic = int(
        LaunchConfiguration("livox_multi_topic").perform(context)
    )
    livox_frame_id = LaunchConfiguration("livox_frame_id").perform(context)
    livox_namespace = LaunchConfiguration("livox_namespace").perform(context)

    livox_config = {
        "lidar_summary_info": {"lidar_type": 8},
        "MID360": {
            "lidar_net_info": {
                "cmd_data_port": 56100,
                "push_msg_port": 56200,
                "point_data_port": 56300,
                "imu_data_port": 56400,
                "log_data_port": 56500,
            },
            "host_net_info": {
                "cmd_data_ip": livox_host_ip,
                "cmd_data_port": 56101,
                "push_msg_ip": livox_host_ip,
                "push_msg_port": 56201,
                "point_data_ip": livox_host_ip,
                "point_data_port": 56301,
                "imu_data_ip": livox_host_ip,
                "imu_data_port": 56401,
                "log_data_ip": "",
                "log_data_port": 56501,
            },
        },
        "lidar_configs": [
            {
                "ip": livox_lidar_ip,
                "pcl_data_type": 1,
                "pattern_mode": 0,
                "extrinsic_parameter": {
                    "roll": 0.0,
                    "pitch": 0.0,
                    "yaw": 0.0,
                    "x": 0,
                    "y": 0,
                    "z": 0,
                },
            }
        ],
    }

    livox_config_path = Path("/tmp/g1_mid360_config.json")
    livox_config_path.write_text(json.dumps(livox_config, indent=2), encoding="utf-8")

    livox_node = Node(
        package="livox_ros_driver2",
        executable="livox_ros_driver2_node",
        namespace=livox_namespace,
        name="livox_lidar_publisher",
        output="screen",
        parameters=[
            {
                "xfer_format": livox_xfer_format,
                "multi_topic": livox_multi_topic,
                "data_src": 0,
                "publish_freq": livox_publish_freq,
                "output_data_type": 0,
                "frame_id": livox_frame_id,
                "lvx_file_path": "/tmp/unused.lvx",
                "user_config_path": str(livox_config_path),
                "cmdline_input_bd_code": "livox0000000001",
            }
        ],
    )

    realsense_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            [
                FindPackageShare("realsense2_camera"),
                "/launch/rs_launch.py",
            ]
        ),
        launch_arguments={
            "camera_namespace": LaunchConfiguration("head_camera_namespace"),
            "camera_name": LaunchConfiguration("head_camera_name"),
            "serial_no": LaunchConfiguration("realsense_serial_no"),
            "enable_color": "true",
            "enable_depth": "true",
            "enable_infra1": "true",
            "enable_infra2": "true",
            "enable_gyro": "true",
            "enable_accel": "true",
            "unite_imu_method": "2",
            "enable_sync": "true",
            "enable_rgbd": "true",
            "pointcloud.enable": "true",
            "align_depth.enable": "true",
            "rgb_camera.color_profile": LaunchConfiguration(
                "realsense_color_profile"
            ),
            "depth_module.depth_profile": LaunchConfiguration(
                "realsense_depth_profile"
            ),
            "publish_tf": LaunchConfiguration("realsense_publish_tf"),
            "output": "screen",
        }.items(),
    )

    return [livox_node, realsense_launch]


def generate_launch_description():
    return LaunchDescription(
        [
            DeclareLaunchArgument("livox_namespace", default_value="mid360"),
            DeclareLaunchArgument("livox_host_ip", default_value="192.168.1.5"),
            DeclareLaunchArgument("livox_lidar_ip", default_value="192.168.1.12"),
            DeclareLaunchArgument("livox_frame_id", default_value="mid360_frame"),
            DeclareLaunchArgument("livox_publish_freq", default_value="10.0"),
            DeclareLaunchArgument("livox_xfer_format", default_value="0"),
            DeclareLaunchArgument("livox_multi_topic", default_value="0"),
            DeclareLaunchArgument(
                "head_camera_namespace", default_value="head_camera"
            ),
            DeclareLaunchArgument("head_camera_name", default_value="d435i"),
            DeclareLaunchArgument("realsense_serial_no", default_value="''"),
            DeclareLaunchArgument(
                "realsense_color_profile", default_value="640x480x30"
            ),
            DeclareLaunchArgument(
                "realsense_depth_profile", default_value="640x480x30"
            ),
            DeclareLaunchArgument("realsense_publish_tf", default_value="true"),
            OpaqueFunction(function=launch_setup),
        ]
    )
