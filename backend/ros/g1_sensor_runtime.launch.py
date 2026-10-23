from pathlib import Path
import os

from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node


def generate_launch_description():
    ros_dir = Path(__file__).resolve().parent
    project_root = ros_dir.parent
    if not (project_root / "g1_23dof.urdf.txt").is_file():
        project_root = ros_dir.parents[1]
    urdf_path = os.getenv(
        "G1_SENSOR_URDF_PATH",
        str(project_root / "g1_23dof.urdf.txt"),
    )
    with open(urdf_path, "r", encoding="utf-8") as urdf_file:
        robot_description = urdf_file.read()
    provider_path = project_root / "ros_lidar_provider.py"
    if not provider_path.is_file():
        provider_path = project_root / "backend" / "ros_lidar_provider.py"
    state_bridge_path = str(ros_dir / "g1_joint_state_bridge.py")
    return LaunchDescription(
        [
            Node(
                package="robot_state_publisher",
                executable="robot_state_publisher",
                name="uni_edu_g1_robot_state_publisher",
                output="screen",
                parameters=[{"robot_description": robot_description}],
            ),
            ExecuteProcess(
                cmd=["python3", state_bridge_path],
                output="screen",
            ),
            ExecuteProcess(
                cmd=["python3", str(provider_path)],
                output="screen",
            ),
        ]
    )
