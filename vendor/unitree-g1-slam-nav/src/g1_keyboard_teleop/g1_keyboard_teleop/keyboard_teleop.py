#!/usr/bin/env python3
import select
import sys
import termios
import tty

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node


HELP = """
Unitree G1 keyboard teleop
--------------------------
w / s : forward / backward
a / d : turn left / right
q / e : increase / decrease linear speed
z / c : increase / decrease angular speed
space : immediate stop
x     : publish stop and exit
CTRL-C: exit
"""


class KeyboardTeleop(Node):
    def __init__(self):
        super().__init__("g1_keyboard_teleop")

        self.declare_parameter("cmd_vel_topic", "/cmd_vel")
        self.declare_parameter("linear_speed", 0.2)
        self.declare_parameter("angular_speed", 0.5)
        self.declare_parameter("linear_step", 0.05)
        self.declare_parameter("angular_step", 0.1)
        self.declare_parameter("max_linear_speed", 0.6)
        self.declare_parameter("max_angular_speed", 1.5)
        self.declare_parameter("publish_rate", 20.0)

        self.cmd_vel_topic = str(self.get_parameter("cmd_vel_topic").value)
        self.linear_speed = float(self.get_parameter("linear_speed").value)
        self.angular_speed = float(self.get_parameter("angular_speed").value)
        self.linear_step = float(self.get_parameter("linear_step").value)
        self.angular_step = float(self.get_parameter("angular_step").value)
        self.max_linear_speed = float(self.get_parameter("max_linear_speed").value)
        self.max_angular_speed = float(self.get_parameter("max_angular_speed").value)
        publish_rate = float(self.get_parameter("publish_rate").value)

        self.linear_cmd = 0.0
        self.angular_cmd = 0.0
        self.should_exit = False

        self.publisher = self.create_publisher(Twist, self.cmd_vel_topic, 10)
        self.timer = self.create_timer(1.0 / publish_rate, self.publish_cmd)

        self.get_logger().info(f"Publishing Twist commands to {self.cmd_vel_topic}")
        self.print_help()
        self.print_status()

    def print_help(self):
        print(HELP)

    def print_status(self):
        print(
            f"linear_speed={self.linear_speed:.2f} m/s, "
            f"angular_speed={self.angular_speed:.2f} rad/s, "
            f"command=({self.linear_cmd:.2f}, {self.angular_cmd:.2f})"
        )

    def clamp(self, value, limit):
        return max(-limit, min(limit, value))

    def update_command(self, key):
        if key == "w":
            self.linear_cmd = self.linear_speed
        elif key == "s":
            self.linear_cmd = -self.linear_speed
        elif key == "a":
            self.angular_cmd = self.angular_speed
        elif key == "d":
            self.angular_cmd = -self.angular_speed
        elif key == " ":
            self.linear_cmd = 0.0
            self.angular_cmd = 0.0
        elif key == "q":
            self.linear_speed = min(
                self.linear_speed + self.linear_step,
                self.max_linear_speed,
            )
        elif key == "e":
            self.linear_speed = max(0.0, self.linear_speed - self.linear_step)
        elif key == "z":
            self.angular_speed = min(
                self.angular_speed + self.angular_step,
                self.max_angular_speed,
            )
        elif key == "c":
            self.angular_speed = max(0.0, self.angular_speed - self.angular_step)
        elif key == "x":
            self.linear_cmd = 0.0
            self.angular_cmd = 0.0
            self.should_exit = True

        self.linear_cmd = self.clamp(self.linear_cmd, self.max_linear_speed)
        self.angular_cmd = self.clamp(self.angular_cmd, self.max_angular_speed)
        self.print_status()

    def stop_motion(self):
        if self.linear_cmd == 0.0 and self.angular_cmd == 0.0:
            return
        self.linear_cmd = 0.0
        self.angular_cmd = 0.0
        self.print_status()

    def publish_cmd(self):
        msg = Twist()
        msg.linear.x = self.linear_cmd
        msg.angular.z = self.angular_cmd
        self.publisher.publish(msg)


def get_key(settings):
    tty.setraw(sys.stdin.fileno())
    ready, _, _ = select.select([sys.stdin], [], [], 0.1)
    key = sys.stdin.read(1) if ready else ""
    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, settings)
    return key


def main():
    settings = termios.tcgetattr(sys.stdin)
    rclpy.init()
    node = KeyboardTeleop()

    try:
        while rclpy.ok() and not node.should_exit:
            key = get_key(settings)
            if key:
                if key == "\x03":
                    break
                node.update_command(key)
            else:
                node.stop_motion()
            rclpy.spin_once(node, timeout_sec=0.0)
    except KeyboardInterrupt:
        pass
    finally:
        node.linear_cmd = 0.0
        node.angular_cmd = 0.0
        node.publish_cmd()
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, settings)
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
