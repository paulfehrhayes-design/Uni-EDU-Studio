import os
import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

try:
    from . import sensor_calibration as calibration_module
    from .sensor_calibration import (
        _live_provider_calibration_report,
        DEFAULT_GEOMETRY_PATH,
        DEFAULT_URDF_PATH,
        automatic_calibration_model,
        calibration_status,
        compare_transforms,
        derive_g1_footprint,
        load_candidate_sensor_mounts,
        load_robot_root_frame,
    )
except ImportError:
    import sensor_calibration as calibration_module
    from sensor_calibration import (
        _live_provider_calibration_report,
        DEFAULT_GEOMETRY_PATH,
        DEFAULT_URDF_PATH,
        automatic_calibration_model,
        calibration_status,
        compare_transforms,
        derive_g1_footprint,
        load_candidate_sensor_mounts,
        load_robot_root_frame,
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

    def test_supported_g1_description_has_pelvis_root(self):
        self.assertEqual(load_robot_root_frame(), "pelvis")

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

    def test_host_uses_bundled_models_when_container_paths_are_unavailable(self):
        original_isfile = os.path.isfile

        def isfile(path):
            if path in {"/opt/uni-edu/g1_23dof.urdf.txt", "/opt/uni-edu/g1.xml"}:
                return False
            return original_isfile(path)

        with patch.dict(
            os.environ,
            {
                "G1_SENSOR_URDF_PATH": "/opt/uni-edu/g1_23dof.urdf.txt",
                "G1_SENSOR_GEOMETRY_PATH": "/opt/uni-edu/g1.xml",
            },
        ), patch.object(calibration_module.os.path, "isfile", side_effect=isfile):
            model = automatic_calibration_model()
            status = calibration_status(
                live_report={
                    "ready": False,
                    "status": "waiting_for_live_transform",
                    "reason": "Waiting for live TF.",
                    "model_fingerprint": model["model_fingerprint"],
                }
            )

        self.assertEqual(len(model["path_warnings"]), 2)
        self.assertEqual(len(status["model_path_warnings"]), 2)
        self.assertIn("bundled G1 EDU 23-DOF URDF", status["reason"])
        self.assertFalse(status["ready"])

    def test_calibration_uses_the_exact_23_dof_edu_collision_model(self):
        model = automatic_calibration_model()

        self.assertEqual(model["actuated_joint_count"], 23)
        self.assertEqual(model["footprint"]["source"], "g1_23dof.xml")
        status = calibration_status(
            env={"G1_DISTANCE_BASE_FRAME": model["root_frame"]},
            live_report={"ready": False},
        )
        self.assertEqual(status["geometry_model"], "g1_23dof.xml")
        self.assertEqual(status["actuated_joint_count"], 23)
        self.assertEqual(
            {key: model["footprint"][key] for key in ("front", "rear", "half_width")},
            {"front": 0.175, "rear": 0.175, "half_width": 0.225},
        )

    def test_calibration_rejects_a_robot_description_with_the_wrong_dof_count(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            urdf_path = os.path.join(temp_dir, "wrong_dof.urdf")
            tree = ET.parse(DEFAULT_URDF_PATH)
            root = tree.getroot()
            ET.SubElement(root, "link", {"name": "extra_link"})
            joint = ET.SubElement(
                root,
                "joint",
                {"name": "extra_joint", "type": "revolute"},
            )
            ET.SubElement(joint, "parent", {"link": "pelvis"})
            ET.SubElement(joint, "child", {"link": "extra_link"})
            ET.SubElement(joint, "axis", {"xyz": "0 0 1"})
            tree.write(urdf_path, encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "must have 23 actuated joints"):
                automatic_calibration_model(urdf_path, DEFAULT_GEOMETRY_PATH)

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

    def test_driver_frame_alias_can_match_model_mount_geometry(self):
        model = automatic_calibration_model()
        candidate = {
            **model["mount"],
            "sensor_frame": "livox_frame",
        }
        observed = {
            **candidate,
            "translation_m": list(candidate["translation_m"]),
            "rotation_xyzw": list(candidate["rotation_xyzw"]),
        }

        comparison = compare_transforms(candidate, observed)

        self.assertTrue(comparison["matches"])

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
                "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                "G1_LIDAR_MOUNT_CONFIRMED": "1",
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
            env={
                "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                "G1_LIDAR_MOUNT_CONFIRMED": "1",
            },
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
        self.assertEqual(status["status"], "model_derived")
        self.assertEqual(status["calibration_source"], "model_derived")
        self.assertIn("provisional", status["verification_note"])
        self.assertTrue(status["axis_confirmed"])
        self.assertTrue(status["calibration_confirmed"])
        self.assertEqual(status["live_transform"]["translation_error_m"], 0.001)

    def test_driver_sensor_frame_alias_is_accepted_only_with_matching_mount_geometry(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={
                "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                "G1_LIDAR_MOUNT_CONFIRMED": "1",
            },
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

    def test_supplemental_live_tf_source_can_use_the_supported_model_footprint(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={"G1_DISTANCE_BASE_FRAME": model["root_frame"]},
            live_report={
                "ready": True,
                "model_fingerprint": model["model_fingerprint"],
                "base_frame_id": model["root_frame"],
                "footprint": model["footprint"],
                "sources": [
                    {
                        "id": "front-depth",
                        "status": "ready",
                        "contributing": True,
                        "sensor_frame_id": "camera_depth_frame",
                        "model_mount": False,
                        "transform": {
                            "target_frame": model["root_frame"],
                            "source_frame": "camera_depth_frame",
                            "translation_m": [0.2, 0.0, 0.3],
                            "rotation_xyzw": [0.0, 0.0, 0.0, 1.0],
                            "calibration_source": "live_tf",
                        },
                    }
                ],
            },
        )

        self.assertTrue(status["ready"])
        self.assertEqual(status["status"], "model_derived")
        self.assertFalse(status["physical_mount_confirmed"])

    def test_model_mount_fallback_is_rejected_for_a_different_sensor_frame(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={"G1_DISTANCE_BASE_FRAME": model["root_frame"]},
            live_report={
                "ready": True,
                "model_fingerprint": model["model_fingerprint"],
                "base_frame_id": model["root_frame"],
                "footprint": model["footprint"],
                "sources": [
                    {
                        "id": "wrong-frame",
                        "status": "ready",
                        "contributing": True,
                        "sensor_frame_id": "other_sensor_frame",
                        "model_mount": True,
                        "transform": {
                            "target_frame": model["root_frame"],
                            "source_frame": "other_sensor_frame",
                            "translation_m": [0.2, 0.0, 0.3],
                            "rotation_xyzw": [0.0, 0.0, 0.0, 1.0],
                            "calibration_source": "model_derived",
                        },
                    }
                ],
            },
        )

        self.assertFalse(status["ready"])
        self.assertIn("without a matching live transform", status["reason"])

    def test_calibration_rejects_evidence_from_a_different_model(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={
                "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                "G1_LIDAR_MOUNT_CONFIRMED": "1",
            },
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
            env={
                "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                "G1_LIDAR_MOUNT_CONFIRMED": "1",
            },
            live_report={
                "ready": True,
                "model_fingerprint": model["model_fingerprint"],
                "footprint": model["footprint"],
            },
        )

        self.assertFalse(status["ready"])
        self.assertIn("without a matching live transform", status["reason"])

    def test_model_derived_calibration_is_available_without_physical_mount_confirmation(self):
        model = automatic_calibration_model()
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = os.path.join(temp_dir, "sensor-calibration.json")
            status = calibration_status(
                env={
                    "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                    "G1_SENSOR_AUTO_CALIBRATION_PERSIST": "1",
                    "G1_SENSOR_CALIBRATION_CACHE_PATH": cache_path,
                },
                live_report={
                    "ready": True,
                    "status": "verified",
                    "model_fingerprint": model["model_fingerprint"],
                    "transform": {
                        "parent_frame": model["mount"]["parent_frame"],
                        "sensor_frame": "livox_frame",
                        "translation_error_m": 0.0,
                        "rotation_error_rad": 0.0,
                    },
                    "footprint": model["footprint"],
                },
            )
            self.assertFalse(os.path.exists(cache_path))

        self.assertTrue(status["ready"])
        self.assertEqual(status["status"], "model_derived")
        self.assertEqual(status["calibration_source"], "model_derived")
        self.assertFalse(status["physical_mount_confirmed"])

    def test_calibration_rejects_non_model_distance_base_frame(self):
        model = automatic_calibration_model()
        status = calibration_status(
            env={
                "G1_DISTANCE_BASE_FRAME": "base_link",
                "G1_LIDAR_MOUNT_CONFIRMED": "1",
            },
            live_report={
                "ready": True,
                "model_fingerprint": model["model_fingerprint"],
            },
        )

        self.assertFalse(status["ready"])
        self.assertIn("supported G1 model root 'pelvis'", status["reason"])

    def test_persisted_model_match_does_not_replace_live_provider_evidence(self):
        model = automatic_calibration_model()
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = os.path.join(temp_dir, "sensor-calibration.json")
            env = {
                "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                "G1_LIDAR_MOUNT_CONFIRMED": "1",
                "G1_SENSOR_AUTO_CALIBRATION_PERSIST": "1",
                "G1_SENSOR_CALIBRATION_CACHE_PATH": cache_path,
            }
            live_report = {
                "ready": True,
                "status": "verified",
                "reason": "Persisted model match.",
                "model_fingerprint": model["model_fingerprint"],
                "transform": {
                    "parent_frame": model["mount"]["parent_frame"],
                    "sensor_frame": model["mount"]["sensor_frame"],
                    "translation_error_m": 0.0,
                    "rotation_error_rad": 0.0,
                },
                "footprint": model["footprint"],
            }
            status = calibration_status(env=env, live_report=live_report)
            self.assertTrue(status["ready"])
            self.assertEqual(status["status"], "model_derived")
            self.assertFalse(os.path.exists(cache_path))

            with open(cache_path, "w", encoding="utf-8") as cache_file:
                json.dump(
                    {
                        "ready": True,
                        "status": "verified",
                        "model_fingerprint": model["model_fingerprint"],
                        "root_frame": model["root_frame"],
                        "footprint": model["footprint"],
                    },
                    cache_file,
                )
            restored = calibration_status(
                env={
                    "G1_DISTANCE_BASE_FRAME": model["root_frame"],
                    "G1_SENSOR_AUTO_CALIBRATION_PERSIST": "1",
                    "G1_SENSOR_CALIBRATION_CACHE_PATH": cache_path,
                }
            )
            self.assertFalse(restored["ready"])
            self.assertEqual(restored["status"], "awaiting_live_validation")
            self.assertEqual(restored["model_fingerprint"], model["model_fingerprint"])


if __name__ == "__main__":
    unittest.main()
