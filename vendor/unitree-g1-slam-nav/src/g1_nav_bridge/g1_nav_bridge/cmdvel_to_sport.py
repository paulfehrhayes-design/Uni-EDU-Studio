#!/usr/bin/env python3
import json
import time

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from unitree_api.msg import Request


ROBOT_API_ID_LOCO_SET_VELOCITY = 7105


class CmdVelToSport(Node):
    def __init__(self):
        super().__init__("cmdvel_to_sport")

        self.declare_parameter("cmd_vel_topic", "/cmd_vel")
        self.declare_parameter("sport_request_topic", "/api/sport/request")
        self.declare_parameter("rate_hz", 30.0)
        self.declare_parameter("timeout_s", 0.25)
        self.declare_parameter("max_vx", 0.20)
        self.declare_parameter("max_vy", 0.00)
        self.declare_parameter("max_wz", 0.30)
        self.declare_parameter("command_duration", 1.0)

        self.cmd_vel_topic = self.get_parameter("cmd_vel_topic").value
        self.sport_request_topic = self.get_parameter("sport_request_topic").value
        self.rate_hz = float(self.get_parameter("rate_hz").value)
        self.timeout_s = float(self.get_parameter("timeout_s").value)
        self.command_duration = float(self.get_parameter("command_duration").value)

        self.max_vx = float(self.get_parameter("max_vx").value)
        self.max_vy = float(self.get_parameter("max_vy").value)
        self.max_wz = float(self.get_parameter("max_wz").value)

        self.pub = self.create_publisher(Request, self.sport_request_topic, 10)
        self.sub = self.create_subscription(Twist, self.cmd_vel_topic, self.on_cmd_vel, 10)

        self.last_cmd_time = 0.0
        self.vx = 0.0
        self.vy = 0.0
        self.wz = 0.0

        self.timer = self.create_timer(1.0 / self.rate_hz, self.on_timer)
        self.get_logger().info(f"cmd_vel -> sport bridge running @ {self.rate_hz} Hz")

    def clamp(self, x, lo, hi):
        return max(lo, min(hi, x))

    def on_cmd_vel(self, msg: Twist):
        self.vx = self.clamp(msg.linear.x, -self.max_vx, self.max_vx)
        self.vy = self.clamp(msg.linear.y, -self.max_vy, self.max_vy)
        self.wz = self.clamp(msg.angular.z, -self.max_wz, self.max_wz)
        self.last_cmd_time = time.time()

    def _set_attr_if_present(self, obj, name, value) -> bool:
        if hasattr(obj, name):
            setattr(obj, name, value)
            return True
        return False

    def build_sport_move_request(self, vx: float, vy: float, wz: float) -> Request:
        req = Request()

        request_id = time.monotonic_ns()
        parameter = json.dumps(
            {
                "velocity": [vx, vy, wz],
                "duration": self.command_duration,
            }
        )

        header = getattr(req, "header", None)
        if header is None:
            raise AttributeError("unitree_api/Request is missing header")

        identity = getattr(header, "identity", None)
        lease = getattr(header, "lease", None)
        policy = getattr(header, "policy", None)
        if identity is None or lease is None or policy is None:
            raise AttributeError("unitree_api/Request header is missing nested fields")

        if not self._set_attr_if_present(identity, "id", request_id):
            raise AttributeError("unitree_api/Request.header.identity is missing id")
        if not self._set_attr_if_present(identity, "api_id", ROBOT_API_ID_LOCO_SET_VELOCITY):
            raise AttributeError("unitree_api/Request.header.identity is missing api_id")
        if not self._set_attr_if_present(lease, "id", 0):
            raise AttributeError("unitree_api/Request.header.lease is missing id")
        if not self._set_attr_if_present(policy, "priority", 0):
            raise AttributeError("unitree_api/Request.header.policy is missing priority")
        if not self._set_attr_if_present(policy, "noreply", False):
            raise AttributeError("unitree_api/Request.header.policy is missing noreply")

        if not self._set_attr_if_present(req, "parameter", parameter):
            raise AttributeError("unitree_api/Request is missing parameter")
        if hasattr(req, "binary"):
            req.binary = []

        return req

    def on_timer(self):
        now = time.time()
        timed_out = (now - self.last_cmd_time) > self.timeout_s
        if timed_out:
            vx, vy, wz = 0.0, 0.0, 0.0
        else:
            vx, vy, wz = self.vx, self.vy, self.wz
        req = self.build_sport_move_request(vx, vy, wz)
        self.pub.publish(req)

def main():
    rclpy.init()
    node = CmdVelToSport()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == "__main__":
    main()
