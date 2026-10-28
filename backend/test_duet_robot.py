import os
import fcntl
import json
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
            "type": "arm_trajectory",
            "gesture": "arm_pose",
            "arm_commands": [{
                "type": "arm_target",
                "pose": "forward",
                "target": duet_robot.DUET_ARM_POSE_TARGETS["forward"],
                "duration_s": 1.5,
            }],
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

        self.assertEqual(commands[0]["type"], "arm_trajectory")
        self.assertEqual(
            [(command["pose"], command["duration_s"]) for command in commands[0]["arm_commands"]],
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

    def test_every_named_arm_command_uses_catalog_targets(self):
        for name in duet_robot.DUET_ARM_COMMANDS:
            with self.subTest(command=name):
                command = duet_robot.parse_duet_program(f"duet.{name}(1)")[0]
                self.assertEqual(command["type"], "arm_trajectory")
                self.assertTrue(command["arm_commands"])
                self.assertTrue(all(
                    arm_command["type"] == "arm_target"
                    and len(arm_command["target"]) == 10
                    for arm_command in command["arm_commands"]
                ))
        for name in duet_robot.DUET_ARM_GESTURES:
            with self.subTest(gesture=name):
                command = duet_robot.parse_duet_program(f"duet.{name}(1)")[0]
                self.assertEqual(command["type"], "arm_trajectory")
                self.assertTrue(all(
                    arm_command["type"] == "arm_target"
                    and len(arm_command["target"]) == 10
                    for arm_command in command["arm_commands"]
                ))

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

        with tempfile.TemporaryDirectory() as control_dir, patch.dict(os.environ, {
            "DUET_CONTROL_DIR": control_dir,
            "DUET_PHYSICAL_ENABLED": "true",
            "DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot",
            "DUET_ROBOT_ID": "g1-test-unit",
        }, clear=True), patch.object(duet_robot, "_gateway_request", return_value={
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "gateway_build_id": "sha256:" + ("a" * 64),
            "connected": True,
            "ready": True,
            "motion_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "arm_targets_active": False,
            "external_arm_active": False,
            "measured_joints": [0.0] * 10,
            "capabilities": [
                "base_velocity",
                "wait",
                "stop",
                "arm_targets",
                "arm_feedback",
                "gateway_identity",
            ],
        }):
            report = {
                "status": "passed",
                "policy_id": "policy-reviewed-on-robot",
                "robot_model": duet_robot.DUET_ROBOT_MODEL,
                "robot_id": "g1-test-unit",
                "catalog_sha256": duet_robot._catalog_digest(),
                "backend_sha256": duet_robot._backend_digest(),
                "gateway_build_id": "sha256:" + ("a" * 64),
                "teacher_reviewed": True,
                "acceptance_id": "test-acceptance",
                "steps": [{
                    "status": "passed",
                    "review": {"passed": True, "physical_result_observed": True},
                }],
                "capabilities": [
                    "base_velocity",
                    "wait",
                    "stop",
                    "arm_targets",
                    "arm_feedback",
                    "gateway_identity",
                ],
            }
            duet_robot._commissioning_report_path().write_text(
                json.dumps(report),
                encoding="utf-8",
            )
            self.assertEqual(
                duet_robot._require_hardware_acceptance(),
                "policy-reviewed-on-robot",
            )
            report["catalog_sha256"] = "stale-catalog"
            duet_robot._commissioning_report_path().write_text(
                json.dumps(report),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "does not match"):
                duet_robot._require_hardware_acceptance()


class DuetCommissioningTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _controller_status(self):
        return {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "sha256:commission-policy",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "arm_targets_active": False,
            "external_arm_active": False,
            "measured_joints": [0.0] * 10,
            "capabilities": [
                "base_velocity",
                "wait",
                "stop",
                "arm_targets",
                "arm_feedback",
                "gateway_identity",
            ],
            "gateway_build_id": "sha256:" + ("a" * 64),
        }

    def test_commissioning_plan_covers_all_pose_and_gesture_mappings(self):
        steps = duet_robot._commissioning_steps()
        step_ids = {step["id"] for step in steps}

        for pose in duet_robot.DUET_ARM_POSES:
            self.assertIn(f"pose-{pose}", step_ids)
        for command in duet_robot.DUET_ARM_COMMANDS:
            self.assertIn(f"command-{command}", step_ids)
        for gesture in duet_robot.DUET_ARM_GESTURES:
            self.assertIn(f"gesture-{gesture}", step_ids)
        for movement in duet_robot.DUET_MOVEMENT_PRESETS:
            self.assertIn(f"base-{movement}", step_ids)
        for step in steps:
            if step["code"]:
                with self.subTest(step=step["id"]):
                    self.assertTrue(duet_robot.parse_duet_program(step["code"]))
        self.assertIn("velocity-lease-expiry", step_ids)
        self.assertIn("explicit-stop", step_ids)
        self.assertIn("concurrent-base-arm", step_ids)
        self.assertIn("move-and-arm", step_ids)

    def test_commissioning_requires_physical_and_supervised_gates_and_feedback(self):
        with patch.dict(os.environ, {
            "DUET_CONTROL_DIR": self.temp_dir.name,
            "DUET_EXPECTED_POLICY_ID": "sha256:commission-policy",
        }, clear=True), patch.object(
            duet_robot, "_gateway_request", return_value=self._controller_status()
        ):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "physical master switch"):
                duet_robot.start_commissioning("teacher")

        with patch.dict(os.environ, {
            "DUET_CONTROL_DIR": self.temp_dir.name,
            "DUET_EXPECTED_POLICY_ID": "sha256:commission-policy",
            "DUET_PHYSICAL_ENABLED": "true",
        }, clear=True), patch.object(
            duet_robot, "_gateway_request", return_value=self._controller_status()
        ):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "DUET_COMMISSIONING_ENABLED"):
                duet_robot.start_commissioning("teacher")

        status = self._controller_status()
        status["capabilities"].remove("arm_feedback")
        status["measured_joints"] = None
        with patch.dict(os.environ, {
            "DUET_CONTROL_DIR": self.temp_dir.name,
            "DUET_EXPECTED_POLICY_ID": "sha256:commission-policy",
            "DUET_PHYSICAL_ENABLED": "true",
            "DUET_COMMISSIONING_ENABLED": "true",
            "DUET_ROBOT_ID": "g1-test-unit",
        }, clear=True), patch.object(duet_robot, "_gateway_request", return_value=status):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "arm_feedback"):
                duet_robot.start_commissioning("teacher")

    def test_one_step_requires_observation_and_creates_matching_acceptance_report(self):
        step = {
            "id": "test-single-step",
            "title": "Single bounded test",
            "category": "base",
            "code": "duet.move(0.05, 0, 0, 0.5)",
            "expected": "Brief movement and stop.",
        }
        with patch.object(duet_robot, "_commissioning_state", None), patch.object(
            duet_robot, "_commissioning_steps", return_value=[step]
        ), patch.dict(os.environ, {
            "DUET_CONTROL_DIR": self.temp_dir.name,
            "DUET_EXPECTED_POLICY_ID": "sha256:commission-policy",
            "DUET_PHYSICAL_ENABLED": "true",
            "DUET_COMMISSIONING_ENABLED": "true",
            "DUET_ROBOT_ID": "g1-test-unit",
        }, clear=True), patch.object(
            duet_robot, "_gateway_request", return_value=self._controller_status()
        ), patch.object(
            duet_robot, "execute_program", return_value={
                "status": "completed",
                "commandsExecuted": 1,
                "armTelemetry": [],
            }
        ) as execute:
            report = duet_robot.start_commissioning("teacher")
            self.assertEqual(report["status"], "in_progress")
            self.assertEqual(report["current_step"], 0)
            report = duet_robot.run_commissioning_step(0)
            self.assertEqual(report["steps"][0]["status"], "awaiting_review")
            execute.assert_called_once_with(step["code"], commissioning=True)
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "confirms observing"):
                duet_robot.review_commissioning_step(0, True, False, "teacher")
            report = duet_robot.review_commissioning_step(0, True, True, "teacher", "Verified")
            self.assertEqual(report["status"], "passed")
            self.assertTrue(report["teacher_reviewed"])
            self.assertTrue(report["acceptance_id"])
            self.assertEqual(
                duet_robot._require_hardware_acceptance(),
                "sha256:commission-policy",
            )

    def test_arm_feedback_mismatch_cannot_be_teacher_passed(self):
        report = {
            "status": "in_progress",
            "current_step": 0,
            "teacher": "teacher",
            "steps": [{
                "id": "pose-check",
                "status": "awaiting_review",
                "feedback_within_tolerance": False,
                "result": {"armTelemetry": [{"maximumErrorRad": 0.5}]},
            }],
        }
        with patch.object(duet_robot, "_commissioning_state", report):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "exceeded 0.25 rad"):
                duet_robot.review_commissioning_step(0, True, True, "teacher")


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

    def test_arm_run_is_rejected_before_program_execution_without_arm_targets(self):
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
                "bounded arm-target capability",
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
            "external_arm_active": False,
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
            "external_arm_active": False,
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
            "external_arm_active": False,
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

    def test_named_arm_pose_runs_through_bounded_arm_targets(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "external_arm_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_targets"],
        }
        accepted = {**status, "arm_targets_active": True}
        requests = []
        clock = {"now": 0.0}
        target_active = {"value": False}

        def gateway_response(request):
            requests.append(request)
            if request.startswith("ARM_TARGETS 250 "):
                target_active["value"] = True
                return accepted
            if request == "RESET_ARMS":
                target_active["value"] = False
                return status
            if request == "STATUS" and target_active["value"]:
                return accepted
            return status

        def advance_clock():
            clock["now"] += 0.1
            return clock["now"]

        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot, "_gateway_request", side_effect=gateway_response
        ), patch.object(
            duet_robot.time, "monotonic", side_effect=advance_clock
        ), patch.object(duet_robot._stop_requested, "wait", return_value=False):
            result = duet_robot.execute_program('duet.arm_pose("box_hold", 1)')

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["commandsExecuted"], 1)
        self.assertEqual(requests[0], "STATUS")
        self.assertTrue(requests[1].startswith("ARM_TARGETS 250 "))
        self.assertNotIn("ARM_POSE", " ".join(requests))
        self.assertEqual(requests[-1], "RESET_ARMS")

    def test_move_and_arm_uses_arm_targets_while_refreshing_base_velocity(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "external_arm_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_targets"],
        }
        targets_active = {**status, "arm_targets_active": True}

        def gateway_response(request):
            if request == "STATUS":
                return status
            if request.startswith("ARM_TARGETS "):
                return targets_active
            if request.startswith("MOVE 0 0 0 "):
                return targets_active
            if request.startswith("MOVE "):
                return {**targets_active, "motion_active": True}
            if request == "RESET_ARMS":
                return status
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
        self.assertEqual(requests[0], "STATUS")
        self.assertTrue(requests[1].startswith("ARM_TARGETS 250 "))
        self.assertIn("MOVE 0.150000 0.000000 0.000000 250", requests)
        self.assertIn("MOVE 0 0 0 250", requests)
        self.assertEqual(requests[-1], "RESET_ARMS")

    def test_concurrent_locomotion_runs_through_a_multi_pose_gesture(self):
        initial = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "external_arm_active": False,
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

    def test_move_and_arm_stops_if_controller_drops_either_motion_lease(self):
        status = {
            "protocol": duet_robot.DUET_PROTOCOL,
            "robot_model": duet_robot.DUET_ROBOT_MODEL,
            "policy_id": "policy-reviewed-on-robot",
            "connected": True,
            "ready": True,
            "motion_active": False,
            "arm_targets_active": False,
            "external_arm_active": False,
            "control_lease": True,
            "lowcmd_owner": "duet",
            "capabilities": ["base_velocity", "wait", "stop", "arm_targets"],
        }
        targets_active = {**status, "arm_targets_active": True}
        arm_expired = {**targets_active, "motion_active": True, "arm_targets_active": False}
        with patch.dict(os.environ, {"DUET_EXPECTED_POLICY_ID": "policy-reviewed-on-robot"}), patch.object(
            duet_robot, "_require_hardware_acceptance"
        ), patch.object(
            duet_robot,
            "_gateway_request",
            side_effect=[status, targets_active, arm_expired, status, status],
        ) as gateway_request, patch.object(
            duet_robot.time, "monotonic", side_effect=[0.0, 0.0, 0.2, 2.0]
        ), patch.object(
            duet_robot._stop_requested, "wait", return_value=False
        ):
            with self.assertRaisesRegex(duet_robot.DuetControllerError, "arm-target lease ended"):
                duet_robot.execute_program(
                    'duet.move_and_arm(0.15, 0, 0, 0.1, "forward", 1)'
                )

        self.assertEqual(
            gateway_request.call_args_list[-2:],
            [call("STOP"), call("RESET_ARMS")],
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
