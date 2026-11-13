import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import duet_setup


class DuetSetupTests(unittest.TestCase):
    def make_controller(self, root: Path) -> Path:
        controller = root / "vendor" / "DUET" / "deploy" / "robots" / "g1_23dof"
        controller.mkdir(parents=True)
        (controller / "CMakeLists.txt").write_text("project(test)\n", encoding="utf-8")
        (controller / "config").mkdir()
        (controller / "config" / "config.yaml").write_text(
            "FSM:\n  Velocity:\n    policy_dir: config/policy/velocity\n",
            encoding="utf-8",
        )
        return controller

    def test_policy_identity_matches_latest_policy_selected_by_controller_config(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            controller = self.make_controller(root)
            for version, contents in (("v0", b"old policy"), ("v2", b"loaded policy")):
                policy = (
                    controller / "config" / "policy" / "velocity"
                    / version / "exported" / "policy.onnx"
                )
                policy.parent.mkdir(parents=True)
                policy.write_bytes(contents)

            expected_policy = (
                controller / "config" / "policy" / "velocity"
                / "v2" / "exported" / "policy.onnx"
            )
            expected = "sha256:" + hashlib.sha256(b"loaded policy").hexdigest()

            self.assertEqual(duet_setup.resolve_loaded_policy(controller), expected_policy.resolve())
            self.assertEqual(duet_setup.policy_identity(controller), expected)

    def test_missing_policy_fails_instead_of_generating_an_unverified_identity(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            controller = self.make_controller(Path(temporary_directory))
            with self.assertRaisesRegex(ValueError, "No exported policy directory"):
                duet_setup.policy_identity(controller)

    def test_preparation_rebuilds_an_existing_executable_incrementally(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            controller = self.make_controller(root)
            (controller.parent.parent / "thirdparty" / "onnxruntime-linux-x64-1.22.0"
             / "lib").mkdir(parents=True)
            (controller.parent.parent / "thirdparty" / "onnxruntime-linux-x64-1.22.0"
             / "lib" / "libonnxruntime.so.1.22.0").touch()
            binary = controller / "build" / "g1_ctrl"
            binary.parent.mkdir()
            binary.write_text("already built", encoding="utf-8")
            binary.chmod(0o755)
            with patch.object(duet_setup.platform, "machine", return_value="x86_64"), \
                    patch.object(duet_setup, "_missing_apt_packages", return_value=[]), \
                    patch.object(duet_setup.subprocess, "run") as run:
                self.assertEqual(duet_setup.prepare_controller(root), str(binary))

        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0].args[0][0], "cmake")
        self.assertIn("--build", run.call_args_list[1].args[0])


if __name__ == "__main__":
    unittest.main()
