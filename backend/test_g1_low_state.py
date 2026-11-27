import unittest
from types import SimpleNamespace
from unittest.mock import patch

from g1_low_state import G1LowStateCache, extract_g1_low_state
from ros.g1_joint_state import JOINT_MOTOR_INDICES


def low_state_message(motor_count=27):
    return SimpleNamespace(
        motor_state=[
            SimpleNamespace(q=float(index), dq=float(index + 1), tau_est=float(index + 2))
            for index in range(motor_count)
        ],
        imu_state=SimpleNamespace(
            rpy=[0.1, 0.2, 0.3],
            gyroscope=[0.4, 0.5, 0.6],
            accelerometer=[0.7, 0.8, 0.9],
        ),
    )


class G1LowStateTests(unittest.TestCase):
    def test_extracts_all_motor_measurements_and_imu_vectors(self):
        sample = extract_g1_low_state(low_state_message())

        self.assertEqual(sample["motor_count"], 27)
        self.assertEqual(sample["motor_state"][26], {
            "index": 26,
            "q": 26.0,
            "dq": 27.0,
            "tau_est": 28.0,
        })
        self.assertEqual(sample["imu_state"]["rpy"], [0.1, 0.2, 0.3])

    def test_rejects_missing_motor_slots_and_non_finite_measurements(self):
        with self.assertRaisesRegex(ValueError, "too few motor"):
            extract_g1_low_state(low_state_message(26))

        malformed = low_state_message()
        malformed.motor_state[3].q = float("nan")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            extract_g1_low_state(malformed)

    def test_cache_reports_fresh_stale_and_unavailable_samples(self):
        cache = G1LowStateCache()
        with patch("g1_low_state.time.monotonic", side_effect=[10.0, 10.1, 10.3]):
            cache.update(low_state_message())
            fresh = cache.snapshot()
            stale = cache.snapshot()

        self.assertEqual(fresh["status"], "available")
        self.assertEqual(stale["status"], "unavailable")
        self.assertIn("stale", stale["reason"])

        cache.mark_unavailable("subscriber failed")
        self.assertEqual(cache.snapshot()["reason"], "subscriber failed")

    def test_joint_mapping_uses_the_verified_ros_motor_indices(self):
        self.assertEqual(
            G1LowStateCache.joint_mapping(),
            [
                {"joint_name": name, "motor_index": index}
                for name, index in JOINT_MOTOR_INDICES
            ],
        )


if __name__ == "__main__":
    unittest.main()
