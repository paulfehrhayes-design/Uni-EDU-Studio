#!/usr/bin/env python3
"""
G1内蔵SLAMの点群を蓄積してPCDマップとして保存するスクリプト

G1が既に動かしているSLAMの出力トピック:
  /unitree/slam_mapping/points  (PointCloud2)
  /unitree/slam_mapping/odom    (Odometry)

Usage:
  source ~/workspace/sakai/g1_lidar/setup_env.bash
  python3 ~/workspace/sakai/g1_lidar/scripts/save_map.py

  # G1を歩かせてマッピング → Ctrl+C で停止するとPCDを保存
"""
import sys
import signal
import struct
import numpy as np

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from sensor_msgs.msg import PointCloud2
from nav_msgs.msg import Odometry

SAVE_PATH = "/home/ubuntu/workspace/sakai/g1_lidar/maps/g1_map.pcd"


class MapCollector(Node):
    def __init__(self):
        super().__init__('map_collector')
        self.points = []
        self.frame_count = 0

        qos = QoSProfile(
            depth=10,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.VOLATILE
        )

        self.sub_points = self.create_subscription(
            PointCloud2,
            '/cloud_registered_1',
            self.points_cb,
            qos
        )
        self.sub_odom = self.create_subscription(
            Odometry,
            '/Odometry_loc',
            self.odom_cb,
            qos
        )
        self.get_logger().info('Map collector started. Walk the G1 around, then Ctrl+C to save.')

    def pointcloud2_to_xyz(self, msg: PointCloud2):
        point_step = msg.point_step
        data = msg.data
        n_points = msg.width * msg.height

        x_off = y_off = z_off = 0
        for field in msg.fields:
            if field.name == 'x':
                x_off = field.offset
            elif field.name == 'y':
                y_off = field.offset
            elif field.name == 'z':
                z_off = field.offset

        pts = np.zeros((n_points, 3), dtype=np.float32)
        for i in range(n_points):
            base = i * point_step
            pts[i, 0] = struct.unpack_from('f', data, base + x_off)[0]
            pts[i, 1] = struct.unpack_from('f', data, base + y_off)[0]
            pts[i, 2] = struct.unpack_from('f', data, base + z_off)[0]
        return pts

    def points_cb(self, msg: PointCloud2):
        pts = self.pointcloud2_to_xyz(msg)
        valid = np.isfinite(pts).all(axis=1)
        pts = pts[valid]
        if len(pts) > 0:
            self.points.append(pts)
            self.frame_count += 1
            total = sum(len(p) for p in self.points)
            if self.frame_count % 10 == 0:
                self.get_logger().info(
                    f'Frame {self.frame_count}: {len(pts)} pts | Total: {total} pts')

    def odom_cb(self, msg: Odometry):
        if self.frame_count % 50 == 0:
            p = msg.pose.pose.position
            self.get_logger().info(f'Position: x={p.x:.2f} y={p.y:.2f} z={p.z:.2f}')

    def save_pcd(self, path: str):
        if not self.points:
            self.get_logger().warn('No points collected, nothing to save.')
            return

        all_pts = np.vstack(self.points)
        self.get_logger().info(f'Saving {len(all_pts)} points to {path}')

        with open(path, 'w') as f:
            f.write('# .PCD v0.7 - Point Cloud Data file format\n')
            f.write('VERSION 0.7\n')
            f.write('FIELDS x y z\n')
            f.write('SIZE 4 4 4\n')
            f.write('TYPE F F F\n')
            f.write('COUNT 1 1 1\n')
            f.write(f'WIDTH {len(all_pts)}\n')
            f.write('HEIGHT 1\n')
            f.write('VIEWPOINT 0 0 0 1 0 0 0\n')
            f.write(f'POINTS {len(all_pts)}\n')
            f.write('DATA ascii\n')
            for pt in all_pts:
                f.write(f'{pt[0]:.6f} {pt[1]:.6f} {pt[2]:.6f}\n')

        self.get_logger().info(f'Map saved: {path}')


def main():
    rclpy.init()
    node = MapCollector()

    def shutdown_handler(sig, frame):
        node.get_logger().info('Shutting down, saving map...')
        node.save_pcd(SAVE_PATH)
        node.destroy_node()
        rclpy.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    rclpy.spin(node)


if __name__ == '__main__':
    main()
