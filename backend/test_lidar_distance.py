import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

try:
    from . import lidar_distance
    from .lidar_distance import DistanceSensorError, get_front_distance_sample, get_rear_distance_sample
except ImportError:
    import lidar_distance
    from lidar_distance import DistanceSensorError, get_front_distance_sample, get_rear_distance_sample


class LidarDistanceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 14, 4, 0, tzinfo=timezone.utc)
        self.payload = {
            "valid": True,
            "sector": "forward",
            "distance_m": 0.85,
            "timestamp": (self.now - timedelta(milliseconds=100)).isoformat(),
            "sensor_id": "mid360-front",
            "frame_id": "lidar_link",
        }
        self.environment = patch.dict(
            "os.environ",
            {
                "G1_DISTANCE_PROVIDER_URL": "http://127.0.0.1:8181/distance/front",
                "G1_DISTANCE_REAR_PROVIDER_URL": "http://127.0.0.1:8181/distance/rear",
                "G1_DISTANCE_PROVIDER_TOKEN": "test-token",
                "G1_DISTANCE_SENSOR_ID": "mid360-front",
                "G1_DISTANCE_FRAME_ID": "lidar_link",
                "G1_LIDAR_AXIS_CONFIRMED": "1",
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_valid_provider_sample_has_normalized_age_and_units(self):
        response = SimpleNamespace(status_code=200, json=lambda: self.payload)
        with patch.object(lidar_distance.httpx, "get", return_value=response) as request:
            sample = get_front_distance_sample(now=self.now)

        self.assertEqual(sample["distance_m"], 0.85)
        self.assertEqual(sample["age_ms"], 100)
        self.assertEqual(sample["sensor_id"], "mid360-front")
        request.assert_called_once_with(
            "http://127.0.0.1:8181/distance/front",
            headers={"Authorization": "Bearer test-token", "Accept": "application/json"},
            timeout=lidar_distance.PROVIDER_TIMEOUT_SECONDS,
            follow_redirects=False,
        )

    def test_clear_sample_is_valid_when_no_object_is_within_40_meters(self):
        clear_payload = {
            **self.payload,
            "distance_m": None,
            "clear": True,
            "max_range_m": 40.0,
        }
        with patch.object(
            lidar_distance.httpx,
            "get",
            return_value=SimpleNamespace(status_code=200, json=lambda: clear_payload),
        ):
            sample = get_front_distance_sample(now=self.now)

        self.assertTrue(sample["clear"])
        self.assertIsNone(sample["distance_m"])
        self.assertEqual(sample["max_range_m"], 40.0)

    def test_provider_must_be_configured_and_return_fresh_matching_data(self):
        response = SimpleNamespace(status_code=200, json=lambda: self.payload)
        with patch.dict("os.environ", {"G1_DISTANCE_PROVIDER_URL": ""}):
            with self.assertRaisesRegex(DistanceSensorError, "not configured"):
                get_front_distance_sample(now=self.now)

    def test_unconfirmed_lidar_axis_disables_distance_conditions(self):
        with patch.dict("os.environ", {"G1_LIDAR_AXIS_CONFIRMED": "0"}):
            with patch.object(lidar_distance.httpx, "get") as request:
                with self.assertRaisesRegex(DistanceSensorError, "axis alignment is unconfirmed"):
                    get_front_distance_sample(now=self.now)
        request.assert_not_called()

    def test_rear_provider_requires_a_fresh_rear_sample(self):
        payload = {**self.payload, "sector": "rear", "distance_m": 1.2}
        response = SimpleNamespace(status_code=200, json=lambda: payload)
        with patch.object(lidar_distance.httpx, "get", return_value=response) as request:
            sample = get_rear_distance_sample(now=self.now)
        self.assertEqual(sample["sector"], "rear")
        self.assertEqual(sample["distance_m"], 1.2)
        request.assert_called_once_with(
            "http://127.0.0.1:8181/distance/rear",
            headers={"Authorization": "Bearer test-token", "Accept": "application/json"},
            timeout=lidar_distance.PROVIDER_TIMEOUT_SECONDS,
            follow_redirects=False,
        )

        with patch.dict("os.environ", {"G1_DISTANCE_REAR_PROVIDER_URL": ""}):
            with self.assertRaisesRegex(DistanceSensorError, "rear-sector distance provider is not configured"):
                get_rear_distance_sample(now=self.now)

        stale = {**self.payload, "timestamp": (self.now - timedelta(milliseconds=501)).isoformat()}
        wrong_frame = {**self.payload, "frame_id": "unverified_frame"}
        invalid = {**self.payload, "valid": False}
        wrong_sector = {**self.payload, "sector": "rear"}
        for payload, expected in (
            (stale, "stale"),
            (wrong_frame, "frame"),
            (invalid, "valid forward-sector sample"),
            (wrong_sector, "not from the configured forward sector"),
        ):
            with self.subTest(payload=payload), patch.object(
                lidar_distance.httpx,
                "get",
                return_value=SimpleNamespace(status_code=200, json=lambda payload=payload: payload),
            ):
                with self.assertRaisesRegex(DistanceSensorError, expected):
                    get_front_distance_sample(now=self.now)

    def test_future_samples_and_out_of_range_values_are_rejected(self):
        for payload, expected in (
            (
                {**self.payload, "timestamp": (self.now + timedelta(seconds=1)).isoformat()},
                "in the future",
            ),
            ({**self.payload, "distance_m": 0}, "greater than 0"),
            ({**self.payload, "distance_m": True}, "numeric meters"),
        ):
            with self.subTest(payload=payload), patch.object(
                lidar_distance.httpx,
                "get",
                return_value=SimpleNamespace(status_code=200, json=lambda payload=payload: payload),
            ):
                with self.assertRaisesRegex(DistanceSensorError, expected):
                    get_front_distance_sample(now=self.now)

    def test_sensor_status_reports_provider_unavailable_explicitly(self):
        with patch.object(
            lidar_distance.httpx,
            "get",
            side_effect=lidar_distance.httpx.ConnectError("provider offline"),
        ):
            status = lidar_distance.distance_sensor_status()

        self.assertFalse(status["ready"])
        self.assertEqual(status["status"], "unavailable")
        self.assertIn("could not be reached", status["error"])


if __name__ == "__main__":
    unittest.main()
