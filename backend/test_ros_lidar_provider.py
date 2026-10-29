import unittest
import base64
import json
import math
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

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
    def test_camera_source_configuration_requires_unique_valid_topics_and_frames(self):
        sources = ros_lidar_provider.parse_camera_source_specs(
            json.dumps([
                {"topic": "/camera/color/image_raw", "frame_id": "camera_color_optical_frame"},
            ])
        )
        self.assertEqual(
            sources,
            [{"topic": "/camera/color/image_raw", "frame_id": "camera_color_optical_frame"}],
        )
        with self.assertRaisesRegex(ValueError, "configured more than once"):
            ros_lidar_provider.parse_camera_source_specs(
                json.dumps([
                    {"topic": "/camera/color/image_raw", "frame_id": "camera_color_optical_frame"},
                    {"topic": "/camera/color/image_raw", "frame_id": "camera_color_optical_frame"},
                ])
            )
        with self.assertRaisesRegex(ValueError, "invalid expected frame"):
            ros_lidar_provider.parse_camera_source_specs(
                json.dumps([{"topic": "/camera/image", "frame_id": ""}])
            )

    def test_camera_source_ingestion_is_limited_per_topic(self):
        cache = ros_lidar_provider.CameraFrameCache(
            [{"topic": "/camera/image", "frame_id": "camera_frame"}]
        )
        with patch.object(ros_lidar_provider.time, "monotonic", return_value=10.0):
            self.assertTrue(cache.should_accept_image("/camera/image"))
            self.assertFalse(cache.should_accept_image("/camera/image"))
        with patch.object(ros_lidar_provider.time, "monotonic", return_value=10.5):
            self.assertTrue(cache.should_accept_image("/camera/image"))

    def test_camera_frame_cache_delivers_only_fresh_configured_frames(self):
        topic = "/camera/color/image_raw"
        cache = ros_lidar_provider.CameraFrameCache(
            [{"topic": topic, "frame_id": "camera_color_optical_frame"}]
        )
        pixels = bytes((255, 0, 0, 0, 255, 0))
        cache.update_image(
            topic,
            "camera_color_optical_frame",
            datetime.now(timezone.utc),
            "rgb8",
            2,
            1,
            6,
            pixels,
        )

        frame = cache.current_frame(topic)

        self.assertEqual(frame["width"], 2)
        self.assertEqual(frame["height"], 1)
        self.assertEqual(frame["encoding"], "rgb8")
        self.assertLess(frame["receive_age_ms"], 100)
        self.assertEqual(base64.b64decode(frame["data_base64"]), pixels)
        with self.assertRaisesRegex(KeyError, "not configured"):
            cache.current_frame("/unselected/image")
        with cache._lock:
            cache._frames[topic]["received_monotonic"] -= 1
        with self.assertRaisesRegex(LookupError, "stale"):
            cache.current_frame(topic)

    def test_camera_frame_cache_rejects_mismatched_frames_unsupported_data_and_large_images(self):
        topic = "/camera/color/image_raw"
        cache = ros_lidar_provider.CameraFrameCache(
            [{"topic": topic, "frame_id": "camera_color_optical_frame"}]
        )
        captured_at = datetime.now(timezone.utc)
        with self.assertRaisesRegex(ValueError, "does not match expected"):
            cache.update_image(topic, "wrong_frame", captured_at, "rgb8", 1, 1, 3, b"123")
        with self.assertRaisesRegex(ValueError, "encoding.*not supported"):
            cache.update_image(topic, "camera_color_optical_frame", captured_at, "yuv422", 1, 1, 2, b"12")
        with self.assertRaisesRegex(ValueError, "invalid or too large"):
            cache.update_image(
                topic,
                "camera_color_optical_frame",
                captured_at,
                "rgb8",
                ros_lidar_provider.MAX_CAMERA_WIDTH + 1,
                1,
                (ros_lidar_provider.MAX_CAMERA_WIDTH + 1) * 3,
                b"x" * ((ros_lidar_provider.MAX_CAMERA_WIDTH + 1) * 3),
            )

    def test_camera_frame_http_endpoint_requires_token_and_disables_caching(self):
        from threading import Thread

        topic = "/camera/color/image_raw"
        camera_cache = ros_lidar_provider.CameraFrameCache(
            [{"topic": topic, "frame_id": "camera_color_optical_frame"}]
        )
        camera_cache.update_image(
            topic,
            "camera_color_optical_frame",
            datetime.now(timezone.utc),
            "rgb8",
            1,
            1,
            3,
            b"rgb",
        )
        server = ros_lidar_provider.serve_http(
            SampleCache("mid360-front", "pelvis"),
            "127.0.0.1",
            0,
            "provider-secret",
            camera_cache,
        )
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = (
            f"http://127.0.0.1:{server.server_address[1]}/camera/frame"
            f"?topic={topic}"
        )
        with self.assertRaises(HTTPError) as unauthorized:
            urlopen(url, timeout=2)
        self.assertEqual(unauthorized.exception.code, 401)
        unauthorized.exception.close()

        request = Request(url, headers={"Authorization": "Bearer provider-secret"})
        with urlopen(request, timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(response.headers["Cache-Control"], "no-store, max-age=0")
        self.assertEqual(payload["topic"], topic)
        self.assertEqual(base64.b64decode(payload["data_base64"]), b"rgb")

    def test_supplemental_pointcloud_configuration_is_explicit_and_model_safe(self):
        sources = ros_lidar_provider.parse_pointcloud_source_specs(
            "/mid360/livox/lidar",
            "mid360-front",
            "mid360_link",
            json.dumps(
                [
                    {
                        "id": "front-depth",
                        "topic": "/camera/depth/points",
                        "frame_id": "camera_depth_frame",
                        "coverage": ["forward"],
                    }
                ]
            ),
        )

        self.assertEqual(len(sources), 2)
        self.assertTrue(sources[0]["model_mount"])
        self.assertFalse(sources[1]["model_mount"])
        self.assertEqual(sources[1]["coverage"], ["forward"])
        with self.assertRaisesRegex(ValueError, "configured more than once"):
            ros_lidar_provider.parse_pointcloud_source_specs(
                "/mid360/livox/lidar",
                "mid360-front",
                "mid360_link",
                json.dumps(
                    [
                        {
                            "id": "duplicate",
                            "topic": "/mid360/livox/lidar",
                            "frame_id": "other_frame",
                            "coverage": ["forward"],
                        }
                    ]
                ),
            )
        with self.assertRaisesRegex(ValueError, "Only the configured primary MID-360"):
            ros_lidar_provider.parse_pointcloud_source_specs(
                "/mid360/livox/lidar",
                "mid360-front",
                "mid360_link",
                json.dumps(
                    [
                        {
                            "id": "unmodeled-fallback",
                            "topic": "/other/points",
                            "frame_id": "other_frame",
                            "coverage": ["rear"],
                            "model_mount": True,
                        }
                    ]
                ),
            )

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
            cache._source_samples["mid360-front"]["received_monotonic"] -= 1
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
        source = cache.source_status()[0]
        self.assertLess(source["receive_age_ms"], 100)
        self.assertGreaterEqual(source["stamp_age_ms"], 280)

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

    def test_multi_source_cache_uses_clearance_minimum_with_directional_coverage(self):
        cache = SampleCache(
            "g1-clearance",
            "pelvis",
            source_specs=[
                {
                    "id": "mid360",
                    "topic": "/mid360/livox/lidar",
                    "frame_id": "mid360_link",
                    "coverage": ["forward", "rear"],
                },
                {
                    "id": "front-depth",
                    "topic": "/camera/depth/points",
                    "frame_id": "camera_depth_frame",
                    "coverage": ["forward"],
                },
            ],
        )
        captured_at = datetime.now(timezone.utc)
        cache.update_source_distances(
            "mid360", 0.8, 1.2, "pelvis", "mid360_link", captured_at, calibrated=True
        )
        cache.update_source_distances(
            "front-depth", 0.35, None, "pelvis", "camera_depth_frame", captured_at, calibrated=True
        )

        front = cache.current_sample("forward")
        rear = cache.current_sample("rear")

        self.assertEqual(front["distance_m"], 0.35)
        self.assertEqual(set(front["source_ids"]), {"mid360", "front-depth"})
        self.assertEqual(rear["distance_m"], 1.2)
        self.assertEqual(rear["source_ids"], ["mid360"])
        self.assertEqual(
            next(source["status"] for source in rear["sources"] if source["id"] == "front-depth"),
            "outside_sector_coverage",
        )

    def test_multi_source_cache_excludes_stale_and_timestamp_skewed_sources(self):
        cache = SampleCache(
            "g1-clearance",
            "pelvis",
            source_specs=[
                {"id": "primary", "coverage": ["forward", "rear"]},
                {"id": "secondary", "coverage": ["forward", "rear"]},
            ],
        )
        now = datetime.now(timezone.utc)
        cache.update_source_distances("primary", 0.8, 1.2, "pelvis", "primary_frame", now, calibrated=True)
        cache.update_source_distances(
            "secondary",
            0.2,
            None,
            "pelvis",
            "secondary_frame",
            now - timedelta(milliseconds=150),
            calibrated=True,
        )

        sample = cache.current_sample("forward")

        self.assertEqual(sample["distance_m"], 0.8)
        self.assertEqual(sample["source_ids"], ["primary"])
        secondary = next(source for source in sample["sources"] if source["id"] == "secondary")
        self.assertEqual(secondary["status"], "timestamp_skew")
        self.assertFalse(secondary["contributing"])

        with cache._lock:
            cache._source_samples["secondary"]["received_monotonic"] -= 1
        degraded = cache.current_sample("forward")
        self.assertEqual(degraded["source_ids"], ["primary"])
        secondary = next(source for source in degraded["sources"] if source["id"] == "secondary")
        self.assertEqual(secondary["status"], "stale")

    def test_multi_source_cache_fails_closed_when_all_sources_are_stale(self):
        cache = SampleCache(
            "g1-clearance",
            "pelvis",
            source_specs=[
                {"id": "primary", "coverage": ["forward", "rear"]},
                {"id": "secondary", "coverage": ["forward"]},
            ],
        )
        captured_at = datetime.now(timezone.utc)
        for source_id in ("primary", "secondary"):
            cache.update_source_distances(
                source_id,
                0.4,
                None,
                "pelvis",
                f"{source_id}_frame",
                captured_at,
                calibrated=True,
            )
        cache.update_calibration_status({"ready": True, "status": "model_derived"})
        with cache._lock:
            for sample in cache._source_samples.values():
                sample["received_monotonic"] -= 1

        self.assertIsNone(cache.current_sample("forward"))
        status = cache.current_calibration_status()
        self.assertFalse(status["ready"])
        self.assertTrue(all(source["status"] == "stale" for source in status["sources"]))

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
            cache._source_samples["mid360-front"]["received_monotonic"] -= 1
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
