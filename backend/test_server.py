import os
import unittest
import uuid

from fastapi.testclient import TestClient

from server import app


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
        self.assertGreaterEqual(len(queue.json()['items']), 1)
        self.assertEqual(queue.json()['items'][0]['status'], 'queued')

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


if __name__ == '__main__':
    unittest.main()
