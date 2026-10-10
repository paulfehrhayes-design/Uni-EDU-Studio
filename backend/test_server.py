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
    def test_github_proxy_requires_url(self):
        client = TestClient(app)
        response = client.get('/api/github-proxy')
        self.assertEqual(response.status_code, 400)

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
