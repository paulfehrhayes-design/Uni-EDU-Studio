# g1_keyboard_teleop

ROS 2 keyboard teleop package for Unitree G1.

This node publishes `geometry_msgs/msg/Twist` on `/cmd_vel` by default.
Use it together with a bridge that converts `/cmd_vel` into Unitree sport API requests.
