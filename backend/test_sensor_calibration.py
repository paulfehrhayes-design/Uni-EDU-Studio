import os
import tempfile
import unittest

try:
    from .sensor_calibration import (
        calibration_status,
        compare_transforms,
        load_candidate_sensor_mounts,
    )
except ImportError:
    from sensor_calibration import (
        calibration_status,
        compare_transforms,
        load_candidate_sensor_mounts,
    )


class SensorCalibrationTests(unittest.TestCase):
    def test_loads_sensor_mounts_as_unverified_model_candidates(self):
        mounts = load_candidate_sensor_mounts()

        self.assertEqual(mounts["mid360"]["status"], "candidate_unverified")
        self.assertEqual(mounts["mid360"]["parent_frame"], "torso_link")
        self.assertEqual(mounts["mid360"]["sensor_frame"], "mid360_link")
        self.assertAlmostEqual(mounts["mid360"]["translation_m"][2], 0.40618)
        self.assertEqual(mounts["d435"]["status"], "candidate_unverified")
        self.assertEqual(mounts["d435"]["parent_frame"], "torso_link")
        self.assertEqual(mounts["d435"]["sensor_frame"], "d435_link")

    def test_reports_missing_or_malformed_description_without_fallback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = os.path.join(temp_dir, "missing.urdf")
            with self.assertRaisesRegex(ValueError, "Could not read supported G1"):
                load_candidate_sensor_mounts(missing)

            invalid = os.path.join(temp_dir, "invalid.urdf")
            with open(invalid, "w", encoding="utf-8") as output:
                output.write("<robot")
            with self.assertRaisesRegex(ValueError, "Could not read supported G1"):
                load_candidate_sensor_mounts(invalid)

    def test_live_transform_must_match_frames_and_tolerances(self):
        candidate = {
            "parent_frame": "torso_link",
            "sensor_frame": "mid360_link",
            "translation_m": [0.0, 0.0, 0.4],
            "rotation_xyzw": [0.0, 0.0, 0.0, 1.0],
        }
        observed = {
            **candidate,
            "translation_m": [0.01, 0.0, 0.4],
        }

        self.assertTrue(compare_transforms(candidate, observed)["matches"])
        observed["translation_m"] = [0.1, 0.0, 0.4]
        self.assertFalse(compare_transforms(candidate, observed)["matches"])
        observed["translation_m"] = candidate["translation_m"]
        observed["parent_frame"] = "base_link"
        self.assertIn("frame labels", compare_transforms(candidate, observed)["reason"])

    def test_live_transform_rejects_zero_quaternion_and_non_finite_values(self):
        candidate = {
            "parent_frame": "torso_link",
            "sensor_frame": "mid360_link",
            "translation_m": [0.0, 0.0, 0.4],
            "rotation_xyzw": [0.0, 0.0, 0.0, 1.0],
        }
        zero_quaternion = {
            **candidate,
            "rotation_xyzw": [0.0, 0.0, 0.0, 0.0],
        }
        non_finite_translation = {
            **candidate,
            "translation_m": [0.0, float("nan"), 0.4],
        }

        zero_result = compare_transforms(candidate, zero_quaternion)
        non_finite_result = compare_transforms(candidate, non_finite_translation)
        self.assertFalse(zero_result["matches"])
        self.assertIn("zero magnitude", zero_result["reason"])
        self.assertFalse(non_finite_result["matches"])
        self.assertIn("finite values", non_finite_result["reason"])

    def test_model_candidate_and_saved_flags_do_not_hide_missing_footprint(self):
        status = calibration_status(
            {
                "G1_LIDAR_AXIS_CONFIRMED": "1",
                "G1_DISTANCE_CALIBRATION_CONFIRMED": "1",
            }
        )

        self.assertFalse(status["ready"])
        self.assertEqual(status["status"], "unverified")
        self.assertEqual(len(status["missing_footprint"]), 3)
        self.assertIn("missing", status["reason"])

    def test_saved_configuration_is_never_claimed_as_live_hardware_validation(self):
        status = calibration_status(
            {
                "G1_LIDAR_AXIS_CONFIRMED": "1",
                "G1_DISTANCE_CALIBRATION_CONFIRMED": "1",
                "G1_DISTANCE_FOOTPRINT_FRONT_M": "0.4",
                "G1_DISTANCE_FOOTPRINT_REAR_M": "0.3",
                "G1_DISTANCE_FOOTPRINT_HALF_WIDTH_M": "0.2",
            }
        )

        self.assertFalse(status["ready"])
        self.assertTrue(status["configuration_present"])
        self.assertEqual(status["status"], "configured_unverified")
        self.assertIn("live transform comparison", status["reason"])
        self.assertIn("No model candidate or saved flag", status["verification_note"])


if __name__ == "__main__":
    unittest.main()
