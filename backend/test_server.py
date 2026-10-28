import os
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import server

app = server.app


class ServerClassroomTests(unittest.TestCase):
    def test_planner_mode_setting_is_teacher_controlled_and_shared(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            result = server.update_planner_settings(
                server.PlannerSettingsRequest(active_mode="sensor_corrected"),
                {"role": "teacher", "username": "teacher"},
            )
            self.assertEqual(result["active_mode"], "sensor_corrected")
            self.assertEqual(
                server.get_planner_settings({"role": "student", "username": "student1"}),
                {"active_mode": "sensor_corrected"},
            )
            with self.assertRaisesRegex(HTTPException, "Teacher role required"):
                server.update_planner_settings(
                    server.PlannerSettingsRequest(active_mode="autonomous"),
                    {"role": "student", "username": "student1"},
                )

    def test_saved_path_project_round_trips_mode_label_variants_and_plain_code(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            server, "DB_PATH", os.path.join(temp_dir, "classroom.db")
        ):
            server.init_db()
            project = server.save_project_for_user(
                "student1",
                {
                    "name": "checkpointed-classroom-route",
                    "plannerWaypoints": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}],
                    "generatedCode": "robot.stand()\nrobot.walktime(2.5)",
                    "plannerMode": "sensor_corrected",
                    "plannerLabel": "checkpointed-classroom-route",
                    "plannerVariants": {"initial": "robot.walktime(2)", "corrected": "robot.walktime(2.5)"},
                    "selectedPlannerVariant": "corrected",
                },
            )
            self.assertEqual(project["plannerMode"], "sensor_corrected")
            self.assertEqual(project["plannerLabel"], "checkpointed-classroom-route")
            self.assertEqual(project["selectedPlannerVariant"], "corrected")
            self.assertEqual(project["generatedCode"], "robot.stand()\nrobot.walktime(2.5)\n")
            library_project = server.list_projects_for_user("student1")[0]
            self.assertEqual(library_project["plannerVariants"]["corrected"], "robot.walktime(2.5)")

    def test_checkpointed_sdk_route_fails_closed_without_deployment_enablement(self):
        request = server.CheckpointedPlannerRequest(
            waypoints=[{"x": 0.0, "y": 0.0}, {"x": 0.5, "y": 0.0}]
        )
        with patch.dict(
            os.environ,
            {
                "G1_SDK_CHECKPOINTED_PLANNER_ENABLED": "",
                "G1_SDK_CHECKPOINTED_PLANNER_OWNER_CONFIRMED": "1",
            },
        ):
            with self.assertRaisesRegex(HTTPException, "deployment-disabled"):
                server.run_checkpointed_planner(request, {"role": "teacher", "username": "teacher"})

    def test_checkpointed_sdk_route_uses_live_pose_at_waypoint_checkpoints(self):
        request = server.CheckpointedPlannerRequest(
            waypoints=[{"x": 0.5, "y": 0.0}, {"x": 1.0, "y": 0.0}]
        )
        poses = iter([
            (0.0, 0.0),
            (0.0, 0.0),
            (0.5, 0.0),
            (0.5, 0.0),
            (1.0, 0.0),
        ])

        def localization_snapshot():
            x, y = next(poses)
            return {
                "localization": {
                    "ready": True,
                    "frame_id": "map",
                    "pose": {"x": x, "y": y, "yaw_rad": 0.0},
                },
                "pointcloudReady": True,
                "estop": {"ready": True},
                "robotHealth": {"ready": True},
            }

        executions = []

        def execute(code, **_kwargs):
            executions.append(code)
            return {"status": "completed", "commandsExecuted": 1}

        with patch.dict(
            os.environ,
            {
                "G1_SDK_CHECKPOINTED_PLANNER_ENABLED": "1",
                "G1_SDK_CHECKPOINTED_PLANNER_OWNER_CONFIRMED": "1",
            },
        ), patch.object(server, "ensure_sdk_motion_available"), patch.object(
            server, "robot_status", return_value={"sdkAvailable": True, "running": False}
        ), patch.object(server, "navigation_bridge_status", side_effect=localization_snapshot), patch.object(
            server, "execute_robot_program", side_effect=execute
        ):
            result = server.run_checkpointed_planner(
                request, {"role": "teacher", "username": "teacher"}
            )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["checkpoints"]), 2)
        self.assertTrue(all(checkpoint["error_m"] <= 0.25 for checkpoint in result["checkpoints"]))
        self.assertIn("robot.walktime", result["correctedCode"])
        self.assertEqual(executions[0], "robot.stand()")
        self.assertEqual(executions[-1], "robot.stand()")

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
            hidden_student_settings = client.get(
                "/api/lidar/settings", headers=student_headers
            )
            enabled = client.put(
                "/api/lidar/settings",
                headers=teacher_headers,
                json={"show_shared_overlay": True},
            )
            shared_student_settings = client.get(
                "/api/lidar/settings", headers=student_headers
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
        self.assertFalse(hidden_student_settings.json()["show_shared_overlay"])
        self.assertTrue(enabled.json()["show_shared_overlay"])
        self.assertTrue(shared_student_settings.json()["show_shared_overlay"])
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
            teacher = client.post(
                "/api/classroom/login",
                json={"username": "teacher", "password": "teacher"},
            ).json()
            enabled = client.put(
                "/api/lidar/settings",
                headers={"Authorization": f"Bearer {teacher['token']}"},
                json={"show_shared_overlay": True},
            )
            bridge_status = {
                "ready": False,
                "status": "unavailable",
                "map": None,
                "localization": {"ready": False},
                "diagnostics": {
                    "topics": {"pointcloud": "/mid360/livox/lidar"},
                },
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
        self.assertEqual(
            update["navigation"]["diagnostics"]["topics"]["pointcloud"],
            "/mid360/livox/lidar",
        )
        self.assertEqual(enabled.status_code, 200)
        self.assertTrue(update["shared_overlay_enabled"])

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

    def test_navigation_map_endpoint_is_available_for_authenticated_planning_and_read_only(self):
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
        self.assertEqual(denied.status_code, 200)
        self.assertEqual(denied.json()["map"]["version"], "v2")

    def test_route_preview_is_available_for_authenticated_users_and_does_not_start_navigation(self):
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
        self.assertEqual(plan_route.call_count, 2)
        self.assertTrue(all(call.kwargs["planner_mode"] == "static" for call in plan_route.call_args_list))
        start_route.assert_not_called()
        self.assertEqual(denied.status_code, 200)
        self.assertEqual(denied.json(), preview)

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
            ) as start_route:
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
        self.assertEqual(start_route.call_args.kwargs["planner_mode"], "static")
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

        with patch.object(server, 'robot_status', return_value={'sdkAvailable': True}), patch.object(
            server,
            'distance_sensor_status',
            return_value=sensor_status,
        ):
            response = client.get('/api/robot/status', headers=teacher_headers)
            denied = client.get('/api/robot/status', headers=student_headers)
            anonymous = client.get('/api/robot/status')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['distanceSensor'], sensor_status)
        self.assertEqual(response.headers['cache-control'], 'no-store, max-age=0')
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(anonymous.status_code, 401)

    def test_robot_status_does_not_query_lidar_until_sdk_connected(self):
        client = TestClient(app)
        teacher = client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        headers = {'Authorization': 'Bearer ' + teacher['token']}

        with patch.object(server, 'robot_status', return_value={'sdkAvailable': False}), patch.object(
            server,
            'distance_sensor_status',
        ) as sensor_status:
            response = client.get('/api/robot/status', headers=headers)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn('distanceSensor', response.json())
        sensor_status.assert_not_called()

    def test_sensor_status_and_discovery_are_teacher_only(self):
        client = TestClient(app)
        teacher = client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        student = client.post(
            '/api/classroom/login',
            json={'username': 'student1', 'password': 'student1'},
        ).json()
        teacher_headers = {'Authorization': 'Bearer ' + teacher['token']}
        student_headers = {'Authorization': 'Bearer ' + student['token']}
        diagnostics = {
            'lidar': {'calibration': {'ready': False}},
            'cameras': {'available': False},
        }

        with patch.object(server, '_sensor_diagnostics', return_value=diagnostics) as discover:
            status = client.get('/api/sensors/status', headers=teacher_headers)
            refreshed = client.post('/api/sensors/discover', headers=teacher_headers)
            denied = client.get('/api/sensors/status', headers=student_headers)
            anonymous = client.post('/api/sensors/discover')

        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json(), diagnostics)
        self.assertEqual(status.headers['cache-control'], 'no-store, max-age=0')
        self.assertEqual(refreshed.status_code, 200)
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(discover.call_count, 2)

    def test_sensor_diagnostics_integrate_independent_backend_reports(self):
        discovery = {'connection': {'method': 'unitree_ros_pointcloud', 'ready': True}}
        distance = {'ready': False, 'error': 'MID-360 calibration is unconfirmed.'}
        calibration = {'ready': False, 'status': 'unverified'}
        cameras = {
            'available': True,
            'sources': {
                'unitree': {'ready': True},
                'realsense': {'ready': False},
            },
        }

        with patch.object(server, 'discover_sensors', return_value=discovery), patch.object(
            server, 'distance_sensor_status', return_value=distance
        ), patch.object(server, 'calibration_status', return_value=calibration), patch.object(
            server, 'discover_camera_sources', return_value=cameras
        ):
            result = server._sensor_diagnostics()

        self.assertEqual(
            result,
            {
                'lidar': {
                    'discovery': discovery,
                    'distance': distance,
                    'calibration': calibration,
                },
                'cameras': cameras,
            },
        )

    def test_sensor_service_operations_are_allowlisted_and_teacher_only(self):
        client = TestClient(app)
        teacher = client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        student = client.post(
            '/api/classroom/login',
            json={'username': 'student1', 'password': 'student1'},
        ).json()
        teacher_headers = {'Authorization': 'Bearer ' + teacher['token']}
        student_headers = {'Authorization': 'Bearer ' + student['token']}
        success = subprocess.CompletedProcess(
            ['systemctl'], 0, '', ''
        )

        with patch.dict(os.environ, {'G1_LIDAR_ROS_RUNTIME': 'host'}), patch.object(
            server.subprocess, 'run', return_value=success
        ) as run:
            response = client.post(
                '/api/sensors/service',
                headers=teacher_headers,
                json={'sensor_id': 'lidar_driver', 'operation': 'repair'},
            )
            denied = client.post(
                '/api/sensors/service',
                headers=student_headers,
                json={'sensor_id': 'lidar_driver', 'operation': 'stop'},
            )
            invalid = client.post(
                '/api/sensors/service',
                headers=teacher_headers,
                json={'sensor_id': 'anything.service', 'operation': 'restart'},
            )
            unsupported_camera_service = client.post(
                '/api/sensors/service',
                headers=teacher_headers,
                json={'sensor_id': 'realsense_camera', 'operation': 'restart'},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['service'], 'uni-edu-lidar-driver.service')
        self.assertEqual(run.call_args.args[0], [
            'systemctl', '--user', 'restart', 'uni-edu-lidar-driver.service'
        ])
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(unsupported_camera_service.status_code, 422)
        self.assertEqual(run.call_count, 1)
        self.assertFalse(run.call_args.kwargs.get('shell', False))

    def test_sensor_service_rejects_command_strings_and_surfaces_service_failures(self):
        client = TestClient(app)
        teacher = client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        headers = {'Authorization': 'Bearer ' + teacher['token']}
        failed = subprocess.CompletedProcess(
            ['systemctl'], 1, '', 'service failed'
        )

        with patch.object(server.subprocess, 'run', return_value=failed) as run:
            injection = client.post(
                '/api/sensors/service',
                headers=headers,
                json={
                    'sensor_id': 'lidar_driver',
                    'operation': 'restart; touch /tmp/should-not-run',
                },
            )
            failure = client.post(
                '/api/sensors/service',
                headers=headers,
                json={'sensor_id': 'lidar_driver', 'operation': 'restart'},
            )

        self.assertEqual(injection.status_code, 422)
        self.assertEqual(failure.status_code, 409)
        self.assertEqual(failure.json()['detail'], 'service failed')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(
            run.call_args.args[0],
            ['systemctl', '--user', 'restart', 'uni-edu-lidar-driver.service'],
        )
        self.assertFalse(run.call_args.kwargs.get('shell', False))

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

    def test_teacher_can_create_student_and_view_roster(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        db_patcher = patch.object(
            server, 'DB_PATH', os.path.join(temp_dir.name, 'classroom.db')
        )
        db_patcher.start()
        self.addCleanup(db_patcher.stop)
        server.init_db()
        client = TestClient(app)

        teacher = client.post('/api/classroom/login', json={'username': 'teacher', 'password': 'teacher'})
        self.assertEqual(teacher.status_code, 200)
        teacher_token = teacher.json()['token']

        unique_username = f'newstudent_{uuid.uuid4().hex[:8]}'
        created = client.post(
            '/api/classroom/users',
            headers={'Authorization': 'Bearer ' + teacher_token},
            json={'username': unique_username, 'password': 'secret123'},
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()['user'], {'username': unique_username, 'role': 'student'})

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
            submission = client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={"name": "robot-motion", "code": code},
            ).json()["item"]

            with patch.object(
                server,
                "execute_robot_program",
                return_value={"status": "completed", "commandsExecuted": 1},
            ) as execute:
                response = client.post(
                    "/api/classroom/run-next",
                    headers=teacher_headers,
                    json={"item_id": submission["id"]},
                )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["item"]["status"], "completed")
            self.assertEqual(response.json()["process"]["commandsExecuted"], 1)
            execute.assert_called_once_with(code)

    def test_run_next_dispatches_each_project_planner_mode_to_its_executor(self):
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
                json={"username": "student1", "password": "student1"},
            ).json()
            teacher_headers = {"Authorization": f"Bearer {teacher['token']}"}
            student_headers = {"Authorization": f"Bearer {student['token']}"}
            base_request = {
                "planner_label": "mode-dispatch-test",
                "planner_waypoints": [{"x": 0, "y": 0}, {"x": 1, "y": 0}],
                "route_variants": {"initial": "robot.walktime(1)"},
                "selected_variant": "initial",
            }
            navigation = {
                "map_id": "classroom",
                "version": "v1",
                "frame_id": "map",
                "planner_mode": "live",
                "waypoints": [{"x": 0, "y": 0}, {"x": 1, "y": 0}],
            }

            manual_item = client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={
                    "name": "manual-planner",
                    "code": "robot.walktime(1)",
                    "planner_request": {**base_request, "planner_mode": "manual"},
                },
            ).json()["item"]
            with patch.object(server, "ensure_sdk_motion_available"), patch.object(
                server,
                "execute_robot_program",
                return_value={"status": "completed", "commandsExecuted": 1},
            ) as execute_manual:
                manual_result = client.post(
                    "/api/classroom/run-next",
                    headers=teacher_headers,
                    json={"item_id": manual_item["id"]},
                )
            execute_manual.assert_called_once_with("robot.walktime(1)")
            self.assertEqual(manual_result.status_code, 200)
            self.assertEqual(manual_result.json()["status"], "completed")

            corrected_item = client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={
                    "name": "sensor-corrected-planner",
                    "code": "robot.walktime(1)",
                    "planner_request": {**base_request, "planner_mode": "sensor_corrected"},
                },
            ).json()["item"]
            corrected = {
                "status": "completed",
                "correctedCode": "robot.walktime(1.1)",
                "checkpoints": [{"error_m": 0.1}],
            }
            with patch.object(
                server, "run_checkpointed_planner", return_value=corrected
            ) as execute_corrected, patch.object(
                server,
                "save_unique_project_for_user",
                return_value={"name": "sensor-corrected-planner"},
            ):
                corrected_result = client.post(
                    "/api/classroom/run-next",
                    headers=teacher_headers,
                    json={"item_id": corrected_item["id"]},
                )
            execute_corrected.assert_called_once()
            self.assertEqual(corrected_result.status_code, 200)
            self.assertEqual(corrected_result.json()["status"], "completed")

            autonomous_item = client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={
                    "name": "autonomous-planner",
                    "code": "",
                    "planner_request": {
                        **base_request,
                        "planner_mode": "autonomous",
                        "navigation": navigation,
                    },
                },
            ).json()["item"]
            operation = {"operation_id": "12345678-1234-1234-1234-123456789abc", "status": "accepted"}
            with patch.object(server, "start_navigation", return_value=operation) as execute_autonomous:
                autonomous_result = client.post(
                    "/api/classroom/run-next",
                    headers=teacher_headers,
                    json={"item_id": autonomous_item["id"]},
                )
            execute_autonomous.assert_called_once()
            self.assertEqual(
                execute_autonomous.call_args.args[0].planner_mode,
                "live",
            )
            self.assertEqual(autonomous_result.status_code, 200)
            self.assertEqual(autonomous_result.json()["status"], "running")

    def test_autonomous_planner_request_rejects_static_nav2_mode(self):
        with self.assertRaisesRegex(HTTPException, "require Live adaptive Nav2"):
            server._validated_planner_request({
                "planner_mode": "autonomous",
                "planner_waypoints": [],
                "route_variants": {},
                "selected_variant": "initial",
                "navigation": {
                    "map_id": "classroom",
                    "version": "v1",
                    "frame_id": "map",
                    "planner_mode": "static",
                    "waypoints": [{"x": 0, "y": 0}],
                },
            })

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
                    json={"item_id": submission["id"]},
                )

            self.assertEqual(response.status_code, 409)
            items = client.get(
                "/api/classroom/queue",
                headers=teacher_headers,
            ).json()["items"]
            self.assertEqual(items[0]["id"], submission["id"])
            self.assertEqual(items[0]["status"], "queued")

    def test_run_next_requires_the_exact_teacher_reviewed_queue_item_id(self):
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
                json={"username": "student1", "password": "student1"},
            ).json()
            teacher_headers = {"Authorization": "Bearer " + teacher["token"]}
            student_headers = {"Authorization": "Bearer " + student["token"]}
            submission = client.post(
                "/api/classroom/submit-code",
                headers=student_headers,
                json={"name": "reviewed-code", "code": "robot.walktime(1)"},
            ).json()["item"]

            with patch.object(server, "execute_robot_program") as execute:
                response = client.post(
                    "/api/classroom/run-next",
                    headers=teacher_headers,
                    json={"item_id": "not-the-reviewed-request"},
                )
            queued_items = server.list_queue_items()

        self.assertEqual(response.status_code, 404)
        execute.assert_not_called()
        self.assertEqual(queued_items[0]["id"], submission["id"])
        self.assertEqual(queued_items[0]["status"], "queued")


class AccountManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_patcher = patch.object(
            server, 'DB_PATH', os.path.join(self.temp_dir.name, 'classroom.db')
        )
        self.db_patcher.start()
        server.SESSION_TOKENS.clear()
        server.init_db()
        self.client = TestClient(app)
        self.teacher = self.client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        self.teacher_headers = {'Authorization': 'Bearer ' + self.teacher['token']}

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def create_student(self, username='class_student', role='student'):
        return self.client.post(
            '/api/classroom/users',
            headers=self.teacher_headers,
            json={'username': username, 'password': 'long-enough-password', 'role': role},
        )

    def test_accounts_api_is_teacher_only_and_public_registration_creates_students_only(self):
        student_created = self.create_student('managed_student')
        self.assertEqual(student_created.status_code, 201)
        student = self.client.post(
            '/api/classroom/login',
            json={'username': 'managed_student', 'password': 'long-enough-password'},
        ).json()
        student_headers = {'Authorization': 'Bearer ' + student['token']}

        self.assertEqual(self.client.get('/api/classroom/users').status_code, 401)
        self.assertEqual(self.client.get('/api/classroom/users', headers=student_headers).status_code, 403)
        self.assertEqual(
            self.client.post(
                '/api/classroom/users',
                headers=student_headers,
                json={'username': 'no_admin', 'password': 'long-enough-password', 'role': 'teacher'},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.delete('/api/classroom/users/managed_student', headers=student_headers).status_code,
            403,
        )
        registration = self.client.post(
            '/api/classroom/register',
            json={
                'username': 'self_registered',
                'password': 'long-enough-password',
                'role': 'teacher',
            },
        )
        self.assertEqual(registration.status_code, 201)
        self.assertEqual(
            registration.json()['user'],
            {'username': 'self_registered', 'role': 'student'},
        )
        self.assertEqual(
            self.client.get(
                '/api/classroom/me',
                headers={'Authorization': 'Bearer ' + registration.json()['token']},
            ).json()['user']['role'],
            'student',
        )

    def test_public_registration_validates_credentials_and_duplicate_username(self):
        invalid_username = self.client.post(
            '/api/classroom/register',
            json={'username': 'ab', 'password': 'long-enough-password'},
        )
        invalid_password = self.client.post(
            '/api/classroom/register',
            json={'username': 'new_student', 'password': 'short'},
        )
        self.assertEqual(invalid_username.status_code, 400)
        self.assertEqual(invalid_password.status_code, 400)

        first = self.client.post(
            '/api/classroom/register',
            json={'username': 'new_student', 'password': 'long-enough-password'},
        )
        duplicate = self.client.post(
            '/api/classroom/register',
            json={'username': 'new_student', 'password': 'long-enough-password'},
        )
        self.assertEqual(first.status_code, 201)
        self.assertEqual(duplicate.status_code, 409)

    def test_creation_validates_username_password_and_duplicate(self):
        for username, password in (
            ('ab', 'long-enough-password'),
            ('invalid name', 'long-enough-password'),
            ('student_ok', 'short'),
            ('student_ok', '        '),
        ):
            response = self.client.post(
                '/api/classroom/users',
                headers=self.teacher_headers,
                json={'username': username, 'password': password},
            )
            self.assertEqual(response.status_code, 400)

        created = self.create_student('student_ok')
        duplicate = self.create_student('student_ok')
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()['user'], {'username': 'student_ok', 'role': 'student'})
        self.assertEqual(duplicate.status_code, 409)

    def test_teacher_can_create_teacher_accounts_but_cannot_assign_other_roles(self):
        created = self.create_student('assistant_teacher', role='teacher')
        invalid_role = self.client.post(
            '/api/classroom/users',
            headers=self.teacher_headers,
            json={
                'username': 'invalid_role',
                'password': 'long-enough-password',
                'role': 'admin',
            },
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()['user'], {'username': 'assistant_teacher', 'role': 'teacher'})
        self.assertEqual(invalid_role.status_code, 400)
        teacher_login = self.client.post(
            '/api/classroom/login',
            json={'username': 'assistant_teacher', 'password': 'long-enough-password'},
        )
        self.assertEqual(teacher_login.status_code, 200)
        self.assertEqual(teacher_login.json()['user']['role'], 'teacher')

    def test_delete_cleans_owned_data_revokes_sessions_and_preserves_shared_map(self):
        self.assertEqual(self.create_student('remove_me').status_code, 201)
        student = self.client.post(
            '/api/classroom/login',
            json={'username': 'remove_me', 'password': 'long-enough-password'},
        ).json()
        server.upsert_program('remove_me', 'saved', 'robot.stand()')
        server.save_project_for_user(
            'remove_me',
            {'name': 'project', 'sceneObjects': [], 'plannerWaypoints': [], 'generatedCode': ''},
        )
        server.insert_queue_item('remove_me', 'submitted', 'robot.stand()')
        conn = server.get_db_connection()
        conn.execute(
            "INSERT INTO navigation_operations (operation_id, status, username, route, updated_at) "
            "VALUES ('nav-done', 'completed', 'remove_me', '{}', 'now')"
        )
        conn.execute(
            "INSERT INTO lidar_scans (job_id, status, username, updated_at) "
            "VALUES ('scan-done', 'completed', 'remove_me', 'now')"
        )
        conn.execute(
            "INSERT INTO shared_lidar_map (id, map_snapshot, pointcloud, published_by, published_at) "
            "VALUES (1, '{}', X'01', 'remove_me', 'now')"
        )
        conn.commit()
        conn.close()

        deleted = self.client.delete(
            '/api/classroom/users/remove_me',
            headers=self.teacher_headers,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(
            self.client.get(
                '/api/classroom/me',
                headers={'Authorization': 'Bearer ' + student['token']},
            ).status_code,
            401,
        )
        conn = server.get_db_connection()
        for table, column in (
            ('users', 'username'),
            ('programs', 'username'),
            ('projects', 'username'),
            ('queue', 'student'),
            ('navigation_operations', 'username'),
            ('lidar_scans', 'username'),
        ):
            self.assertEqual(
                conn.execute(f'SELECT COUNT(*) FROM {table} WHERE {column} = ?', ('remove_me',)).fetchone()[0],
                0,
            )
        self.assertEqual(
            conn.execute('SELECT published_by FROM shared_lidar_map WHERE id = 1').fetchone()[0],
            'deleted account',
        )
        conn.close()

    def test_delete_protects_current_and_last_teacher_and_live_queue_work(self):
        current_account = self.client.delete(
            '/api/classroom/users/teacher',
            headers=self.teacher_headers,
        )
        self.assertEqual(current_account.status_code, 409)
        self.assertIn('currently using', current_account.json()['detail'])

        with self.assertRaises(HTTPException) as last_teacher:
            server.delete_user_account('teacher', 'another_teacher')
        self.assertIn('last teacher', last_teacher.exception.detail)

        self.assertEqual(self.create_student('busy_student').status_code, 201)
        running = server.insert_queue_item('busy_student', 'running', 'robot.stand()')
        server.set_queue_item_status(running['id'], 'running')
        blocked = self.client.delete(
            '/api/classroom/users/busy_student',
            headers=self.teacher_headers,
        )
        self.assertEqual(blocked.status_code, 409)
        self.assertIsNotNone(server.get_user_by_username('busy_student'))

        conn = server.get_db_connection()
        conn.execute(
            "INSERT INTO lidar_scans (job_id, status, username, updated_at) "
            "VALUES ('scan-live', 'scanning', 'busy_student', 'now')"
        )
        conn.commit()
        conn.close()
        server.set_queue_item_status(running['id'], 'completed')
        blocked_scan = self.client.delete(
            '/api/classroom/users/busy_student',
            headers=self.teacher_headers,
        )
        self.assertEqual(blocked_scan.status_code, 409)
        self.assertIsNotNone(server.get_user_by_username('busy_student'))


class ProjectLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_patcher = patch.object(
            server, 'DB_PATH', os.path.join(self.temp_dir.name, 'classroom.db')
        )
        self.db_patcher.start()
        server.SESSION_TOKENS.clear()
        server.init_db()
        self.client = TestClient(app)
        teacher = self.client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        self.teacher_headers = {'Authorization': 'Bearer ' + teacher['token']}
        self.client.post(
            '/api/classroom/users',
            headers=self.teacher_headers,
            json={'username': 'project_student', 'password': 'long-enough-password'},
        )
        student = self.client.post(
            '/api/classroom/login',
            json={'username': 'project_student', 'password': 'long-enough-password'},
        ).json()
        self.student_headers = {'Authorization': 'Bearer ' + student['token']}

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_all_authenticated_users_can_list_and_open_shared_projects(self):
        server.save_project_for_user(
            'project_student',
            {'name': 'student-route', 'generatedCode': 'robot.stand()'},
        )
        server.save_project_for_user(
            'teacher',
            {'name': 'teacher-route', 'generatedCode': 'robot.walktime(1)'},
        )

        for headers in (self.teacher_headers, self.student_headers):
            response = self.client.get('/api/classroom/projects', headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                {(project['username'], project['name']) for project in response.json()['projects']},
                {('project_student', 'student-route'), ('teacher', 'teacher-route')},
            )

        opened = self.client.get(
            '/api/classroom/project',
            params={'owner': 'project_student', 'name': 'student-route'},
            headers=self.teacher_headers,
        )
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(opened.json()['project']['username'], 'project_student')
        self.assertEqual(opened.json()['project']['generatedCode'], 'robot.stand()')

    def test_only_teachers_can_rename_or_delete_any_owner_project(self):
        server.save_project_for_user(
            'project_student',
            {
                'name': 'student-route',
                'generatedCode': 'robot.walktime(1)',
                'plannerMode': 'sensor_corrected',
                'plannerLabel': 'student-route',
                'plannerVariants': {'initial': 'robot.walktime(0.5)', 'corrected': 'robot.walktime(1)'},
            },
        )
        rename_request = {
            'owner': 'project_student',
            'name': 'student-route',
            'new_name': 'reviewed-route',
        }
        self.assertEqual(
            self.client.post(
                '/api/classroom/project/rename',
                json=rename_request,
                headers=self.student_headers,
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                '/api/classroom/project/delete',
                json={'owner': 'project_student', 'name': 'student-route'},
                headers=self.student_headers,
            ).status_code,
            403,
        )
        renamed = self.client.post(
            '/api/classroom/project/rename',
            json=rename_request,
            headers=self.teacher_headers,
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()['project']['name'], 'reviewed-route')
        self.assertEqual(renamed.json()['project']['plannerLabel'], 'reviewed-route')
        self.assertEqual(renamed.json()['project']['plannerVariants']['initial'], 'robot.walktime(0.5)')
        deleted = self.client.post(
            '/api/classroom/project/delete',
            json={'owner': 'project_student', 'name': 'reviewed-route'},
            headers=self.teacher_headers,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(server.list_all_projects(), [])

    def test_execution_project_names_are_unique_and_never_overwrite(self):
        original = server.save_unique_project_for_user(
            'project_student',
            {'name': 'Sensor-corrected route', 'generatedCode': 'robot.walktime(1)'},
        )
        second = server.save_unique_project_for_user(
            'project_student',
            {'name': 'Sensor-corrected route', 'generatedCode': 'robot.walktime(2)'},
        )

        self.assertEqual(original['name'], 'Sensor-corrected route')
        self.assertEqual(second['name'], 'Sensor-corrected route (2)')
        self.assertEqual(
            server.get_project_for_user('project_student', original['name'])['generatedCode'],
            'robot.walktime(1)',
        )

    def test_direct_execution_save_preserves_mode_two_original_and_corrected_routes(self):
        payload = {
            'name': 'checkpoint route',
            'sceneObjects': [{'id': 'box-1'}],
            'plannerWaypoints': [{'x': 0, 'y': 0}, {'x': 1, 'y': 0}],
            'generatedCode': 'robot.walktime(1.2)',
            'plannerMode': 'sensor_corrected',
            'plannerLabel': 'checkpoint route',
            'plannerVariants': {
                'initial': 'robot.walktime(1)',
                'corrected': 'robot.walktime(1.2)',
                'final': 'robot.walktime(1.2)',
            },
            'selectedPlannerVariant': 'corrected',
        }
        denied = self.client.post(
            '/api/classroom/project/save-execution',
            headers=self.student_headers,
            json=payload,
        )
        self.assertEqual(denied.status_code, 403)

        first = self.client.post(
            '/api/classroom/project/save-execution',
            headers=self.teacher_headers,
            json=payload,
        )
        second = self.client.post(
            '/api/classroom/project/save-execution',
            headers=self.teacher_headers,
            json=payload,
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()['project']['plannerVariants']['initial'], 'robot.walktime(1)')
        self.assertEqual(first.json()['project']['plannerVariants']['corrected'], 'robot.walktime(1.2)')
        self.assertEqual(second.json()['project']['name'], 'checkpoint route (2)')

    def test_direct_mode_three_execution_save_has_no_original_variant(self):
        response = self.client.post(
            '/api/classroom/project/save-execution',
            headers=self.teacher_headers,
            json={
                'name': 'autonomous route',
                'plannerWaypoints': [{'x': 0, 'y': 0}, {'x': 1, 'y': 0}],
                'generatedCode': 'robot.stand()\nrobot.walktime(2.5)\nrobot.stand()',
                'plannerMode': 'autonomous',
                'plannerLabel': 'autonomous route',
                'plannerVariants': {
                    'corrected': 'robot.stand()\nrobot.walktime(2.5)\nrobot.stand()',
                    'final': 'robot.stand()\nrobot.walktime(2.5)\nrobot.stand()',
                },
                'selectedPlannerVariant': 'final',
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn('initial', response.json()['project']['plannerVariants'])


class NavigationHomeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_patcher = patch.object(
            server, 'DB_PATH', os.path.join(self.temp_dir.name, 'classroom.db')
        )
        self.db_patcher.start()
        server.SESSION_TOKENS.clear()
        server.init_db()
        self.client = TestClient(app)
        teacher = self.client.post(
            '/api/classroom/login',
            json={'username': 'teacher', 'password': 'teacher'},
        ).json()
        student = self.client.post(
            '/api/classroom/login',
            json={'username': 'student1', 'password': 'student1'},
        ).json()
        self.teacher_headers = {'Authorization': 'Bearer ' + teacher['token']}
        self.student_headers = {'Authorization': 'Bearer ' + student['token']}

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_teacher_captures_fresh_shared_origin_and_students_can_read_it(self):
        status = {
            'ready': True,
            'motionReady': True,
            'map': {'map_id': 'classroom', 'version': 'v4', 'frame_id': 'map'},
            'localization': {
                'ready': True,
                'frame_id': 'map',
                'pose': {'x': 2.5, 'y': -1.25, 'yaw_rad': 1.1},
            },
        }
        with patch.object(server, 'active_navigation_operation', return_value=None), patch.object(
            server, 'active_lidar_scan', return_value=None
        ), patch.object(server, 'robot_status', return_value={'running': False}), patch.object(
            server, 'navigation_bridge_status', return_value=status
        ):
            captured = self.client.post('/api/navigation/home', headers=self.teacher_headers)
        student_read = self.client.get('/api/navigation/home', headers=self.student_headers)
        denied_set = self.client.post('/api/navigation/home', headers=self.student_headers)

        self.assertEqual(captured.status_code, 200)
        self.assertEqual(captured.json()['home']['map_version'], 'v4')
        self.assertEqual(captured.json()['home']['x'], 2.5)
        self.assertEqual(captured.json()['home']['y'], -1.25)
        self.assertEqual(captured.json()['home']['yaw_rad'], 1.1)
        self.assertEqual(student_read.json()['home'], captured.json()['home'])
        self.assertEqual(denied_set.status_code, 403)

    def test_return_home_uses_live_nav_and_accepts_newer_version_same_identity(self):
        server.save_navigation_home(
            {
                'map_id': 'classroom',
                'map_version': 'v4',
                'frame_id': 'map',
                'x': 2.5,
                'y': -1.25,
                'yaw_rad': 1.1,
            },
            'teacher',
        )
        with patch.object(server, 'navigation_map_snapshot', return_value={
            'ready': True,
            'map': {'map_id': 'classroom', 'version': 'v5', 'frame_id': 'map'},
        }), patch.object(server, 'ensure_sdk_motion_available'), patch.object(
            server, 'active_lidar_scan', return_value=None
        ), patch.object(server, 'robot_status', return_value={'running': False}), patch.object(
            server,
            'navigation_start_route',
            return_value={'operation_id': 'home-return-operation', 'status': 'accepted'},
        ) as start_route:
            response = self.client.post('/api/navigation/home/return', headers=self.teacher_headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['operation_id'], 'home-return-operation')
        self.assertEqual(start_route.call_args.args[0:4], (
            'classroom', 'v5', 'map', [{'x': 2.5, 'y': -1.25, 'yaw_rad': 1.1}],
        ))
        self.assertEqual(start_route.call_args.kwargs['planner_mode'], 'live')
        self.assertTrue(start_route.call_args.kwargs['allow_map_version_update'])

    def test_return_home_rejects_different_map_identity_or_frame(self):
        server.save_navigation_home(
            {
                'map_id': 'classroom',
                'map_version': 'v4',
                'frame_id': 'map',
                'x': 2.5,
                'y': -1.25,
                'yaw_rad': 1.1,
            },
            'teacher',
        )
        for current_map in (
            {'map_id': 'different-room', 'version': 'v5', 'frame_id': 'map'},
            {'map_id': 'classroom', 'version': 'v5', 'frame_id': 'odom'},
        ):
            with patch.object(server, 'navigation_map_snapshot', return_value={
                'ready': True,
                'map': current_map,
            }), patch.object(server, 'navigation_start_route') as start_route:
                response = self.client.post('/api/navigation/home/return', headers=self.teacher_headers)
            self.assertEqual(response.status_code, 409)
            start_route.assert_not_called()


if __name__ == '__main__':
    unittest.main()
