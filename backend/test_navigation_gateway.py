import math
import os
import unittest
from unittest.mock import patch

try:
    from .ros.navigation_gateway import (
        GatewayConfigurationError,
        _configuration,
        accumulate_scan_rotation,
        controller_ownership_ready,
        scan_rotation_complete,
        validate_estop_health,
        validate_pointcloud_timestamp,
    )
except ImportError:
    from ros.navigation_gateway import (
        GatewayConfigurationError,
        _configuration,
        accumulate_scan_rotation,
        controller_ownership_ready,
        scan_rotation_complete,
        validate_estop_health,
        validate_pointcloud_timestamp,
    )


class NavigationGatewayScanTests(unittest.TestCase):
    def test_estop_health_is_fresh_and_true_before_motion_is_ready(self):
        self.assertTrue(validate_estop_health(True, 0.2, 1.0)["ready"])
        for healthy, age, expected in (
            (None, None, "not been reported"),
            (False, 0.1, "engaged"),
            (True, 1.1, "stale"),
            (True, -0.1, "stale"),
        ):
            with self.subTest(healthy=healthy, age=age):
                result = validate_estop_health(healthy, age, 1.0)
                self.assertFalse(result["ready"])
                self.assertIn(expected, result["error"])

    def test_pointcloud_timestamps_reject_stale_future_and_malformed_samples(self):
        self.assertAlmostEqual(validate_pointcloud_timestamp(100, 0, now_seconds=100.5), 0.5)
        for stamp, expected in (
            ((98, 0), "stale"),
            ((101, 0), "future"),
            ((0, 0), "missing"),
            ((100, 1_000_000_000), "invalid"),
        ):
            with self.subTest(stamp=stamp), self.assertRaisesRegex(ValueError, expected):
                validate_pointcloud_timestamp(*stamp, now_seconds=100)

    def test_scan_rotation_accumulates_wrapped_yaw_in_signed_direction(self):
        rotation = accumulate_scan_rotation(0.0, 3.1, -3.1)
        self.assertAlmostEqual(rotation, 0.08318530717958605)

        reverse = accumulate_scan_rotation(0.0, -3.1, 3.1)
        self.assertAlmostEqual(reverse, -0.08318530717958605)

    def test_only_near_full_measured_turn_is_accepted(self):
        self.assertTrue(scan_rotation_complete(2 * math.pi))
        self.assertTrue(scan_rotation_complete(-(2 * math.pi - 0.15)))
        self.assertFalse(scan_rotation_complete(2 * math.pi - 0.2))
        self.assertFalse(scan_rotation_complete(float("nan")))

    def test_spin_action_and_bounded_timeout_are_configurable(self):
        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_SPIN_ACTION_NAME": "/custom_spin",
                "G1_NAV_SCAN_ROTATION_TIMEOUT_SECONDS": "90",
            },
            clear=True,
        ):
            config = _configuration()
        self.assertEqual(config["spin_action_name"], "/custom_spin")
        self.assertEqual(config["scan_rotation_timeout_seconds"], 90)

        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_SCAN_ROTATION_TIMEOUT_SECONDS": "10",
            },
            clear=True,
        ), self.assertRaisesRegex(GatewayConfigurationError, "between 30 and 300"):
            _configuration()

    def test_path_planner_action_and_timeout_are_configurable(self):
        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_PLAN_ACTION_NAME": "/planner/compute_path",
                "G1_NAV_PLANNER_ID": "Smac2D",
                "G1_NAV_PLAN_TIMEOUT_SECONDS": "20",
            },
            clear=True,
        ):
            config = _configuration()
        self.assertEqual(config["plan_action_name"], "/planner/compute_path")
        self.assertEqual(config["planner_id"], "Smac2D")
        self.assertEqual(config["plan_timeout_seconds"], 20)

        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_PLAN_TIMEOUT_SECONDS": "0",
            },
            clear=True,
        ), self.assertRaisesRegex(GatewayConfigurationError, "between 1 and 60"):
            _configuration()

    def test_estop_heartbeat_topic_and_freshness_are_configurable(self):
        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_ESTOP_HEALTHY_TOPIC": "/safety/estop_healthy",
                "G1_NAV_ESTOP_MAX_AGE_MS": "500",
            },
            clear=True,
        ):
            config = _configuration()
        self.assertEqual(config["estop_healthy_topic"], "/safety/estop_healthy")
        self.assertEqual(config["estop_max_age_seconds"], 0.5)

        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_ESTOP_MAX_AGE_MS": "50",
            },
            clear=True,
        ), self.assertRaisesRegex(GatewayConfigurationError, "between 100 and 5000"):
            _configuration()

    def test_robot_health_heartbeat_topic_and_freshness_are_configurable(self):
        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_ROBOT_HEALTHY_TOPIC": "/g1/controller_healthy",
                "G1_NAV_ROBOT_HEALTH_MAX_AGE_MS": "750",
            },
            clear=True,
        ):
            config = _configuration()
        self.assertEqual(config["robot_healthy_topic"], "/g1/controller_healthy")
        self.assertEqual(config["robot_health_max_age_seconds"], 0.75)

    def test_motion_requires_explicit_single_bridge_ownership_commissioning(self):
        with patch.dict(
            os.environ,
            {
                "G1_NAV_GATEWAY_TOKEN": "a sufficiently long test gateway token",
                "G1_NAV_LOCOMOTION_OWNER": "nav2_via_single_unitree_bridge",
                "G1_NAV_CONTROLLER_OWNERSHIP_CONFIRMED": "1",
            },
            clear=True,
        ):
            config = _configuration()
        self.assertEqual(config["locomotion_owner"], "nav2_via_single_unitree_bridge")
        self.assertTrue(config["controller_ownership_confirmed"])
        self.assertTrue(controller_ownership_ready(
            config["locomotion_owner"],
            config["controller_ownership_confirmed"],
        ))
        self.assertFalse(controller_ownership_ready("unverified", True))
        self.assertFalse(controller_ownership_ready("other_controller", True))
        self.assertFalse(controller_ownership_ready("nav2_via_single_unitree_bridge", False))


if __name__ == "__main__":
    unittest.main()
