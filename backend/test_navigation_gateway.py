import math
import os
import unittest
from unittest.mock import patch

try:
    from .ros.navigation_gateway import (
        GatewayConfigurationError,
        _configuration,
        accumulate_scan_rotation,
        scan_rotation_complete,
    )
except ImportError:
    from ros.navigation_gateway import (
        GatewayConfigurationError,
        _configuration,
        accumulate_scan_rotation,
        scan_rotation_complete,
    )


class NavigationGatewayScanTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
