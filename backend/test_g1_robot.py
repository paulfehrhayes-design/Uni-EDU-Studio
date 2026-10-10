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

    def test_arbitrary_python_and_sim_only_actions_are_rejected(self):
        for code in (
            'import os',
            'robot.moveTo(1, 2)',
            'robot.kickleft("high")',
            'robot.waveleftDegrees(90)',
        ):
            with self.subTest(code=code), self.assertRaises(CommandValidationError):
                parse_robot_program(code)

    def test_loop_count_and_program_duration_are_bounded(self):
        with self.assertRaisesRegex(CommandValidationError, "Loop count"):
            parse_robot_program('for count in range(21):\n    robot.stand()')
        with self.assertRaisesRegex(CommandValidationError, "duration"):
            parse_robot_program('robot.walktime(10)\nrobot.walktime(10)\nrobot.walktime(10)\nrobot.walktime(10)')

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
            {"status": "completed", "commandsExecuted": 3, "physicalMotionVerified": False},
        )
        self.assertEqual(client.fsm_requests, [706])
        self.assertEqual(moves[0][:3], (0.4, 0, 0))
        self.assertAlmostEqual(moves[0][3], 2.0)
        self.assertAlmostEqual(moves[1][2], -0.6)

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
            self.assertIn("Squat2StandUp failed with code 3102", raised.exception.detail)
        finally:
            g1_robot._client = original_client


if __name__ == "__main__":
    unittest.main()
