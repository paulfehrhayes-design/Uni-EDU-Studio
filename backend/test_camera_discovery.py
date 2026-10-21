import os
import subprocess
import tempfile
import unittest

try:
    from .camera_discovery import discover_camera_sources
except ImportError:
    from camera_discovery import discover_camera_sources


class CameraDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.now = 1_800_000_000.0
        self.echo_commands = []

    def write_usb_device(self, path_name, fields):
        device_dir = os.path.join(self.temp_dir.name, path_name)
        os.makedirs(device_dir)
        for name, value in fields.items():
            with open(os.path.join(device_dir, name), "w", encoding="utf-8") as output:
                output.write(value)

    def run_discovery(self, topics="", headers=None, intrinsics=None):
        fresh_header = (
            "stamp:\n"
            "  sec: 1799999999\n"
            "  nanosec: 900000000\n"
            "frame_id: camera_optical_frame\n"
        )

        def runner(command, **_options):
            if command[1:4] == ["topic", "list", "-t"]:
                stdout = topics
            elif "echo" in command:
                self.echo_commands.append(command)
                self.assertNotIn("--once", command)
                self.assertNotIn("--field", command)
                topic = command[command.index("echo") + 1]
                stdout = (headers or {}).get(topic, fresh_header)
                if "camera_info" in topic:
                    matrix = (intrinsics or {}).get(
                        topic,
                        "600.0\n0.0\n320.0\n0.0\n600.0\n240.0\n0.0\n0.0\n1.0\n",
                    )
                    stdout += "k:\n" + "\n".join(
                        "- {}".format(value)
                        for value in matrix.splitlines()
                        if value.strip()
                    ) + "\n"
            else:
                raise AssertionError("Unexpected camera discovery command: {!r}".format(command))
            return subprocess.CompletedProcess(command, 0, stdout, "")

        return discover_camera_sources(
            env={},
            runner=runner,
            now_seconds=self.now,
            usb_root=self.temp_dir.name,
            ros2_executable="/usr/bin/ros2",
        )

    def test_detects_unitree_and_realsense_streams_independently(self):
        self.write_usb_device(
            "1-2",
            {
                "idVendor": "8086",
                "idProduct": "0b3a",
                "product": "Intel RealSense D435I",
                "serial": "camera-serial",
                "manufacturer": "Intel",
            },
        )
        topics = (
            "/unitree/camera/color/image_raw [sensor_msgs/msg/Image]\n"
            "/unitree/camera/color/camera_info [sensor_msgs/msg/CameraInfo]\n"
            "/camera/color/image_raw [sensor_msgs/msg/Image]\n"
            "/camera/color/camera_info [sensor_msgs/msg/CameraInfo]\n"
        )
        fresh_header = (
            "stamp:\n"
            "  sec: 1799999999\n"
            "  nanosec: 900000000\n"
            "frame_id: camera_color_optical_frame\n"
        )
        report = self.run_discovery(
            topics,
            {
                "/unitree/camera/color/image_raw": fresh_header,
                "/unitree/camera/color/camera_info": fresh_header,
                "/camera/color/image_raw": fresh_header,
                "/camera/color/camera_info": fresh_header,
            },
        )

        self.assertTrue(report["sources"]["unitree"]["ready"])
        self.assertTrue(report["sources"]["realsense"]["ready"])
        self.assertEqual(
            report["sources"]["realsense"]["devices"][0]["serial"],
            "camera-serial",
        )
        self.assertTrue(report["sources"]["realsense"]["intrinsics_available"])
        self.assertEqual(report["sources"]["realsense"]["intrinsics"]["fx_px"], 600.0)
        self.assertEqual(len(self.echo_commands), 4)

    def test_unavailable_camera_does_not_affect_other_source(self):
        topics = (
            "/unitree/camera/image_raw [sensor_msgs/msg/Image]\n"
            "/unitree/camera/camera_info [sensor_msgs/msg/CameraInfo]\n"
        )
        report = self.run_discovery(
            topics,
            {
                "/unitree/camera/image_raw": (
                    "stamp:\n"
                    "  sec: 1799999999\n"
                    "  nanosec: 900000000\n"
                    "frame_id: unitree_camera\n"
                ),
                "/unitree/camera/camera_info": (
                    "stamp:\n"
                    "  sec: 1799999999\n"
                    "  nanosec: 900000000\n"
                    "frame_id: unitree_camera\n"
                ),
            },
        )

        self.assertTrue(report["sources"]["unitree"]["ready"])
        self.assertFalse(report["sources"]["realsense"]["available"])
        self.assertTrue(report["available"])

    def test_stale_camera_stream_is_unavailable(self):
        report = self.run_discovery(
            "/camera/color/image_raw [sensor_msgs/msg/Image]\n",
            {
                "/camera/color/image_raw": (
                    "stamp:\n"
                    "  sec: 1799999999\n"
                    "  nanosec: 0\n"
                    "frame_id: camera_color_optical_frame\n"
                )
            },
        )

        self.assertFalse(report["sources"]["realsense"]["available"])
        self.assertIn("stale", " ".join(report["diagnostics"]))

    def test_camera_info_must_be_fresh_and_have_valid_intrinsics(self):
        topics = (
            "/camera/color/image_raw [sensor_msgs/msg/Image]\n"
            "/camera/color/camera_info [sensor_msgs/msg/CameraInfo]\n"
        )
        stale_info_header = (
            "stamp:\n"
            "  sec: 1799999000\n"
            "  nanosec: 0\n"
            "frame_id: camera_color_optical_frame\n"
        )
        stale = self.run_discovery(
            topics,
            {"/camera/color/camera_info": stale_info_header},
        )
        self.assertTrue(stale["sources"]["realsense"]["available"])
        self.assertFalse(stale["sources"]["realsense"]["ready"])
        self.assertFalse(stale["sources"]["realsense"]["intrinsics_available"])

        invalid_intrinsics = self.run_discovery(
            topics,
            intrinsics={"/camera/color/camera_info": "- 0.0\n- 0.0\n- 0.0\n"},
        )
        self.assertTrue(invalid_intrinsics["sources"]["realsense"]["available"])
        self.assertFalse(invalid_intrinsics["sources"]["realsense"]["ready"])
        self.assertFalse(
            invalid_intrinsics["sources"]["realsense"]["intrinsics_available"]
        )

    def test_camera_info_must_match_fresh_image_frame(self):
        topics = (
            "/camera/color/image_raw [sensor_msgs/msg/Image]\n"
            "/camera/color/camera_info [sensor_msgs/msg/CameraInfo]\n"
        )
        report = self.run_discovery(
            topics,
            {
                "/camera/color/image_raw": (
                    "stamp:\n"
                    "  sec: 1799999999\n"
                    "  nanosec: 900000000\n"
                    "frame_id: color_optical_frame\n"
                ),
                "/camera/color/camera_info": (
                    "stamp:\n"
                    "  sec: 1799999999\n"
                    "  nanosec: 900000000\n"
                    "frame_id: depth_optical_frame\n"
                ),
            },
        )

        source = report["sources"]["realsense"]
        self.assertTrue(source["available"])
        self.assertFalse(source["ready"])
        self.assertFalse(source["intrinsics_available"])
        self.assertIsNone(source["intrinsics"])

    def test_future_dated_camera_stream_is_not_available(self):
        report = self.run_discovery(
            "/camera/color/image_raw [sensor_msgs/msg/Image]\n",
            {
                "/camera/color/image_raw": (
                    "stamp:\n"
                    "  sec: 1800000001\n"
                    "  nanosec: 0\n"
                    "frame_id: camera_color_optical_frame\n"
                )
            },
        )

        self.assertFalse(report["sources"]["realsense"]["available"])
        self.assertIn("future", " ".join(report["diagnostics"]))

    def test_missing_ros_or_usb_camera_reports_clear_diagnostic(self):
        report = discover_camera_sources(
            env={},
            now_seconds=self.now,
            usb_root=os.path.join(self.temp_dir.name, "missing"),
            ros2_executable=None,
            which=lambda _name: None,
        )

        self.assertFalse(report["available"])
        self.assertFalse(report["sources"]["unitree"]["ready"])
        self.assertFalse(report["sources"]["realsense"]["ready"])
        self.assertIn("ROS 2 CLI is unavailable", " ".join(report["diagnostics"]))


if __name__ == "__main__":
    unittest.main()
