from glob import glob
import os

from setuptools import setup

package_name = "g1_keyboard_teleop"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        (
            "share/ament_index/resource_index/packages",
            ["resource/" + package_name],
        ),
        ("share/" + package_name, ["package.xml"]),
        (os.path.join("share", package_name, "launch"), glob("launch/*.py")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="unitree",
    maintainer_email="unitree@todo.todo",
    description="Keyboard teleoperation for Unitree G1 using ROS 2 Twist commands.",
    license="MIT",
    tests_require=["pytest"],
    entry_points={
        "console_scripts": [
            "keyboard_teleop = g1_keyboard_teleop.keyboard_teleop:main",
        ],
    },
)
