import unittest

from harry_botter_voice.sessions import (
    InvalidSessionTransitionError,
    SessionManager,
    SessionNotFoundError,
    SessionState,
)


class SessionManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = SessionManager()

    def test_session_lifecycle_and_delete(self) -> None:
        created = self.manager.create()
        self.assertEqual(created.state, SessionState.CREATED)
        self.assertIsNone(created.started_at)

        running = self.manager.start(created.session_id)
        self.assertEqual(running.state, SessionState.RUNNING)
        self.assertIsNotNone(running.started_at)

        stopped = self.manager.stop(created.session_id)
        self.assertEqual(stopped.state, SessionState.STOPPED)
        self.assertIsNotNone(stopped.stopped_at)

        self.manager.delete(created.session_id)
        with self.assertRaises(SessionNotFoundError):
            self.manager.get(created.session_id)

    def test_invalid_transitions_are_rejected(self) -> None:
        created = self.manager.create()
        with self.assertRaises(InvalidSessionTransitionError):
            self.manager.stop(created.session_id)

        self.manager.start(created.session_id)
        self.manager.stop(created.session_id)
        with self.assertRaises(InvalidSessionTransitionError):
            self.manager.start(created.session_id)


if __name__ == "__main__":
    unittest.main()
