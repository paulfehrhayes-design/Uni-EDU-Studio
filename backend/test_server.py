import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import server

app = server.app


class ServerClassroomTests(unittest.TestCase):
    def test_teacher_can_capture_publish_and_share_validated_lidar_map(self):
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            job_id = "12345678-1234-1234-1234-123456789abc"
            map_snapshot = {
                "ready": True,
                "map": {
                    "map_id": "classroom",
                    "version": "v-room-1",
                    "frame_id": "map",
                    "resolution_m": 0.05,
                    "width": 2,
                    "height": 2,
                    "origin": {"x": -0.05, "y": -0.05, "yaw_rad": 0.0},
                    "updated_at": "2026-10-14T17:00:00+00:00",
                },
                "data": [0, 100, -1, 50],
            }
            pointcloud = {
                "job_id": job_id,
                "frame_id": "map",
                "captured_at": "2026-10-14T17:00:00+00:00",
                "point_count": 1000,
                "points": [{"x": 1.0, "y": 2.0, "z": 0.5}] * 1000,
            }
            with patch.object(
                server, "robot_status", return_value={"running": False}
            ), patch.object(
                server, "navigation_start_scan",
                return_value={
                    "job_id": job_id,
                    "status": "scanning",
                    "rotation_status": "submitted",
                    "rotation_radians": 0.0,
                    "point_count": 0,
                    "preview_points": [],
                },
            ), patch.object(
                server, "navigation_scan_status",
                return_value={
                    "job_id": job_id,
                    "status": "scanning",
                    "rotation_status": "completed",
                    "rotation_radians": 6.283185307179586,
                    "point_count": 1000,
                    "preview_points": [],
                },
            ), patch.object(
                server, "navigation_complete_scan",
                return_value={
                    "job_id": job_id, "status": "completed",
                    "map_id": "classroom", "map_version": "v-room-1",
                    "frame_id": "map",
                },
            ), patch.object(
                server, "navigation_scan_map_snapshot", return_value=map_snapshot
            ), patch.object(
                server, "navigation_scan_pointcloud", return_value=pointcloud
            ):
                unconfirmed = client.post(
                    "/api/lidar/scan",
                    headers=teacher_headers,
                    json={"confirm_rotation": False},
                )
                started = client.post(
                    "/api/lidar/scan",
                    headers=teacher_headers,
                    json={"confirm_rotation": True},
                )
                status = client.get(f"/api/lidar/scan/{job_id}", headers=teacher_headers)
                blocked_sdk = client.post(
                    "/api/run",
                    headers=teacher_headers,
                    json={"code": "robot.walk(1)"},
                )
                completed = client.post(
                    f"/api/lidar/scan/{job_id}/complete", headers=teacher_headers
                )

            published = client.post(
                "/api/lidar/map/publish",
                headers=teacher_headers,
                json={"job_id": job_id},
            )
            hidden_student_map = client.get("/api/lidar/map", headers=student_headers)
            forbidden_toggle = client.put(
                "/api/lidar/settings",
                headers=student_headers,
                json={"show_shared_overlay": True},
            )
            enabled = client.put(
                "/api/lidar/settings",
                headers=teacher_headers,
                json={"show_shared_overlay": True},
            )
            shared_student_map = client.get("/api/lidar/map", headers=student_headers)

        self.assertEqual(started.status_code, 200)
        self.assertEqual(unconfirmed.status_code, 400)
        self.assertEqual(started.json()["rotation_status"], "submitted")
        self.assertEqual(status.json()["point_count"], 1000)
        self.assertEqual(blocked_sdk.status_code, 409)
        self.assertIn("LiDAR scan", blocked_sdk.json()["detail"])
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(published.json()["status"], "published")
        self.assertFalse(hidden_student_map.json()["enabled"])
        self.assertEqual(forbidden_toggle.status_code, 403)
        self.assertTrue(enabled.json()["show_shared_overlay"])
        self.assertEqual(shared_student_map.json()["map"]["map"]["version"], "v-room-1")
        self.assertEqual(shared_student_map.json()["pointcloud"]["point_count"], 1000)

    def test_authenticated_lidar_websocket_streams_live_status(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            client = TestClient(app)
            session = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1"},
            ).json()
            bridge_status = {
                "ready": False,
                "status": "unavailable",
                "map": None,
                "localization": {"ready": False},
                "error": "bridge unavailable",
            }
            with patch.object(server, "navigation_bridge_status", return_value=bridge_status):
                with client.websocket_connect(
                    "/api/lidar/live",
                    subprotocols=[f"edu-auth.{session['token']}"],
                ) as websocket:
                    update = websocket.receive_json()

        self.assertEqual(update["type"], "live_update")
        self.assertFalse(update["navigation"]["ready"])
        self.assertFalse(update["shared_overlay_enabled"])

    def test_navigation_status_is_teacher_only_and_records_map_versions(self):
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            bridge_status = {
                "status": "ready",
                "ready": True,
                "bridgeReady": True,
                "localization": {
                    "ready": True,
                    "frame_id": "map",
                    "pose": {"x": 1.0, "y": 2.0, "yaw_rad": 0.2},
                    "timestamp": "2026-10-14T17:00:00+00:00",
                    "age_ms": 50,
                },
                "plannerReady": True,
                "map": {
                    "map_id": "classroom",
                    "version": "v1",
                    "frame_id": "map",
                    "resolution_m": 0.05,
                    "width": 100,
                    "height": 80,
                    "origin": {"x": -2.5, "y": -2.0},
                    "updated_at": "2026-10-13T17:00:00+00:00",
                },
                "error": None,
            }

            with patch.object(server, "navigation_bridge_status", return_value=bridge_status):
                response = client.get("/api/navigation/status", headers=teacher_headers)
                denied = client.get("/api/navigation/status", headers=student_headers)
                anonymous = client.get("/api/navigation/status")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(response.json()["knownMapVersions"][0]["version"], "v1")
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(anonymous.status_code, 401)

    def test_navigation_map_endpoint_is_teacher_only_and_read_only(self):
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            snapshot = {
                "ready": True,
                "map": {
                    "map_id": "classroom",
                    "version": "v2",
                    "frame_id": "map",
                    "resolution_m": 0.05,
                    "width": 2,
                    "height": 2,
                    "origin": {"x": -0.05, "y": -0.05, "yaw_rad": 0.0},
                    "updated_at": "2026-10-14T17:00:00+00:00",
                },
                "data": [0, 100, -1, 50],
            }
            with patch.object(server, "navigation_map_snapshot", return_value=snapshot):
                response = client.get("/api/navigation/map", headers=teacher_headers)
                denied = client.get("/api/navigation/map", headers=student_headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"], [0, 100, -1, 50])
        self.assertEqual(response.json()["knownMapVersions"][0]["version"], "v2")
        self.assertEqual(denied.status_code, 403)

    def test_route_preview_is_teacher_only_and_does_not_start_navigation(self):
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            preview = {
                "map_id": "classroom",
                "version": "v4",
                "frame_id": "map",
                "planner_id": "GridBased",
                "path": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}],
            }
            with patch.object(server, "robot_status", return_value={"running": False}), patch.object(
                server, "navigation_plan_route", return_value=preview
            ) as plan_route, patch.object(server, "navigation_start_route") as start_route:
                response = client.post(
                    "/api/navigation/plan",
                    headers=teacher_headers,
                    json={
                        "map_id": "classroom",
                        "version": "v4",
                        "frame_id": "map",
                        "waypoints": [{"x": 1.0, "y": 0.0}],
                    },
                )
                denied = client.post(
                    "/api/navigation/plan",
                    headers=student_headers,
                    json={
                        "map_id": "classroom",
                        "version": "v4",
                        "frame_id": "map",
                        "waypoints": [{"x": 1.0, "y": 0.0}],
                    },
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), preview)
        plan_route.assert_called_once()
        start_route.assert_not_called()
        self.assertEqual(denied.status_code, 403)

    def test_navigation_start_is_teacher_only_persists_operation_and_locks_sdk(self):
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            route_request = {
                "map_id": "classroom",
                "version": "v4",
                "frame_id": "map",
                "waypoints": [{"x": 1.0, "y": 2.0}],
            }
            operation = {
                "operation_id": "12345678-1234-1234-1234-123456789abc",
                "status": "accepted",
            }
            with patch.object(server, "robot_status", return_value={"running": False}), patch.object(
                server, "navigation_start_route", return_value=operation
            ):
                response = client.post(
                    "/api/navigation/start",
                    headers=teacher_headers,
                    json=route_request,
                )
                denied = client.post(
                    "/api/navigation/start",
                    headers=student_headers,
                    json=route_request,
                )

            blocked_sdk = client.post(
                "/api/run",
                headers=teacher_headers,
                json={"code": "robot.walk(1)"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["operation_id"], operation["operation_id"])
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(blocked_sdk.status_code, 409)
        self.assertIn("owns locomotion", blocked_sdk.json()["detail"])

    def test_navigation_terminal_status_releases_sdk_lock_and_stop_requires_active_operation(self):
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            headers = {"Authorization": f"Bearer {teacher['token']}"}
            operation_id = "12345678-1234-1234-1234-123456789abc"
            server.save_navigation_operation(
                {"operation_id": operation_id, "status": "accepted"},
                "teacher",
                {"map_id": "classroom", "version": "v4", "frame_id": "map", "waypoints": []},
            )
            with patch.object(
                server,
                "navigation_operation_status",
                return_value={"operation_id": operation_id, "status": "succeeded"},
            ):
                response = client.get(
                    f"/api/navigation/operation/{operation_id}",
                    headers=headers,
                )
            stop_response = client.post(
                f"/api/navigation/operation/{operation_id}/stop",
                headers=headers,
            )
            with patch.object(server, "execute_robot_program", return_value={"status": "completed"}):
                sdk_response = client.post(
                    "/api/run",
                    headers=headers,
                    json={"code": "robot.walk(1)"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "completed")
        self.assertEqual(stop_response.status_code, 409)
        self.assertEqual(sdk_response.status_code, 200)

    def test_github_proxy_requires_url(self):
        client = TestClient(app)
        response = client.get('/api/github-proxy')
        self.assertEqual(response.status_code, 400)

    def test_robot_connect_defaults_to_configured_unitree_interface(self):
        client = TestClient(app)
        teacher = client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        headers = {'Authorization': f"Bearer {teacher['token']}"}

        with patch.dict(os.environ, {'UNITREE_INTERFACE': 'eth0'}), patch.object(
            server,
            'connect_robot',
            return_value={'status': 'connected', 'interface': 'eth0', 'domain': 0},
        ) as connect:
            response = client.post('/api/robot/connect', headers=headers, json={})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['interface'], 'eth0')
        connect.assert_called_once_with('eth0')

    def test_robot_status_reports_distance_provider_only_to_teacher(self):
        client = TestClient(app)
        teacher = client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        student = client.post(
            '/api/classroom/login',
            json={'username': 'student1', 'password': 'student1'},
        ).json()
        teacher_headers = {'Authorization': f"Bearer {teacher['token']}"}
        student_headers = {'Authorization': f"Bearer {student['token']}"}
        sensor_status = {
            'status': 'ready',
            'ready': True,
            'distance_m': 0.8,
            'age_ms': 40,
        }

        with patch.object(server, 'distance_sensor_status', return_value=sensor_status):
            response = client.get('/api/robot/status', headers=teacher_headers)
            denied = client.get('/api/robot/status', headers=student_headers)
            anonymous = client.get('/api/robot/status')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['distanceSensor'], sensor_status)
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(anonymous.status_code, 401)

    def test_classroom_login_and_queue_flow(self):
        client = TestClient(app)

        teacher = client.post('/api/classroom/login', json={'username': 'teacher', 'password': 'teacher'})
        self.assertEqual(teacher.status_code, 200)
        teacher_token = teacher.json()['token']

        student = client.post('/api/classroom/login', json={'username': 'student1', 'password': 'student1', 'role': 'student'})
        self.assertEqual(student.status_code, 200)
        student_token = student.json()['token']

        saved = client.post(
            '/api/classroom/save-code',
            headers={'Authorization': f'Bearer {student_token}'},
            json={'name': 'demo', 'code': 'print("hello")'}
        )
        self.assertEqual(saved.status_code, 200)

        submitted = client.post(
            '/api/classroom/submit-code',
            headers={'Authorization': f'Bearer {student_token}'},
            json={'name': 'demo', 'code': 'print("hello")'}
        )
        self.assertEqual(submitted.status_code, 200)

        queue = client.get('/api/classroom/queue', headers={'Authorization': f'Bearer {teacher_token}'})
        self.assertEqual(queue.status_code, 200)
        submitted_id = submitted.json()['item']['id']
        matching_items = [item for item in queue.json()['items'] if item['id'] == submitted_id]
        self.assertEqual(len(matching_items), 1)
        self.assertEqual(matching_items[0]['status'], 'queued')

    def test_teacher_can_signup_student_and_view_roster(self):
        client = TestClient(app)

        teacher = client.post('/api/classroom/login', json={'username': 'teacher', 'password': 'teacher'})
        self.assertEqual(teacher.status_code, 200)
        teacher_token = teacher.json()['token']

        unique_username = f'newstudent_{uuid.uuid4().hex[:8]}'
        signup = client.post('/api/classroom/signup', json={'username': unique_username, 'password': 'secret123', 'role': 'student'})
        self.assertEqual(signup.status_code, 200)
        self.assertEqual(signup.json()['user']['username'], unique_username)

        roster = client.get('/api/classroom/users', headers={'Authorization': f'Bearer {teacher_token}'})
        self.assertEqual(roster.status_code, 200)
        usernames = [entry['username'] for entry in roster.json()['users']]
        self.assertIn(unique_username, usernames)

    def test_static_mount_uses_backend_static_directory(self):
        static_mounts = [route for route in app.routes if hasattr(route, 'app') and route.path == '']
        self.assertTrue(static_mounts)
        mounted_dir = static_mounts[0].app.directory
        expected_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), 'static'))
        self.assertEqual(os.path.abspath(mounted_dir), expected_dir)

    def test_frontend_index_is_not_cached(self):
        response = TestClient(app).get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('no-store', response.headers['cache-control'])
        self.assertIn('no-cache', response.headers['cache-control'])
        self.assertRegex(response.text, r'assets/index-[A-Za-z0-9_-]+\.js')

    def test_find_available_port_skips_busy_port(self):
        import socket

        busy_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        busy_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        busy_socket.bind(('0.0.0.0', 5199))
        busy_socket.listen(1)

        from server import find_available_port
        selected = find_available_port(5199, 5)
        self.assertNotEqual(selected, 5199)
        self.assertGreaterEqual(selected, 5199)
        busy_socket.close()

    def test_teacher_clear_queue_removes_waiting_items_and_preserves_running_job(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            client = TestClient(app)
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1", "role": "student"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={"name": "waiting", "code": "robot.stand()"},
            )
            running = server.insert_queue_item("student1", "running", "robot.stand()")
            server.set_queue_item_status(running["id"], "running")

            cleared = client.post("/api/classroom/clear-queue", headers=teacher_headers)

            self.assertEqual(cleared.status_code, 200)
            self.assertEqual(cleared.json()["deleted"], 1)
            self.assertEqual(
                [item["id"] for item in cleared.json()["remaining"]],
                [running["id"]],
            )
            forbidden = client.post("/api/classroom/clear-queue", headers=student_headers)
            self.assertEqual(forbidden.status_code, 403)

    def test_run_next_dispatches_queued_program_to_robot_executor(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            client = TestClient(app)
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1", "role": "student"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            code = "robot.walktime(0.5)"
            client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={"name": "robot-motion", "code": code},
            )

            with patch.object(
                server,
                "execute_robot_program",
                return_value={"status": "completed", "commandsExecuted": 1},
            ) as execute:
                response = client.post(
                    "/api/classroom/run-next",
                    headers=teacher_headers,
                )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["item"]["status"], "completed")
            self.assertEqual(response.json()["process"]["commandsExecuted"], 1)
            execute.assert_called_once_with(code)

    def test_run_next_keeps_program_queued_when_robot_is_not_ready(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            client = TestClient(app)
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            student = client.post(
                "/api/classroom/login",
                json={"username": "student1", "password": "student1", "role": "student"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            submission = client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={"name": "retry-after-connect", "code": "robot.walk(1)"},
            ).json()["item"]

            with patch.object(
                server,
                "execute_robot_program",
                side_effect=HTTPException(status_code=409, detail="Connect the G1 SDK first."),
            ):
                response = client.post(
                    "/api/classroom/run-next",
                    headers=teacher_headers,
                )

            self.assertEqual(response.status_code, 409)
            items = client.get(
                "/api/classroom/queue",
                headers=teacher_headers,
            ).json()["items"]
            self.assertEqual(items[0]["id"], submission["id"])
            self.assertEqual(items[0]["status"], "queued")


if __name__ == '__main__':
    unittest.main()
