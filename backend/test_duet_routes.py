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

    def test_duet_queue_item_uses_duet_controller_not_legacy_sdk(self):
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

        with patch.object(server, "active_navigation_operation", return_value=None), patch.object(
            server, "active_lidar_scan", return_value=None
        ), patch.object(server, "robot_status", return_value={"running": False}), patch.object(
            server,
            "execute_duet_program",
            return_value={"status": "completed", "commandsExecuted": 1},
        ) as execute_duet, patch.object(server, "execute_robot_program") as execute_sdk:
            response = self.client.post(
                "/api/classroom/run-next",
                headers=self.teacher,
                json={"item_id": submitted.json()["item"]["id"]},
            )

        self.assertEqual(response.status_code, 200)
        execute_duet.assert_called_once_with("duet.stop()")
        execute_sdk.assert_not_called()
        self.assertEqual(server.list_queue_items()[0]["status"], "completed")

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
        with patch.object(
            server,
            "run_checkpointed_planner",
            return_value={"status": "completed", "correctedCode": "robot.walktime(2.5)"},
        ) as run_checkpointed:
            queue_run = self.client.post(
                "/api/classroom/run-next",
                headers=self.teacher,
                json={"item_id": item["id"]},
            )
        self.assertEqual(queue_run.status_code, 200)
        self.assertEqual(queue_run.json()["item"]["status"], "completed")
        self.assertEqual(run_checkpointed.call_args.args[0].waypoints, planner_request["planner_waypoints"])
        project = queue_run.json()["process"]["saved_project"]
        self.assertEqual(project["username"], "student1")
        self.assertEqual(project["plannerVariants"]["initial"], planner_request["route_variants"]["initial"])
        self.assertEqual(project["plannerVariants"]["corrected"], "robot.walktime(2.5)")
        self.assertEqual(server.list_queue_items()[0]["result_project"]["name"], project["name"])

    def test_queue_snapshot_preserves_project_fields_and_manual_run_uses_submitted_code(self):
        project_snapshot = {
            "name": "student-project",
            "sceneObjects": [{"id": "box-1", "type": "box", "x": 1, "y": 2}],
            "plannerWaypoints": [{"id": "a", "x": 0, "y": 0}, {"id": "b", "x": 1, "y": 0}],
            "generatedCode": "robot.walktime(1)",
            "duetCode": "duet.move(0.1, 0, 0, 0.5)",
            "plannerMode": "manual",
            "plannerLabel": "student route",
            "plannerVariants": {"initial": "robot.walktime(1)", "corrected": "", "final": ""},
            "selectedPlannerVariant": "initial",
        }
        planner_request = {
            "planner_mode": "manual",
            "planner_label": "student route",
            "planner_waypoints": [{"x": 0, "y": 0}, {"x": 1, "y": 0}],
            "route_variants": {"initial": "robot.walktime(1)"},
            "selected_variant": "initial",
        }
        submitted = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={
                "name": "manual-route",
                "code": "robot.walktime(1)",
                "controller_version": "legacy",
                "planner_request": planner_request,
                "project_snapshot": project_snapshot,
            },
        )
        self.assertEqual(submitted.status_code, 200)
        item = submitted.json()["item"]
        self.assertEqual(item["project_snapshot"], project_snapshot)
        self.assertEqual(server.list_queue_items()[0]["project_snapshot"], project_snapshot)

        with patch.object(server, "ensure_sdk_motion_available"), patch.object(
            server,
            "execute_robot_program",
            return_value={"status": "completed", "commandsExecuted": 1},
        ) as execute_sdk:
            approved = self.client.post(
                "/api/classroom/run-next",
                headers=self.teacher,
                json={"item_id": item["id"]},
            )

        self.assertEqual(approved.status_code, 200)
        self.assertEqual(approved.json()["item"]["status"], "completed")
        execute_sdk.assert_called_once_with("robot.walktime(1)")
        self.assertEqual(server.list_queue_items()[0]["status"], "completed")

    def test_teacher_stop_during_queue_run_keeps_item_paused(self):
        submitted = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={"name": "stoppable", "code": "robot.walktime(1)"},
        )
        item = submitted.json()["item"]

        def stop_during_execution(code):
            server.set_queue_item_status(item["id"], "paused")
            raise server.HTTPException(status_code=409, detail="Robot program stopped by teacher.")

        with patch.object(server, "ensure_sdk_motion_available"), patch.object(
            server, "execute_robot_program", side_effect=stop_during_execution
        ):
            response = self.client.post(
                "/api/classroom/run-next",
                headers=self.teacher,
                json={"item_id": item["id"]},
            )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(server.list_queue_items()[0]["status"], "paused")

    def test_autonomous_queue_status_tracks_linked_navigation_operation(self):
        submitted = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={
                "name": "autonomous-route",
                "code": "",
                "controller_version": "legacy",
                "planner_request": {
                    "planner_mode": "autonomous",
                    "planner_waypoints": [],
                    "route_variants": {},
                    "navigation": {
                        "map_id": "classroom",
                        "version": "map-v2",
                        "frame_id": "map",
                        "planner_mode": "live",
                        "waypoints": [{"x": 1, "y": 2}],
                    },
                },
            },
        )
        item = submitted.json()["item"]
        with patch.object(
            server,
            "start_navigation",
            return_value={"status": "accepted", "operation_id": "nav-queue-linked"},
        ) as start_navigation:
            approved = self.client.post(
                "/api/classroom/run-next",
                headers=self.teacher,
                json={"item_id": item["id"]},
            )

        self.assertEqual(approved.status_code, 200)
        self.assertEqual(approved.json()["item"]["status"], "running")
        self.assertEqual(start_navigation.call_args.args[0].queue_item_id, item["id"])
        server.save_navigation_operation(
            {"operation_id": "nav-queue-linked", "status": "running"},
            "teacher",
            {"queue_item_id": item["id"]},
        )
        with patch.object(
            server,
            "navigation_operation_status",
            return_value={
                "operation_id": "nav-queue-linked",
                "status": "succeeded",
                "path_trace": [
                    {"x": 0.0, "y": 0.0, "yaw_rad": 0.0, "frame_id": "map"},
                    {"x": 1.0, "y": 0.0, "yaw_rad": 0.0, "frame_id": "map"},
                ],
                "path_trace_truncated": False,
                "path_trace_error": None,
            },
        ):
            operation = self.client.get(
                "/api/navigation/operation/nav-queue-linked",
                headers=self.teacher,
            )

        self.assertEqual(operation.status_code, 200)
        self.assertEqual(operation.json()["status"], "completed")
        project = operation.json()["saved_project"]
        self.assertEqual(project["username"], "student1")
        self.assertEqual(project["plannerMode"], "autonomous")
        self.assertNotIn("initial", project["plannerVariants"])
        self.assertEqual(server.list_queue_items()[0]["status"], "completed")
        self.assertEqual(server.list_queue_items()[0]["result_project"]["name"], project["name"])

    def test_truncated_autonomous_trace_does_not_create_project(self):
        item = server.insert_queue_item("student1", "truncated-route", "")
        server.set_queue_item_status(item["id"], "running")
        server.save_navigation_operation(
            {"operation_id": "nav-truncated", "status": "running"},
            "teacher",
            {"queue_item_id": item["id"]},
        )
        with patch.object(
            server,
            "navigation_operation_status",
            return_value={
                "operation_id": "nav-truncated",
                "status": "succeeded",
                "path_trace": [],
                "path_trace_truncated": True,
                "path_trace_error": "feedback trace was truncated",
            },
        ):
            operation = self.client.get(
                "/api/navigation/operation/nav-truncated",
                headers=self.teacher,
            )

        self.assertEqual(operation.status_code, 200)
        self.assertNotIn("saved_project", operation.json())
        self.assertIsNone(server.list_queue_items()[0]["result_project"])
        self.assertEqual(server.list_queue_items()[0]["status"], "completed")

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

    def test_planner_request_rejects_duet_controller(self):
        response = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={
                "name": "duet-planner-route",
                "code": "duet.move(0.1, 0, 0, 0.5)",
                "controller_version": "duet",
                "planner_request": {
                    "planner_mode": "manual",
                    "planner_waypoints": [{"x": 0, "y": 0}, {"x": 1, "y": 0}],
                },
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("require the G1 SDK", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
