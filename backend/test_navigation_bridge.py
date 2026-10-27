import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

try:
    from . import navigation_bridge
    from .navigation_bridge import (
        NavigationBridgeError,
        navigation_bridge_status,
        navigation_cancel_route,
        navigation_map_snapshot,
        navigation_plan_route,
        navigation_start_route,
    )
except ImportError:
    import navigation_bridge
    from navigation_bridge import (
        NavigationBridgeError,
        navigation_bridge_status,
        navigation_cancel_route,
        navigation_map_snapshot,
        navigation_plan_route,
        navigation_start_route,
    )


class NavigationBridgeTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 14, 17, 0, tzinfo=timezone.utc)
        self.status = {
            "ready": True,
            "planner_ready": True,
            "pointcloud_ready": True,
            "pointcloud_age_ms": 80,
            "diagnostics": {
                "topics": {"pointcloud": "/mid360/livox/lidar", "map": "/map"},
                "frames": {"pointcloud": "livox_frame", "map": "map", "base": "base_link"},
                "pointcloud": {
                    "count": 120,
                    "rate_hz": 20.0,
                    "age_ms": 80,
                    "stamp_age_ms": 30.0,
                    "callback_duration_ms": 2.5,
                },
                "map": {
                    "occupied_threshold": 65,
                    "metadata": None,
                    "age_ms": 40,
                },
                "actions": {"navigation": True, "route_preview": True, "spin": True},
                "controller": {
                    "owner": "nav2_via_single_unitree_bridge",
                    "ownership_confirmed": True,
                    "ready": True,
                },
            },
            "estop": {"ready": True, "age_ms": 40, "error": None},
            "robot_health": {"ready": True, "age_ms": 30, "error": None},
            "localization": {
                "ready": True,
                "frame_id": "map",
                "pose": {"x": 1.2, "y": -0.4, "yaw_rad": 0.3},
                "timestamp": (self.now - timedelta(milliseconds=80)).isoformat(),
            },
        }
        self.map_metadata = {
            "map_id": "classroom",
            "version": "v4",
            "frame_id": "map",
            "resolution_m": 0.05,
            "width": 200,
            "height": 150,
            "origin": {"x": -5.0, "y": -3.75, "yaw_rad": 0.0},
            "updated_at": (self.now - timedelta(days=1)).isoformat(),
        }
        self.map_snapshot = {
            **self.map_metadata,
            "data": [0] * (self.map_metadata["width"] * self.map_metadata["height"]),
        }
        self.environment = patch.dict(
            os.environ,
            {
                "G1_NAV_BRIDGE_URL": "http://127.0.0.1:8282",
                "G1_NAV_BRIDGE_TOKEN": "test-bridge-token",
                "G1_NAV_EXECUTION_ENABLED": "1",
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def mock_bridge(self, status=None, map_metadata=None):
        payloads = {
            "/api/v1/status": status or self.status,
            "/api/v1/map/metadata": map_metadata or self.map_metadata,
            "/api/v1/map": self.map_snapshot,
        }

        def get(url, **kwargs):
            path = url.removeprefix("http://127.0.0.1:8282")
            return SimpleNamespace(status_code=200, json=lambda: payloads[path])

        return patch.object(navigation_bridge.httpx, "get", side_effect=get)

    def test_valid_bridge_status_and_map_metadata_are_reported_read_only(self):
        with self.mock_bridge():
            result = navigation_bridge_status(now=self.now)
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["ready"])
        self.assertTrue(result["motionReady"])
        self.assertTrue(result["estop"]["ready"])
        self.assertTrue(result["robotHealth"]["ready"])
        self.assertEqual(result["localization"]["frame_id"], "map")
        self.assertEqual(result["localization"]["age_ms"], 80)
        self.assertEqual(result["map"]["version"], "v4")
        self.assertEqual(result["map"]["width"], 200)
        self.assertEqual(result["diagnostics"]["topics"]["pointcloud"], "/mid360/livox/lidar")
        self.assertEqual(result["diagnostics"]["pointcloud"]["rate_hz"], 20.0)
        self.assertTrue(result["diagnostics"]["actions"]["spin"])
        self.assertTrue(result["diagnostics"]["controller"]["ready"])
        self.assertTrue(result["diagnostics"]["execution_enabled"])

    def test_live_obstacle_layer_requires_fresh_points_in_the_localization_frame(self):
        status = {
            **self.status,
            "live_avoidance_ready": True,
            "live_obstacles": {
                "ready": True,
                "frame_id": "map",
                "age_ms": 120,
                "points": [{"x": 1.0, "y": -0.5}],
            },
        }
        with self.mock_bridge(status=status):
            result = navigation_bridge_status(now=self.now)
        self.assertTrue(result["liveAvoidanceReady"])
        self.assertEqual(result["liveObstacles"]["points"], [{"x": 1.0, "y": -0.5}])

        status["live_obstacles"]["age_ms"] = 2_000
        with self.mock_bridge(status=status):
            result = navigation_bridge_status(now=self.now)
        self.assertFalse(result["liveAvoidanceReady"])
        self.assertEqual(result["liveObstacles"]["points"], [])

    def test_unconfirmed_or_competing_controller_ownership_disables_motion(self):
        for controller in (
            {
                "owner": "unverified",
                "ownership_confirmed": False,
                "ready": False,
            },
            {
                "owner": "another_controller",
                "ownership_confirmed": True,
                "ready": True,
            },
        ):
            status = {
                **self.status,
                "diagnostics": {
                    **self.status["diagnostics"],
                    "controller": controller,
                },
            }
            with self.subTest(controller=controller), self.mock_bridge(status=status):
                result = navigation_bridge_status(now=self.now)
            self.assertTrue(result["ready"])
            self.assertFalse(result["motionReady"])
            self.assertFalse(result["diagnostics"]["controller"]["ready"])
            self.assertIn("not commissioned", result["diagnostics"]["controller"]["error"])

    def test_execution_disabled_keeps_map_ready_but_disables_scan_and_navigation(self):
        with patch.dict(os.environ, {"G1_NAV_EXECUTION_ENABLED": "0"}), self.mock_bridge():
            result = navigation_bridge_status(now=self.now)
        self.assertTrue(result["ready"])
        self.assertFalse(result["motionReady"])
        self.assertFalse(result["diagnostics"]["execution_enabled"])
        with patch.dict(os.environ, {"G1_NAV_EXECUTION_ENABLED": "0"}), self.assertRaisesRegex(
            NavigationBridgeError, "Physical scan execution is disabled"
        ):
            navigation_bridge.navigation_start_scan()

    def test_missing_estop_signal_keeps_preview_ready_but_disables_motion(self):
        status_without_estop = {key: value for key, value in self.status.items() if key != "estop"}
        with self.mock_bridge(status=status_without_estop):
            result = navigation_bridge_status(now=self.now)
        self.assertTrue(result["ready"])
        self.assertFalse(result["motionReady"])
        self.assertFalse(result["estop"]["ready"])
        self.assertIn("missing, stale, or invalid", result["estop"]["error"])

    def test_stale_or_invalid_estop_age_disables_motion_but_keeps_map_readiness(self):
        for estop in (
            {"ready": True, "age_ms": 5_001, "error": None},
            {"ready": True, "age_ms": float("nan"), "error": None},
            {"ready": True, "age_ms": True, "error": None},
            {"ready": True, "age_ms": 50, "error": "safety circuit unhealthy"},
        ):
            with self.subTest(estop=estop), self.mock_bridge(status={
                **self.status,
                "estop": estop,
            }):
                result = navigation_bridge_status(now=self.now)
            self.assertTrue(result["ready"])
            self.assertFalse(result["motionReady"])
            self.assertFalse(result["estop"]["ready"])

    def test_missing_robot_health_keeps_preview_ready_but_disables_motion(self):
        status_without_robot_health = {
            key: value for key, value in self.status.items() if key != "robot_health"
        }
        with self.mock_bridge(status=status_without_robot_health):
            result = navigation_bridge_status(now=self.now)
        self.assertTrue(result["ready"])
        self.assertFalse(result["motionReady"])
        self.assertFalse(result["robotHealth"]["ready"])

    def test_bridge_requests_are_authenticated_and_do_not_redirect(self):
        with self.mock_bridge(), patch.object(navigation_bridge.httpx, "get", wraps=navigation_bridge.httpx.get) as request:
            navigation_bridge_status(now=self.now)
        self.assertEqual(request.call_count, 2)
        for call in request.call_args_list:
            self.assertEqual(call.kwargs["headers"]["Authorization"], "Bearer test-bridge-token")
            self.assertFalse(call.kwargs["follow_redirects"])
            self.assertEqual(call.kwargs["timeout"], navigation_bridge.BRIDGE_TIMEOUT_SECONDS)

    def test_missing_bridge_configuration_reports_unavailable(self):
        with patch.dict(os.environ, {"G1_NAV_BRIDGE_URL": "", "G1_NAV_BRIDGE_TOKEN": ""}):
            result = navigation_bridge_status(now=self.now)
        self.assertFalse(result["ready"])
        self.assertEqual(result["status"], "unavailable")
        self.assertIn("not configured", result["error"])

    def test_insecure_non_loopback_bridge_is_rejected(self):
        with patch.dict(os.environ, {"G1_NAV_BRIDGE_URL": "http://192.168.1.8:8282"}):
            result = navigation_bridge_status(now=self.now)
        self.assertFalse(result["ready"])
        self.assertIn("HTTPS unless", result["error"])

    def test_stale_localization_and_wrong_map_frame_are_rejected(self):
        stale = {
            **self.status,
            "localization": {
                **self.status["localization"],
                "timestamp": (self.now - timedelta(seconds=2)).isoformat(),
            },
        }
        with self.mock_bridge(status=stale):
            stale_result = navigation_bridge_status(now=self.now)
        self.assertFalse(stale_result["ready"])
        self.assertIn("stale", stale_result["error"])

        wrong_map = {**self.map_metadata, "frame_id": "odom"}
        with self.mock_bridge(map_metadata=wrong_map):
            frame_result = navigation_bridge_status(now=self.now)
        self.assertFalse(frame_result["ready"])
        self.assertIn("does not match", frame_result["error"])

    def test_missing_or_stale_pointcloud_fails_navigation_readiness(self):
        for sensor_status in (
            {**self.status, "pointcloud_ready": False},
            {**self.status, "pointcloud_age_ms": 1_501},
        ):
            with self.mock_bridge(status=sensor_status):
                result = navigation_bridge_status(now=self.now)
            self.assertFalse(result["ready"])

    def test_map_dimensions_are_bounded(self):
        too_large = {**self.map_metadata, "width": 100_000, "height": 100_000}
        with self.mock_bridge(map_metadata=too_large):
            result = navigation_bridge_status(now=self.now)
        self.assertFalse(result["ready"])
        self.assertIn("dimensions", result["error"])

    def test_map_snapshot_validates_complete_bounded_occupancy_grid(self):
        with self.mock_bridge():
            result = navigation_map_snapshot(now=self.now)
        self.assertTrue(result["ready"])
        self.assertEqual(len(result["data"]), 30_000)

        malformed = {**self.map_snapshot, "data": [0, 100]}
        with self.mock_bridge(), patch.object(
            navigation_bridge,
            "_get_json",
            side_effect=[self.status, malformed],
        ):
            invalid = navigation_map_snapshot(now=self.now)
        self.assertFalse(invalid["ready"])
        self.assertIn("length does not match", invalid["error"])

    def test_map_snapshot_rejects_values_outside_occupancy_range(self):
        small_status = self.status
        small_map = {**self.map_metadata, "width": 2, "height": 2}
        invalid_map = {**small_map, "data": [0, 100, -2, 50]}
        with self.mock_bridge(), patch.object(
            navigation_bridge,
            "_get_json",
            side_effect=[small_status, invalid_map],
        ):
            result = navigation_map_snapshot(now=self.now)
        self.assertFalse(result["ready"])
        self.assertIn("integers from -1 through 100", result["error"])

    def test_map_snapshot_preserves_origin_rotation_and_metadata(self):
        rotated_map = {
            **self.map_metadata,
            "origin": {"x": -3.0, "y": 2.0, "yaw_rad": 0.5},
            "data": [0] * 30_000,
        }
        with self.mock_bridge(), patch.object(
            navigation_bridge,
            "_get_json",
            side_effect=[self.status, rotated_map],
        ):
            result = navigation_map_snapshot(now=self.now)
        self.assertTrue(result["ready"])
        self.assertAlmostEqual(result["map"]["origin"]["yaw_rad"], 0.5)

    def test_map_snapshot_requires_ready_localization_and_bounds_payload_size(self):
        unavailable_status = {**self.status, "planner_ready": False}
        with self.mock_bridge(status=unavailable_status):
            unavailable = navigation_map_snapshot(now=self.now)
        self.assertFalse(unavailable["ready"])
        self.assertIn("not ready", unavailable["error"])

        oversized = {
            **self.map_metadata,
            "width": 600,
            "height": 500,
            "data": [0] * 300_000,
        }
        with self.mock_bridge(), patch.object(
            navigation_bridge,
            "_get_json",
            side_effect=[self.status, oversized],
        ):
            bounded = navigation_map_snapshot(now=self.now)
        self.assertFalse(bounded["ready"])
        self.assertIn("preview limit", bounded["error"])

    def test_route_start_requires_enabled_execution_and_current_free_map_targets(self):
        route = [{"x": -4.975, "y": -3.725}]
        operation_id = "12345678-1234-1234-1234-123456789abc"
        with self.mock_bridge(), patch.dict(os.environ, {"G1_NAV_EXECUTION_ENABLED": "0"}):
            with self.assertRaisesRegex(NavigationBridgeError, "disabled"):
                navigation_start_route(
                    "classroom", "v4", "map", route, operation_id, now=self.now
                )

        accepted = {
            "operation_id": "12345678-1234-1234-1234-123456789abc",
            "status": "accepted",
        }
        with self.mock_bridge(), patch.dict(os.environ, {"G1_NAV_EXECUTION_ENABLED": "1"}), patch.object(
            navigation_bridge.httpx,
            "post",
            return_value=SimpleNamespace(status_code=202, json=lambda: accepted),
        ) as request:
            result = navigation_start_route(
                "classroom", "v4", "map", route, operation_id, now=self.now
            )
        self.assertEqual(result["operation_id"], accepted["operation_id"])
        self.assertEqual(
            request.call_args.kwargs["json"]["goals"],
            [{"x": route[0]["x"], "y": route[0]["y"], "yaw_rad": 0.0}],
        )

        with self.mock_bridge(), patch.dict(os.environ, {"G1_NAV_EXECUTION_ENABLED": "1"}):
            with self.assertRaisesRegex(NavigationBridgeError, "map changed"):
                navigation_start_route(
                    "classroom", "old-version", "map", route, operation_id, now=self.now
                )
            with self.assertRaisesRegex(NavigationBridgeError, "outside the current map"):
                navigation_start_route(
                    "classroom", "v4", "map", [{"x": 100, "y": 100}],
                    operation_id,                     now=self.now,
                )
        occupied_map = {
            **self.map_metadata,
            "width": 2,
            "height": 2,
            "origin": {"x": 0, "y": 0, "yaw_rad": 0},
        }
        occupied = {**occupied_map, "data": [100, 0, 0, 0]}
        with self.mock_bridge(), patch.dict(os.environ, {"G1_NAV_EXECUTION_ENABLED": "1"}), patch.object(
            navigation_bridge,
            "_get_json",
            side_effect=[self.status, occupied],
        ):
            with self.assertRaisesRegex(NavigationBridgeError, "known free space"):
                navigation_start_route(
                    "classroom", "v4", "map", [{"x": 0.025, "y": 0.025}],
                    operation_id, now=self.now,
                )

        status_without_estop = {key: value for key, value in self.status.items() if key != "estop"}
        with self.mock_bridge(status=status_without_estop), patch.dict(
            os.environ, {"G1_NAV_EXECUTION_ENABLED": "1"}
        ), patch.object(navigation_bridge.httpx, "post") as motion_request:
            with self.assertRaisesRegex(NavigationBridgeError, "E-stop health is missing, stale, or invalid"):
                navigation_start_route(
                    "classroom", "v4", "map", route, operation_id, now=self.now
                )
        motion_request.assert_not_called()

    def test_route_preview_validates_targets_and_returns_bounded_map_frame_path(self):
        plan = {
            "map_id": "classroom",
            "version": "v4",
            "frame_id": "map",
            "planner_id": "GridBased",
            "path": [{"x": -0.5, "y": 0.25}, {"x": 0.0, "y": 0.5}],
        }
        with patch.object(navigation_bridge, "navigation_map_snapshot", return_value={
            "ready": True,
            "map": self.map_metadata,
            "data": self.map_snapshot["data"],
        }), patch.object(navigation_bridge, "_bridge_configuration", return_value=(
            "http://127.0.0.1:8282", "test-bridge-token"
        )), patch.dict(os.environ, {"G1_NAV_EXECUTION_ENABLED": "0"}), patch.object(
            navigation_bridge, "_post_json", return_value=plan
        ) as post:
            result = navigation_plan_route(
                "classroom", "v4", "map", [{"x": 0.0, "y": 0.0}], now=self.now
            )

        self.assertEqual(result["path"], plan["path"])
        self.assertEqual(result["planner_id"], "GridBased")
        self.assertEqual(post.call_args.args[2], "/api/v1/navigation/plan")
        self.assertEqual(post.call_args.args[3]["goals"], [
            {"x": 0.0, "y": 0.0, "yaw_rad": 0.0},
        ])
        self.assertEqual(post.call_args.kwargs["timeout"], navigation_bridge.NAVIGATION_PLAN_TIMEOUT_SECONDS)

    def test_route_preview_rejects_unmapped_targets_before_contacting_gateway(self):
        with patch.object(navigation_bridge, "navigation_map_snapshot", return_value={
            "ready": True,
            "map": self.map_metadata,
            "data": self.map_snapshot["data"],
        }), patch.object(navigation_bridge, "_bridge_configuration"), patch.object(
            navigation_bridge, "_post_json"
        ) as post:
            with self.assertRaisesRegex(NavigationBridgeError, "outside the current map"):
                navigation_plan_route(
                    "classroom", "v4", "map", [{"x": 100.0, "y": 100.0}], now=self.now
                )
        post.assert_not_called()

    def test_static_scan_route_validates_saved_and_live_maps_but_plans_on_current_version(self):
        static_map = {
            **self.map_metadata,
            "version": "published-scan-v3",
        }
        static_snapshot = {"ready": True, "map": static_map, "data": self.map_snapshot["data"]}
        plan = {
            "map_id": "classroom",
            "version": "v4",
            "frame_id": "map",
            "planner_id": "GridBased",
            "path": [{"x": 0.0, "y": 0.0}],
        }
        with patch.object(
            navigation_bridge,
            "navigation_map_snapshot",
            return_value={
                "ready": True,
                "map": self.map_metadata,
                "data": self.map_snapshot["data"],
            },
        ), patch.object(navigation_bridge, "_bridge_configuration"), patch.object(
            navigation_bridge, "_post_json", return_value=plan
        ) as post:
            result = navigation_plan_route(
                "classroom",
                "published-scan-v3",
                "map",
                [{"x": 0.0, "y": 0.0}],
                planner_mode="static",
                static_map_snapshot=static_snapshot,
            )

        self.assertEqual(result["version"], "published-scan-v3")
        self.assertEqual(post.call_args.args[3]["version"], "v4")
        self.assertEqual(post.call_args.args[3]["planner_mode"], "static")

    def test_static_scan_route_rejects_waypoint_blocked_on_current_live_map(self):
        static_map = {**self.map_metadata, "version": "published-scan-v3"}
        static_snapshot = {"ready": True, "map": static_map, "data": self.map_snapshot["data"]}
        live_snapshot = {
            **self.map_snapshot,
            "data": list(self.map_snapshot["data"]),
        }
        waypoint_index = 75 * self.map_metadata["width"] + 100
        live_snapshot["data"][waypoint_index] = 100
        with patch.object(
            navigation_bridge,
            "navigation_map_snapshot",
            return_value={
                "ready": True,
                "map": self.map_metadata,
                "data": live_snapshot["data"],
            },
        ), patch.object(navigation_bridge, "_bridge_configuration"), patch.object(
            navigation_bridge, "_post_json"
        ) as post:
            with self.assertRaisesRegex(NavigationBridgeError, "known free space"):
                navigation_plan_route(
                    "classroom",
                    "published-scan-v3",
                    "map",
                    [{"x": 0.0, "y": 0.0}],
                    planner_mode="static",
                    static_map_snapshot=static_snapshot,
                )
        post.assert_not_called()

    def test_live_adaptive_route_requires_fresh_commissioned_costmap(self):
        with patch.object(
            navigation_bridge,
            "navigation_map_snapshot",
            return_value={
                "ready": True,
                "map": self.map_metadata,
                "data": self.map_snapshot["data"],
            },
        ), patch.object(navigation_bridge, "_bridge_configuration"), patch.object(
            navigation_bridge, "_post_json"
        ) as post:
            with self.assertRaisesRegex(NavigationBridgeError, "commissioned obstacle avoidance"):
                navigation_plan_route(
                    "classroom",
                    "v4",
                    "map",
                    [{"x": 0.0, "y": 0.0}],
                    planner_mode="live",
                )
        post.assert_not_called()

    def test_route_cancellation_requires_valid_operation_and_terminal_contract(self):
        operation_id = "12345678-1234-1234-1234-123456789abc"
        response = {"operation_id": operation_id, "status": "cancel_requested"}
        with patch.object(
            navigation_bridge.httpx,
            "post",
            return_value=SimpleNamespace(status_code=200, json=lambda: response),
        ) as request:
            self.assertEqual(navigation_cancel_route(operation_id), response)
        self.assertTrue(request.call_args.args[0].endswith(f"/{operation_id}/cancel"))
        with self.assertRaisesRegex(NavigationBridgeError, "ID is invalid"):
            navigation_cancel_route("../../other")

    def test_scan_start_and_status_validate_job_contract(self):
        job_id = "12345678-1234-1234-1234-123456789abc"
        with patch.object(
            navigation_bridge,
            "_post_json",
            return_value={
                "job_id": job_id,
                "status": "scanning",
                "rotation_status": "submitted",
                "rotation_radians": 0.0,
                "point_count": 0,
                "preview_points": [],
            },
        ) as start:
            result = navigation_bridge.navigation_start_scan()
        self.assertEqual(result["status"], "scanning")
        self.assertEqual(result["rotation_status"], "submitted")
        start.assert_called_once()

        with patch.object(
            navigation_bridge,
            "_get_json",
            return_value={
                "job_id": job_id,
                "status": "scanning",
                "rotation_status": "rotating",
                "rotation_radians": 3.14,
                "point_count": 1250,
            },
        ):
            status = navigation_bridge.navigation_scan_status(job_id)
        self.assertEqual(status["point_count"], 1250)
        self.assertEqual(status["rotation_status"], "rotating")
        with patch.object(
            navigation_bridge,
            "_get_json",
            return_value={
                "job_id": job_id,
                "status": "scanning",
                "rotation_status": "rotating",
                "point_count": -1,
            },
        ):
            with self.assertRaisesRegex(NavigationBridgeError, "point count"):
                navigation_bridge.navigation_scan_status(job_id)

        with patch.object(
            navigation_bridge,
            "_get_json",
            return_value={
                "job_id": job_id,
                "status": "scanning",
                "rotation_status": "rotating",
                "rotation_radians": -6.283185307179586,
            },
        ):
            status = navigation_bridge.navigation_scan_status(job_id)
        self.assertEqual(status["rotation_radians"], -6.283185307179586)

        with patch.object(
            navigation_bridge,
            "_get_json",
            return_value={
                "job_id": job_id,
                "status": "scanning",
                "rotation_status": "rotating",
                "rotation_radians": float("nan"),
            },
        ):
            with self.assertRaisesRegex(NavigationBridgeError, "rotation measurement"):
                navigation_bridge.navigation_scan_status(job_id)

    def test_scan_cancel_can_report_pending_until_nav2_confirms_terminal_stop(self):
        job_id = "12345678-1234-1234-1234-123456789abc"
        response = {
            "job_id": job_id,
            "status": "scanning",
            "rotation_status": "cancel_requested",
            "rotation_radians": 1.2,
            "point_count": 30,
            "preview_points": [],
        }
        with patch.object(navigation_bridge, "_post_json", return_value=response):
            result = navigation_bridge.navigation_cancel_scan(job_id)
        self.assertEqual(result["status"], "scanning")
        self.assertEqual(result["rotation_status"], "cancel_requested")

    def test_scan_pointcloud_requires_finite_map_frame_points_and_timestamp(self):
        job_id = "12345678-1234-1234-1234-123456789abc"
        payload = {
            "job_id": job_id,
            "frame_id": "map",
            "captured_at": self.now.isoformat(),
            "points": [{"x": 1.0, "y": -2.0, "z": 0.4}],
        }
        with patch.object(navigation_bridge, "_get_json", return_value=payload):
            cloud = navigation_bridge.navigation_scan_pointcloud(job_id)
        self.assertEqual(cloud["point_count"], 1)
        self.assertEqual(cloud["points"][0]["z"], 0.4)

        invalid = {**payload, "points": [{"x": float("nan"), "y": 0, "z": 0}]}
        with patch.object(navigation_bridge, "_get_json", return_value=invalid):
            with self.assertRaisesRegex(NavigationBridgeError, "finite number"):
                navigation_bridge.navigation_scan_pointcloud(job_id)

    def test_completed_scan_map_is_validated_as_a_metric_snapshot(self):
        job_id = "12345678-1234-1234-1234-123456789abc"
        payload = {
            **self.map_metadata,
            "width": 2,
            "height": 2,
            "data": [0, 100, -1, 50],
        }
        with patch.object(navigation_bridge, "_get_json", return_value=payload):
            snapshot = navigation_bridge.navigation_scan_map_snapshot(job_id)
        self.assertEqual(snapshot["map"]["resolution_m"], 0.05)
        self.assertEqual(snapshot["data"], [0, 100, -1, 50])

        with patch.object(
            navigation_bridge,
            "_get_json",
            return_value={**payload, "data": [0]},
        ):
            with self.assertRaisesRegex(NavigationBridgeError, "length does not match"):
                navigation_bridge.navigation_scan_map_snapshot(job_id)

    def test_completed_navigation_status_preserves_validated_executed_feedback_trace(self):
        operation_id = "12345678-1234-1234-1234-123456789abc"
        payload = {
            "operation_id": operation_id,
            "status": "succeeded",
            "path_trace": [
                {"x": 0.0, "y": 0.0, "yaw_rad": 0.0, "frame_id": "map"},
                {"x": 1.0, "y": 0.5, "yaw_rad": 0.2, "frame_id": "map"},
            ],
        }
        with patch.object(navigation_bridge, "_bridge_credentials", return_value=("https://bridge", "token")), patch.object(
            navigation_bridge, "_get_json", return_value=payload
        ):
            result = navigation_bridge.navigation_operation_status(operation_id)
        self.assertEqual(result["path_trace"], payload["path_trace"])
        self.assertFalse(result["path_trace_truncated"])

        invalid = {
            **payload,
            "path_trace": [
                {"x": float("nan"), "y": 0.0, "yaw_rad": 0.0, "frame_id": "map"},
            ],
        }
        with patch.object(navigation_bridge, "_bridge_credentials", return_value=("https://bridge", "token")), patch.object(
            navigation_bridge, "_get_json", return_value=invalid
        ):
            with self.assertRaisesRegex(NavigationBridgeError, "finite number"):
                navigation_bridge.navigation_operation_status(operation_id)


if __name__ == "__main__":
    unittest.main()
