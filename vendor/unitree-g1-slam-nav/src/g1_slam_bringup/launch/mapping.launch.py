"""
mapping.launch.py  –  Full G1 mapping bringup
Starts:
  1. SLAM (Livox + pointcloud_to_laserscan + slam_toolbox)
  2. cmd_vel → Sport API bridge  (g1_nav_bridge)
  3. Keyboard teleoperation        (g1_keyboard_teleop)

Usage:
  ros2 launch g1_slam_bringup mapping.launch.py use_livox:=true

Save the map when done:
  bash /home/unitree/ws_slam/src/g1_slam_bringup/scripts/save_map.sh
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    use_livox      = LaunchConfiguration("use_livox")
    use_sim_time   = LaunchConfiguration("use_sim_time")
    base_frame     = LaunchConfiguration("base_frame")
    odom_frame     = LaunchConfiguration("odom_frame")
    map_frame      = LaunchConfiguration("map_frame")
    livox_x        = LaunchConfiguration("livox_x")
    livox_y        = LaunchConfiguration("livox_y")
    livox_z        = LaunchConfiguration("livox_z")
    livox_roll     = LaunchConfiguration("livox_roll")
    livox_pitch    = LaunchConfiguration("livox_pitch")
    livox_yaw      = LaunchConfiguration("livox_yaw")
    nav_bridge_params = LaunchConfiguration("nav_bridge_params")
    use_rviz       = LaunchConfiguration("use_rviz")
    rviz_config    = LaunchConfiguration("rviz_config")

    return LaunchDescription(
        [
            # ── Arguments ───────────────────────────────────────────────────
            DeclareLaunchArgument("use_livox",    default_value="true"),
            DeclareLaunchArgument("use_sim_time", default_value="false"),
            DeclareLaunchArgument("base_frame",   default_value="robot_center"),
            DeclareLaunchArgument("odom_frame",   default_value="odom"),
            DeclareLaunchArgument("map_frame",    default_value="map"),
            DeclareLaunchArgument("livox_x",      default_value="0.0"),
            DeclareLaunchArgument("livox_y",      default_value="0.0"),
            DeclareLaunchArgument("livox_z",      default_value="0.25"),
            DeclareLaunchArgument("livox_roll",   default_value="0.0"),
            DeclareLaunchArgument("livox_pitch",  default_value="0.0"),
            DeclareLaunchArgument("livox_yaw",    default_value="0.0"),
            DeclareLaunchArgument(
                "nav_bridge_params",
                default_value=PathJoinSubstitution(
                    [FindPackageShare("g1_nav_bridge"), "config", "nav_bridge.yaml"]
                ),
            ),
            DeclareLaunchArgument("use_rviz", default_value="true"),
            DeclareLaunchArgument(
                "rviz_config",
                default_value=PathJoinSubstitution(
                    [FindPackageShare("g1_slam_bringup"), "config", "mapping.rviz"]
                ),
            ),

            # ── 1. SLAM pipeline ─────────────────────────────────────────
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    PathJoinSubstitution(
                        [FindPackageShare("g1_slam_bringup"), "launch", "online_slam.launch.py"]
                    )
                ),
                launch_arguments={
                    "use_livox":    use_livox,
                    "use_sim_time": use_sim_time,
                    "use_rviz":     "false",    # mapping.launch.py handles RViz itself
                    "base_frame":   base_frame,
                    "odom_frame":   odom_frame,
                    "map_frame":    map_frame,
                    "livox_x":      livox_x,
                    "livox_y":      livox_y,
                    "livox_z":      livox_z,
                    "livox_roll":   livox_roll,
                    "livox_pitch":  livox_pitch,
                    "livox_yaw":    livox_yaw,
                }.items(),
            ),

            # ── 2. cmd_vel → Sport API bridge ────────────────────────────
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    PathJoinSubstitution(
                        [FindPackageShare("g1_nav_bridge"), "launch", "nav_bridge.launch.py"]
                    )
                ),
                launch_arguments={
                    "params_file": nav_bridge_params,
                }.items(),
            ),

            # ── 3. Keyboard teleoperation ────────────────────────────────
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(
                    PathJoinSubstitution(
                        [FindPackageShare("g1_keyboard_teleop"), "launch", "keyboard_teleop.launch.py"]
                    )
                ),
            ),

            # ── 4. RViz ──────────────────────────────────────────────────
            Node(
                condition=IfCondition(use_rviz),
                package="rviz2",
                executable="rviz2",
                name="rviz2",
                output="screen",
                arguments=["-d", rviz_config],
                parameters=[{"use_sim_time": use_sim_time}],
            ),
        ]
    )
