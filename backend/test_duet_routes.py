import os
import sqlite3
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

    def test_safe_mode_setting_is_teacher_only_and_persists_per_teacher(self):
        default = self.client.get("/api/classroom/safe-mode", headers=self.teacher)
        student = self.client.get("/api/classroom/safe-mode", headers=self.student)
        self.assertEqual(default.status_code, 200)
        self.assertFalse(default.json()["enabled"])
        self.assertEqual(default.json()["coverage"], "front_rear_footprint")
        self.assertFalse(default.json()["full_coverage_available"])
        self.assertEqual(student.status_code, 403)

        updated = self.client.put(
            "/api/classroom/safe-mode",
            headers=self.teacher,
            json={"enabled": True},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertTrue(updated.json()["enabled"])
        self.assertTrue(
            self.client.get("/api/classroom/safe-mode", headers=self.teacher).json()["enabled"]
        )

        forbidden = self.client.put(
            "/api/classroom/safe-mode",
            headers=self.student,
            json={"enabled": False},
        )
        self.assertEqual(forbidden.status_code, 403)

    def test_safe_mode_setting_is_passed_to_both_physical_run_paths(self):
        updated = self.client.put(
            "/api/classroom/safe-mode",
            headers=self.teacher,
            json={"enabled": True},
        )
        self.assertEqual(updated.status_code, 200)

        with patch.object(server, "ensure_sdk_motion_available"), patch.object(
            server, "execute_robot_program", return_value={"status": "completed"}
        ) as execute_sdk, patch.object(
            server, "active_navigation_operation", return_value=None
        ), patch.object(
            server, "active_lidar_scan", return_value=None
        ), patch.object(
            server, "robot_status", return_value={"running": False}
        ), patch.object(
            server, "execute_duet_program", return_value={"status": "completed"}
        ) as execute_duet:
            legacy = self.client.post(
                "/api/run",
                headers=self.teacher,
                json={"code": "robot.walk(1)"},
            )
            duet = self.client.post(
                "/api/duet/run",
                headers=self.teacher,
                json={"code": "duet.walk(1)"},
            )

        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(duet.status_code, 200)
        execute_sdk.assert_called_once_with(
            "robot.walk(1)",
            safe_mode=True,
            safe_mode_stop_margin_m=server.SAFE_MODE_STOP_MARGIN_METERS,
        )
        execute_duet.assert_called_once_with(
            "duet.walk(1)",
            safe_mode=True,
            safe_mode_stop_margin_m=server.SAFE_MODE_STOP_MARGIN_METERS,
        )

    def test_duet_commissioning_routes_are_teacher_only(self):
        requests = (
            ("get", "/api/duet/commissioning", None),
            ("get", "/api/duet/commissioning/evidence", None),
            ("post", "/api/duet/commissioning/start", None),
            ("post", "/api/duet/commissioning/step", {"step_index": 0}),
            ("post", "/api/duet/commissioning/review", {
                "step_index": 0,
                "passed": True,
                "observed": True,
                "observed_result": "Observed the expected bounded response.",
                "notes": "",
            }),
            ("post", "/api/duet/commissioning/abort", None),
        )
        for method, path, body in requests:
            with self.subTest(path=path):
                if method == "get":
                    response = self.client.get(path, headers=self.student)
                else:
                    response = self.client.post(path, headers=self.student, json=body)
                self.assertEqual(response.status_code, 403)

    def test_teacher_commissioning_routes_use_duet_service_only(self):
        report = {"status": "in_progress", "steps": [], "current_step": 0}
        with patch.object(server, "active_navigation_operation", return_value=None), patch.object(
            server, "active_lidar_scan", return_value=None
        ), patch.object(server, "robot_status", return_value={"running": False}), patch.object(
            server, "start_duet_commissioning", return_value=report
        ) as start, patch.object(
            server, "run_duet_commissioning_step", return_value=report
        ) as run_step, patch.object(
            server, "review_duet_commissioning_step", return_value=report
        ) as review, patch.object(
            server, "abort_duet_commissioning", return_value=report
        ) as abort:
            started = self.client.post("/api/duet/commissioning/start", headers=self.teacher)
            stepped = self.client.post(
                    "/api/duet/commissioning/step",
                    headers=self.teacher,
                    json={"step_index": 0},
            )
            reviewed = self.client.post(
                    "/api/duet/commissioning/review",
                    headers=self.teacher,
                    json={
                        "step_index": 0,
                        "passed": True,
                        "observed": True,
                        "observed_result": "Observed the expected bounded response.",
                        "notes": "clear",
                    },
            )
            aborted = self.client.post("/api/duet/commissioning/abort", headers=self.teacher)

        self.assertEqual([started.status_code, stepped.status_code, reviewed.status_code, aborted.status_code], [200] * 4)
        start.assert_called_once_with("teacher")
        run_step.assert_called_once_with(0)
        review.assert_called_once_with(
            0,
            True,
            True,
            "teacher",
            "Observed the expected bounded response.",
            notes="clear",
        )
        abort.assert_called_once_with("teacher")

    def test_teacher_can_fetch_full_commissioning_evidence(self):
        evidence = {
            "report": {"status": "passed"},
            "events": [{"event": "started"}],
            "event_log": '{"event":"started"}\n',
        }
        with patch.object(server, "duet_commissioning_evidence", return_value=evidence) as get_evidence:
            response = self.client.get("/api/duet/commissioning/evidence", headers=self.teacher)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), evidence)
        get_evidence.assert_called_once_with()

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

    def test_duet_saved_motion_library_is_teacher_only_and_resolves_named_calls(self):
        forbidden = self.client.get("/api/duet/motions", headers=self.student)
        self.assertEqual(forbidden.status_code, 403)
        forbidden_save = self.client.post(
            "/api/duet/motions",
            headers=self.student,
            json={"name": "Student motion", "code": 'duet.arm_carry(1.5)'},
        )
        self.assertEqual(forbidden_save.status_code, 403)

        saved = self.client.post(
            "/api/duet/motions",
            headers=self.teacher,
            json={"name": "Welcome wave", "code": 'duet.wave_left("mid", 1)'},
        )
        self.assertEqual(saved.status_code, 200)
        motion = saved.json()["motion"]
        self.assertEqual(motion["name"], "Welcome wave")
        self.assertRegex(motion["id"], r"^welcome_wave_[a-f0-9]{8}$")
        listed = self.client.get("/api/duet/motions", headers=self.teacher)
        self.assertEqual([entry["id"] for entry in listed.json()["motions"]], [motion["id"]])

        resolved = server.expand_duet_motion_calls(
            f'duet.saved_motion("{motion["id"]}")',
            "teacher",
        )
        self.assertEqual(resolved, "duet.wave_left('mid', 1)")
        with self.assertRaises(server.DuetProgramValidationError):
            server.expand_duet_motion_calls(
                f'duet.saved_motion("{motion["id"]}")',
                "student1",
            )

    def test_duet_saved_motion_storage_rejects_unsafe_or_duplicate_definitions(self):
        invalid = self.client.post(
            "/api/duet/motions",
            headers=self.teacher,
            json={"name": "Unsafe", "code": "__import__('os').system('true')"},
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("duet", invalid.json()["detail"].lower())

        first = self.client.post(
            "/api/duet/motions",
            headers=self.teacher,
            json={"name": "Carry", "code": "duet.arm_carry(1.5)"},
        )
        duplicate = self.client.post(
            "/api/duet/motions",
            headers=self.teacher,
            json={"name": " carry ", "code": "duet.arm_carry(1.5)"},
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(duplicate.status_code, 409)

    def test_duet_arm_recordings_are_teacher_owned_and_persist_measured_samples(self):
        samples = [
            {"time": 0.0, "joints": [0.0] * 10},
            {"time": 0.1, "joints": [0.1] * 10},
            {"time": 0.2, "joints": [0.2] * 10},
        ]
        forbidden = self.client.post(
            "/api/duet/recordings",
            headers=self.student,
            json={"name": "Wave", "frames": samples},
        )
        self.assertEqual(forbidden.status_code, 403)

        created = self.client.post(
            "/api/duet/recordings",
            headers=self.teacher,
            json={"name": "Wave", "frames": samples},
        )
        self.assertEqual(created.status_code, 200)
        recording = created.json()["recording"]
        self.assertEqual(recording["name"], "Wave")
        self.assertRegex(recording["id"], r"^capture_[a-f0-9]{12}$")
        self.assertEqual(recording["frames"], samples)
        listed = self.client.get("/api/duet/recordings", headers=self.teacher)
        self.assertEqual(listed.json()["recordings"], [recording])
        self.assertEqual(
            self.client.get("/api/duet/recordings", headers=self.student).status_code,
            403,
        )

        duplicated = self.client.post(
            "/api/duet/recordings",
            headers=self.teacher,
            json={"name": " wave ", "frames": samples},
        )
        self.assertEqual(duplicated.status_code, 409)

        forbidden_delete = self.client.delete(
            f"/api/duet/recordings/{recording['id']}",
            headers=self.student,
        )
        self.assertEqual(forbidden_delete.status_code, 403)
        deleted = self.client.delete(
            f"/api/duet/recordings/{recording['id']}",
            headers=self.teacher,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(
            self.client.get("/api/duet/recordings", headers=self.teacher).json()["recordings"],
            [],
        )

    def test_duet_arm_recordings_reject_invalid_sample_shapes_and_times(self):
        cases = (
            [{"time": 0.0, "joints": [0.0] * 9}, {"time": 0.1, "joints": [0.0] * 10}],
            [{"time": 0.0, "joints": [0.0] * 10}, {"time": 0.0, "joints": [0.0] * 10}],
            [{"time": 0.1, "joints": [0.0] * 10}, {"time": 0.2, "joints": [0.0] * 10}],
            [{"time": 0.0, "joints": [0.0] * 10}, {"time": 31.0, "joints": [0.0] * 10}],
        )
        for frames in cases:
            response = self.client.post(
                "/api/duet/recordings",
                headers=self.teacher,
                json={"name": "Invalid", "frames": frames},
            )
            self.assertEqual(response.status_code, 400)

    def test_generic_recording_routes_store_duet_and_legacy_joint_layouts(self):
        duet_frames = [
            {"time": 0.0, "joints": [0.0] * 10},
            {"time": 0.1, "joints": [0.1] * 10},
        ]
        legacy_frames = [
            {"time": 0.0, "joints": [0.0] * 23},
            {"time": 0.1, "joints": [0.1] * 23},
        ]
        legacy_joint_names = list(server.G1_JOINT_NAMES)
        duet_joint_names = list(server.DUET_ARM_JOINT_NAMES)

        forbidden = self.client.post(
            "/api/robot/recordings",
            headers=self.student,
            json={
                "name": "Student capture",
                "controller_version": "legacy",
                "command": 'robot.arm_action("face wave")',
                "joint_names": legacy_joint_names,
                "frames": legacy_frames,
            },
        )
        self.assertEqual(forbidden.status_code, 403)

        duet = self.client.post(
            "/api/robot/recordings",
            headers=self.teacher,
            json={
                "name": "DUET wave",
                "controller_version": "duet",
                "command": 'duet.wave_right("mid", 1.5)',
                "joint_names": duet_joint_names,
                "frames": duet_frames,
            },
        )
        legacy = self.client.post(
            "/api/robot/recordings",
            headers=self.teacher,
            json={
                "name": "Legacy wave",
                "controller_version": "legacy",
                "command": 'robot.arm_action("face wave")',
                "joint_names": legacy_joint_names,
                "captured_at": "2026-03-01T10:00:00Z",
                "frames": legacy_frames,
            },
        )
        self.assertEqual(duet.status_code, 200)
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(duet.json()["recording"]["joint_names"], duet_joint_names)
        self.assertEqual(legacy.json()["recording"]["joint_names"], legacy_joint_names)
        self.assertEqual(legacy.json()["recording"]["captured_at"], "2026-03-01T10:00:00Z")
        self.assertEqual(legacy.json()["recording"]["frames"], legacy_frames)
        all_recordings = self.client.get("/api/robot/recordings", headers=self.teacher)
        self.assertEqual(
            {entry["controller_version"] for entry in all_recordings.json()["recordings"]},
            {"legacy", "duet"},
        )
        self.assertEqual(
            len(self.client.get("/api/duet/recordings", headers=self.teacher).json()["recordings"]),
            1,
        )
        self.assertEqual(
            self.client.delete(
                f"/api/robot/recordings/{legacy.json()['recording']['id']}",
                headers=self.teacher,
            ).status_code,
            200,
        )

        invalid_layout = self.client.post(
            "/api/robot/recordings",
            headers=self.teacher,
            json={
                "name": "Bad legacy layout",
                "controller_version": "legacy",
                "command": "robot.arm_action('face wave')",
                "joint_names": duet_joint_names,
                "frames": duet_frames,
            },
        )
        self.assertEqual(invalid_layout.status_code, 400)

    def test_existing_duet_recordings_migrate_with_joint_names(self):
        legacy_db_path = os.path.join(self.temp_dir.name, "pre-migration.db")
        connection = sqlite3.connect(legacy_db_path)
        connection.execute(
            """
            CREATE TABLE duet_arm_recordings (
                recording_id TEXT NOT NULL,
                username TEXT NOT NULL,
                name TEXT NOT NULL,
                frames TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (username, recording_id),
                UNIQUE (username, name)
            )
            """
        )
        connection.execute(
            "INSERT INTO duet_arm_recordings (recording_id, username, name, frames) VALUES (?, ?, ?, ?)",
            (
                "capture_existing",
                "teacher",
                "Old DUET capture",
                '[{"time":0,"joints":[0,0,0,0,0,0,0,0,0,0]},{"time":0.1,"joints":[0,0,0,0,0,0,0,0,0,0]}]',
            ),
        )
        connection.commit()
        connection.close()

        with patch.object(server, "DB_PATH", legacy_db_path):
            server.init_db()
            migrated = server.list_duet_arm_recordings_for_user("teacher")

        self.assertEqual(migrated[0]["id"], "capture_existing")
        self.assertEqual(migrated[0]["controller_version"], "duet")
        self.assertEqual(migrated[0]["joint_names"], list(server.DUET_ARM_JOINT_NAMES))

    def test_legacy_joint_state_proxy_is_teacher_only_fresh_and_no_store(self):
        positions = [index / 100 for index in range(23)]
        payload = {
            "joint_names": list(server.G1_JOINT_NAMES),
            "positions_rad": positions,
            "received_at": "2026-03-01T10:00:00+00:00",
            "age_ms": 40,
        }
        provider_response = unittest.mock.Mock(status_code=200)
        provider_response.json.return_value = payload
        with patch.dict(os.environ, {
            "G1_DISTANCE_PROVIDER_URL": "http://127.0.0.1:8181/distance/front",
            "G1_DISTANCE_PROVIDER_TOKEN": "provider-secret",
        }), patch.object(server.httpx, "get", return_value=provider_response) as provider_get:
            response = self.client.get("/api/robot/joint-state", headers=self.teacher)
            forbidden = self.client.get("/api/robot/joint-state", headers=self.student)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["joint_names"], list(server.G1_JOINT_NAMES))
        self.assertEqual(response.json()["positions_rad"], positions)
        self.assertEqual(response.headers["cache-control"], "no-store, no-cache, max-age=0")
        self.assertEqual(forbidden.status_code, 403)
        provider_get.assert_called_once_with(
            "http://127.0.0.1:8181/joint_state",
            headers={"Authorization": "Bearer provider-secret", "Accept": "application/json"},
            timeout=0.5,
            follow_redirects=False,
        )

        stale_response = unittest.mock.Mock(status_code=200)
        stale_response.json.return_value = {**payload, "age_ms": 250.1}
        with patch.dict(os.environ, {
            "G1_DISTANCE_PROVIDER_URL": "http://127.0.0.1:8181/distance/front",
            "G1_DISTANCE_PROVIDER_TOKEN": "provider-secret",
        }), patch.object(server.httpx, "get", return_value=stale_response):
            stale = self.client.get("/api/robot/joint-state", headers=self.teacher)
        self.assertEqual(stale.status_code, 502)

    def test_duet_run_expands_saved_motion_before_controller_execution(self):
        saved = self.client.post(
            "/api/duet/motions",
            headers=self.teacher,
            json={"name": "Safe wave", "code": 'duet.wave_left("mid", 1)'},
        ).json()["motion"]
        expected = {"status": "completed", "commandsExecuted": 1}
        with patch.object(server, "active_navigation_operation", return_value=None), patch.object(
            server, "active_lidar_scan", return_value=None
        ), patch.object(
            server, "robot_status", return_value={"running": False}
        ), patch.object(server, "execute_duet_program", return_value=expected) as execute:
            response = self.client.post(
                "/api/duet/run",
                headers=self.teacher,
                json={"code": f'duet.saved_motion("{saved["id"]}")'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), expected)
        execute.assert_called_once_with(
            "duet.wave_left('mid', 1)",
            safe_mode=False,
            safe_mode_stop_margin_m=server.SAFE_MODE_STOP_MARGIN_METERS,
        )

    def test_duet_connect_reports_missing_controller_unit_and_does_not_use_sdk(self):
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
        self.assertIn("manual DUET controller unit is not installed", response.json()["detail"])
        connect_sdk.assert_not_called()

    def test_duet_status_explains_when_the_local_gateway_is_not_running(self):
        with patch.dict(os.environ, {
            "DUET_CONTROL_DIR": os.path.join(self.temp_dir.name, "duet-control"),
        }), patch.object(server.Path, "home", return_value=server.Path(self.temp_dir.name)):
            response = self.client.get("/api/duet/status", headers=self.teacher)

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["connected"])
        self.assertEqual(response.json()["motionOwner"], "none")
        self.assertFalse(response.json()["controllerServiceActive"])
        self.assertIn("DUET_GATEWAY_ENABLED=true", response.json()["error"])
        self.assertIn("DUET_CONTROL_DIR", response.json()["error"])

    def test_duet_connect_attaches_to_already_active_controller_without_starting_it(self):
        connected = {
            "status": "connected",
            "connected": True,
            "ready": True,
            "controlLease": True,
            "motionOwner": "duet",
        }
        with patch.dict(os.environ, {"DUET_PHYSICAL_ENABLED": ""}), patch.object(
            server, "active_navigation_operation", return_value=None
        ), patch.object(server, "active_lidar_scan", return_value=None), patch.object(
            server, "robot_status", return_value={"sdkAvailable": False, "running": False}
        ), patch.object(
            server, "duet_controller_status",
            side_effect=[
                {"motionOwner": "none", "controlLease": False},
                connected,
            ],
        ), patch.object(
            server, "duet_controller_service_state", return_value="active"
        ), patch.object(
            server, "connect_duet_controller", return_value=connected
        ) as connect_duet, patch.object(server, "connect_robot") as connect_sdk:
            response = self.client.post("/api/duet/connect", headers=self.teacher)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), connected)
        connect_duet.assert_called_once_with()
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
        execute_sdk.assert_called_once_with(
            "robot.walk(1)",
            safe_mode=False,
            safe_mode_stop_margin_m=server.SAFE_MODE_STOP_MARGIN_METERS,
        )
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
        execute_duet.assert_called_once_with(
            "duet.stop()",
            safe_mode=False,
            safe_mode_stop_margin_m=server.SAFE_MODE_STOP_MARGIN_METERS,
        )
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
        execute_sdk.assert_called_once_with(
            "robot.walktime(1)",
            safe_mode=False,
            safe_mode_stop_margin_m=server.SAFE_MODE_STOP_MARGIN_METERS,
        )
        self.assertEqual(server.list_queue_items()[0]["status"], "completed")

    def test_teacher_stop_during_queue_run_keeps_item_paused(self):
        submitted = self.client.post(
            "/api/classroom/submit-code",
            headers=self.student,
            json={"name": "stoppable", "code": "robot.walktime(1)"},
        )
        item = submitted.json()["item"]

        def stop_during_execution(code, **_kwargs):
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
