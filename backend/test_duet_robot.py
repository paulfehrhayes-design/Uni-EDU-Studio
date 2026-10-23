import os
import fcntl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

import duet_robot


class DuetProgramValidationTests(unittest.TestCase):
    def test_parser_accepts_only_bounded_duet_commands_and_loops(self):
        commands = duet_robot.parse_duet_program(
            'for _ in range(2):\n'
            '    duet.move(0.2, 0, 0, 1)\n'
            'duet.wait(0.5)'
        )

        self.assertEqual(len(commands), 3)
        self.assertEqual(commands[0]["type"], "move")
        self.assertEqual(commands[-1]["type"], "wait")

    def test_parser_accepts_negative_velocity_and_yaw_literals(self):
        command = duet_robot.parse_duet_program("duet.move(-0.1, 0, -0.2, 0.5)")[0]

        self.assertEqual(command["vx_mps"], -0.1)
        self.assertEqual(command["yaw_rate_rps"], -0.2)

    def test_parser_expands_directional_commands_to_bounded_velocity(self):
        commands = duet_robot.parse_duet_program(
            "duet.forward(1)\n"
            "duet.backward(1)\n"
            "duet.strafe_left(1)\n"
            "duet.strafe_right(1)\n"
            "duet.turn_left(1)\n"
            "duet.turn_right(1)\n"
            "duet.arc_forward_left(1)\n"
            "duet.arc_forward_right(1)\n"
            "duet.arc_backward_left(1)\n"
            "duet.arc_backward_right(1)"
        )

        self.assertEqual(len(commands), 10)
        self.assertEqual(commands[0]["vx_mps"], 0.15)
        self.assertEqual(commands[2]["vy_mps"], 0.1)
        self.assertEqual(commands[4]["yaw_rate_rps"], 0.25)
        self.assertEqual(commands[-1]["vx_mps"], -0.08)
        self.assertEqual(commands[-1]["yaw_rate_rps"], -0.2)
        with self.assertRaisesRegex(duet_robot.DuetProgramValidationError, "duration must be between"):
            duet_robot.parse_duet_program("duet.forward(3.1)")

    def test_parser_accepts_only_fixed_arm_poses_and_bounded_lease_duration(self):
        command = duet_robot.parse_duet_program('duet.arm_pose("forward", 1.5)')[0]
        self.assertEqual(command, {
            "type": "arm_pose",
            "pose": "forward",
            "duration_s": 1.5,
        })
        for code in (
            'duet.arm_pose("wave", 1)',
            'duet.arm_pose("forward", 0.5)',
            'duet.arm_pose("forward", 3.1)',
            "duet.arm_pose(1, 1)",
        ):
            with self.subTest(code=code), self.assertRaises(duet_robot.DuetProgramValidationError):
                duet_robot.parse_duet_program(code)

    def test_parser_expands_arm_motion_names_into_bounded_existing_pose_commands(self):
        commands = duet_robot.parse_duet_program(
            'duet.arm_motion("receive_hold_return", 1.5)'
        )

        self.assertEqual(
            [(command["pose"], command["duration_s"]) for command in commands],
            [("forward", 1.5), ("box_hold", 1.5), ("carry", 1.5)],
        )
        for code in (
            'duet.arm_motion("wave", 1.5)',
            'duet.arm_motion("reach_and_return", 0.5)',
            'duet.arm_motion(1, 1.5)',
        ):
            with self.subTest(code=code), self.assertRaises(duet_robot.DuetProgramValidationError):
                duet_robot.parse_duet_program(code)

    def test_parser_rejects_legacy_syntax_and_out_of_bounds_values(self):
        for code in (
            "robot.walk(1)",
            "duet.raw_joint(1)",
            'duet.raise_arm("left", "mid", 1)',
            'duet.wave("left", "mid", 1)',
            "duet.move(0.31, 0, 0, 1)",
            "for _ in range(11):\n    duet.stop()",
        ):
            with self.subTest(code=code), self.assertRaises(duet_robot.DuetProgramValidationError):
                duet_robot.parse_duet_program(code)

    def test_stop_must_be_final_and_program_duration_is_bounded(self):
        with self.assertRaisesRegex(duet_robot.DuetProgramValidationError, "final command"):
            duet_robot.parse_duet_program("duet.stop()\nduet.wait(1)")
        with self.assertRaisesRegex(duet_robot.DuetProgramValidationError, "duration may not exceed"):
            duet_robot.parse_duet_program(
                "for _ in range(10):\n"
                "    for _ in range(10):\n"
                "        duet.wait(0.4)"
            )

    def test_gateway_configuration_uses_an_absolute_local_socket_directory(self):
        with tempfile.TemporaryDirectory() as temporary_directory, patch.dict(os.environ, {
            "DUET_CONTROL_DIR": temporary_directory,
        }):
            socket_path, lock_path = duet_robot._gateway_configuration()

        self.assertEqual(socket_path, Path(temporary_directory) / "controller.sock")
        self.assertEqual(lock_path, Path(temporary_directory) / "controller.lock")

        with patch.dict(os.environ, {"DUET_CONTROL_DIR": "relative/path"}):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "absolute"):
                duet_robot._gateway_configuration()

    def test_physical_execution_requires_explicit_hardware_acceptance(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "disabled"):
                duet_robot._require_hardware_acceptance()

        with patch.dict(os.environ, {
            "DUET_PHYSICAL_ENABLED": "true",
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
            "DUET_HARDWARE_ACCEPTANCE_ID": "G1-acceptance-2026-01",
        }, clear=True):
            self.assertEqual(
                duet_robot._require_hardware_acceptance(),
                "policy-reviewed-on-robot",
            )


class DuetOwnershipTests(unittest.TestCase):
    def test_arm_run_is_rejected_before_program_execution_when_gateway_gate_is_disabled(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop"],
        }
        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot, "_gateway_request", side_effect=[status, status]
        ) as gateway_request:
            with self.assertRaisesRegex(
                duet_robot.DuetControllerError,
                "separately accepted arm-pose capability",
            ):
                duet_robot.execute_program(
                    'duet.forward(1)\nduet.arm_motion("receive_hold_return", 1.5)'
                )

        self.assertEqual(
            [call.args[0] for call in gateway_request.call_args_list],
            ["STATUS", "STOP"],
        )

    def test_arm_run_uses_only_the_named_preset_protocol(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_pose_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_pose"],
        }
        accepted = {**status, "arm_pose_active": True}
        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot, "_gateway_request", side_effect=[status, accepted]
        ) as gateway_request, patch.object(duet_robot._stop_requested, "wait", return_value=False):
            result = duet_robot.execute_program('duet.arm_pose("box_hold", 1)')

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["commandsExecuted"], 1)
        self.assertEqual(
            [call.args[0] for call in gateway_request.call_args_list],
            ["STATUS", "ARM_POSE box_hold 1000"],
        )

    def test_connect_returns_the_acquired_controller_snapshot(self):
        acquired = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop"],
        }
        with patch.dict(os.environ, {
            "DUET_PHYSICAL_ENABLED": "true",
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
            "DUET_HARDWARE_ACCEPTANCE_ID": "acceptance-record",
        }), patch.object(duet_robot, "_gateway_request", return_value=acquired) as gateway_request:
            result = duet_robot.connect_controller()

        self.assertEqual(result["status"], "connected")
        self.assertTrue(result["controlLease"])
        self.assertEqual(result["motionOwner"], "duet")
        gateway_request.assert_called_once_with("ACQUIRE")

    def test_disconnect_reports_app_lease_release_without_claiming_process_stopped(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "control_lease": False,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop"],
        }
        with patch.dict(os.environ, {
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
        }), patch.object(
            duet_robot,
            "_gateway_request",
            side_effect=[{**status, "control_lease": True}, status],
        ) as gateway_request:
            result = duet_robot.disconnect_controller()

        self.assertEqual(result["status"], "released")
        self.assertEqual(result["motionOwner"], "duet")
        self.assertEqual(
            gateway_request.call_args_list,
            [call("STOP"), call("RELEASE")],
        )

    def test_stop_rejects_gateway_response_that_keeps_velocity_command_active(self):
        active_after_stop = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": True,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop"],
        }
        with patch.dict(os.environ, {
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
        }), patch.object(duet_robot, "_gateway_request", return_value=active_after_stop):
            with self.assertRaisesRegex(
                duet_robot.DuetControllerError,
                "inactive velocity command after STOP",
            ):
                duet_robot.stop_controller()

    def test_unconfigured_controller_reports_no_motion_ownership(self):
        with tempfile.TemporaryDirectory() as temporary_directory, patch.dict(os.environ, {
            "DUET_CONTROL_DIR": str(Path(temporary_directory) / "duet"),
        }, clear=True):
            status = duet_robot.controller_status()

        self.assertFalse(status["connected"])
        self.assertEqual(status["motionOwner"], "none")
        self.assertFalse(duet_robot.controller_owns_motion()[0])

    def test_controller_status_requires_exact_protocol_policy_and_capabilities(self):
        disconnected = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": False,
            "ready": False,
            "motion_active": False,
            "control_lease": False,
            "lowcmd_owner": "none",
            "capabilities": ["base_velocity", "wait", "stop"],
        }
        active = {
            **disconnected,
            "connected": True,
            "ready": True,
            "control_lease": True,
            "lowcmd_owner": "duet",
        }
        with tempfile.TemporaryDirectory() as temporary_directory, patch.dict(os.environ, {
            "DUET_CONTROL_DIR": str(Path(temporary_directory) / "duet"),
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
        }), patch.object(duet_robot, "_gateway_request", return_value=disconnected):
            self.assertFalse(duet_robot.controller_owns_motion()[0])
        with tempfile.TemporaryDirectory() as temporary_directory, patch.dict(os.environ, {
            "DUET_CONTROL_DIR": str(Path(temporary_directory) / "duet"),
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
        }), patch.object(duet_robot, "_gateway_request", return_value=active):
            self.assertTrue(duet_robot.controller_owns_motion()[0])
        with tempfile.TemporaryDirectory() as temporary_directory, patch.dict(os.environ, {
            "DUET_CONTROL_DIR": str(Path(temporary_directory) / "duet"),
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
        }), patch.object(duet_robot, "_gateway_request", return_value={
            **disconnected,
            "lowcmd_owner": "unknown",
        }):
            self.assertTrue(duet_robot.controller_owns_motion()[0])

        with tempfile.TemporaryDirectory() as temporary_directory, patch.dict(os.environ, {
            "DUET_CONTROL_DIR": str(Path(temporary_directory) / "duet"),
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
        }), patch.object(duet_robot, "_gateway_request", return_value={
            **disconnected,
            "capabilities": ["base_velocity", "wait"],
        }):
            status = duet_robot.controller_status()
            self.assertEqual(status["motionOwner"], "unknown")

    def test_process_lock_keeps_ownership_unknown_when_socket_is_unreachable(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            control_dir = Path(temporary_directory) / "duet"
            control_dir.mkdir()
            lock_path = control_dir / "controller.lock"
            descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                with patch.dict(os.environ, {
                    "DUET_CONTROL_DIR": str(control_dir),
                }), patch.object(
                    duet_robot,
                    "_gateway_request",
                    side_effect=duet_robot.DuetControllerError("socket unavailable"),
                ):
                    status = duet_robot.controller_status()
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

        self.assertEqual(status["motionOwner"], "unknown")


if __name__ == "__main__":
    unittest.main()
