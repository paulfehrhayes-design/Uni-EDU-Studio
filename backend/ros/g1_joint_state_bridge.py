#!/usr/bin/env python3

import os
import sys
from pathlib import Path

import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState
from unitree_hg.msg import LowState
from g1_joint_state import joint_state_values

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class G1JointStateBridge(Node):
    def __init__(self):
        super().__init__("uni_edu_g1_joint_state_bridge")
        self.joint_publisher = self.create_publisher(JointState, "/joint_states", 10)
        self.create_subscription(
            LowState,
            os.getenv("G1_LIDAR_LOWSTATE_TOPIC", "/lowstate"),
            self.on_low_state,
            qos_profile_sensor_data,
        )
        self.received_state = False

    def on_low_state(self, message):
        try:
            names, positions = joint_state_values(message.motor_state)
        except (TypeError, ValueError) as error:
            self.get_logger().warning("Ignoring invalid G1 LowState: {}".format(error))
            return
        joint_state = JointState()
        joint_state.header.stamp = self.get_clock().now().to_msg()
        joint_state.name = names
        joint_state.position = positions
        self.joint_publisher.publish(joint_state)
        if not self.received_state:
            self.get_logger().info(
                "Publishing supported G1 joint states from {}.".format(
                    os.getenv("G1_LIDAR_LOWSTATE_TOPIC", "/lowstate")
                )
            )
            self.received_state = True


def main():
    rclpy.init()
    node = G1JointStateBridge()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
