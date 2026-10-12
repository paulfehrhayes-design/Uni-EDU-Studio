import json
import os
import tempfile
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

    def test_motion_values_are_bounded(self):
        commands = parse_robot_program('robot.walktime(99)')
        self.assertEqual(commands[0]["seconds"], 10)

    def test_sit_command_is_a_bounded_no_argument_posture_command(self):
        self.assertEqual(parse_robot_program("robot.sit()"), [{"method": "sit"}])
        with self.assertRaisesRegex(CommandValidationError, "takes no arguments"):
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

        for code in (
            'robot.arm_action(15)',
            'robot.arm_action("taught action")',
            'robot.arm_action("hands up", 15)',
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

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

    def test_tts_counts_toward_the_program_duration_limit(self):
        long_phrase = "h" * 100
        with self.assertRaisesRegex(CommandValidationError, "duration"):
            parse_robot_program(
                (f'robot.say("{long_phrase}", 1)\n' * 3)
                + 'robot.walktime(10)'
            )

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

    def test_loop_count_and_program_duration_are_bounded(self):
        with self.assertRaisesRegex(CommandValidationError, "Loop count"):
            parse_robot_program('for count in range(21):\n    robot.stand()')
        with self.assertRaisesRegex(CommandValidationError, "duration"):
            parse_robot_program('robot.walktime(10)\nrobot.walktime(10)\nrobot.walktime(10)\nrobot.walktime(10)')
        with self.assertRaisesRegex(CommandValidationError, "duration"):
            parse_robot_program('robot.arm_action("hands up")\n' * 16)

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

            def SetFsmId(self, fsm_id):
                self.fsm_requests.append(fsm_id)
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

    def test_robot_program_dispatches_sit_to_the_sdk_sit_fsm(self):
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
            result = g1_robot.execute_robot_program("robot.sit()")
        finally:
            g1_robot._client = original_client

        self.assertEqual(client.fsm_requests, [3])
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

    def test_slow_motion_test_command_is_bounded_and_uses_slow_speed(self):
        class FakeLocoClient:
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


if __name__ == "__main__":
    unittest.main()
