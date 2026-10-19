import unittest
import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    from . import ros_lidar_provider
    from .ros_lidar_provider import SampleCache, select_forward_distance
except ImportError:
    import ros_lidar_provider
    from ros_lidar_provider import SampleCache, select_forward_distance


class RosLidarProviderTests(unittest.TestCase):
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

    def test_fresh_cloud_with_no_points_in_sector_is_reported_as_clear(self):
        cache = SampleCache("mid360-front", "livox_frame")
        cache.update([], "livox_frame", 15, -0.5, 1.5)

        sample = cache.current_sample("forward")

        self.assertTrue(sample["valid"])
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

        with cache._lock:
            cache._received_monotonic -= 1
        with self.assertRaises(HTTPError) as stale:
            urlopen(request, timeout=2)
        self.assertEqual(stale.exception.code, 503)
        stale_payload = json.loads(stale.exception.read())
        self.assertIn("Latest point cloud is stale", stale_payload["error"])
        stale.exception.close()

    def test_unavailable_reason_distinguishes_no_cloud_and_wrong_frame(self):
        cache = SampleCache("mid360-front", "livox_frame")
        self.assertIn("has not received a point cloud", cache.unavailable_reason())

        cache.update([(1.0, 0.0, 0.0)], "other_frame", 15, -0.5, 1.5)
        self.assertIn("expected 'livox_frame'", cache.unavailable_reason())


if __name__ == "__main__":
    unittest.main()
