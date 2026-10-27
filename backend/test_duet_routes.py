import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

try:
    from . import server
except ImportError:
    import server


class DuetRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(server, "DB_PATH", os.path.join(self.temp_dir.name, "classroom.db"))
        self.db_patch.start()
        server.init_db()
        self.client = TestClient(server.app)
        self.teacher = self._login("teacher", "teacher")
        self.student = self._login("student1", "student1")

    def tearDown(self):
        self.db_patch.stop()
        self.temp_dir.cleanup()

    def _login(self, username, password):
        response = self.client.post(
            "/api/classroom/login",
            json={"username": username, "password": password},
        )
        self.assertEqual(response.status_code, 200)
        return {"Authorization": f"Bearer {response.json()['token']}"}

    def test_duet_routes_are_teacher_only(self):
        response = self.client.get("/api/duet/status", headers=self.student)

        self.assertEqual(response.status_code, 403)

    def test_duet_run_rejects_legacy_commands_before_gateway_access(self):
        with patch.object(server, "active_navigation_operation", return_value=None), patch.object(
            server, "active_lidar_scan", return_value=None
        ), patch.object(server, "robot_status", return_value={"running": False}):
            responses = [
                self.client.post(
                    "/api/duet/run",
                    headers=self.teacher,
                    json={"code": code},
                )
                for code in ("robot.walk(1)", 'duet.wave("left", "mid", 1)')
            ]

        for response in responses:
            self.assertEqual(response.status_code, 400)
            self.assertIn("duet", response.json()["detail"].lower())

    def test_duet_connect_fails_closed_without_gateway_and_does_not_use_sdk(self):
        with patch.dict(os.environ, {
            "DUET_CONTROL_DIR": os.path.join(self.temp_dir.name, "duet-control"),
            "DUET_PHYSICAL_ENABLED": "",
        }), patch.object(
            server, "active_navigation_operation", return_value=None
        ), patch.object(server, "active_lidar_scan", return_value=None), patch.object(
            server, "robot_status", return_value={"running": False}
        ), patch.object(server, "connect_robot") as connect_sdk:
            response = self.client.post("/api/duet/connect", headers=self.teacher)

        self.assertEqual(response.status_code, 503)
        self.assertIn("disabled until supervised", response.json()["detail"])
        connect_sdk.assert_not_called()

    def test_legacy_run_remains_on_sdk_route(self):
        expected = {"status": "completed", "commandsExecuted": 1}
        with patch.object(server, "ensure_sdk_motion_available"), patch.object(
            server, "execute_robot_program", return_value=expected
        ) as execute_sdk, patch.object(server, "execute_duet_program") as execute_duet:
            response = self.client.post(
                "/api/run",
                headers=self.teacher,
                json={"code": "robot.walk(1)"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), expected)
        execute_sdk.assert_called_once_with("robot.walk(1)")
        execute_duet.assert_not_called()

    def test_legacy_motion_is_blocked_when_duet_owns_or_may_own_motion(self):
        with patch.object(
            server, "duet_controller_owns_motion", return_value=(True, "DUET ownership is active.")
        ), patch.object(server, "execute_robot_program") as execute_sdk:
            response = self.client.post(
                "/api/run",
                headers=self.teacher,
                json={"code": "robot.walk(1)"},
            )

        self.assertEqual(response.status_code, 409)
        self.assertIn("DUET ownership", response.json()["detail"])
        execute_sdk.assert_not_called()

    def test_duet_queue_item_is_never_sent_to_legacy_sdk(self):
        submitted = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={
                "name": "duet-preview",
                "code": "duet.stop()",
                "controller_version": "duet",
            },
        )
        self.assertEqual(submitted.status_code, 200)
        self.assertEqual(submitted.json()["item"]["controller_version"], "duet")

        with patch.object(server, "execute_robot_program") as execute_sdk:
            response = self.client.post(
                "/api/classroom/run-next",
                headers=self.teacher,
                json={"item_id": submitted.json()["item"]["id"]},
            )

        self.assertEqual(response.status_code, 409)
        self.assertIn("will not be sent to the legacy SDK", response.json()["detail"])
        execute_sdk.assert_not_called()
        self.assertEqual(server.list_queue_items()[0]["status"], "queued")

    def test_planner_request_queue_preserves_reviewable_mode_waypoints_and_code(self):
        planner_request = {
            "planner_mode": "sensor_corrected",
            "planner_label": "Checkpoint route",
            "planner_waypoints": [{"x": 1, "y": -0.5}, {"x": 2, "y": 1}],
            "route_variants": {"initial": "robot.walktime(2.5)", "corrected": ""},
            "selected_variant": "initial",
        }
        response = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={
                "name": "checkpoint-route",
                "code": "robot.walktime(2.5)",
                "controller_version": "legacy",
                "planner_request": planner_request,
            },
        )

        self.assertEqual(response.status_code, 200)
        item = response.json()["item"]
        self.assertEqual(item["code"], "robot.walktime(2.5)")
        self.assertEqual(item["planner_request"]["planner_mode"], "sensor_corrected")
        self.assertEqual(len(item["planner_request"]["planner_waypoints"]), 2)
        self.assertEqual(server.list_queue_items()[0]["planner_request"], item["planner_request"])
        with patch.object(server, "execute_robot_program") as execute_sdk:
            queue_run = self.client.post(
                "/api/classroom/run-next",
                headers=self.teacher,
                json={"item_id": item["id"]},
            )
        self.assertEqual(queue_run.status_code, 409)
        self.assertIn("matching planner controls", queue_run.json()["detail"])
        execute_sdk.assert_not_called()

    def test_planner_request_rejects_invalid_autonomous_map_goals(self):
        response = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={
                "name": "bad-autonomous-route",
                "code": "",
                "planner_request": {
                    "planner_mode": "autonomous",
                    "navigation": {
                        "map_id": "classroom",
                        "version": "v1",
                        "frame_id": "map",
                        "planner_mode": "live",
                        "waypoints": [{"x": 1001, "y": 2}],
                    },
                },
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("outside the accepted finite coordinate range", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
