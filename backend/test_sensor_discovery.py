import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

try:
    from . import sensor_discovery
    from .sensor_discovery import _read_topic_sample
except ImportError:
    import sensor_discovery
    from sensor_discovery import _read_topic_sample


class SensorDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.os_release = os.path.join(self.temp_dir.name, "os-release")
        with open(self.os_release, "w", encoding="utf-8") as output:
            output.write('ID="ubuntu"\nVERSION_ID="22.04"\n')
        self.now = 1_800_000_000.0
        self.env = {"XDG_CONFIG_HOME": self.temp_dir.name}
        self.echo_commands = []

    def run_discovery(self, responses, **kwargs):
        def runner(command, **_options):
            if command[-5:] == ["-4", "-j", "address", "show", "up"]:
                stdout = responses.get(
                    "interfaces",
                    json.dumps(
                        [
                            {
                                "ifname": "eth0",
                                "addr_info": [
                                    {
                                        "family": "inet",
                                        "local": "192.168.123.164",
                                        "prefixlen": 24,
                                    }
                                ],
                            }
                        ]
                    ),
                )
            elif command[1:4] == ["topic", "list", "-t"]:
                stdout = responses.get("topics", "")
            elif "echo" in command:
                self.echo_commands.append(command)
                self.assertNotIn("--once", command)
                self.assertNotIn("--field", command)
                topic = command[command.index("echo") + 1]
                stdout = responses.get("headers", {}).get(topic, "")
            elif "systemctl" in command[0]:
                stdout = responses.get("service", "inactive")
            else:
                raise AssertionError("Unexpected discovery command: {!r}".format(command))
            return subprocess.CompletedProcess(command, 0, stdout, "")

        return sensor_discovery.discover_sensors(
            env=self.env,
            runner=runner,
            now_seconds=self.now,
            os_release_path=self.os_release,
            ros2_executable="/usr/bin/ros2",
            ip_executable="/usr/sbin/ip",
            systemctl_executable=kwargs.get("systemctl_executable"),
        )

    def test_missing_network_settings_are_reported_without_guessing(self):
        report = self.run_discovery({})

        self.assertEqual(report["connection"]["method"], "unavailable")
        self.assertIn("will be guessed", report["connection"]["reason"])
        self.assertIsNone(report["network"]["host_ip"])
        self.assertIsNone(report["network"]["device_ip"])

    def test_topic_echo_uses_sensor_data_qos_and_reads_one_header(self):
        message = (
            "header:\n"
            "  stamp:\n"
            "    sec: 1799999999\n"
            "    nanosec: 900000000\n"
            "  frame_id: livox_frame\n"
        )
        script = "import sys,time; print({!r}, flush=True); time.sleep(5)".format(message)
        started_at = time.monotonic()

        output, error = _read_topic_sample(
            [sys.executable, "-u", "-c", script],
            "/mid360/points",
            timeout=1.0,
        )

        self.assertIsNone(error)
        self.assertIn("frame_id: livox_frame", output)
        self.assertLess(time.monotonic() - started_at, 1.0)

    def test_configured_direct_livox_network_is_validated(self):
        self.env.update(
            {
                "G1_LIDAR_HOST_IP": "192.168.123.164",
                "G1_LIDAR_DEVICE_IP": "192.168.123.120",
            }
        )

        report = self.run_discovery({})

        self.assertEqual(report["connection"]["method"], "direct_livox")
        self.assertTrue(report["network"]["direct_network_valid"])
        self.assertEqual(report["connection"]["host_interface"], "eth0")
        self.assertTrue(report["connection"]["driver_required"])
        self.assertIn("presence is not yet verified", report["connection"]["reason"])

    def test_saved_direct_network_settings_are_reused_after_restart(self):
        config_dir = os.path.join(self.temp_dir.name, "uni-edu-studio")
        os.makedirs(config_dir)
        with open(os.path.join(config_dir, "lidar.env"), "w", encoding="utf-8") as output:
            output.write(
                "G1_LIDAR_HOST_IP=192.168.123.164\n"
                "G1_LIDAR_DEVICE_IP=192.168.123.120\n"
            )

        report = self.run_discovery({})

        self.assertEqual(report["connection"]["method"], "direct_livox")
        self.assertTrue(report["network"]["direct_network_valid"])

    def test_device_outside_active_subnet_is_rejected(self):
        self.env.update(
            {
                "G1_LIDAR_HOST_IP": "192.168.123.164",
                "G1_LIDAR_DEVICE_IP": "192.168.124.120",
            }
        )

        report = self.run_discovery({})

        self.assertEqual(report["connection"]["method"], "unavailable")
        self.assertIn("not on the active subnet", report["connection"]["reason"])

    def test_fresh_unitree_pointcloud_is_reused_without_starting_livox(self):
        self.now = 1_800_000_000.0
        report = self.run_discovery(
            {
                "topics": (
                    "/collision_clouds [sensor_msgs/msg/PointCloud2]\n"
                    "/grid_clouds [sensor_msgs/msg/PointCloud2]\n"
                    "/safe_clouds [sensor_msgs/msg/PointCloud2]\n"
                    "/rt/utlidar/cloud [sensor_msgs/msg/PointCloud2]\n"
                ),
                "headers": {
                    "/rt/utlidar/cloud": (
                        "stamp:\n"
                        "  sec: 1799999999\n"
                        "  nanosec: 900000000\n"
                        "frame_id: utlidar_lidar\n"
                    )
                },
            }
        )

        self.assertEqual(report["connection"]["method"], "unitree_ros_pointcloud")
        self.assertTrue(report["connection"]["ready"])
        self.assertFalse(report["connection"]["driver_required"])
        self.assertEqual(report["connection"]["topic"], "/rt/utlidar/cloud")
        self.assertEqual(report["connection"]["frame_id"], "utlidar_lidar")
        self.assertEqual(
            self.echo_commands,
            [
                [
                    "/usr/bin/ros2",
                    "topic",
                    "echo",
                    "/rt/utlidar/cloud",
                    "--qos-reliability",
                    "best_effort",
                    "--qos-durability",
                    "volatile",
                ]
            ],
        )

    def test_saved_topic_without_fresh_samples_is_reused_for_provider_recovery(self):
        config_dir = os.path.join(self.temp_dir.name, "uni-edu-studio")
        os.makedirs(config_dir)
        with open(os.path.join(config_dir, "lidar.env"), "w", encoding="utf-8") as output:
            output.write(
                "G1_LIDAR_TOPIC=/mid360/livox/lidar\n"
                "G1_DISTANCE_FRAME_ID=livox_frame\n"
                "G1_DISTANCE_SENSOR_ID=mid360-front\n"
            )

        report = self.run_discovery(
            {
                "topics": (
                    "/collision_clouds [sensor_msgs/msg/PointCloud2]\n"
                    "/grid_clouds [sensor_msgs/msg/PointCloud2]\n"
                    "/mid360/livox/lidar [sensor_msgs/msg/PointCloud2]\n"
                    "/utlidar/cloud_livox_mid360 [sensor_msgs/msg/PointCloud2]\n"
                ),
                "headers": {},
            }
        )

        self.assertEqual(
            report["connection"]["method"], "existing_ros_pointcloud_unverified"
        )
        self.assertFalse(report["connection"]["ready"])
        self.assertFalse(report["connection"]["driver_required"])
        self.assertEqual(report["connection"]["topic"], "/mid360/livox/lidar")
        self.assertEqual(report["connection"]["frame_id"], "livox_frame")
        self.assertIn("distance remains unavailable", report["connection"]["reason"])

    def test_stale_pointcloud_is_not_reported_as_ready(self):
        report = self.run_discovery(
            {
                "topics": "/mid360/points [sensor_msgs/msg/PointCloud2]\n",
                "headers": {
                    "/mid360/points": (
                        "stamp:\n"
                        "  sec: 1799999999\n"
                        "  nanosec: 0\n"
                        "frame_id: livox_frame\n"
                    )
                },
            }
        )

        self.assertEqual(report["connection"]["method"], "unsupported_existing_sensor_topic")
        self.assertFalse(report["connection"]["ready"])
        self.assertIn("stale", " ".join(report["diagnostics"]))

    def test_invalid_pointcloud_header_is_not_reported_as_ready(self):
        report = self.run_discovery(
            {
                "topics": "/mid360/points [sensor_msgs/msg/PointCloud2]\n",
                "headers": {
                    "/mid360/points": (
                        "stamp:\n"
                        "  sec: 1799999999\n"
                        "  nanosec: 1000000000\n"
                        "frame_id: livox_frame\n"
                    )
                },
            }
        )

        self.assertEqual(report["connection"]["method"], "unsupported_existing_sensor_topic")
        self.assertFalse(report["connection"]["ready"])
        self.assertIn("invalid frame or timestamp", " ".join(report["diagnostics"]))

    def test_unidentified_pointcloud_is_not_assumed_to_be_lidar(self):
        report = self.run_discovery(
            {
                "topics": "/points [sensor_msgs/msg/PointCloud2]\n",
                "headers": {
                    "/points": (
                        "stamp:\n"
                        "  sec: 1799999999\n"
                        "  nanosec: 900000000\n"
                        "frame_id: cloud_frame\n"
                    )
                },
            }
        )

        self.assertEqual(report["connection"]["method"], "unsupported_existing_sensor_topic")
        self.assertFalse(report["connection"]["driver_required"])
        self.assertIn("identity is ambiguous", report["connection"]["reason"])

    def test_active_driver_is_not_duplicated_when_no_cloud_is_available(self):
        def runner(command, **_options):
            if command[0] == "/usr/sbin/ip":
                return subprocess.CompletedProcess(command, 0, "[]", "")
            if command[1:4] == ["topic", "list", "-t"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            if command[0] == "/usr/bin/systemctl":
                state = "active" if "uni-edu-lidar-driver.service" in command else "inactive"
                return subprocess.CompletedProcess(command, 0, state, "")
            raise AssertionError("Unexpected discovery command: {!r}".format(command))

        report = sensor_discovery.discover_sensors(
            env=self.env,
            runner=runner,
            now_seconds=self.now,
            os_release_path=self.os_release,
            ros2_executable="/usr/bin/ros2",
            ip_executable="/usr/sbin/ip",
            systemctl_executable="/usr/bin/systemctl",
        )

        self.assertEqual(report["connection"]["method"], "existing_driver")
        self.assertFalse(report["connection"]["driver_required"])
        self.assertIn("will not be duplicated", report["connection"]["reason"])

    def test_running_livox_process_is_not_duplicated(self):
        proc_root = os.path.join(self.temp_dir.name, "proc")
        command_line = os.path.join(proc_root, "2345")
        os.makedirs(command_line)
        with open(os.path.join(command_line, "cmdline"), "wb") as output:
            output.write(b"/opt/livox_ros_driver2/livox_ros_driver2_node\0")

        def runner(command, **_options):
            if command[0] == "/usr/sbin/ip":
                return subprocess.CompletedProcess(command, 0, "[]", "")
            if command[1:4] == ["topic", "list", "-t"]:
                return subprocess.CompletedProcess(command, 0, "", "")
            if command[0] == "/usr/bin/systemctl":
                return subprocess.CompletedProcess(command, 0, "inactive", "")
            raise AssertionError("Unexpected discovery command: {!r}".format(command))

        report = sensor_discovery.discover_sensors(
            env=self.env,
            runner=runner,
            now_seconds=self.now,
            os_release_path=self.os_release,
            ros2_executable="/usr/bin/ros2",
            ip_executable="/usr/sbin/ip",
            systemctl_executable="/usr/bin/systemctl",
            proc_root=proc_root,
        )

        self.assertEqual(report["connection"]["method"], "existing_driver")
        self.assertFalse(report["connection"]["driver_required"])
        self.assertEqual(report["driver_processes"][0]["pid"], "2345")

    def test_multiple_fresh_pointclouds_are_reported_as_ambiguous(self):
        fresh_header = (
            "stamp:\n"
            "  sec: 1799999999\n"
            "  nanosec: 900000000\n"
            "frame_id: sensor_frame\n"
        )

        report = self.run_discovery(
            {
                "topics": (
                    "/lidar/front [sensor_msgs/msg/PointCloud2]\n"
                    "/lidar/rear [sensor_msgs/msg/PointCloud2]\n"
                ),
                "headers": {
                    "/lidar/front": fresh_header,
                    "/lidar/rear": fresh_header,
                },
            }
        )

        self.assertEqual(report["connection"]["method"], "ambiguous")
        self.assertFalse(report["connection"]["ready"])
        self.assertIn("Multiple fresh", report["connection"]["reason"])


if __name__ == "__main__":
    unittest.main()
