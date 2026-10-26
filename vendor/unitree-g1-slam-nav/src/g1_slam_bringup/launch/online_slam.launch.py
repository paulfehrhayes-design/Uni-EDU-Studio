from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution, PythonExpression
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from launch.actions import ExecuteProcess


def generate_launch_description():
    use_rviz = LaunchConfiguration("use_rviz")
    use_livox = LaunchConfiguration("use_livox")
    use_sim_time = LaunchConfiguration("use_sim_time")
    scan_topic = LaunchConfiguration("scan_topic")
    base_frame = LaunchConfiguration("base_frame")
    odom_frame = LaunchConfiguration("odom_frame")
    map_frame = LaunchConfiguration("map_frame")
    params_file = LaunchConfiguration("params_file")
    livox_frame = LaunchConfiguration("livox_frame")
    livox_config_file = LaunchConfiguration("livox_config_file")
    livox_pointcloud_topic = LaunchConfiguration("livox_pointcloud_topic")
    publish_livox_tf = LaunchConfiguration("publish_livox_tf")
    livox_x = LaunchConfiguration("livox_x")
    livox_y = LaunchConfiguration("livox_y")
    livox_z = LaunchConfiguration("livox_z")
    livox_roll = LaunchConfiguration("livox_roll")
    livox_pitch = LaunchConfiguration("livox_pitch")
    livox_yaw = LaunchConfiguration("livox_yaw")

    return LaunchDescription(
        [
            DeclareLaunchArgument("use_rviz", default_value="true"),
            DeclareLaunchArgument("use_livox", default_value="false"),
            DeclareLaunchArgument("use_sim_time", default_value="false"),
            DeclareLaunchArgument("scan_topic", default_value="/scan"),
            DeclareLaunchArgument("base_frame", default_value="robot_center"),
            DeclareLaunchArgument("odom_frame", default_value="odom"),
            DeclareLaunchArgument("map_frame", default_value="map"),
            DeclareLaunchArgument("livox_frame", default_value="livox_frame"),
            DeclareLaunchArgument(
                "livox_config_file",
                default_value="/home/unitree/ws_livox/install/livox_ros_driver2/share/livox_ros_driver2/config/MID360_config.json",
            ),
            DeclareLaunchArgument("livox_pointcloud_topic", default_value="/livox/lidar"),
            DeclareLaunchArgument("publish_livox_tf", default_value="true"),
            DeclareLaunchArgument("livox_x", default_value="0.0"),
            DeclareLaunchArgument("livox_y", default_value="0.0"),
            DeclareLaunchArgument("livox_z", default_value="0.25"),
            DeclareLaunchArgument("livox_roll", default_value="0.0"),
            DeclareLaunchArgument("livox_pitch", default_value="0.0"),
            DeclareLaunchArgument("livox_yaw", default_value="0.0"),
            DeclareLaunchArgument(
                "params_file",
                default_value=PathJoinSubstitution(
                    [FindPackageShare("g1_slam_bringup"), "config", "slam_toolbox.yaml"]
                ),
            ),
            Node(
                condition=IfCondition(use_livox),
                package="livox_ros_driver2",
                executable="livox_ros_driver2_node",
                name="livox_lidar_publisher",
                output="screen",
                parameters=[
                    {
                        "xfer_format": 0,
                        "multi_topic": 0,
                        "data_src": 0,
                        "publish_freq": 10.0,
                        "output_data_type": 0,
                        "frame_id": livox_frame,
                        "user_config_path": livox_config_file,
                        "cmdline_input_bd_code": "livox0000000001",
                    }
                ],
            ),
            Node(
                condition=IfCondition(PythonExpression(["'", use_livox, "' == 'true' and '", publish_livox_tf, "' == 'true'"])),
                package="tf2_ros",
                executable="static_transform_publisher",
                name="livox_static_tf",
                arguments=[
                    livox_x,
                    livox_y,
                    livox_z,
                    livox_roll,
                    livox_pitch,
                    livox_yaw,
                    base_frame,
                    livox_frame,
                ],
            ),
            Node(
                condition=IfCondition(use_livox),
                package="pointcloud_to_laserscan",
                executable="pointcloud_to_laserscan_node",
                name="livox_scan_converter",
                output="screen",
                remappings=[
                    ("cloud_in", livox_pointcloud_topic),
                    ("scan", "/scan_raw"),   # publish to raw topic; restamper republishes to scan_topic
                ],
                parameters=[
                    {
                        "target_frame": base_frame,
                        "transform_tolerance": 0.1,
                        "min_height": -0.15,
                        "max_height": 0.15,
                        "angle_min": -3.14159,
                        "angle_max": 3.14159,
                        "angle_increment": 0.0087,
                        "scan_time": 0.1,
                        "range_min": 0.1,
                        "range_max": 30.0,
                        "use_inf": True,
                        "inf_epsilon": 1.0,
                    }
                ],
            ),
            Node(
                condition=IfCondition(use_livox),
                package="g1_nav_bridge",
                executable="scan_restamper",
                name="scan_restamper",
                output="screen",
                parameters=[{
                    "input_topic": "/scan_raw",
                    "output_topic": scan_topic,
                }],
            ),
            Node(
                package="slam_toolbox",
                executable="async_slam_toolbox_node",
                name="slam_toolbox",
                output="screen",
                parameters=[
                    params_file,
                    {
                        "use_sim_time": use_sim_time,
                        "base_frame": base_frame,
                        "odom_frame": odom_frame,
                        "map_frame": map_frame,
                    },
                ],
                remappings=[("scan", scan_topic)],
            ),
            Node(
                package="g1_nav_bridge",
                executable="odom_tf_broadcaster",
                name="odom_tf_broadcaster",
                output="screen",
                parameters=[{"odom_topic": "/dog_odom"}],
            ),
            Node(
                condition=IfCondition(use_rviz),
                package="rviz2",
                executable="rviz2",
                name="rviz2",
                output="screen",
                arguments=[
                    "-d",
                    PathJoinSubstitution(
                        [FindPackageShare("g1_slam_bringup"), "config", "mapping.rviz"]
                    ),
                ],
            ),
        ]
    )
