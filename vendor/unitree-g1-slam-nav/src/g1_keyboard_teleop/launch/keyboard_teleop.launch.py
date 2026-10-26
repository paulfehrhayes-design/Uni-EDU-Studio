from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription(
        [
            Node(
                package="g1_keyboard_teleop",
                executable="keyboard_teleop",
                name="g1_keyboard_teleop",
                output="screen",
                emulate_tty=True,
            )
        ]
    )
