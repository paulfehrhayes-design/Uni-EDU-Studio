import os
import tempfile
import unittest
from unittest.mock import patch

try:
    from . import sensor_calibration as calibration_module
    from .sensor_calibration import (
        _live_provider_calibration_report,
        automatic_calibration_model,
        calibration_status,
        compare_transforms,
        derive_g1_footprint,
        load_candidate_sensor_mounts,
    )
except ImportError:
    import sensor_calibration as calibration_module
    from sensor_calibration import (
        _live_provider_calibration_report,
        automatic_calibration_model,
        calibration_status,
        compare_transforms,
        derive_g1_footprint,
        load_candidate_sensor_mounts,
    )


class SensorCalibrationTests(unittest.TestCase):
    def test_live_provider_status_uses_sibling_calibration_endpoint(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self):
                return b'{"ready":false,"status":"waiting"}'

        with patch.object(
            calibration_module.urllib.request, "urlopen", return_value=Response()
        ) as open_url:
            report, error = _live_provider_calibration_report(
                {
                    "G1_DISTANCE_PROVIDER_URL": (
                        "http://127.0.0.1:8181/distance/front"
                    ),
                    "G1_DISTANCE_PROVIDER_TOKEN": "test-token",
                }
            )

        self.assertIsNone(error)
        self.assertEqual(report["status"], "waiting")
        self.assertEqual(
            open_url.call_args.args[0].full_url,
            "http://127.0.0.1:8181/calibration",
        )

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

    def test_derives_footprint_from_g1_model_without_user_measurements(self):
        footprint = derive_g1_footprint()

        self.assertEqual(
            {key: footprint[key] for key in ("front", "rear", "half_width")},
            {"front": 0.175, "rear": 0.175, "half_width": 0.225},
        )
        self.assertGreaterEqual(footprint["front"], footprint["model_bounds_m"]["front"])
        self.assertGreaterEqual(footprint["rear"], footprint["model_bounds_m"]["rear"])
        self.assertGreaterEqual(
            footprint["half_width"], footprint["model_bounds_m"]["half_width"]
        )
        self.assertEqual(
            automatic_calibration_model()["mount"]["sensor_frame"],
            "mid360_link",
        )

    def test_model_geometry_and_saved_flags_are_not_live_calibration_evidence(self):
        model = automatic_calibration_model()
        status = calibration_status(
            {
                "G1_LIDAR_AXIS_CONFIRMED": "1",
                "G1_DISTANCE_CALIBRATION_CONFIRMED": "1",
                "G1_DISTANCE_FOOTPRINT_FRONT_M": "0.4",
                "G1_DISTANCE_FOOTPRINT_REAR_M": "0.3",
                "G1_DISTANCE_FOOTPRINT_HALF_WIDTH_M": "0.2",
            },
            live_report={
                "ready": False,
                "status": "waiting_for_live_transform",
                "reason": "No fresh matching live transform.",
                "model_fingerprint": model["model_fingerprint"],
            },
        )

        self.assertFalse(status["ready"])
        self.assertTrue(status["configuration_present"])
        self.assertEqual(status["status"], "awaiting_live_validation")
        self.assertIn("No fresh matching live transform", status["reason"])
        self.assertEqual(status["missing_footprint"], [])

    def test_calibration_becomes_ready_only_for_fresh_matching_model_evidence(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={},
            live_report={
                "ready": True,
                "status": "verified",
                "reason": "Live transform matches.",
                "model_fingerprint": model["model_fingerprint"],
                "transform": {
                    "parent_frame": model["mount"]["parent_frame"],
                    "sensor_frame": model["mount"]["sensor_frame"],
                    "translation_error_m": 0.001,
                    "rotation_error_rad": 0.001,
                },
                "footprint": model["footprint"],
            },
        )

        self.assertTrue(status["ready"])
        self.assertEqual(status["status"], "verified")
        self.assertTrue(status["axis_confirmed"])
        self.assertTrue(status["calibration_confirmed"])
        self.assertEqual(status["live_transform"]["translation_error_m"], 0.001)

    def test_driver_sensor_frame_alias_is_accepted_only_with_matching_mount_geometry(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={},
            live_report={
                "ready": True,
                "status": "verified",
                "model_fingerprint": model["model_fingerprint"],
                "transform": {
                    "parent_frame": model["mount"]["parent_frame"],
                    "sensor_frame": "utlidar_lidar",
                    "translation_error_m": 0.001,
                    "rotation_error_rad": 0.001,
                },
                "footprint": model["footprint"],
            },
        )

        self.assertTrue(status["ready"])

    def test_calibration_rejects_evidence_from_a_different_model(self):
        status = calibration_status(
            env={},
            live_report={
                "ready": True,
                "model_fingerprint": "not-the-current-model",
            },
        )

        self.assertFalse(status["ready"])
        self.assertIn("different G1 model", status["reason"])

    def test_provider_ready_flag_without_transform_evidence_is_rejected(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={},
            live_report={
                "ready": True,
                "model_fingerprint": model["model_fingerprint"],
                "footprint": model["footprint"],
            },
        )

        self.assertFalse(status["ready"])
        self.assertIn("without a matching live transform", status["reason"])


if __name__ == "__main__":
    unittest.main()
