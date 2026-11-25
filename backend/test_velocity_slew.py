import os
import unittest
from unittest.mock import patch

from velocity_slew import (
    DEFAULT_LINEAR_ACCELERATION_MPS2,
    DEFAULT_YAW_ACCELERATION_RADPS2,
    VelocitySlewLimits,
    configured_velocity_slew_limits,
    slew_velocity,
)


class VelocitySlewTests(unittest.TestCase):
    def test_velocity_ramps_each_axis_at_its_configured_acceleration(self):
        limits = VelocitySlewLimits(linear_mps2=0.3, yaw_radps2=0.6)

        velocity = slew_velocity((0.0, 0.0, 0.0), (0.15, -0.1, 0.25), 0.1, limits)

        self.assertEqual(velocity, (0.03, -0.03, 0.06))

    def test_velocity_decelerates_to_zero_without_overshoot(self):
        limits = VelocitySlewLimits(linear_mps2=0.3, yaw_radps2=0.6)
        velocity = slew_velocity((0.08, -0.02, 0.1), (0.0, 0.0, 0.0), 0.1, limits)

        self.assertAlmostEqual(velocity[0], 0.05)
        self.assertEqual(velocity[1], 0.0)
        self.assertAlmostEqual(velocity[2], 0.04)

    def test_reversal_reaches_zero_before_accelerating_in_the_other_direction(self):
        limits = VelocitySlewLimits(linear_mps2=0.3, yaw_radps2=0.6)
        velocity = (0.06, 0.0, 0.0)
        outputs = []
        for _ in range(4):
            velocity = slew_velocity(velocity, (-0.1, 0.0, 0.0), 0.1, limits)
            outputs.append(velocity[0])

        self.assertEqual(outputs, [0.03, 0.0, -0.03, -0.06])

    def test_slew_configuration_is_bounded_and_reports_invalid_values(self):
        with patch.dict(os.environ, {}, clear=True):
            limits = configured_velocity_slew_limits()
        self.assertEqual(limits.linear_mps2, DEFAULT_LINEAR_ACCELERATION_MPS2)
        self.assertEqual(limits.yaw_radps2, DEFAULT_YAW_ACCELERATION_RADPS2)

        with patch.dict(os.environ, {"G1_MAX_LINEAR_ACCELERATION_MPS2": "0"}):
            with self.assertRaisesRegex(ValueError, "G1_MAX_LINEAR_ACCELERATION_MPS2"):
                configured_velocity_slew_limits()


if __name__ == "__main__":
    unittest.main()
