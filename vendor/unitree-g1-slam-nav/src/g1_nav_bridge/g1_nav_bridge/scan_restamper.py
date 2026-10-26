"""
scan_restamper.py
Republishes LaserScan messages with the current ROS clock timestamp,
replacing the hardware timestamp from the Livox LiDAR.
This fixes slam_toolbox TF lookup failures caused by the Livox hardware
clock being out of sync with the system clock.
"""

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import LaserScan

# Match the BEST_EFFORT QoS used by pointcloud_to_laserscan and slam_toolbox
SENSOR_QOS = QoSProfile(
    reliability=ReliabilityPolicy.BEST_EFFORT,
    history=HistoryPolicy.KEEP_LAST,
    depth=5,
)


class ScanRestamper(Node):
    def __init__(self):
        super().__init__('scan_restamper')
        self.declare_parameter('input_topic', '/scan_raw')
        self.declare_parameter('output_topic', '/scan')

        in_topic = self.get_parameter('input_topic').get_parameter_value().string_value
        out_topic = self.get_parameter('output_topic').get_parameter_value().string_value

        self.pub = self.create_publisher(LaserScan, out_topic, 10)  # RELIABLE for all subscribers
        self.sub = self.create_subscription(LaserScan, in_topic, self.callback, SENSOR_QOS)  # BEST_EFFORT to match livox
        self.get_logger().info(f'Restamping {in_topic} → {out_topic}')

    def callback(self, msg: LaserScan):
        msg.header.stamp = self.get_clock().now().to_msg()
        self.pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = ScanRestamper()
    rclpy.spin(node)
    rclpy.shutdown()
