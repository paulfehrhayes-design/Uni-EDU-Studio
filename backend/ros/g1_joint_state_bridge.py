#!/usr/bin/env python3

import os
import sys
from pathlib import Path

import rclpy
from geometry_msgs.msg import TransformStamped
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState
from tf2_ros.static_transform_broadcaster import StaticTransformBroadcaster
from unitree_hg.msg import LowState
from g1_joint_state import joint_state_values

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sensor_calibration import automatic_calibration_model


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
        self.mount_confirmed = os.getenv("G1_LIDAR_MOUNT_CONFIRMED", "0") == "1"
        self.static_broadcaster = StaticTransformBroadcaster(self)
        self.received_state = False
        if self.mount_confirmed:
            self.publish_sensor_frame_alias()
        else:
            self.get_logger().warning(
                "MID-360 mount is not confirmed; no model-derived transform to the "
                "cloud frame will be published and distance conditions stay disabled."
            )

    def publish_sensor_frame_alias(self):
        model = automatic_calibration_model()
        mount = model["mount"]
        transform = TransformStamped()
        transform.header.stamp = self.get_clock().now().to_msg()
        transform.header.frame_id = mount["parent_frame"]
        transform.child_frame_id = os.getenv("G1_DISTANCE_FRAME_ID", "").strip()
        if not transform.child_frame_id:
            raise ValueError("G1_DISTANCE_FRAME_ID is required for the sensor frame alias.")
        transform.transform.translation.x = mount["translation_m"][0]
        transform.transform.translation.y = mount["translation_m"][1]
        transform.transform.translation.z = mount["translation_m"][2]
        (
            transform.transform.rotation.x,
            transform.transform.rotation.y,
            transform.transform.rotation.z,
            transform.transform.rotation.w,
        ) = mount["rotation_xyzw"]
        self.static_broadcaster.sendTransform(transform)
        self.get_logger().info(
            "Publishing the explicitly confirmed G1 model mount {} -> {}.".format(
                transform.header.frame_id, transform.child_frame_id
            )
        )

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
