import os
import fcntl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

import duet_robot


class DuetProgramValidationTests(unittest.TestCase):
    def test_parser_accepts_bounded_front_and_rear_distance_conditions(self):
        for sensor, operator in (
            ("front", "<"),
            ("front", "<="),
            ("front", ">"),
            ("front", ">="),
            ("front", "=="),
            ("front", "!="),
            ("rear", "<"),
        ):
            with self.subTest(sensor=sensor, operator=operator):
                command = duet_robot.parse_duet_program(
                    f"if duet.{sensor}_distance_m() {operator} 0.1:\n"
                    "    duet.stop()\n"
                    "else:\n"
                    "    duet.wait(0.1)"
                )[0]
                self.assertEqual(command["type"], "distance_condition")
                self.assertEqual(command["sensor"], f"{sensor}_distance_m")
                self.assertEqual(command["operator"], operator)
                self.assertEqual(command["threshold"], 0.1)
                self.assertEqual(command["then"][0]["type"], "stop")
                self.assertEqual(command["else"][0]["type"], "wait")

        for code in (
            "if duet.front_distance_m() < 0.09:\n    duet.stop()",
            "if duet.rear_distance_m() > 40.1:\n    duet.stop()",
            "if duet.front_distance_m() < True:\n    duet.stop()",
            "if duet.front_distance_m() in [1, 2]:\n    duet.stop()",
            "if robot.front_distance_m() < 1:\n    duet.stop()",
            "if duet.front_distance_m() < 1:\n    pass",
        ):
            with self.subTest(code=code), self.assertRaises(
                duet_robot.DuetProgramValidationError
            ):
                duet_robot.parse_duet_program(code)

    def test_clear_sample_comparisons_only_return_when_clearance_proves_the_result(self):
        clear_sample = {
            "distance_m": None,
            "clear": True,
            "max_range_m": 4.0,
            "age_ms": 10,
        }
        self.assertFalse(duet_robot._distance_condition_result(clear_sample, "<", 1.0))
        self.assertTrue(duet_robot._distance_condition_result(clear_sample, ">", 1.0))
        with self.assertRaisesRegex(duet_robot.DistanceSensorError, "ambiguous"):
            duet_robot._distance_condition_result(clear_sample, "<=", 4.0)

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

    def test_parser_accepts_only_bounded_concurrent_move_with_named_arm_pose(self):
        command = duet_robot.parse_duet_program(
            'duet.move_and_arm(0.15, 0, 0, 1, "forward", 1.5)'
        )[0]
        self.assertEqual(command, {
            "type": "move_and_arm",
            "vx_mps": 0.15,
            "vy_mps": 0.0,
            "yaw_rate_rps": 0.0,
            "duration_s": 1.0,
            "pose": "forward",
            "arm_duration_s": 1.5,
        })
        for code in (
            'duet.move_and_arm(0.31, 0, 0, 1, "forward", 1.5)',
            'duet.move_and_arm(0.15, 0, 0, 2.6, "forward", 3)',
            'duet.move_and_arm(0.15, 0, 0, 1, "wave", 1.5)',
            'duet.move_and_arm(0.15, 0, 0, 1.5, "forward", 1.5)',
        ):
            with self.subTest(code=code), self.assertRaises(duet_robot.DuetProgramValidationError):
                duet_robot.parse_duet_program(code)

    def test_parser_pairs_any_supported_locomotion_with_a_specific_gesture(self):
        command = duet_robot.parse_duet_program(
            "with duet.concurrent():\n"
            "    duet.arc_backward_right(1.5)\n"
            "    duet.wave_left_mid(1)"
        )[0]
        self.assertEqual(command["type"], "concurrent")
        self.assertEqual(command["movement"]["vx_mps"], -0.08)
        self.assertEqual(command["movement"]["yaw_rate_rps"], -0.2)
        self.assertEqual(command["arm_commands"][0]["pose"], "left_wave_mid")
        self.assertEqual(command["arm_commands"][0]["type"], "arm_target")
        self.assertEqual(command["arm_commands"][-1]["pose"], "carry")
        invalid_programs = (
            "with duet.concurrent():\n    duet.wave_left_mid(1)\n    duet.arm_carry(1)",
            "with duet.concurrent():\n    duet.forward(1)\n    duet.turn_left(1)",
            "with duet.concurrent():\n    duet.forward(1)",
        )
        for code in invalid_programs:
            with self.subTest(code=code), self.assertRaises(duet_robot.DuetProgramValidationError):
                duet_robot.parse_duet_program(code)

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

    def test_parser_accepts_catalog_gestures_named_pose_holds_and_explicit_reset(self):
        gesture = duet_robot.parse_duet_program("duet.gesture_kiss_left(1)")[0]
        self.assertEqual(gesture["type"], "arm_trajectory")
        self.assertEqual(gesture["gesture"], "gesture_kiss_left")
        self.assertEqual(len(gesture["arm_commands"]), 2)

        held = duet_robot.parse_duet_program(
            'duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\n'
            "duet.wait(1)\n"
            "duet.reset_arms()"
        )
        self.assertEqual(held[0]["type"], "arm_target_hold")
        self.assertTrue(held[0]["until_reset"])
        self.assertEqual(held[1]["type"], "wait")
        self.assertEqual(held[2]["type"], "reset_arms")
        timed = duet_robot.parse_duet_program(
            'duet.hold_pose(duet.pose("both_forward_low"), 30)'
        )[0]
        self.assertEqual(timed["duration_s"], 30)
        self.assertEqual(len(timed["target"]), 10)
        self.assertIn("right_arm_cross_body", duet_robot.DUET_ARM_POSES)

        for code in (
            'duet.hold_pose(duet.pose("carry"), 31)',
            'duet.hold_pose_until_reset(duet.pose("unknown"))',
            'duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\n'
            "duet.gesture_clap(1)",
            'duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\n'
            'with duet.concurrent():\n'
            "    duet.forward(1)\n"
            "    duet.arm_carry(1)",
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
        left_wave = duet_robot.parse_duet_program('duet.wave_left("mid", 1.5)')
        right_wave = duet_robot.parse_duet_program('duet.wave_right("mid", 1.5)')
        self.assertEqual(left_wave[0]["type"], "arm_trajectory")
        self.assertEqual(
            [command["pose"] for command in left_wave[0]["arm_commands"]],
            ["left_wave_mid", "left_wave_mid_out", "left_wave_mid", "left_wave_mid_out", "carry"],
        )
        self.assertEqual(
            [command["pose"] for command in right_wave[0]["arm_commands"]],
            ["right_wave_mid", "right_wave_mid_out", "right_wave_mid", "right_wave_mid_out", "carry"],
        )
        left_target = left_wave[0]["arm_commands"][0]["target"]
        right_target = right_wave[0]["arm_commands"][0]["target"]
        self.assertEqual(right_target[:5], [
            left_target[5], -left_target[6], -left_target[7], left_target[8], -left_target[9],
        ])
        self.assertEqual(right_target[5:], [
            left_target[0], -left_target[1], -left_target[2], left_target[3], -left_target[4],
        ])
        for code in (
            'duet.arm_motion("wave", 1.5)',
            'duet.arm_motion("reach_and_return", 0.5)',
            'duet.arm_motion(1, 1.5)',
            'duet.wave_left("urgent", 1.5)',
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
            "for _ in range(21):\n    duet.stop()",
        ):
            with self.subTest(code=code), self.assertRaises(duet_robot.DuetProgramValidationError):
                duet_robot.parse_duet_program(code)
        raise_both = duet_robot.parse_duet_program('duet.raise_both_arms("high", 1.5)')[0]
        self.assertEqual(raise_both["type"], "arm_trajectory")
        self.assertEqual(
            [command["pose"] for command in raise_both["arm_commands"]],
            ["both_raise_high", "carry"],
        )

    def test_stop_must_be_final_and_program_has_no_aggregate_duration_cap(self):
        with self.assertRaisesRegex(duet_robot.DuetProgramValidationError, "final command"):
            duet_robot.parse_duet_program("duet.stop()\nduet.wait(1)")
        twenty_repeats = "for _ in range(20):\n    duet.wait(0.1)"
        four_hundred_repeats = (
            "for _ in range(20):\n"
            "    for _ in range(20):\n"
            "        duet.wait(3)"
        )
        self.assertEqual(len(duet_robot.parse_duet_program(twenty_repeats)), 20)
        commands = duet_robot.parse_duet_program(four_hundred_repeats)
        self.assertEqual(len(commands), 400)
        self.assertEqual(sum(command["duration_s"] for command in commands), 1200)
        with self.assertRaisesRegex(duet_robot.DuetProgramValidationError, "400 expanded commands"):
            duet_robot.parse_duet_program(f"{four_hundred_repeats}\nduet.wait(3)")

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
    def test_distance_condition_samples_front_sensor_and_executes_selected_branch(self):
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
        sample = {
            "distance_m": 0.4,
            "clear": False,
            "max_range_m": 40.0,
            "age_ms": 12,
        }
        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot, "_gateway_request", return_value=status
        ) as gateway_request, patch.object(
            duet_robot, "get_front_distance_sample", return_value=sample
        ) as front_sample:
            result = duet_robot.execute_program(
                "if duet.front_distance_m() < 0.5:\n"
                "    duet.stop()\n"
                "else:\n"
                "    duet.wait(0.1)"
            )

        front_sample.assert_called_once_with()
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["conditionsEvaluated"][0]["branch"], "then")
        self.assertEqual(result["conditionsEvaluated"][0]["distance_m"], 0.4)
        self.assertEqual([item.args[0] for item in gateway_request.call_args_list], ["STATUS", "STOP"])

    def test_distance_condition_provider_error_aborts_and_requests_stop(self):
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
            duet_robot, "_gateway_request", return_value=status
        ) as gateway_request, patch.object(
            duet_robot,
            "get_rear_distance_sample",
            side_effect=duet_robot.DistanceSensorError("sample is stale"),
        ) as rear_sample:
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "sample is stale"):
                duet_robot.execute_program(
                    "if duet.rear_distance_m() < 1:\n"
                    "    duet.stop()\n"
                    "else:\n"
                    "    duet.wait(0.1)"
                )

        rear_sample.assert_called_once_with()
        self.assertIn(call("STOP"), gateway_request.call_args_list)

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

    def test_target_trajectory_fails_closed_without_arm_targets_capability(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_pose"],
            "arm_pose_active": False,
        }
        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot, "_gateway_request", side_effect=[status, status]
        ) as gateway_request:
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "arm-target capability"):
                duet_robot.execute_program("duet.gesture_kiss_left(1)")

        self.assertEqual(
            [call.args[0] for call in gateway_request.call_args_list],
            ["STATUS", "STOP"],
        )

    def test_until_reset_target_uses_only_advertised_target_protocol(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_targets"],
        }
        target_active = {**status, "arm_targets_active": True}
        requests = []

        def gateway_response(request):
            requests.append(request)
            if request == "STATUS" or request == "RESET_ARMS":
                return status
            if request.startswith("ARM_TARGETS "):
                return target_active
            raise AssertionError(f"Unexpected gateway request: {request}")

        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(duet_robot, "_gateway_request", side_effect=gateway_response):
            result = duet_robot.execute_program(
                'duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\n'
                "duet.reset_arms()"
            )

        self.assertEqual(result["status"], "completed")
        self.assertTrue(any(request.startswith("ARM_TARGETS 250 ") for request in requests))
        self.assertEqual(requests[-1], "RESET_ARMS")

    def test_stop_confirms_target_reset_when_gateway_advertises_arm_targets(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_targets"],
        }
        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_gateway_request", return_value=status
        ) as gateway_request:
            duet_robot._stop_gateway_command()

        self.assertEqual(
            [call.args[0] for call in gateway_request.call_args_list],
            ["STOP", "RESET_ARMS"],
        )

    def test_program_completion_resets_an_until_reset_arm_target(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_targets"],
        }
        requests = []

        def gateway_response(request):
            requests.append(request)
            if request == "STATUS" or request == "RESET_ARMS":
                return status
            if request.startswith("ARM_TARGETS "):
                return {**status, "arm_targets_active": True}
            raise AssertionError(f"Unexpected gateway request: {request}")

        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(duet_robot, "_gateway_request", side_effect=gateway_response):
            result = duet_robot.execute_program(
                'duet.hold_pose_until_reset(duet.pose("both_overhead"))'
            )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(requests[-1], "RESET_ARMS")

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

    def test_concurrent_move_keeps_arm_lease_active_while_refreshing_base_velocity(self):
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
        pose_active = {**status, "arm_pose_active": True}
        moving = {**pose_active, "motion_active": True}
        stopped = {**status, "motion_active": False}

        def gateway_response(request):
            if request == "STATUS":
                return status
            if request.startswith("ARM_POSE "):
                return pose_active
            if request.startswith("MOVE 0 0 0 "):
                return pose_active
            if request.startswith("MOVE "):
                return moving
            if request == "STOP":
                return stopped
            raise AssertionError(f"Unexpected gateway request: {request}")

        clock = {"now": 0.0}

        def advance_clock():
            clock["now"] += 0.05
            return clock["now"]

        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot,
            "_gateway_request",
            side_effect=gateway_response,
        ) as gateway_request, patch.object(
            duet_robot.time, "monotonic", side_effect=advance_clock
        ), patch.object(
            duet_robot._stop_requested, "wait", return_value=False
        ):
            result = duet_robot.execute_program(
                'duet.move_and_arm(0.15, 0, 0, 0.2, "forward", 1)'
            )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["commandsExecuted"], 1)
        requests = [request.args[0] for request in gateway_request.call_args_list]
        self.assertEqual(requests[:3], [
            "STATUS",
            "ARM_POSE forward 1000",
            "MOVE 0.150000 0.000000 0.000000 250",
        ])
        self.assertIn("MOVE 0 0 0 250", requests)
        self.assertEqual(requests[-1], "STOP")

    def test_concurrent_locomotion_runs_through_a_multi_pose_gesture(self):
        initial = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_targets"],
        }
        clock = {"now": 0.0}
        requests = []

        def gateway_response(request):
            requests.append(request)
            if request == "STATUS":
                return initial
            if request.startswith("ARM_TARGETS "):
                return {**initial, "arm_targets_active": True}
            if request == "RESET_ARMS":
                return initial
            if request.startswith("MOVE "):
                moving = request != "MOVE 0.000000 0.000000 0.000000 250"
                return {
                    **initial,
                    "motion_active": moving,
                    "arm_targets_active": clock["now"] < 5,
                }
            if request == "STOP":
                return initial
            raise AssertionError(f"Unexpected gateway request: {request}")

        def wait_and_advance(duration):
            clock["now"] += duration
            return False

        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot, "_gateway_request", side_effect=gateway_response
        ), patch.object(
            duet_robot.time, "monotonic", side_effect=lambda: clock["now"]
        ), patch.object(
            duet_robot._stop_requested, "wait", side_effect=wait_and_advance
        ):
            result = duet_robot.execute_program(
                "with duet.concurrent():\n"
                "    duet.forward(0.2)\n"
                "    duet.wave_left_low(1)"
            )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["commandsExecuted"], 1)
        self.assertTrue(any(request.startswith("ARM_TARGETS 250 ") for request in requests))
        self.assertIn("MOVE 0.150000 0.000000 0.000000 250", requests)
        self.assertIn("MOVE 0.000000 0.000000 0.000000 250", requests)
        self.assertEqual(requests[-1], "RESET_ARMS")

    def test_concurrent_move_stops_if_controller_drops_either_motion_lease(self):
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
        pose_active = {**status, "arm_pose_active": True}
        arm_expired = {**pose_active, "motion_active": True, "arm_pose_active": False}
        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot, "_gateway_request", side_effect=[status, pose_active, arm_expired, status]
        ) as gateway_request, patch.object(
            duet_robot.time, "monotonic", side_effect=[0.0, 0.0, 0.2, 2.0]
        ), patch.object(
            duet_robot._stop_requested, "wait", return_value=False
        ):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "arm-pose lease ended"):
                duet_robot.execute_program(
                    'duet.move_and_arm(0.15, 0, 0, 0.1, "forward", 1)'
                )

        self.assertEqual(gateway_request.call_args_list[-1], call("STOP"))

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
