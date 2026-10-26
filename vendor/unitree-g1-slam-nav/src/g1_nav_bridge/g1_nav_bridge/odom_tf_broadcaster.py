import rclpy
from rclpy.node import Node
from nav_msgs.msg import Odometry
from geometry_msgs.msg import TransformStamped
from tf2_ros import TransformBroadcaster


class OdomTfBroadcaster(Node):
    def __init__(self):
        super().__init__('odom_tf_broadcaster')
        self.declare_parameter('odom_topic', '/dog_odom')
        odom_topic = self.get_parameter('odom_topic').get_parameter_value().string_value
        self._tf_broadcaster = TransformBroadcaster(self)
        self.create_subscription(Odometry, odom_topic, self._odom_cb, 10)
        self.get_logger().info(f'Broadcasting TF from odometry topic: {odom_topic}')

    def _odom_cb(self, msg: Odometry):
        t = TransformStamped()
        t.header.stamp = self.get_clock().now().to_msg()  # use ROS clock, not robot hardware clock
        t.header.frame_id = msg.header.frame_id
        t.child_frame_id = msg.child_frame_id
        t.transform.translation.x = msg.pose.pose.position.x
        t.transform.translation.y = msg.pose.pose.position.y
        t.transform.translation.z = msg.pose.pose.position.z
        t.transform.rotation = msg.pose.pose.orientation
        self._tf_broadcaster.sendTransform(t)


def main(args=None):
    rclpy.init(args=args)
    node = OdomTfBroadcaster()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()
