import unittest
from unittest.mock import patch

try:
    from . import g1_robot
    from .g1_robot import CommandValidationError, parse_robot_program
except ImportError:
    import g1_robot
    from g1_robot import CommandValidationError, parse_robot_program


class G1RobotProgramTests(unittest.TestCase):
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
                self.stand_calls = 0

            def Squat2StandUp(self):
                self.stand_calls += 1
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

        self.assertEqual(result, {"status": "completed", "commandsExecuted": 3})
        self.assertEqual(client.stand_calls, 1)
        self.assertEqual(moves[0][:3], (0.4, 0, 0))
        self.assertAlmostEqual(moves[0][3], 2.0)
        self.assertAlmostEqual(moves[1][2], -0.6)


if __name__ == "__main__":
    unittest.main()
