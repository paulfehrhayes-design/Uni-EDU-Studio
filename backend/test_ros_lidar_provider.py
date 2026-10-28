import unittest
import json
import math
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    from . import ros_lidar_provider
    from .ros_lidar_provider import (
        SampleCache,
        PointCloudClockNormalizer,
        compose_transforms,
        footprint_clear_range_m,
        footprint_clearance_m,
        format_tf_calibration_error,
        should_log_tf_warning,
        select_forward_distance,
        select_footprint_distances_array,
        transform_point_to_base,
        transform_points_to_base_array,
        validate_pointcloud_timestamp,
    )
except ImportError:
    import ros_lidar_provider
    from ros_lidar_provider import (
        SampleCache,
        PointCloudClockNormalizer,
        compose_transforms,
        footprint_clear_range_m,
        footprint_clearance_m,
        format_tf_calibration_error,
        should_log_tf_warning,
        select_forward_distance,
        select_footprint_distances_array,
        transform_point_to_base,
        transform_points_to_base_array,
        validate_pointcloud_timestamp,
    )

try:
    import numpy
except ImportError:
    numpy = None


class RosLidarProviderTests(unittest.TestCase):
    def test_clock_normalizer_corrects_only_a_stable_future_sensor_offset(self):
        normalizer = PointCloudClockNormalizer()
        now = 1_800_000_000.0

        for sample_index in range(4):
            raw_timestamp = now + 3.0 + sample_index * 0.05
            with self.assertRaisesRegex(ValueError, "stable LiDAR-to-ROS clock offset"):
                normalizer.normalize(
                    int(raw_timestamp),
                    round((raw_timestamp % 1) * 1_000_000_000),
                    now + sample_index * 0.05,
                )

        raw_timestamp = now + 3.2
        corrected = normalizer.normalize(
            int(raw_timestamp),
            round((raw_timestamp % 1) * 1_000_000_000),
            now + 0.2,
        )

        self.assertAlmostEqual(normalizer.offset_seconds, 3.0, places=5)
        self.assertAlmostEqual(corrected.timestamp(), now + 0.2, places=5)

    def test_clock_normalizer_does_not_rescue_stale_or_unstable_samples(self):
        normalizer = PointCloudClockNormalizer()
        with self.assertRaisesRegex(ValueError, "stale"):
            normalizer.normalize(1_799_999_999, 0, 1_800_000_000)

        offsets = [2.0, 2.3, 2.0, 2.3, 2.0, 2.3]
        for offset in offsets:
            now = 1_800_000_000.0
            raw_timestamp = now + offset
            with self.assertRaisesRegex(ValueError, "stable|unstable"):
                normalizer.normalize(
                    int(raw_timestamp),
                    round((raw_timestamp % 1) * 1_000_000_000),
                    now,
                )

    def test_missing_live_tf_error_identifies_required_frames_and_safe_action(self):
        message = format_tf_calibration_error(
            RuntimeError('"torso_link" passed to lookupTransform argument target_frame does not exist'),
            "torso_link",
            "livox_frame",
            "base_link",
        )

        self.assertIn("G1 TF/joint-state publisher is active", message)
        self.assertNotIn(". .", message)
        self.assertIn("torso_link -> livox_frame", message)
        self.assertIn("base_link <- livox_frame", message)
        self.assertIn("Do not substitute an assumed static transform", message)

    def test_tf_warning_logging_is_throttled(self):
        self.assertTrue(should_log_tf_warning(None, 10.0))
        self.assertFalse(should_log_tf_warning(10.0, 14.9))
        self.assertTrue(should_log_tf_warning(10.0, 15.0))

    def test_transforms_lidar_point_into_base_frame(self):
        point = transform_point_to_base(
            (1.0, 0.0, 0.0),
            (0.2, -0.1, 0.3),
            (0.0, 0.0, 2 ** -0.5, 2 ** -0.5),
        )

        for actual, expected in zip(point, (0.2, 0.9, 0.3)):
            self.assertAlmostEqual(actual, expected)

    def test_composes_model_mount_with_live_parent_to_base_transform(self):
        translation, rotation = compose_transforms(
            (0.2, -0.1, 0.3),
            (0.0, 0.0, 2 ** -0.5, 2 ** -0.5),
            (1.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        )

        for actual, expected in zip(translation, (0.2, 0.9, 0.3)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(rotation, (0.0, 0.0, 2 ** -0.5, 2 ** -0.5)):
            self.assertAlmostEqual(actual, expected)

    def test_distance_is_measured_from_robot_footprint_boundary(self):
        self.assertAlmostEqual(footprint_clearance_m(1.0, 0.0, 0.4, 0.3, 0.2), 0.6)
        self.assertAlmostEqual(footprint_clearance_m(-0.8, 0.0, 0.4, 0.3, 0.2), 0.5)
        self.assertEqual(footprint_clearance_m(0.1, 0.1, 0.4, 0.3, 0.2), 0.0)
        self.assertIsNone(footprint_clearance_m(0.0, 1.0, 0.4, 0.3, 0.2))
        self.assertAlmostEqual(
            footprint_clear_range_m(0.4, 0.3, 0.2, 0.0, 0.0, "forward"),
            40 - math.hypot(0.4, 0.2),
        )

    def test_transform_rejects_invalid_quaternion(self):
        with self.assertRaisesRegex(ValueError, "quaternion is invalid"):
            transform_point_to_base((1.0, 0.0, 0.0), (0.0, 0.0, 0.0), (0.0, 0.0, 0.0, 0.0))

    def test_pointcloud_timestamp_rejects_stale_missing_and_future_stamps(self):
        now = 1_800_000_000.0
        self.assertEqual(
            validate_pointcloud_timestamp(1_799_999_999, 800_000_000, now).timestamp(),
            1_799_999_999.8,
        )
        for seconds, nanoseconds, expected in (
            (0, 0, "missing"),
            (1_799_999_999, 0, "stale"),
            (1_800_000_001, 0, "time synchronization"),
        ):
            with self.subTest(seconds=seconds, nanoseconds=nanoseconds):
                with self.assertRaisesRegex(ValueError, expected):
                    validate_pointcloud_timestamp(seconds, nanoseconds, now)

    @unittest.skipIf(numpy is None, "NumPy is provided by the ROS runtime, not the backend test environment.")
    def test_vectorized_transform_and_footprint_clearance_use_base_frame(self):
        points = numpy.array([(1.0, 0.0, 0.0), (-0.8, 0.0, 0.0)])
        transformed = transform_points_to_base_array(
            points,
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 2 ** -0.5, 2 ** -0.5),
        )
        self.assertAlmostEqual(transformed[0, 1], 1.0)
        front, rear, valid_points = select_footprint_distances_array(
            transformed,
            45,
            -0.5,
            1.5,
            0.4,
            0.3,
            0.2,
        )
        self.assertIsNone(front)
        self.assertIsNone(rear)
        self.assertEqual(valid_points, 2)

    @unittest.skipIf(numpy is None, "NumPy is provided by the ROS runtime, not the backend test environment.")
    def test_vectorized_front_and_rear_ranges_are_footprint_relative(self):
        front, rear, _ = select_footprint_distances_array(
            numpy.array([(1.0, 0.0, 0.0), (-0.8, 0.0, 0.0)]),
            15,
            -0.5,
            1.5,
            0.4,
            0.3,
            0.2,
        )
        self.assertAlmostEqual(front, 0.6)
        self.assertAlmostEqual(rear, 0.5)

    @unittest.skipIf(numpy is None, "NumPy is provided by the ROS runtime, not the backend test environment.")
    def test_sensor_range_limit_uses_raw_point_before_base_translation(self):
        front, _, _ = select_footprint_distances_array(
            numpy.array([(40.5, 0.0, 0.0)]),
            15,
            -0.5,
            1.5,
            0.4,
            0.3,
            0.2,
            sensor_ranges_m=numpy.array([39.5]),
        )
        self.assertEqual(front, 40.0)

    def test_selects_nearest_point_inside_forward_sector_and_height(self):
        distance = select_forward_distance(
            [
                (2.0, 0.0, 0.0),
                (1.5, 0.2, 0.0),
                (0.5, 1.0, 0.0),
                (0.4, 0.0, 2.0),
                (-0.2, 0.0, 0.0),
            ],
            15,
            -0.5,
            1.5,
        )
        self.assertAlmostEqual(distance, 1.5132746)

    def test_ignores_invalid_and_out_of_range_points(self):
        self.assertIsNone(
            select_forward_distance(
                [(float("nan"), 0.0, 0.0), (50.0, 0.0, 0.0)],
                15,
                -0.5,
                1.5,
            )
        )

    @unittest.skipIf(numpy is None, "NumPy is provided by the ROS runtime, not the backend test environment.")
    def test_selects_sector_distances_from_vectorized_point_cloud(self):
        points = numpy.array(
            [
                (1.2, 0.0, 0.0),
                (-1.4, 0.0, 0.0),
                (0.5, 1.0, 0.0),
                (float("nan"), 0.0, 0.0),
            ],
            dtype=[("x", "f4"), ("y", "f4"), ("z", "f4")],
        )

        front, rear, valid_points = ros_lidar_provider.select_sector_distances_array(
            points,
            15,
            -0.5,
            1.5,
        )

        self.assertAlmostEqual(front, 1.2)
        self.assertAlmostEqual(rear, 1.4)
        self.assertEqual(valid_points, 3)

    def test_sample_cache_requires_matching_frame_and_fresh_sample(self):
        cache = SampleCache("mid360-front", "livox_frame")
        points = [(0.8, 0.0, 0.0), (-1.2, 0.0, 0.0)]
        cache.update(points, "livox_frame", 15, -0.5, 1.5)
        self.assertEqual(cache.current_sample()["distance_m"], 0.8)
        self.assertEqual(cache.current_sample("rear")["distance_m"], 1.2)
        cache.update(points, "wrong_frame", 15, -0.5, 1.5)
        self.assertIsNone(cache.current_sample())

        cache.update(points, "livox_frame", 15, -0.5, 1.5)
        with cache._lock:
            cache._received_monotonic -= 1
        self.assertIsNone(cache.current_sample())
        self.assertIsNone(cache.current_sample("rear"))

    def test_sample_cache_freshness_is_anchored_to_capture_time(self):
        cache = SampleCache("mid360-front", "base_link")
        captured_at = datetime.now(timezone.utc) - timedelta(milliseconds=300)
        cache.update_distances(
            0.8,
            None,
            "base_link",
            "livox_frame",
            captured_at,
            calibrated=True,
        )
        sample = cache.current_sample()
        self.assertIsNotNone(sample)
        self.assertGreaterEqual(sample["age_ms"], 280)
        self.assertLess(sample["age_ms"], 500)

        stale_cache = SampleCache("mid360-front", "base_link")
        stale_cache.update_distances(
            0.8,
            None,
            "base_link",
            "livox_frame",
            datetime.now(timezone.utc) - timedelta(milliseconds=600),
            calibrated=True,
        )
        self.assertIsNone(stale_cache.current_sample())

    def test_fresh_cloud_with_no_points_in_sector_is_reported_as_clear(self):
        cache = SampleCache("mid360-front", "livox_frame")
        cache.update([], "livox_frame", 15, -0.5, 1.5)

        sample = cache.current_sample("forward")

        self.assertTrue(sample["valid"])
        self.assertFalse(sample["calibrated"])
        self.assertEqual(sample["measurement"], "sensor_frame_range")
        self.assertTrue(sample["clear"])
        self.assertIsNone(sample["distance_m"])
        self.assertEqual(sample["max_range_m"], 40.0)

    def test_http_endpoint_requires_token_and_returns_only_fresh_samples(self):
        from threading import Thread

        try:
            from .ros_lidar_provider import serve_http
        except ImportError:
            from ros_lidar_provider import serve_http

        cache = SampleCache("mid360-front", "livox_frame")
        cache.update([(0.8, 0.0, 0.0), (-1.2, 0.0, 0.0)], "livox_frame", 15, -0.5, 1.5)
        server = serve_http(cache, "127.0.0.1", 0, "provider-secret")
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base_url = f"http://127.0.0.1:{server.server_address[1]}/distance/front"

        with self.assertRaises(HTTPError) as unauthorized:
            urlopen(base_url, timeout=2)
        self.assertEqual(unauthorized.exception.code, 401)
        unauthorized.exception.close()

        request = Request(base_url, headers={"Authorization": "Bearer provider-secret"})
        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
        self.assertTrue(payload["valid"])
        self.assertEqual(payload["sector"], "forward")
        self.assertEqual(payload["distance_m"], 0.8)

        rear_request = Request(
            base_url.replace("/distance/front", "/distance/rear"),
            headers={"Authorization": "Bearer provider-secret"},
        )
        with urlopen(rear_request, timeout=2) as response:
            rear_payload = json.load(response)
        self.assertEqual(rear_payload["sector"], "rear")
        self.assertEqual(rear_payload["distance_m"], 1.2)

        cache.update_calibration_status(
            {
                "ready": True,
                "status": "verified",
                "model_fingerprint": "test-model",
                "reason": "Transform matches the model.",
            }
        )
        calibration_request = Request(
            base_url.replace("/distance/front", "/calibration"),
            headers={"Authorization": "Bearer provider-secret"},
        )
        with urlopen(calibration_request, timeout=2) as response:
            calibration = json.load(response)
        self.assertTrue(calibration["ready"])
        self.assertEqual(calibration["model_fingerprint"], "test-model")

        with cache._lock:
            cache._received_monotonic -= 1
        self.assertFalse(cache.current_calibration_status()["ready"])
        self.assertEqual(cache.current_calibration_status()["status"], "stale")
        with self.assertRaises(HTTPError) as stale:
            urlopen(request, timeout=2)
        self.assertEqual(stale.exception.code, 503)
        stale_payload = json.loads(stale.exception.read())
        self.assertIn("Latest point cloud is stale", stale_payload["error"])
        stale.exception.close()

    def test_unavailable_reason_distinguishes_no_cloud_and_wrong_frame(self):
        cache = SampleCache("mid360-front", "livox_frame")
        self.assertIn("has not received a point cloud", cache.unavailable_reason())
        self.assertIsNone(cache.current_sample())

        cache.update([(1.0, 0.0, 0.0)], "other_frame", 15, -0.5, 1.5)
        self.assertIn("expected 'livox_frame'", cache.unavailable_reason())


if __name__ == "__main__":
    unittest.main()
