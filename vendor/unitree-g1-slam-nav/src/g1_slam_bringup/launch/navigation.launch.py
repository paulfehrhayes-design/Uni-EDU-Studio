"""
navigation.launch.py  –  G1 autonomous navigation bringup
==========================================================
Starts:
  1. Livox LiDAR driver + pointcloud-to-laserscan converter
  2. Odometry TF broadcaster         (odom → base_link)
  3. slam_toolbox in localization mode (map → odom TF + /map topic)
  4. Nav2 stack: controller, planner, behaviors, bt_navigator
  5. cmd_vel → Sport API bridge      (g1_nav_bridge)
  6. RViz (optional)

Prerequisites
-------------
1. Install full Nav2:
     sudo apt install ros-humble-navigation2 ros-humble-nav2-bringup

2. Build and save a slam_toolbox map first:
     ros2 launch g1_slam_bringup mapping.launch.py use_livox:=true
     # drive the robot around to build the map, then:
     ros2 service call /slam_toolbox/serialize_map \\
       slam_toolbox/srv/SerializePoseGraph \\
       "{filename: '/home/unitree/ws_slam/maps/atrium_slam'}"
     # also save a 2D pgm for Nav2 costmaps:
     bash /home/unitree/ws_slam/src/g1_slam_bringup/scripts/save_map.sh \\
       /home/unitree/ws_slam/maps/atrium_2d

3. Launch navigation:
     ros2 launch g1_slam_bringup navigation.launch.py \\
       use_livox:=true \\
       map:=/home/unitree/ws_slam/maps/atrium_2d.yaml

Usage
-----
  ros2 launch g1_slam_bringup navigation.launch.py use_livox:=true map:=<path>.yaml

Send a navigation goal:
  ros2 topic pub /goal_pose geometry_msgs/PoseStamped ...
  or use RViz "Nav2 Goal" tool (2D Goal Pose button)
"""

import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, GroupAction
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution, PythonExpression
from launch_ros.actions import Node, PushRosNamespace
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():

    # ── Launch arguments ────────────────────────────────────────────────────
    use_livox      = LaunchConfiguration("use_livox")
    use_rviz       = LaunchConfiguration("use_rviz")
    use_sim_time   = LaunchConfiguration("use_sim_time")
    map_yaml       = LaunchConfiguration("map")
    base_frame     = LaunchConfiguration("base_frame")
    odom_frame     = LaunchConfiguration("odom_frame")
    map_frame      = LaunchConfiguration("map_frame")
    scan_topic     = LaunchConfiguration("scan_topic")
    livox_frame    = LaunchConfiguration("livox_frame")
    livox_x        = LaunchConfiguration("livox_x")
    livox_y        = LaunchConfiguration("livox_y")
    livox_z        = LaunchConfiguration("livox_z")
    livox_roll     = LaunchConfiguration("livox_roll")
    livox_pitch    = LaunchConfiguration("livox_pitch")
    livox_yaw      = LaunchConfiguration("livox_yaw")
    livox_config   = LaunchConfiguration("livox_config_file")
    localization_params = LaunchConfiguration("localization_params")
    nav2_params    = LaunchConfiguration("nav2_params")
    nav_bridge_params = LaunchConfiguration("nav_bridge_params")

    return LaunchDescription([

        # ── Arguments ───────────────────────────────────────────────────────
        DeclareLaunchArgument("use_livox",    default_value="true"),
        DeclareLaunchArgument("use_rviz",     default_value="true"),
        DeclareLaunchArgument("use_sim_time", default_value="false"),
        DeclareLaunchArgument(
            "map",
            description="Full path to the 2D occupancy grid map yaml file. "
                        "Example: /home/unitree/ws_slam/maps/atrium_2d.yaml",
        ),
        DeclareLaunchArgument("base_frame",   default_value="robot_center"),
        DeclareLaunchArgument("odom_frame",   default_value="odom"),
        DeclareLaunchArgument("map_frame",    default_value="map"),
        DeclareLaunchArgument("scan_topic",   default_value="/scan"),
        DeclareLaunchArgument("livox_frame",  default_value="livox_frame"),
        DeclareLaunchArgument("livox_x",      default_value="0.0"),
        DeclareLaunchArgument("livox_y",      default_value="0.0"),
        DeclareLaunchArgument("livox_z",      default_value="0.25"),
        DeclareLaunchArgument("livox_roll",   default_value="0.0"),
        DeclareLaunchArgument("livox_pitch",  default_value="0.0"),
        DeclareLaunchArgument("livox_yaw",    default_value="0.0"),
        DeclareLaunchArgument(
            "livox_config_file",
            default_value="/home/unitree/ws_livox/install/livox_ros_driver2/share/"
                          "livox_ros_driver2/config/MID360_config.json",
        ),
        DeclareLaunchArgument(
            "localization_params",
            default_value=PathJoinSubstitution(
                [FindPackageShare("g1_slam_bringup"), "config", "localization.yaml"]
            ),
        ),
        DeclareLaunchArgument(
            "nav2_params",
            default_value=PathJoinSubstitution(
                [FindPackageShare("g1_slam_bringup"), "config", "nav2_params.yaml"]
            ),
        ),
        DeclareLaunchArgument(
            "nav_bridge_params",
            default_value=PathJoinSubstitution(
                [FindPackageShare("g1_nav_bridge"), "config", "nav_bridge.yaml"]
            ),
        ),

        # ── 1. Livox LiDAR driver ────────────────────────────────────────────
        Node(
            condition=IfCondition(use_livox),
            package="livox_ros_driver2",
            executable="livox_ros_driver2_node",
            name="livox_lidar_publisher",
            output="screen",
            parameters=[{
                "xfer_format": 0,
                "multi_topic": 0,
                "data_src": 0,
                "publish_freq": 10.0,
                "output_data_type": 0,
                "frame_id": livox_frame,
                "user_config_path": livox_config,
                "cmdline_input_bd_code": "livox0000000001",
            }],
        ),

        # ── 2. Static TF: base_link → livox_frame ───────────────────────────
        Node(
            condition=IfCondition(
                PythonExpression(["'", use_livox, "' == 'true'"])
            ),
            package="tf2_ros",
            executable="static_transform_publisher",
            name="livox_static_tf",
            arguments=[
                livox_x, livox_y, livox_z,
                livox_roll, livox_pitch, livox_yaw,
                base_frame, livox_frame,
            ],
        ),

        # ── 3. PointCloud → LaserScan ────────────────────────────────────────
        Node(
            condition=IfCondition(use_livox),
            package="pointcloud_to_laserscan",
            executable="pointcloud_to_laserscan_node",
            name="livox_scan_converter",
            output="screen",
            remappings=[
                ("cloud_in", "/livox/lidar"),
                ("scan", "/scan_raw"),   # restamper republishes to scan_topic
            ],
            parameters=[{
                "target_frame": base_frame,
                "transform_tolerance": 0.1,
                "min_height": -0.15,
                "max_height": 0.15,
                "angle_min": -3.14159,
                "angle_max":  3.14159,
                "angle_increment": 0.0087,
                "scan_time": 0.1,
                "range_min": 0.1,
                "range_max": 30.0,
                "use_inf": True,
                "inf_epsilon": 1.0,
            }],
        ),

        # ── 3b. Scan restamper (fixes Livox hardware clock offset) ───────────
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

        # ── 4. Odometry TF broadcaster (odom → base_link) ───────────────────
        Node(
            package="g1_nav_bridge",
            executable="odom_tf_broadcaster",
            name="odom_tf_broadcaster",
            output="screen",
            parameters=[{"odom_topic": "/dog_odom"}],
        ),

        # ── 5. slam_toolbox in localization mode (map → odom TF + /map) ─────
        Node(
            package="slam_toolbox",
            executable="localization_slam_toolbox_node",
            name="slam_toolbox",
            output="screen",
            parameters=[
                localization_params,
                {
                    "use_sim_time": use_sim_time,
                    "base_frame":   base_frame,
                    "odom_frame":   odom_frame,
                    "map_frame":    map_frame,
                },
            ],
            remappings=[("scan", scan_topic), ("map", "slam_map")],
        ),

        # ── 6. Nav2 map_server (serves 2D pgm map to costmaps) ──────────────
        Node(
            package="nav2_map_server",
            executable="map_server",
            name="map_server",
            output="screen",
            parameters=[
                nav2_params,
                {"yaml_filename": map_yaml, "use_sim_time": use_sim_time},
            ],
        ),

        # ── 7. Nav2 controller server (Regulated Pure Pursuit) ───────────────
        Node(
            package="nav2_controller",
            executable="controller_server",
            name="controller_server",
            output="screen",
            parameters=[nav2_params, {"use_sim_time": use_sim_time}],
            remappings=[("cmd_vel", "/cmd_vel")],
        ),

        # ── 8. Nav2 planner server (NavFn / A*) ──────────────────────────────
        Node(
            package="nav2_planner",
            executable="planner_server",
            name="planner_server",
            output="screen",
            parameters=[nav2_params, {"use_sim_time": use_sim_time}],
        ),

        # ── 9. Nav2 behavior server (spin, backup, wait) ─────────────────────
        Node(
            package="nav2_behaviors",
            executable="behavior_server",
            name="behavior_server",
            output="screen",
            parameters=[nav2_params, {"use_sim_time": use_sim_time}],
        ),

        # ── 10. Nav2 BT navigator ────────────────────────────────────────────
        Node(
            package="nav2_bt_navigator",
            executable="bt_navigator",
            name="bt_navigator",
            output="screen",
            parameters=[nav2_params, {"use_sim_time": use_sim_time}],
        ),

        # ── 11. Nav2 lifecycle manager ───────────────────────────────────────
        Node(
            package="nav2_lifecycle_manager",
            executable="lifecycle_manager",
            name="lifecycle_manager_navigation",
            output="screen",
            parameters=[nav2_params, {"use_sim_time": use_sim_time}],
        ),

        # ── 12. cmd_vel → Unitree Sport API bridge ───────────────────────────
        Node(
            package="g1_nav_bridge",
            executable="cmdvel_to_sport",
            name="cmdvel_to_sport",
            output="screen",
            parameters=[nav_bridge_params],
        ),

        # ── 13. RViz ─────────────────────────────────────────────────────────
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
            parameters=[{"use_sim_time": use_sim_time}],
        ),
    ])
