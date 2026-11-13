import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "deploy"
    / "robots"
    / "g1_23dof"
    / "install_user_service.py"
)
SPEC = importlib.util.spec_from_file_location("duet_user_service_installer", SCRIPT)
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class UserServiceInstallerTests(unittest.TestCase):
    def test_unit_uses_absolute_same_user_gateway_directory_and_explicit_dds_interface(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory) / "g1-user"
            controller_dir = Path(temporary_directory) / "checkout" / "g1_23dof"
            unit = INSTALLER.render_unit(controller_dir, home, "eth0")
            control_dir = str(home / ".cache" / "uni-edu-duet")

        self.assertIn(f"Environment=DUET_CONTROL_DIR={control_dir}", unit)
        self.assertIn("Environment=DUET_GATEWAY_ENABLED=true", unit)
        self.assertIn(
            f"ConditionFileIsExecutable={controller_dir}/build/g1_ctrl",
            unit,
        )
        self.assertIn(
            f"ExecStart={controller_dir}/build/g1_ctrl --network eth0",
            unit,
        )
        self.assertIn(f"WorkingDirectory={controller_dir}", unit)

    def test_unit_is_manual_start_only_and_does_not_restart_the_controller(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            unit = INSTALLER.render_unit(
                Path(temporary_directory) / "controller",
                Path(temporary_directory) / "home",
                "enp1s0",
            )

        self.assertIn("Restart=no", unit)
        self.assertNotIn("WantedBy=", unit)
        self.assertNotIn("ExecStartPre=", unit)

    def test_custom_control_directory_is_shared_with_the_backend(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            custom_control_dir = root / "shared-duet"
            unit = INSTALLER.render_unit(
                root / "controller",
                root / "home",
                "enp1s0",
                custom_control_dir,
            )

        self.assertIn(f"Environment=DUET_CONTROL_DIR={custom_control_dir}", unit)

    def test_rejects_missing_or_malformed_network_interfaces(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            sysfs = Path(temporary_directory)
            (sysfs / "enp1s0").mkdir()

            INSTALLER.validate_interface("enp1s0", sysfs)
            for interface in ("missing0", "../enp1s0", "interface name"):
                with self.subTest(interface=interface):
                    with self.assertRaises(ValueError):
                        INSTALLER.validate_interface(interface, sysfs)

    def test_rejects_long_control_socket_paths(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            long_home = Path(temporary_directory) / ("h" * 100)
            with self.assertRaisesRegex(ValueError, "too long"):
                INSTALLER.render_unit(
                    Path(temporary_directory) / "controller",
                    long_home,
                    "eth0",
                )


if __name__ == "__main__":
    unittest.main()
