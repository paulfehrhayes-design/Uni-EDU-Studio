import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import HTTPException

try:
    from . import g1_robot
    from .g1_robot import CommandValidationError, parse_robot_program
except ImportError:
    import g1_robot
    from g1_robot import CommandValidationError, parse_robot_program
    from g1_robot import CommandValidationError, parse_robot_program


class G1RobotProgramTests(unittest.TestCase):
    def test_connection_log_creates_private_session_file(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {"G1_DATA_DIR": temp_dir},
        ), patch.object(g1_robot, "_connection_log_path", None):
            g1_robot._start_connection_log("eth0", 0)
            log_path = g1_robot._connection_log_path
            g1_robot._log_event("connected", interface="eth0", domain=0)

            self.assertTrue(log_path.is_file())
            self.assertEqual(log_path.parent, Path(temp_dir))
            self.assertEqual(
                [json.loads(line)["event"] for line in log_path.read_text().splitlines()],
            ["connection_attempt", "connected"],
            )
            self.assertEqual(log_path.stat().st_mode & 0o777, 0o600)

    def test_loop_compiles_to_bounded_physical_commands(self):
        commands = parse_robot_program(
            'robot.stand()\n'
            'for count in range(0, 2):\n'
            '    robot.walk(2)\n'
            '    robot.turn("left")\n'
        )

        self.assertEqual(
            [command["method"] for command in commands],
            ["stand", "walk", "turn", "walk", "turn"],
        )
        self.assertEqual(commands[-1]["degrees"], 90)

    def test_distance_condition_preserves_both_validated_branches(self):
        nodes = parse_robot_program(
            "if robot.front_distance_m() < 1.25:\n"
            "    robot.walk(2)\n"
            "else:\n"
            '    robot.turn("left", 90)'
        )
        self.assertEqual(
            nodes,
            [{
                "type": "condition",
                "sensor": "front_distance_m",
                "operator": "<",
                "threshold": 1.25,
                "then": [{"method": "walk", "steps": 2}],
                "else": [{"method": "turn", "direction": "left", "degrees": 90}],
            }],
        )

    def test_boolean_condition_parses_as_a_structured_branch(self):
        nodes = parse_robot_program(
            "obstacle_detected = True\n"
            "if obstacle_detected:\n"
            "    robot.stand()\n"
            "else:\n"
            "    robot.stand_to_squat()"
        )
        self.assertEqual(nodes[0], {
            "type": "boolean_assignment",
            "name": "obstacle_detected",
            "value": True,
        })
        self.assertEqual(nodes[1]["variable"], "obstacle_detected")
        self.assertEqual(nodes[1]["then"][0]["method"], "stand")
        self.assertEqual(nodes[1]["else"][0]["method"], "stand_to_squat")

    def test_boolean_condition_executes_only_the_selected_supported_branch(self):
        class FakeLocoClient:
            def __init__(self):
                self.fsm_ids = []

            def SetFsmId(self, fsm_id):
                self.fsm_ids.append(fsm_id)
                return 0

        program = (
            "obstacle_detected = True\n"
            "if obstacle_detected:\n"
            "    robot.stand()\n"
            "else:\n"
            "    robot.stand_to_squat()"
        )
        original_client = g1_robot._client
        client = FakeLocoClient()
        g1_robot._client = client
        try:
            result = g1_robot.execute_robot_program(program)
            self.assertEqual(client.fsm_ids, [500])
            self.assertEqual(result["conditionsEvaluated"][0]["branch"], "then")

            client.fsm_ids.clear()
            result = g1_robot.execute_robot_program(program.replace("= True", "= False"))
            self.assertEqual(client.fsm_ids, [706])
            self.assertEqual(result["conditionsEvaluated"][0]["branch"], "else")
        finally:
            g1_robot._client = original_client

    def test_boolean_condition_rejects_unassigned_names_and_dynamic_expressions(self):
        for code in (
            "if obstacle_detected:\n    robot.stand()",
            "obstacle_detected = robot.getfsm()\nrobot.stand()",
            "obstacle_detected = True\nif robot.getfsm():\n    robot.stand()",
            "obstacle_detected = True\nif not obstacle_detected:\n    robot.stand()",
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

    def test_distance_condition_loops_remain_structured_and_are_bounded(self):
        nodes = parse_robot_program(
            "for _ in range(2):\n"
            "    if robot.front_distance_m() <= 0.5:\n"
            "        robot.walktime(0.2)\n"
            "    else:\n"
            '        robot.turn("right", 45)'
        )
        self.assertEqual(nodes[0]["type"], "repeat")
        self.assertEqual(nodes[0]["times"], 2)
        self.assertEqual(nodes[0]["body"][0]["type"], "condition")

    def test_rear_distance_condition_is_parsed_and_uses_rear_sensor(self):
        nodes = parse_robot_program(
            "if robot.rear_distance_m() < 0.8:\n"
            "    robot.backward(1)\n"
            "else:\n"
            '    robot.turn("left", 90)'
        )
        self.assertEqual(nodes[0]["sensor"], "rear_distance_m")
        self.assertEqual(nodes[0]["then"][0]["method"], "backward")

        class FakeLocoClient:
            def __init__(self):
                self.fsm_ids = []

            def SetFsmId(self, fsm_id):
                self.fsm_ids.append(fsm_id)
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        try:
            with patch.object(
                g1_robot,
                "get_rear_distance_sample",
                return_value={"distance_m": 0.5, "age_ms": 25, "timestamp": "sample"},
            ) as rear_sample, patch.object(g1_robot, "get_front_distance_sample") as front_sample:
                result = g1_robot.execute_robot_program(
                    "if robot.rear_distance_m() < 0.8:\n"
                    "    robot.stand()\n"
                    "else:\n"
                    "    robot.stand_to_squat()"
                )
            rear_sample.assert_called_once_with()
            front_sample.assert_not_called()
            self.assertEqual(client.fsm_ids, [500])
            self.assertEqual(result["conditionsEvaluated"][0]["sensor"], "rear_distance_m")
        finally:
            g1_robot._client = original_client

    def test_distance_condition_rejects_unsupported_or_unbounded_predicates(self):
        for code in (
            "if robot.distance() < 1:\n    robot.stand()",
            "if robot.side_distance_m() < 1:\n    robot.stand()",
            "if robot.front_distance_m() < robot.getfsm():\n    robot.stand()",
            "if robot.front_distance_m() ** 2 < 1:\n    robot.stand()",
            "if robot.front_distance_m() < 40.1:\n    robot.stand()",
            "if robot.front_distance_m() < 1:\n    robot.stand()\nelif robot.front_distance_m() < 2:\n    robot.walk(1)",
            "if robot.front_distance_m() < 1:\n    pass",
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

    def test_backend_executes_only_branch_selected_by_live_distance(self):
        class FakeLocoClient:
            def __init__(self):
                self.fsm_ids = []

            def SetFsmId(self, fsm_id):
                self.fsm_ids.append(fsm_id)
                return 0

        program = (
            "if robot.front_distance_m() < 1:\n"
            "    robot.stand()\n"
            "else:\n"
            "    robot.stand_to_squat()"
        )
        original_client = g1_robot._client
        client = FakeLocoClient()
        g1_robot._client = client
        try:
            with patch.object(
                g1_robot,
                "get_front_distance_sample",
                return_value={"distance_m": 0.75, "age_ms": 20, "timestamp": "sample"},
            ):
                result = g1_robot.execute_robot_program(program)
            self.assertEqual(client.fsm_ids, [500])
            self.assertEqual(result["conditionsEvaluated"][0]["branch"], "then")
            self.assertEqual(result["commandsExecuted"], 1)

            client.fsm_ids.clear()
            with patch.object(
                g1_robot,
                "get_front_distance_sample",
                return_value={"distance_m": 1.2, "age_ms": 50, "timestamp": "sample"},
            ):
                result = g1_robot.execute_robot_program(program)
            self.assertEqual(client.fsm_ids, [706])
            self.assertEqual(result["conditionsEvaluated"][0]["branch"], "else")
        finally:
            g1_robot._client = original_client

    def test_clear_sector_selects_no_near_obstacle_branch(self):
        class FakeLocoClient:
            def SetFsmId(self, fsm_id):
                return 0

        original_client = g1_robot._client
        g1_robot._client = FakeLocoClient()
        try:
            with patch.object(
                g1_robot,
                "get_front_distance_sample",
                return_value={
                    "distance_m": None,
                    "clear": True,
                    "max_range_m": 40.0,
                    "age_ms": 15,
                    "timestamp": "sample",
                },
            ):
                result = g1_robot.execute_robot_program(
                    "if robot.front_distance_m() < 1:\n"
                    "    robot.stand()\n"
                    "else:\n"
                    "    robot.stand_to_squat()"
                )
        finally:
            g1_robot._client = original_client

        self.assertEqual(result["conditionsEvaluated"][0]["branch"], "else")
        self.assertTrue(result["conditionsEvaluated"][0]["clear"])

    def test_clear_sector_aborts_ambiguous_distance_threshold_and_requests_stop(self):
        class FakeLocoClient:
            def __init__(self):
                self.stop_count = 0

            def SetFsmId(self, fsm_id):
                return 0

            def StopMove(self):
                self.stop_count += 1
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        try:
            with patch.object(
                g1_robot,
                "get_front_distance_sample",
                return_value={
                    "distance_m": None,
                    "clear": True,
                    "max_range_m": 39.5,
                    "age_ms": 15,
                    "timestamp": "sample",
                },
            ), self.assertRaisesRegex(HTTPException, "comparison < 40 m is ambiguous"):
                g1_robot.execute_robot_program(
                    "if robot.front_distance_m() < 40:\n"
                    "    robot.stand()\n"
                    "else:\n"
                    "    robot.stand_to_squat()"
                )
        finally:
            g1_robot._client = original_client

        self.assertEqual(client.stop_count, 1)

    def test_invalid_distance_requests_sdk_stop_and_aborts_without_else(self):
        class FakeLocoClient:
            def __init__(self):
                self.stop_count = 0

            def SetFsmId(self, fsm_id):
                return 0

            def StopMove(self):
                self.stop_count += 1
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        try:
            with patch.object(
                g1_robot,
                "get_front_distance_sample",
                side_effect=g1_robot.DistanceSensorError("MID-360 sample is stale"),
            ):
                with self.assertRaises(HTTPException) as raised:
                    g1_robot.execute_robot_program(
                        "if robot.front_distance_m() < 1:\n"
                        "    robot.stand()\n"
                        "else:\n"
                        "    robot.stand_to_squat()"
                    )
            self.assertEqual(raised.exception.status_code, 503)
            self.assertIn("stop was requested", raised.exception.detail)
            self.assertEqual(client.stop_count, 1)
        finally:
            g1_robot._client = original_client

    def test_unavailable_rear_sample_requests_stop_and_aborts(self):
        class FakeLocoClient:
            def __init__(self):
                self.stop_count = 0

            def StopMove(self):
                self.stop_count += 1
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        try:
            with patch.object(
                g1_robot,
                "get_rear_distance_sample",
                side_effect=g1_robot.DistanceSensorError("rear-sector sample unavailable"),
            ):
                with self.assertRaises(HTTPException) as raised:
                    g1_robot.execute_robot_program(
                        "if robot.rear_distance_m() < 1:\n"
                        "    robot.stand()\n"
                        "else:\n"
                        "    robot.backward(1)"
                    )
            self.assertEqual(raised.exception.status_code, 503)
            self.assertIn("stop was requested", raised.exception.detail)
            self.assertEqual(client.stop_count, 1)
        finally:
            g1_robot._client = original_client

    def test_motion_values_are_bounded(self):
        commands = parse_robot_program('robot.walktime(99)')
        self.assertEqual(commands[0]["seconds"], 10)

    def test_wait_is_bounded_without_aggregate_program_duration_limit(self):
        self.assertEqual(
            parse_robot_program("robot.wait(2)"),
            [{"method": "wait", "seconds": 2}],
        )
        self.assertEqual(
            parse_robot_program("robot.wait(99)"),
            [{"method": "wait", "seconds": 10}],
        )
        self.assertEqual(
            len(parse_robot_program("robot.wait(10)\nrobot.wait(10)\nrobot.wait(10)\nrobot.wait(1)")),
            4,
        )
        with self.assertRaisesRegex(CommandValidationError, "duration in seconds"):
            parse_robot_program("robot.wait()")

    def test_sit_command_is_rejected(self):
        with self.assertRaisesRegex(CommandValidationError, "Unknown robot command: sit"):
            parse_robot_program("robot.sit()")
        with self.assertRaisesRegex(CommandValidationError, "Unknown robot command: sit"):
            parse_robot_program("robot.sit(1)")

    def test_arm_presets_accept_only_known_names_and_resolve_official_ids(self):
        expected = {
            "release arm": 99,
            "two-hand kiss": 11,
            "left kiss": 12,
            "right kiss": 13,
            "hands up": 15,
            "clap": 17,
            "high five": 18,
            "hug": 19,
            "heart": 20,
            "right heart": 21,
            "reject": 22,
            "right hand up": 23,
            "x-ray": 24,
            "face wave": 25,
            "high wave": 26,
            "shake hand": 27,
        }

        for action, action_id in expected.items():
            with self.subTest(action=action):
                self.assertEqual(
                    parse_robot_program(f'robot.arm_action("{action}")'),
                    [{"method": "arm_action", "action": action, "action_id": action_id}],
                )

    def test_arm_presets_only_release_when_the_program_explicitly_requests_it(self):
        self.assertEqual(
            parse_robot_program(
                'for _ in range(2):\n'
                '    robot.arm_action("hands up")\n'
                '    robot.arm_action("release arm")\n'
                '    robot.arm_action("right heart")'
            ),
            [
                {"method": "arm_action", "action": "hands up", "action_id": 15},
                {"method": "arm_action", "action": "release arm", "action_id": 99},
                {"method": "arm_action", "action": "right heart", "action_id": 21},
                {"method": "arm_action", "action": "hands up", "action_id": 15},
                {"method": "arm_action", "action": "release arm", "action_id": 99},
                {"method": "arm_action", "action": "right heart", "action_id": 21},
            ],
        )

        for code in (
            'robot.arm_action(15)',
            'robot.arm_action("taught action")',
            'robot.arm_action("hands up", 15)',
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

    def test_timed_arm_pose_uses_only_static_presets_and_is_bounded(self):
        self.assertEqual(
            parse_robot_program('robot.hold_arm("hands up", 3)'),
            [{
                "method": "hold_arm",
                "action": "hands up",
                "action_id": 15,
                "seconds": 3.0,
            }],
        )
        self.assertEqual(
            parse_robot_program('robot.hold_arm("hands up", 99)')[0]["seconds"],
            10,
        )
        for code in (
            'robot.hold_arm("release arm", 3)',
            'robot.hold_arm("clap", 3)',
            'robot.hold_arm("hands up")',
            'robot.hold_arm("hands up", 3, 4)',
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

    def test_timed_arm_pose_executes_preset_then_waits_without_releasing(self):
        class FakeLocoClient:
            pass

        class FakeArmClient:
            def __init__(self):
                self.actions = []

            def ExecuteAction(self, action_id):
                self.actions.append(action_id)
                return 0

        original_clients = g1_robot._client, g1_robot._arm_client
        arm_client = FakeArmClient()
        g1_robot._client, g1_robot._arm_client = FakeLocoClient(), arm_client
        try:
            with patch.object(g1_robot._stop_requested, "wait", return_value=False) as wait:
                result = g1_robot.execute_robot_program('robot.hold_arm("hands up", 3)')
            wait.assert_called_once_with(3.0)
            self.assertEqual(arm_client.actions, [15])
            self.assertEqual(result["commandsExecuted"], 1)
        finally:
            g1_robot._client, g1_robot._arm_client = original_clients

    def test_sdk_diagnostics_and_audio_arguments_are_bounded(self):
        commands = parse_robot_program(
            'robot.getfsm()\n'
            'robot.getactions()\n'
            'robot.getvolume()\n'
            'robot.say("Hello, G1", 1)\n'
            'robot.setvolume(120)\n'
            'robot.led(-1, 20, 300)\n'
            'robot.playstop("classroom audio")'
        )

        self.assertEqual(
            commands,
            [
                {"method": "getfsm"},
                {"method": "getactions"},
                {"method": "getvolume"},
                {"method": "say", "text": "Hello, G1", "speaker": 1},
                {"method": "setvolume", "volume": 70},
                {"method": "led", "red": 0, "green": 20, "blue": 255},
                {"method": "playstop", "app_name": "classroom audio"},
            ],
        )

    def test_sdk_audio_rejects_nonliteral_text_and_invalid_app_names(self):
        for code in (
            'robot.say("line\\nbreak", 1)',
            'robot.say("x" * 4, 1)',
            'robot.say("hello", 2)',
            'robot.playstop("../audio")',
            'robot.setvolume(True)',
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

    def test_tts_program_can_exceed_thirty_seconds(self):
        long_phrase = "h" * 100
        commands = parse_robot_program(
            (f'robot.say("{long_phrase}", 1)\n' * 3)
            + 'robot.walktime(10)'
        )
        self.assertEqual(len(commands), 4)

    def test_arbitrary_python_and_sim_only_actions_are_rejected(self):
        for code in (
            'import os',
            'robot.moveTo(1, 2)',
            'robot.kickleft("high")',
            'robot.waveleftDegrees(90)',
            'robot.simulate_arm_action("hands up")',
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

    def test_loop_and_expanded_command_limits_remain_without_runtime_cap(self):
        with self.assertRaisesRegex(CommandValidationError, "Loop count"):
            parse_robot_program('for count in range(21):\n    robot.stand()')
        self.assertEqual(
            len(parse_robot_program('robot.walktime(10)\n' * 4)),
            4,
        )
        self.assertEqual(
            len(parse_robot_program('robot.arm_action("hands up")\n' * 16)),
            16,
        )
        self.assertEqual(
            len(parse_robot_program('robot.stand()\n' * 200)),
            200,
        )
        with self.assertRaisesRegex(CommandValidationError, "expanded commands"):
            parse_robot_program('robot.stand()\n' * 201)

    def test_motion_is_held_continuously_until_stop(self):
        class FakeLocoClient:
            def __init__(self):
                self.calls = []

            def SetVelocity(self, vx, vy, vyaw, duration):
                self.calls.append(("SetVelocity", vx, vy, vyaw, duration))
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        try:
            with patch.object(g1_robot.time, "sleep"):
                g1_robot._move(0.4, 0, 0, 0.25)
        finally:
            g1_robot._client = original_client

        self.assertEqual(
            client.calls,
            [
                ("SetVelocity", 0.4, 0, 0, g1_robot._CONTINUOUS_MOVE_DURATION),
                ("SetVelocity", 0.0, 0.0, 0.0, 1.0),
            ],
        )

    def test_robot_program_dispatches_stand_and_locomotion_commands(self):
        class FakeLocoClient:
            def __init__(self):
                self.fsm_requests = []
                self.fsm_id = 706

            def GetFsmId(self):
                return 0, self.fsm_id

            def SetFsmId(self, fsm_id):
                self.fsm_requests.append(fsm_id)
                self.fsm_id = fsm_id
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        moves = []
        try:
            with patch.object(g1_robot, "_move", side_effect=lambda *args: moves.append(args)):
                result = g1_robot.execute_robot_program(
                    'robot.stand()\nrobot.walk(2)\nrobot.turn("right", 90)'
                )
        finally:
            g1_robot._client = original_client

        self.assertEqual(
            result,
            {"status": "completed", "commandsExecuted": 3, "results": [], "physicalMotionVerified": False},
        )
        self.assertEqual(client.fsm_requests, [500])
        self.assertEqual(moves[0][:3], (0.4, 0, 0))
        self.assertAlmostEqual(moves[0][3], 1.725)
        self.assertAlmostEqual(moves[1][2], -0.6)

    def test_step_count_durations_use_measured_345mm_step_estimate(self):
        speed_durations = [
            ("robot.walk(1)", 0.4, 0.8625),
            ("robot.slowwalk(1)", 0.2, 1.725),
            ("robot.fastwalk(1)", 0.8, 0.43125),
        ]
        for code, speed, duration in speed_durations:
            with self.subTest(code=code):
                command = parse_robot_program(code)[0]
                self.assertAlmostEqual(g1_robot._STEP_METERS, 0.345)
                self.assertAlmostEqual(g1_robot._estimated_duration(command), duration)

    def test_robot_program_dispatches_stand_to_the_sdk_ready_fsm(self):
        class FakeLocoClient:
            def __init__(self):
                self.fsm_requests = []

            def SetFsmId(self, fsm_id):
                self.fsm_requests.append(fsm_id)
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        try:
            result = g1_robot.execute_robot_program("robot.stand()")
        finally:
            g1_robot._client = original_client

        self.assertEqual(client.fsm_requests, [500])
        self.assertEqual(result["commandsExecuted"], 1)

    def test_robot_program_dispatches_posture_transitions_to_sdk_fsms(self):
        class FakeLocoClient:
            def __init__(self):
                self.fsm_requests = []

            def SetFsmId(self, fsm_id):
                self.fsm_requests.append(fsm_id)
                return 0

        client = FakeLocoClient()
        original_client = g1_robot._client
        g1_robot._client = client
        try:
            result = g1_robot.execute_robot_program(
                "robot.squat_to_stand()\nrobot.lie_to_stand()\nrobot.stand_to_squat()"
            )
        finally:
            g1_robot._client = original_client

        self.assertEqual(client.fsm_requests, [706, 702, 706])
        self.assertEqual(result["commandsExecuted"], 3)

    def test_wait_uses_interruptible_backend_delay(self):
        class FakeLocoClient:
            pass

        original_client = g1_robot._client
        g1_robot._client = FakeLocoClient()
        try:
            with patch.object(g1_robot._stop_requested, "wait", return_value=False) as wait:
                result = g1_robot.execute_robot_program("robot.wait(2)")
            wait.assert_called_once_with(2.0)
            self.assertEqual(result["commandsExecuted"], 1)
            with patch.object(g1_robot._stop_requested, "wait", return_value=True):
                with self.assertRaisesRegex(HTTPException, "stopped by teacher"):
                    g1_robot.execute_robot_program("robot.wait(2)")
        finally:
            g1_robot._client = original_client

    def test_slow_motion_test_command_is_bounded_and_uses_slow_speed(self):
        class FakeLocoClient:
            def GetFsmId(self):
                return 0, 500

            def SetVelocity(self, vx, vy, vyaw, duration):
                return 0

        original_client = g1_robot._client
        g1_robot._client = FakeLocoClient()
        moves = []
        try:
            with patch.object(g1_robot, "_move", side_effect=lambda *args: moves.append(args)):
                result = g1_robot.execute_robot_program("robot.slowwalktime(0.5)")
        finally:
            g1_robot._client = original_client

        self.assertEqual(result["commandsExecuted"], 1)
        self.assertEqual(moves, [(0.2, 0, 0, 0.5)])

    def test_robot_program_dispatches_arm_diagnostics_and_audio_sdks(self):
        class FakeLocoClient:
            def GetFsmId(self):
                return 0, 500

        class FakeArmClient:
            def __init__(self):
                self.actions = []

            def GetActionList(self):
                return 0, {"actions": ["hands up"]}

            def ExecuteAction(self, action_id):
                self.actions.append(action_id)
                return 0

        class FakeAudioClient:
            def __init__(self):
                self.calls = []

            def GetVolume(self):
                return 0, {"volume": 35}

            def TtsMaker(self, text, speaker_id):
                self.calls.append(("TtsMaker", text, speaker_id))
                return 0

            def SetVolume(self, volume):
                self.calls.append(("SetVolume", volume))
                return 0

            def LedControl(self, red, green, blue):
                self.calls.append(("LedControl", red, green, blue))
                return 0

            def PlayStop(self, app_name):
                self.calls.append(("PlayStop", app_name))
                return 0

        original_clients = g1_robot._client, g1_robot._arm_client, g1_robot._audio_client
        arm_client = FakeArmClient()
        audio_client = FakeAudioClient()
        g1_robot._client, g1_robot._arm_client, g1_robot._audio_client = (
            FakeLocoClient(),
            arm_client,
            audio_client,
        )
        try:
            with patch.object(g1_robot._stop_requested, "wait", return_value=False):
                result = g1_robot.execute_robot_program(
                    'robot.getfsm()\n'
                    'robot.getactions()\n'
                    'robot.arm_action("hands up")\n'
                    'robot.getvolume()\n'
                    'robot.say("Hello, G1", 1)\n'
                    'robot.setvolume(35)\n'
                    'robot.led(1, 2, 3)\n'
                    'robot.playstop("example")'
                )
        finally:
            g1_robot._client, g1_robot._arm_client, g1_robot._audio_client = original_clients

        self.assertEqual(
            result["results"],
            [
                {"command": "getfsm", "value": 500},
                {"command": "getactions", "value": {"actions": ["hands up"]}},
                {"command": "getvolume", "value": {"volume": 35}},
            ],
        )
        self.assertEqual(
            audio_client.calls,
            [
                ("TtsMaker", "Hello, G1", 1),
                ("SetVolume", 35),
                ("LedControl", 1, 2, 3),
                ("PlayStop", "example"),
            ],
        )
        self.assertEqual(arm_client.actions, [15])
        self.assertEqual(result["commandsExecuted"], 8)

    def test_locomotion_is_not_sent_until_g1_is_in_ready_fsm(self):
        class FakeLocoClient:
            def __init__(self):
                self.velocity_calls = []
                self.fsm_checks = 0

            def GetFsmId(self):
                self.fsm_checks += 1
                return 0, 706

            def SetVelocity(self, vx, vy, vyaw, duration):
                self.velocity_calls.append((vx, vy, vyaw, duration))
                return 0

        class FakeArmClient:
            def __init__(self):
                self.actions = []

            def ExecuteAction(self, action_id):
                self.actions.append(action_id)
                return 0

        original_clients = g1_robot._client, g1_robot._arm_client
        client, arm_client = FakeLocoClient(), FakeArmClient()
        g1_robot._client, g1_robot._arm_client = client, arm_client
        try:
            with patch.object(g1_robot._stop_requested, "wait", return_value=False), patch.object(
                g1_robot, "_move"
            ) as move:
                with self.assertRaisesRegex(HTTPException, "FSM 706, not walking-ready FSM 500"):
                    g1_robot.execute_robot_program('robot.arm_action("hands up")\nrobot.walk(1)')
            self.assertEqual(arm_client.actions, [15])
            self.assertEqual(client.fsm_checks, 1)
            move.assert_not_called()
            self.assertEqual(client.velocity_calls, [])
        finally:
            g1_robot._client, g1_robot._arm_client = original_clients

    def test_stop_during_arm_action_spacing_does_not_claim_to_cancel_arm(self):
        class FakeLocoClient:
            def StopMove(self):
                return 0

        class FakeArmClient:
            def ExecuteAction(self, action_id):
                return 0

        original_clients = g1_robot._client, g1_robot._arm_client
        g1_robot._client, g1_robot._arm_client = FakeLocoClient(), FakeArmClient()
        try:
            with patch.object(g1_robot._stop_requested, "wait", return_value=True):
                with self.assertRaisesRegex(HTTPException, "no verified way to cancel the active arm motion"):
                    g1_robot.execute_robot_program('robot.arm_action("hands up")')
        finally:
            g1_robot._client, g1_robot._arm_client = original_clients

    def test_robot_program_logs_validated_command_outcomes(self):
        class FakeLocoClient:
            def SetFsmId(self, fsm_id):
                return 0

        with tempfile.TemporaryDirectory() as temp_dir:
            log_path = Path(temp_dir) / "session.jsonl"
            log_path.touch(mode=0o600)
            original_client = g1_robot._client
            g1_robot._client = FakeLocoClient()
            try:
                with patch.object(g1_robot, "_connection_log_path", log_path):
                    result = g1_robot.execute_robot_program("robot.stand()")
            finally:
                g1_robot._client = original_client

            events = [json.loads(line) for line in log_path.read_text().splitlines()]
            self.assertEqual(result["status"], "completed")
            self.assertEqual(
                [event["event"] for event in events],
                ["program_started", "command_started", "command_completed", "program_completed"],
            )
            self.assertEqual(events[1]["command"], {"method": "stand"})

    def test_stand_reports_sdk_transition_error(self):
        class FakeLocoClient:
            def SetFsmId(self, fsm_id):
                return 3102

        original_client = g1_robot._client
        g1_robot._client = FakeLocoClient()
        try:
            with self.assertRaises(HTTPException) as raised:
                g1_robot.execute_robot_program("robot.stand()")
            self.assertEqual(raised.exception.status_code, 502)
            self.assertIn("Start failed with code 3102", raised.exception.detail)
        finally:
            g1_robot._client = original_client

    def test_sdk_probe_3102_keeps_connection_closed_before_motion_dispatch(self):
        class FakeLocoClient:
            def SetTimeout(self, timeout):
                pass

            def Init(self):
                return 0

            def GetFsmId(self):
                return 3102, 0

        def unexpected_client():
            self.fail("The SDK probe must pass before other physical clients are initialized.")

        package_names = (
            "unitree_sdk2py",
            "unitree_sdk2py.core",
            "unitree_sdk2py.g1",
            "unitree_sdk2py.g1.loco",
            "unitree_sdk2py.g1.arm",
            "unitree_sdk2py.g1.audio",
        )
        modules = {}
        for name in package_names:
            module = types.ModuleType(name)
            module.__path__ = []
            modules[name] = module
        channel_module = types.ModuleType("unitree_sdk2py.core.channel")
        channel_module.ChannelFactoryInitialize = lambda domain, interface: None
        loco_module = types.ModuleType("unitree_sdk2py.g1.loco.g1_loco_client")
        loco_module.LocoClient = FakeLocoClient
        arm_module = types.ModuleType("unitree_sdk2py.g1.arm.g1_arm_action_client")
        arm_module.G1ArmActionClient = unexpected_client
        audio_module = types.ModuleType("unitree_sdk2py.g1.audio.g1_audio_client")
        audio_module.AudioClient = unexpected_client
        modules.update({
            channel_module.__name__: channel_module,
            loco_module.__name__: loco_module,
            arm_module.__name__: arm_module,
            audio_module.__name__: audio_module,
        })
        original_clients = (
            g1_robot._client,
            g1_robot._arm_client,
            g1_robot._audio_client,
            g1_robot._connected_interface,
            g1_robot._connection_log_path,
        )
        try:
            with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
                os.environ, {"G1_DATA_DIR": temp_dir}
            ), patch.dict(sys.modules, modules):
                with self.assertRaises(HTTPException) as raised:
                    g1_robot.connect_robot("eth0")
                self.assertEqual(raised.exception.status_code, 502)
                self.assertIn("RPC probe failed with code 3102", raised.exception.detail)
                self.assertFalse(g1_robot.robot_status()["sdkAvailable"])
                with self.assertRaisesRegex(HTTPException, "Connect the G1 SDK"):
                    g1_robot.execute_robot_program("robot.walk(1)")
        finally:
            (
                g1_robot._client,
                g1_robot._arm_client,
                g1_robot._audio_client,
                g1_robot._connected_interface,
                g1_robot._connection_log_path,
            ) = original_clients


if __name__ == "__main__":
    unittest.main()
