from __future__ import annotations

import asyncio
import json
import math
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import uuid
import zlib
import logging
import subprocess
from datetime import datetime, timezone
from typing import Dict, List, Optional, Literal
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Header, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
try:
    from .g1_robot import clear_robot_stop_request, connect_robot, execute_robot_program, robot_status, stop_robot
    from .duet_robot import (
        DuetControllerError,
        DuetProgramValidationError,
        connect_controller as connect_duet_controller,
        controller_owns_motion as duet_controller_owns_motion,
        controller_status as duet_controller_status,
        disconnect_controller as disconnect_duet_controller,
        execute_program as execute_duet_program,
        stop_controller as stop_duet_controller,
    )
    from .camera_discovery import discover_camera_sources
    from .lidar_distance import distance_sensor_status
    from .sensor_calibration import calibration_status
    from .sensor_discovery import discover_sensors
    from .navigation_bridge import (
        NavigationBridgeError,
        navigation_bridge_status,
        navigation_cancel_route,
        navigation_cancel_scan,
        navigation_complete_scan,
        navigation_map_snapshot,
        navigation_operation_status,
        navigation_plan_route,
        navigation_scan_pointcloud,
        navigation_scan_map_snapshot,
        navigation_scan_status,
        navigation_start_scan,
        navigation_start_route,
    )
except ImportError:
    from g1_robot import clear_robot_stop_request, connect_robot, execute_robot_program, robot_status, stop_robot
    from duet_robot import (
        DuetControllerError,
        DuetProgramValidationError,
        connect_controller as connect_duet_controller,
        controller_owns_motion as duet_controller_owns_motion,
        controller_status as duet_controller_status,
        disconnect_controller as disconnect_duet_controller,
        execute_program as execute_duet_program,
        stop_controller as stop_duet_controller,
    )
    from camera_discovery import discover_camera_sources
    from lidar_distance import distance_sensor_status
    from sensor_calibration import calibration_status
    from sensor_discovery import discover_sensors
    from navigation_bridge import (
        NavigationBridgeError,
        navigation_bridge_status,
        navigation_cancel_route,
        navigation_cancel_scan,
        navigation_complete_scan,
        navigation_map_snapshot,
        navigation_operation_status,
        navigation_plan_route,
        navigation_scan_pointcloud,
        navigation_scan_map_snapshot,
        navigation_scan_status,
        navigation_start_scan,
        navigation_start_route,
    )

# 确保 unitree_sdk2py 在路径中
# 假设 backend 文件夹与 unitree_sdk2py 同级，或者已安装
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PROJECT_ROOT = os.path.dirname(BASE_DIR)
G1_URDF_PATH = os.path.join(PROJECT_ROOT, "g1_23dof.urdf.txt")

app = FastAPI()
logger = logging.getLogger(__name__)

# 允许跨域（方便开发调试）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)

@app.middleware("http")
async def prevent_stale_frontend_index(request, call_next):
    response = await call_next(request)
    if request.url.path in {"/", "/index.html"}:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

class CodeRequest(BaseModel):
    code: str


class DuetProgramRequest(BaseModel):
    code: str


class ConnectRobotRequest(BaseModel):
    interface: Optional[str] = None

class HFTextMotionRequest(BaseModel):
    prompt: str

class LoginRequest(BaseModel):
    username: str
    password: str
    role: Optional[str] = None

class SaveCodeRequest(BaseModel):
    name: str
    code: str


class QueueSubmissionRequest(SaveCodeRequest):
    controller_version: Literal["legacy", "duet"] = "legacy"
    planner_request: Optional[dict] = None


class QueueRunRequest(BaseModel):
    item_id: str


class ProjectSaveRequest(BaseModel):
    name: str = "default"
    sceneObjects: List[dict] = []
    plannerWaypoints: List[dict] = []
    generatedCode: str = ""
    duetCode: Optional[str] = None
    plannerMode: Optional[str] = None
    plannerLabel: Optional[str] = None
    plannerVariants: Optional[dict] = None

class NavigationStartRequest(BaseModel):
    map_id: str
    version: str
    frame_id: str
    waypoints: List[dict]
    planner_mode: Optional[Literal["static", "live"]] = None


class CheckpointedPlannerRequest(BaseModel):
    waypoints: List[dict]


class PlannerSettingsRequest(BaseModel):
    active_mode: Literal["manual", "sensor_corrected", "autonomous"]


class LidarScanStartRequest(BaseModel):
    confirm_rotation: bool


class SharedLidarSettingsRequest(BaseModel):
    show_shared_overlay: bool


class SensorServiceRequest(BaseModel):
    sensor_id: Literal["lidar_driver", "lidar_provider"]
    operation: Literal["start", "stop", "restart", "repair"]


class LidarMapPublishRequest(BaseModel):
    job_id: str

class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "student"

DB_PATH = os.path.join(os.path.dirname(__file__), "classroom.db")
DEFAULT_USERS: Dict[str, Dict[str, str]] = {
    "teacher": {"username": "teacher", "password": "teacher", "role": "teacher"},
    "student1": {"username": "student1", "password": "student1", "role": "student"},
    "student2": {"username": "student2", "password": "student2", "role": "student"},
}
SESSION_TOKENS: Dict[str, str] = {}
_QUEUE_RUN_LOCK = threading.Lock()
_MOTION_START_LOCK = threading.Lock()
_NAVIGATION_ACTIVE_STATES = ("accepted", "starting", "running", "cancel_requested", "uncertain")
_WEBSOCKET_TICKETS: Dict[str, tuple[str, float]] = {}
_WEBSOCKET_TICKET_LOCK = threading.Lock()


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def record_navigation_map_version(metadata: dict):
    conn = get_db_connection()
    conn.execute(
        """
        INSERT OR IGNORE INTO navigation_map_versions (map_id, version, metadata)
        VALUES (?, ?, ?)
        """,
        (metadata["map_id"], metadata["version"], json.dumps(metadata, separators=(",", ":"))),
    )
    conn.commit()
    rows = conn.execute(
        """
        SELECT map_id, version, metadata, first_seen_at
        FROM navigation_map_versions
        ORDER BY first_seen_at DESC, map_id ASC, version DESC
        LIMIT 20
        """
    ).fetchall()
    conn.close()
    return [
        {
            "map_id": row["map_id"],
            "version": row["version"],
            "metadata": json.loads(row["metadata"]),
            "first_seen_at": row["first_seen_at"],
        }
        for row in rows
    ]


def list_navigation_map_versions():
    conn = get_db_connection()
    rows = conn.execute(
        """
        SELECT map_id, version, metadata, first_seen_at
        FROM navigation_map_versions
        ORDER BY first_seen_at DESC, map_id ASC, version DESC
        LIMIT 20
        """
    ).fetchall()
    conn.close()
    return [
        {
            "map_id": row["map_id"],
            "version": row["version"],
            "metadata": json.loads(row["metadata"]),
            "first_seen_at": row["first_seen_at"],
        }
        for row in rows
    ]


def save_navigation_operation(operation: dict, username: str, route: dict) -> None:
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO navigation_operations (
            operation_id, status, username, route, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(operation_id)
        DO UPDATE SET status = excluded.status, username = excluded.username, route = excluded.route, updated_at = excluded.updated_at
        """,
        (
            operation["operation_id"],
            operation["status"],
            username,
            json.dumps(route, separators=(",", ":")),
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    conn.commit()
    conn.close()


def update_navigation_operation(operation_id: str, status: str) -> None:
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO navigation_operations (operation_id, status, username, route, updated_at)
        VALUES (?, ?, 'teacher', '{}', ?)
        ON CONFLICT(operation_id)
        DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
        """,
        (operation_id, status, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()


def save_lidar_scan(
    job_id: str,
    status: str,
    username: str,
    map_snapshot: Optional[dict] = None,
    pointcloud: Optional[dict] = None,
    rotation_status: Optional[str] = None,
    rotation_radians: Optional[float] = None,
    error: Optional[str] = None,
) -> None:
    map_json = json.dumps(map_snapshot, separators=(",", ":")) if map_snapshot else None
    points_blob = (
        zlib.compress(json.dumps(pointcloud, separators=(",", ":")).encode("utf-8"), level=6)
        if pointcloud else None
    )
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO lidar_scans (
            job_id, status, username, map_snapshot, pointcloud,
            rotation_status, rotation_radians, error, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
            status = excluded.status,
            map_snapshot = COALESCE(excluded.map_snapshot, lidar_scans.map_snapshot),
            pointcloud = COALESCE(excluded.pointcloud, lidar_scans.pointcloud),
            rotation_status = COALESCE(excluded.rotation_status, lidar_scans.rotation_status),
            rotation_radians = COALESCE(excluded.rotation_radians, lidar_scans.rotation_radians),
            error = COALESCE(excluded.error, lidar_scans.error),
            updated_at = excluded.updated_at
        """,
        (
            job_id, status, username, map_json, points_blob,
            rotation_status, rotation_radians, error,
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    if status in {"completed", "failed", "canceled"}:
        conn.execute(
            """
            DELETE FROM lidar_scans
            WHERE job_id IN (
                SELECT job_id FROM lidar_scans
                WHERE status IN ('completed', 'failed', 'canceled')
                ORDER BY updated_at DESC
                LIMIT -1 OFFSET 20
            )
            """
        )
    conn.commit()
    conn.close()


def get_lidar_scan(job_id: str):
    conn = get_db_connection()
    row = conn.execute(
        "SELECT job_id, status, username, map_snapshot, pointcloud, updated_at, rotation_status, rotation_radians, error "
        "FROM lidar_scans WHERE job_id = ?",
        (job_id,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    pointcloud = None
    if row["pointcloud"] is not None:
        pointcloud = json.loads(zlib.decompress(row["pointcloud"]).decode("utf-8"))
    return {
        "job_id": row["job_id"],
        "status": row["status"],
        "username": row["username"],
        "map_snapshot": json.loads(row["map_snapshot"]) if row["map_snapshot"] else None,
        "pointcloud": pointcloud,
        "updated_at": row["updated_at"],
        "rotation_status": row["rotation_status"],
        "rotation_radians": row["rotation_radians"] or 0.0,
        "error": row["error"],
    }


def save_shared_lidar_map(map_snapshot: dict, pointcloud: dict, username: str) -> None:
    map_json = json.dumps(map_snapshot, separators=(",", ":"))
    points_blob = zlib.compress(
        json.dumps(pointcloud, separators=(",", ":")).encode("utf-8"), level=6
    )
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO shared_lidar_map (id, map_snapshot, pointcloud, published_by, published_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            map_snapshot = excluded.map_snapshot,
            pointcloud = excluded.pointcloud,
            published_by = excluded.published_by,
            published_at = excluded.published_at
        """,
        (map_json, points_blob, username, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()


def get_shared_lidar_map():
    conn = get_db_connection()
    row = conn.execute(
        "SELECT map_snapshot, pointcloud, published_by, published_at FROM shared_lidar_map WHERE id = 1"
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "map": json.loads(row["map_snapshot"]),
        "pointcloud": json.loads(zlib.decompress(row["pointcloud"]).decode("utf-8")),
        "published_by": row["published_by"],
        "published_at": row["published_at"],
    }


def get_shared_lidar_map_version():
    conn = get_db_connection()
    row = conn.execute("SELECT map_snapshot FROM shared_lidar_map WHERE id = 1").fetchone()
    conn.close()
    if not row:
        return None
    return json.loads(row["map_snapshot"])["map"]["version"]


def get_shared_lidar_overlay_enabled() -> bool:
    conn = get_db_connection()
    row = conn.execute(
        "SELECT show_shared_overlay FROM lidar_settings WHERE id = 1"
    ).fetchone()
    conn.close()
    return bool(row["show_shared_overlay"]) if row else False


def active_navigation_operation():
    conn = get_db_connection()
    placeholders = ",".join("?" for _ in _NAVIGATION_ACTIVE_STATES)
    row = conn.execute(
        f"SELECT operation_id, status FROM navigation_operations WHERE status IN ({placeholders}) "
        "ORDER BY updated_at DESC LIMIT 1",
        _NAVIGATION_ACTIVE_STATES,
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def active_lidar_scan():
    conn = get_db_connection()
    row = conn.execute(
        "SELECT job_id, status FROM lidar_scans WHERE status = 'scanning' ORDER BY updated_at DESC LIMIT 1"
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def ensure_sdk_motion_available() -> None:
    duet_owns_motion, duet_ownership_error = duet_controller_owns_motion()
    if duet_owns_motion:
        detail = duet_ownership_error or "DUET owns the G1 motion controller; disconnect DUET before using SDK or ROS motion."
        raise HTTPException(status_code=409, detail=detail)
    operation = active_navigation_operation()
    if operation:
        raise HTTPException(
            status_code=409,
            detail=(
                "ROS navigation owns locomotion "
                f"({operation['status']}, operation {operation['operation_id']}); "
                "wait for a terminal navigation status before connecting or running SDK motion."
            ),
        )
    scan = active_lidar_scan()
    if scan:
        raise HTTPException(
            status_code=409,
            detail=f"LiDAR scan {scan['job_id']} is capturing the room; stop the scan before running SDK motion.",
        )


def list_users():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT username, role FROM users ORDER BY role ASC, username ASC"
    ).fetchall()
    conn.close()
    return [{"username": row["username"], "role": row["role"]} for row in rows]


def validate_account_credentials(username: str, password: str) -> tuple[str, str]:
    normalized_username = username.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,32}", normalized_username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3–32 characters using letters, numbers, _ or -.",
        )
    if len(password) < 8 or len(password) > 128 or not password.strip():
        raise HTTPException(
            status_code=400,
            detail="Password must be 8–128 characters and cannot be only whitespace.",
        )
    return normalized_username, password


def delete_user_account(username: str, active_username: str) -> None:
    if username == active_username:
        raise HTTPException(status_code=409, detail="You cannot delete the account you are currently using.")

    if not _QUEUE_RUN_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Wait for the running classroom queue item to finish before deleting an account.")

    conn = None
    try:
        conn = get_db_connection()
        conn.execute("BEGIN IMMEDIATE")
        account = conn.execute(
            "SELECT username, role FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if not account:
            raise HTTPException(status_code=404, detail="Account not found.")

        if account["role"] == "teacher":
            teacher_count = conn.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'teacher'"
            ).fetchone()[0]
            if teacher_count <= 1:
                raise HTTPException(status_code=409, detail="The last teacher account cannot be deleted.")

        running_queue_item = conn.execute(
            "SELECT 1 FROM queue WHERE student = ? AND status = 'running' LIMIT 1",
            (username,),
        ).fetchone()
        if running_queue_item:
            raise HTTPException(status_code=409, detail="This account has a running queue item; stop or finish it before deletion.")

        active_navigation = conn.execute(
            "SELECT 1 FROM navigation_operations WHERE username = ? AND status IN ("
            + ",".join("?" for _ in _NAVIGATION_ACTIVE_STATES)
            + ") LIMIT 1",
            (username, *_NAVIGATION_ACTIVE_STATES),
        ).fetchone()
        active_scan = conn.execute(
            "SELECT 1 FROM lidar_scans WHERE username = ? AND status = 'scanning' LIMIT 1",
            (username,),
        ).fetchone()
        if active_navigation or active_scan:
            raise HTTPException(status_code=409, detail="This account owns an active robot operation; wait for it to finish before deletion.")

        for table, owner_column in (
            ("programs", "username"),
            ("projects", "username"),
            ("queue", "student"),
            ("navigation_operations", "username"),
            ("lidar_scans", "username"),
        ):
            conn.execute(f"DELETE FROM {table} WHERE {owner_column} = ?", (username,))
        conn.execute(
            "UPDATE shared_lidar_map SET published_by = 'deleted account' WHERE published_by = ?",
            (username,),
        )
        conn.execute("DELETE FROM users WHERE username = ?", (username,))
        conn.commit()
    except Exception:
        if conn is not None:
            conn.rollback()
        raise
    finally:
        if conn is not None:
            conn.close()
        _QUEUE_RUN_LOCK.release()

    for token, token_username in list(SESSION_TOKENS.items()):
        if token_username == username:
            SESSION_TOKENS.pop(token, None)


def init_db():
    conn = get_db_connection()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS navigation_map_versions (
            map_id TEXT NOT NULL,
            version TEXT NOT NULL,
            metadata TEXT NOT NULL,
            first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (map_id, version)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS navigation_operations (
            operation_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            username TEXT NOT NULL,
            route TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS lidar_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            show_shared_overlay INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute("INSERT OR IGNORE INTO lidar_settings (id, show_shared_overlay) VALUES (1, 0)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS planner_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            active_mode TEXT NOT NULL DEFAULT 'manual'
        )
        """
    )
    conn.execute("INSERT OR IGNORE INTO planner_settings (id, active_mode) VALUES (1, 'manual')")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS lidar_scans (
            job_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            username TEXT NOT NULL,
            map_snapshot TEXT,
            pointcloud BLOB,
            rotation_status TEXT,
            rotation_radians REAL,
            error TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )
    lidar_scan_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(lidar_scans)").fetchall()
    }
    for column, sql_type in (
        ("rotation_status", "TEXT"),
        ("rotation_radians", "REAL"),
        ("error", "TEXT"),
    ):
        if column not in lidar_scan_columns:
            conn.execute(f"ALTER TABLE lidar_scans ADD COLUMN {column} {sql_type}")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS shared_lidar_map (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            map_snapshot TEXT NOT NULL,
            pointcloud BLOB NOT NULL,
            published_by TEXT NOT NULL,
            published_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, name)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS queue (
            id TEXT PRIMARY KEY,
            student TEXT NOT NULL,
            name TEXT NOT NULL,
            code TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            controller_version TEXT NOT NULL DEFAULT 'legacy',
            planner_request TEXT
        )
        """
    )
    queue_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(queue)").fetchall()
    }
    if "controller_version" not in queue_columns:
        conn.execute(
            "ALTER TABLE queue ADD COLUMN controller_version TEXT NOT NULL DEFAULT 'legacy'"
        )
    if "planner_request" not in queue_columns:
        conn.execute("ALTER TABLE queue ADD COLUMN planner_request TEXT")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            name TEXT NOT NULL,
            scene_objects TEXT NOT NULL DEFAULT '[]',
            planner_waypoints TEXT NOT NULL DEFAULT '[]',
            generated_code TEXT NOT NULL DEFAULT '',
            duet_code TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, name)
        )
        """
    )
    project_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(projects)").fetchall()
    }
    if "duet_code" not in project_columns:
        conn.execute("ALTER TABLE projects ADD COLUMN duet_code TEXT")
    for user in DEFAULT_USERS.values():
        conn.execute(
            "INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)",
            (user["username"], user["password"], user["role"]),
        )
    conn.commit()
    conn.close()


def get_user_from_db(username: str):
    conn = get_db_connection()
    row = conn.execute(
        "SELECT username, password, role FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {"username": row["username"], "password": row["password"], "role": row["role"]}


def get_user_from_token(token: Optional[str]):
    if not token:
        return None
    username = SESSION_TOKENS.get(token)
    if not username:
        return None
    return get_user_by_username(username)


def get_user_by_username(username: str):
    user = get_user_from_db(username)
    if user:
        return user
    return None


def get_saved_codes_for_user(username: str):
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT name, code FROM programs WHERE username = ? ORDER BY created_at DESC",
        (username,),
    ).fetchall()
    conn.close()
    return [{"name": row["name"], "code": row["code"]} for row in rows]


def list_queue_items():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT id, student, name, code, status, created_at, controller_version, planner_request "
        "FROM queue ORDER BY created_at ASC"
    ).fetchall()
    conn.close()
    items = []
    for row in rows:
        try:
            planner_request = json.loads(row["planner_request"]) if row["planner_request"] else None
        except (TypeError, json.JSONDecodeError):
            planner_request = None
        items.append({
            "id": row["id"],
            "student": row["student"],
            "name": row["name"],
            "code": row["code"],
            "status": row["status"],
            "created_at": row["created_at"],
            "controller_version": row["controller_version"],
            "planner_request": planner_request,
        })
    return [
        item for item in items
    ]


def upsert_program(username: str, name: str, code: str):
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO programs (username, name, code)
        VALUES (?, ?, ?)
        ON CONFLICT(username, name)
        DO UPDATE SET code = excluded.code, created_at = CURRENT_TIMESTAMP
        """,
        (username, name, code),
    )
    conn.commit()
    conn.close()


def insert_queue_item(
    student: str,
    name: str,
    code: str,
    controller_version: Literal["legacy", "duet"] = "legacy",
    planner_request: Optional[dict] = None,
):
    item_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    planner_request_json = (
        json.dumps(planner_request, separators=(",", ":"), allow_nan=False)
        if planner_request is not None
        else None
    )
    conn = get_db_connection()
    conn.execute(
        "INSERT INTO queue (id, student, name, code, status, created_at, controller_version, planner_request) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (item_id, student, name, code, "queued", now, controller_version, planner_request_json),
    )
    conn.commit()
    conn.close()
    return {
        "id": item_id,
        "student": student,
        "name": name,
        "code": code,
        "status": "queued",
        "created_at": now,
        "controller_version": controller_version,
        "planner_request": planner_request,
    }


def delete_queue_item_by_id(item_id: str):
    conn = get_db_connection()
    result = conn.execute("DELETE FROM queue WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()
    return result.rowcount > 0


def clear_queue_items():
    conn = get_db_connection()
    result = conn.execute("DELETE FROM queue WHERE status != 'running'")
    conn.commit()
    conn.close()
    return result.rowcount


def list_projects_for_user(username: str):
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT username, name, scene_objects, planner_waypoints, generated_code, duet_code FROM projects WHERE username = ? ORDER BY updated_at DESC",
        (username,),
    ).fetchall()
    conn.close()
    return [
        {
            "username": row["username"],
            "name": row["name"],
            "sceneObjects": __safe_json_load(row["scene_objects"]),
            "plannerWaypoints": __safe_json_load(row["planner_waypoints"]),
            "generatedCode": (row["generated_code"] or "").split("\n", 1)[1]
            if (row["generated_code"] or "").startswith("# __PLANNER_META__") and "\n" in (row["generated_code"] or "")
            else row["generated_code"],
            "duetCode": row["duet_code"] or "",
            **_project_planner_metadata(row["generated_code"] or ""),
        }
        for row in rows
    ]


def list_all_projects_for_teacher():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT username, name, scene_objects, planner_waypoints, generated_code, duet_code FROM projects ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [
        {
            "username": row["username"],
            "name": row["name"],
            "sceneObjects": __safe_json_load(row["scene_objects"]),
            "plannerWaypoints": __safe_json_load(row["planner_waypoints"]),
            "generatedCode": (row["generated_code"] or "").split("\n", 1)[1]
            if (row["generated_code"] or "").startswith("# __PLANNER_META__") and "\n" in (row["generated_code"] or "")
            else row["generated_code"],
            "duetCode": row["duet_code"] or "",
            **_project_planner_metadata(row["generated_code"] or ""),
        }
        for row in rows
    ]


def __safe_json_load(value: Optional[str]):
    if not value:
        return []
    try:
        return json.loads(value)
    except Exception:
        return []


def _planner_project_meta_payload(payload: dict) -> dict:
    meta = {}
    for key in ("plannerMode", "plannerLabel", "plannerVariants", "selectedPlannerVariant"):
        value = payload.get(key)
        if value not in (None, "", [], {}):
            meta[key] = value
    return meta


def _annotate_generated_code(code: str, payload: dict) -> str:
    meta = _planner_project_meta_payload(payload)
    if isinstance(code, str) and code.startswith("# __PLANNER_META__"):
        code = code.split("\n", 1)[1] if "\n" in code else ""
    if not meta:
        return code or ""
    serialized = json.dumps(meta, separators=(",", ":"), ensure_ascii=True)
    return f"# __PLANNER_META__ {serialized}\n{code or ''}".strip() + ("\n" if code else "")


def _project_planner_metadata(code: str) -> dict:
    if not isinstance(code, str) or not code.startswith("# __PLANNER_META__"):
        return {}
    try:
        metadata = json.loads(code.split("\n", 1)[0].split("__PLANNER_META__", 1)[1].strip())
    except (IndexError, json.JSONDecodeError):
        return {}
    return metadata if isinstance(metadata, dict) else {}


def get_project_for_user(username: str, name: str = "default"):
    conn = get_db_connection()
    row = conn.execute(
        "SELECT name, scene_objects, planner_waypoints, generated_code, duet_code FROM projects WHERE username = ? AND name = ?",
        (username, name),
    ).fetchone()
    conn.close()
    if not row:
        return None
    generated_code = row["generated_code"] or ""
    stripped_code = generated_code.split("\n", 1)[1] if generated_code.startswith("# __PLANNER_META__") and "\n" in generated_code else generated_code
    return {
        "name": row["name"],
        "sceneObjects": __safe_json_load(row["scene_objects"]),
        "plannerWaypoints": __safe_json_load(row["planner_waypoints"]),
        "generatedCode": stripped_code,
        "duetCode": row["duet_code"] or "",
        **_project_planner_metadata(generated_code),
    }


def save_project_for_user(username: str, payload: dict):
    name = (payload.get("name") or "default").strip() or "default"
    generated_code = _annotate_generated_code(payload.get("generatedCode", ""), payload)
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO projects (username, name, scene_objects, planner_waypoints, generated_code, duet_code)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(username, name)
        DO UPDATE SET scene_objects = excluded.scene_objects,
                      planner_waypoints = excluded.planner_waypoints,
                      generated_code = excluded.generated_code,
                      duet_code = COALESCE(excluded.duet_code, projects.duet_code),
                      updated_at = CURRENT_TIMESTAMP
        """,
        (
            username,
            name,
            json.dumps(payload.get("sceneObjects", [])),
            json.dumps(payload.get("plannerWaypoints", [])),
            generated_code,
            payload.get("duetCode"),
        ),
    )
    conn.commit()
    conn.close()
    return get_project_for_user(username, name)


def set_queue_item_status(item_id: str, status: str):
    conn = get_db_connection()
    conn.execute("UPDATE queue SET status = ? WHERE id = ?", (status, item_id))
    conn.commit()
    conn.close()


init_db()


def auth_required(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization header")
    token = authorization.split(" ", 1)[1].strip()
    user = get_user_from_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user


@app.get("/api/github-proxy")
async def github_proxy(url: Optional[str] = Query(None)):
    if not url:
        raise HTTPException(status_code=400, detail="Missing required query parameter: url")

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="URL must be a valid http(s) URL")

    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            return Response(
                content=response.content,
                media_type=response.headers.get("content-type", "application/octet-stream"),
                status_code=response.status_code,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch the target URL: {exc}") from exc


@app.post("/api/hf/text-to-motion")
async def hf_text_to_motion(request: HFTextMotionRequest, user: dict = Depends(auth_required)):
    token = os.getenv("HUGGINGFACE_API_TOKEN") or os.getenv("HF_TOKEN")
    model = os.getenv("HF_TEXT_TO_MOTION_MODEL", "HuggingFaceTB/SmolLM3-3B")
    if not token:
        raise HTTPException(status_code=503, detail="Hugging Face inference is not configured on the server")
    if not request.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt is required")

    instruction = (
        "Convert the user's request into a short sequence using only G1-supported actions: "
        "walk forward or backward by steps or seconds, slow/fast walking, turn left/right, "
        "sidestep, wave, raise arms, kick, raise a knee, stand, square path, or zigzag. "
        "Do not suggest sitting, waiting, stopping, or lowering arms. Return only the sequence.\n"
        f"User request: {request.prompt.strip()}"
    )
    endpoint = f"https://router.huggingface.co/hf-inference/models/{model}"
    try:
        async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
            response = await client.post(
                endpoint,
                headers={"Authorization": f"Bearer {token}"},
                json={"inputs": instruction, "parameters": {"max_new_tokens": 120, "return_full_text": False}},
            )
        data = response.json()
        if response.status_code >= 400:
            detail = data.get("error", "Hugging Face inference failed") if isinstance(data, dict) else "Hugging Face inference failed"
            raise HTTPException(status_code=502, detail=detail)
        if isinstance(data, list) and data and isinstance(data[0], dict):
            generated_text = data[0].get("generated_text", "")
        elif isinstance(data, dict):
            generated_text = data.get("generated_text", "")
        else:
            generated_text = ""
        if not generated_text.strip():
            raise HTTPException(status_code=502, detail="Hugging Face returned no generated text")
        return {"model": model, "text": generated_text.strip()}
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Hugging Face request failed: {exc}") from exc


@app.post("/api/classroom/login")
def classroom_login(request: LoginRequest):
    normalized = request.username.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Username is required")

    user = get_user_by_username(normalized)
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Account not found. Choose Create Account to register a student account.",
        )

    if user["password"] != request.password:
        raise HTTPException(status_code=401, detail="Incorrect password")

    if request.role and user["role"] != request.role:
        raise HTTPException(status_code=403, detail="This account is not allowed to log in as that role")

    token = uuid.uuid4().hex
    SESSION_TOKENS[token] = normalized
    return {"token": token, "user": {"username": normalized, "role": user["role"]}}


@app.post("/api/classroom/register", status_code=201)
def classroom_register_student(request: CreateUserRequest):
    username, password = validate_account_credentials(request.username, request.password)
    conn = get_db_connection()
    try:
        conn.execute(
            "INSERT INTO users (username, password, role) VALUES (?, ?, 'student')",
            (username, password),
        )
        conn.commit()
    except sqlite3.IntegrityError as error:
        conn.rollback()
        raise HTTPException(status_code=409, detail="Username already exists.") from error
    finally:
        conn.close()

    token = uuid.uuid4().hex
    SESSION_TOKENS[token] = username
    return {"token": token, "user": {"username": username, "role": "student"}}


@app.get("/api/classroom/me")
def classroom_me(user: dict = Depends(auth_required)):
    return {"user": {"username": user["username"], "role": user["role"]}}


@app.get("/api/classroom/codes")
def classroom_codes(user: dict = Depends(auth_required)):
    codes = get_saved_codes_for_user(user["username"])
    return {"codes": codes}


@app.get("/api/classroom/projects")
def classroom_projects(user: dict = Depends(auth_required)):
    return {"projects": list_projects_for_user(user["username"]) }


@app.get("/api/classroom/projects/all")
def classroom_all_projects(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    return {"projects": list_all_projects_for_teacher()}


@app.get("/api/classroom/project")
def classroom_project(user: dict = Depends(auth_required), name: str = "default"):
    project = get_project_for_user(user["username"], name)
    return {"project": project or {"name": name, "sceneObjects": [], "plannerWaypoints": [], "generatedCode": ""}}


@app.post("/api/classroom/project/save")
def save_project(user: dict = Depends(auth_required), request: ProjectSaveRequest = None):
    if not request:
        raise HTTPException(status_code=400, detail="Missing project payload")
    project = save_project_for_user(user["username"], request.model_dump())
    return {"status": "saved", "project": project}


@app.post("/api/classroom/save-code")
def save_code(user: dict = Depends(auth_required), request: SaveCodeRequest = None):
    if not request:
        raise HTTPException(status_code=400, detail="Missing code payload")
    upsert_program(user["username"], request.name, request.code)
    return {"status": "saved", "code": {"name": request.name, "code": request.code}}


@app.post("/api/classroom/submit-code")
def submit_code(user: dict = Depends(auth_required), request: QueueSubmissionRequest = None):
    if not request:
        raise HTTPException(status_code=400, detail="Missing code payload")
    planner_request = _validated_planner_request(request.planner_request)
    item = insert_queue_item(
        user["username"],
        request.name,
        request.code,
        request.controller_version,
        planner_request,
    )
    return {"status": "submitted", "item": item}


def _validated_planner_request(value: Optional[dict]) -> Optional[dict]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="Planner request must be an object.")
    mode = value.get("planner_mode")
    if not isinstance(mode, str) or mode not in {"manual", "sensor_corrected", "autonomous"}:
        raise HTTPException(status_code=400, detail="Planner request mode is invalid.")

    def validate_points(points, label, minimum=1, maximum=20, coordinate_limit=100.0):
        if not isinstance(points, list) or not minimum <= len(points) <= maximum:
            raise HTTPException(
                status_code=400,
                detail=f"{label} must contain between {minimum} and {maximum} points.",
            )
        normalized = []
        for index, point in enumerate(points):
            if not isinstance(point, dict):
                raise HTTPException(status_code=400, detail=f"{label} point {index + 1} is invalid.")
            coordinates = {}
            for axis in ("x", "y"):
                coordinate = point.get(axis)
                if (
                    isinstance(coordinate, bool)
                    or not isinstance(coordinate, (int, float))
                    or not math.isfinite(float(coordinate))
                    or abs(float(coordinate)) > coordinate_limit
                ):
                    raise HTTPException(
                        status_code=400,
                        detail=f"{label} point {index + 1} {axis} is outside the accepted finite coordinate range.",
                    )
                coordinates[axis] = float(coordinate)
            normalized.append(coordinates)
        return normalized

    planner_waypoints = value.get("planner_waypoints")
    if mode in {"manual", "sensor_corrected"}:
        planner_waypoints = validate_points(
            planner_waypoints,
            "Planner waypoints",
            minimum=2,
            coordinate_limit=10.0,
        )
    elif planner_waypoints is not None:
        planner_waypoints = (
            validate_points(
                planner_waypoints,
                "Planner waypoints",
                minimum=2,
                coordinate_limit=10.0,
            )
            if planner_waypoints
            else []
        )

    variants = value.get("route_variants", {})
    if not isinstance(variants, dict) or set(variants) - {"initial", "corrected", "final"}:
        raise HTTPException(status_code=400, detail="Planner route variants are invalid.")
    normalized_variants = {}
    for variant, code in variants.items():
        if not isinstance(code, str) or len(code) > 40000:
            raise HTTPException(status_code=400, detail=f"Planner {variant} code is invalid or too large.")
        normalized_variants[variant] = code

    navigation = value.get("navigation")
    normalized_navigation = None
    if mode == "autonomous":
        if not isinstance(navigation, dict):
            raise HTTPException(status_code=400, detail="Autonomous requests must include map goals.")
        map_id = navigation.get("map_id")
        version = navigation.get("version")
        frame_id = navigation.get("frame_id")
        nav_mode = navigation.get("planner_mode")
        if not all(isinstance(item, str) and item.strip() for item in (map_id, version, frame_id)):
            raise HTTPException(status_code=400, detail="Autonomous request map identity is incomplete.")
        if not isinstance(nav_mode, str) or nav_mode not in {"static", "live"}:
            raise HTTPException(status_code=400, detail="Autonomous request Nav2 mode is invalid.")
        normalized_navigation = {
            "map_id": map_id.strip()[:128],
            "version": version.strip()[:128],
            "frame_id": frame_id.strip()[:128],
            "planner_mode": nav_mode,
            "waypoints": validate_points(
                navigation.get("waypoints"),
                "Autonomous map goals",
                coordinate_limit=1000.0,
            ),
        }

    selected_variant = value.get("selected_variant", "initial")
    if not isinstance(selected_variant, str) or selected_variant not in {"initial", "corrected", "final"}:
        raise HTTPException(status_code=400, detail="Selected planner variant is invalid.")
    label = value.get("planner_label", "")
    if not isinstance(label, str):
        raise HTTPException(status_code=400, detail="Planner label must be text.")
    return {
        "planner_mode": mode,
        "planner_label": label.strip()[:120],
        "planner_waypoints": planner_waypoints or [],
        "route_variants": normalized_variants,
        "selected_variant": selected_variant,
        "navigation": normalized_navigation,
    }


@app.get("/api/classroom/queue")
def queue_items(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    return {"items": list_queue_items()}


@app.post("/api/classroom/run-next")
def run_next(request: QueueRunRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")

    if not _QUEUE_RUN_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A queued robot program is already running.")
    try:
        queue = list_queue_items()
        item = next((queued for queued in queue if queued["id"] == request.item_id), None)
        if not item or item["status"] != "queued":
            raise HTTPException(status_code=404, detail="The approved queue item is no longer queued.")
        if item.get("planner_request"):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Planner request {item['name']} must be loaded into the teacher workspace "
                    "and approved through its matching planner controls; it cannot run as ordinary queue code."
                ),
            )
        if item["controller_version"] != "legacy":
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Queue item {item['name']} targets the DUET controller. "
                    "DUET queue execution is not enabled; it will not be sent to the legacy SDK."
                ),
            )
        set_queue_item_status(item["id"], "running")
        item["status"] = "running"
        try:
            with _MOTION_START_LOCK:
                ensure_sdk_motion_available()
                result = execute_robot_program(item["code"])
        except HTTPException as error:
            set_queue_item_status(
                item["id"],
                "queued" if error.status_code == 409 else "failed",
            )
            raise
        set_queue_item_status(item["id"], "completed")
        item["status"] = "completed"
        return {"status": "completed", "item": item, "process": result}
    finally:
        _QUEUE_RUN_LOCK.release()


@app.post("/api/classroom/stop-current")
def stop_current(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    ensure_sdk_motion_available()
    result = stop_robot()
    if result["status"] == "stopping":
        queue = list_queue_items()
        for item in reversed(queue):
            if item["status"] == "running":
                set_queue_item_status(item["id"], "paused")
                break
        return {"status": "paused"}
    return {"status": "no_process_running"}


@app.post("/api/classroom/delete-item/{item_id}")
def delete_item(item_id: str, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if not delete_queue_item_by_id(item_id):
        raise HTTPException(status_code=404, detail="Queue item not found")
    return {"status": "deleted", "id": item_id}


@app.post("/api/classroom/clear-queue")
def clear_queue(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    deleted_count = clear_queue_items()
    remaining_items = list_queue_items()
    return {
        "status": "cleared",
        "deleted": deleted_count,
        "remaining": remaining_items,
    }


@app.get("/api/g1-model")
def g1_model_info():
    if not os.path.exists(G1_URDF_PATH):
        raise HTTPException(status_code=404, detail="G1 URDF not found")

    with open(G1_URDF_PATH, "r", encoding="utf-8") as urdf_file:
        urdf_text = urdf_file.read()

    cleaned_urdf = re.sub(r'<!--.*?-->', '', urdf_text, flags=re.DOTALL)
    joint_blocks = re.findall(r'<joint\b[^>]*>.*?</joint>', cleaned_urdf, flags=re.DOTALL)
    joint_details = []
    for block in joint_blocks:
        name_match = re.search(r'<joint\s+name="([^"]+)"', block)
        type_match = re.search(r'<joint\s+[^>]*type="([^"]+)"', block)
        if not name_match:
            continue
        joint_details.append({
            "name": name_match.group(1),
            "type": type_match.group(1) if type_match else "fixed",
            "parent": re.search(r'<parent\s+link="([^"]+)"', block).group(1) if re.search(r'<parent\s+link="([^"]+)"', block) else None,
            "child": re.search(r'<child\s+link="([^"]+)"', block).group(1) if re.search(r'<child\s+link="([^"]+)"', block) else None,
            "axis": re.search(r'<axis\s+xyz="([^"]+)"', block).group(1) if re.search(r'<axis\s+xyz="([^"]+)"', block) else "0 0 0",
            "origin": re.search(r'<origin\s+xyz="([^"]+)"', block).group(1) if re.search(r'<origin\s+xyz="([^"]+)"', block) else "0 0 0",
        })

    all_joints = [joint["name"] for joint in joint_details if not joint["name"].startswith("floating_")]
    revolute_joints = [joint["name"] for joint in joint_details if joint["type"] == "revolute" and not joint["name"].startswith("floating_")]
    fixed_joints = [joint["name"] for joint in joint_details if joint["type"] == "fixed" and not joint["name"].startswith("floating_")]
    links = re.findall(r'<link\s+name="([^"]+)"', cleaned_urdf)

    return {
        "robotType": "Unitree G1",
        "source": "URDF",
        "sourceFile": "g1_23dof.urdf.txt",
        "baseLink": "pelvis" if "pelvis" in links else (links[0] if links else "pelvis"),
        "jointCount": len(revolute_joints),
        "joints": revolute_joints,
        "revoluteJoints": revolute_joints,
        "fixedJoints": fixed_joints,
        "allJoints": all_joints,
        "links": links,
        "jointDetails": joint_details,
    }


@app.get("/g1_23dof.urdf.txt")
def serve_g1_urdf():
    return FileResponse(G1_URDF_PATH)


@app.get("/api/classroom/status")
def classroom_status(user: dict = Depends(auth_required)):
    queue = list_queue_items()
    if robot_status()["running"]:
        return {"status": "running", "queue_length": len(queue)}
    return {"status": "idle", "queue_length": len(queue)}


@app.get("/api/classroom/users")
def classroom_users(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    return {"users": list_users()}


@app.post("/api/classroom/users", status_code=201)
def classroom_create_user(
    request: CreateUserRequest,
    user: dict = Depends(auth_required),
):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if request.role not in {"student", "teacher"}:
        raise HTTPException(status_code=400, detail="Account role must be student or teacher.")
    username, password = validate_account_credentials(request.username, request.password)
    conn = get_db_connection()
    try:
        conn.execute(
            "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
            (username, password, request.role),
        )
        conn.commit()
    except sqlite3.IntegrityError as error:
        conn.rollback()
        raise HTTPException(status_code=409, detail="Username already exists.") from error
    finally:
        conn.close()
    return {"status": "created", "user": {"username": username, "role": request.role}}


@app.delete("/api/classroom/users/{username}")
def classroom_delete_user(username: str, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    delete_user_account(username, user["username"])
    return {"status": "deleted", "username": username}


@app.post("/api/run")
def run_code(request: CodeRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    with _MOTION_START_LOCK:
        ensure_sdk_motion_available()
        return execute_robot_program(request.code)


def _checkpoint_localization() -> dict:
    snapshot = navigation_bridge_status()
    localization = snapshot.get("localization")
    if not isinstance(localization, dict) or localization.get("ready") is not True:
        raise HTTPException(status_code=503, detail="Fresh robot localization is required at every planner checkpoint.")
    if snapshot.get("pointcloudReady") is not True:
        raise HTTPException(status_code=503, detail="Fresh LiDAR data is required at every planner checkpoint.")
    if not isinstance(snapshot.get("estop"), dict) or snapshot["estop"].get("ready") is not True:
        raise HTTPException(status_code=503, detail="Fresh emergency-stop health is required for checkpointed motion.")
    if not isinstance(snapshot.get("robotHealth"), dict) or snapshot["robotHealth"].get("ready") is not True:
        raise HTTPException(status_code=503, detail="Fresh robot-link health is required for checkpointed motion.")
    pose = localization.get("pose")
    if not isinstance(pose, dict):
        raise HTTPException(status_code=503, detail="Robot localization did not report a pose.")
    try:
        x, y, yaw = (float(pose[key]) for key in ("x", "y", "yaw_rad"))
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=503, detail="Robot localization pose is incomplete.") from error
    if not all(math.isfinite(value) for value in (x, y, yaw)):
        raise HTTPException(status_code=503, detail="Robot localization pose is not finite.")
    frame_id = localization.get("frame_id")
    if not isinstance(frame_id, str) or not frame_id.strip():
        raise HTTPException(status_code=503, detail="Robot localization frame is missing.")
    return {"x": x, "y": y, "yaw_rad": yaw, "frame_id": frame_id}


def _sdk_commands_to_pose(current: dict, target: dict) -> list[str]:
    dx = target["x"] - current["x"]
    dy = target["y"] - current["y"]
    distance = math.hypot(dx, dy)
    if distance > 3.0:
        raise HTTPException(status_code=400, detail="Checkpoint spacing exceeds the 3 m SDK correction envelope.")
    if distance <= 0.04:
        return []
    target_yaw = math.atan2(dy, dx)
    turn = (target_yaw - current["yaw_rad"] + math.pi) % (2 * math.pi) - math.pi
    commands = []
    if abs(turn) >= math.radians(5):
        commands.append(
            f'robot.turn("{"left" if turn > 0 else "right"}", {math.degrees(abs(turn)):.2f})'
        )
    remaining = distance / 0.4
    while remaining > 0.001:
        duration = min(10.0, remaining)
        if duration < 0.1:
            break
        commands.append(f"robot.walktime({duration:.3f})")
        remaining -= duration
    return commands


@app.post("/api/planner/checkpointed-run")
def run_checkpointed_planner(
    request: CheckpointedPlannerRequest,
    user: dict = Depends(auth_required),
):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if os.getenv("G1_SDK_CHECKPOINTED_PLANNER_ENABLED", "").strip() != "1":
        raise HTTPException(
            status_code=503,
            detail="Checkpointed SDK planning is deployment-disabled until supervised SDK ownership and localization are commissioned.",
        )
    if os.getenv("G1_SDK_CHECKPOINTED_PLANNER_OWNER_CONFIRMED", "").strip() != "1":
        raise HTTPException(
            status_code=503,
            detail="SDK locomotion ownership has not been explicitly commissioned for checkpointed planning.",
        )
    if not 2 <= len(request.waypoints) <= 20:
        raise HTTPException(status_code=400, detail="Checkpointed routes require 2 to 20 waypoints.")
    targets = []
    for index, waypoint in enumerate(request.waypoints):
        if not isinstance(waypoint, dict):
            raise HTTPException(status_code=400, detail=f"Waypoint {index + 1} is invalid.")
        values = []
        for axis in ("x", "y"):
            value = waypoint.get(axis)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                raise HTTPException(status_code=400, detail=f"Waypoint {index + 1} {axis} must be finite.")
            if not -10 <= float(value) <= 10:
                raise HTTPException(status_code=400, detail=f"Waypoint {index + 1} {axis} must be between -10 and 10 m.")
            values.append(float(value))
        targets.append({"x": values[0], "y": values[1]})

    if not _MOTION_START_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Another robot motion operation is starting or running.")
    executed_code = []
    checkpoints = []
    try:
        ensure_sdk_motion_available()
        status = robot_status()
        if status.get("sdkAvailable") is not True:
            raise HTTPException(status_code=409, detail="Connect the G1 SDK before running a checkpointed path.")
        if status.get("running"):
            raise HTTPException(status_code=409, detail="An SDK program is already running.")

        clear_robot_stop_request()
        start = _checkpoint_localization()
        cosine = math.cos(start["yaw_rad"])
        sine = math.sin(start["yaw_rad"])
        world_targets = [
            {
                "x": start["x"] + point["x"] * cosine - point["y"] * sine,
                "y": start["y"] + point["x"] * sine + point["y"] * cosine,
            }
            for point in targets
        ]
        stand = execute_robot_program(
            "robot.stand()", reset_stop_request=False, clear_stop_request=False
        )
        executed_code.append("robot.stand()")
        if stand.get("status") != "completed":
            raise HTTPException(status_code=502, detail="SDK did not confirm the initial stand command.")

        for index, target in enumerate(world_targets):
            reached = False
            for correction_index in range(2):
                current = _checkpoint_localization()
                if current["frame_id"] != start["frame_id"]:
                    raise HTTPException(status_code=503, detail="Localization frame changed during the SDK path.")
                commands = _sdk_commands_to_pose(current, target)
                if commands:
                    result = execute_robot_program(
                        "\n".join(commands), reset_stop_request=False, clear_stop_request=False
                    )
                    if result.get("status") != "completed":
                        raise HTTPException(status_code=502, detail=f"SDK did not complete waypoint {index + 1}.")
                    executed_code.extend(commands)
                measured = _checkpoint_localization()
                if measured["frame_id"] != start["frame_id"]:
                    raise HTTPException(status_code=503, detail="Localization frame changed during the SDK path.")
                error = math.hypot(target["x"] - measured["x"], target["y"] - measured["y"])
                checkpoints.append({
                    "waypoint": index + 1,
                    "correction": correction_index + 1,
                    "target": target,
                    "measured": measured,
                    "error_m": round(error, 3),
                })
                if error <= 0.25:
                    reached = True
                    break
            if not reached:
                raise HTTPException(
                    status_code=409,
                    detail=f"Waypoint {index + 1} was not reached within 0.25 m after one SDK correction; route stopped.",
                )
        stand = execute_robot_program(
            "robot.stand()", reset_stop_request=False, clear_stop_request=False
        )
        executed_code.append("robot.stand()")
        if stand.get("status") != "completed":
            raise HTTPException(status_code=502, detail="SDK did not confirm the final stand command.")
        return {
            "status": "completed",
            "initialPose": start,
            "checkpoints": checkpoints,
            "correctedCode": "\n".join(executed_code),
            "physicalMotionVerified": False,
        }
    except HTTPException:
        raise
    except NavigationBridgeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    finally:
        clear_robot_stop_request()
        _MOTION_START_LOCK.release()

@app.post("/api/robot/connect")
def robot_connect(request: ConnectRobotRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    with _MOTION_START_LOCK:
        ensure_sdk_motion_available()
        return connect_robot(request.interface or os.getenv("UNITREE_INTERFACE", "eth0"))

@app.get("/api/robot/status")
def get_robot_status(response: Response, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    response.headers["Cache-Control"] = "no-store, max-age=0"
    status = robot_status()
    if not status["sdkAvailable"]:
        return status
    return {**status, "distanceSensor": distance_sensor_status()}


@app.post("/api/duet/connect")
def duet_connect(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if not _MOTION_START_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Another robot motion operation is starting.")
    try:
        current = duet_controller_status()
        if current.get("controlLease") and current.get("ready") and current.get("motionOwner") == "duet":
            return current
        if current.get("motionOwner") == "unknown":
            raise HTTPException(status_code=409, detail=current.get("error") or "DUET controller ownership is unknown.")
        if robot_status().get("running"):
            raise HTTPException(status_code=409, detail="Stop the active SDK robot program before connecting DUET.")
        if active_navigation_operation():
            raise HTTPException(status_code=409, detail="ROS navigation owns locomotion; stop it before connecting DUET.")
        scan = active_lidar_scan()
        if scan:
            raise HTTPException(
                status_code=409,
                detail=f"LiDAR scan {scan['job_id']} is capturing the room; stop it before connecting DUET.",
            )
        return connect_duet_controller()
    except DuetProgramValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except DuetControllerError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    finally:
        _MOTION_START_LOCK.release()


@app.post("/api/duet/disconnect")
def duet_disconnect(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    try:
        return disconnect_duet_controller()
    except DuetControllerError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/duet/status")
def get_duet_status(response: Response, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return duet_controller_status()


@app.post("/api/duet/run")
def run_duet_code(request: DuetProgramRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if not _MOTION_START_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Another robot motion operation is starting.")
    try:
        if active_navigation_operation():
            raise HTTPException(status_code=409, detail="ROS navigation owns locomotion; stop it before running DUET.")
        scan = active_lidar_scan()
        if scan:
            raise HTTPException(
                status_code=409,
                detail=f"LiDAR scan {scan['job_id']} is capturing the room; stop it before running DUET.",
            )
        if robot_status().get("running"):
            raise HTTPException(status_code=409, detail="An SDK robot program is already running.")
        return execute_duet_program(request.code)
    except DuetProgramValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except DuetControllerError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    finally:
        _MOTION_START_LOCK.release()


@app.post("/api/duet/stop")
def stop_duet_code(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    try:
        return stop_duet_controller()
    except DuetControllerError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def _require_teacher(user):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")


def _sensor_diagnostics():
    return {
        "lidar": {
            "discovery": discover_sensors(),
            "distance": distance_sensor_status(),
            "calibration": calibration_status(),
        },
        "cameras": discover_camera_sources(),
    }


@app.get("/api/sensors/status")
def get_sensor_status(response: Response, user: dict = Depends(auth_required)):
    _require_teacher(user)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return _sensor_diagnostics()


@app.post("/api/sensors/discover")
def run_sensor_discovery(response: Response, user: dict = Depends(auth_required)):
    _require_teacher(user)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return _sensor_diagnostics()


@app.post("/api/sensors/service")
def operate_sensor_service(request: SensorServiceRequest, user: dict = Depends(auth_required)):
    _require_teacher(user)
    service_names = {
        "lidar_driver": "uni-edu-lidar-driver.service",
        "lidar_provider": "uni-edu-lidar-provider.service",
    }
    operation = "restart" if request.operation == "repair" else request.operation
    command = ["systemctl"]
    if os.getenv("G1_LIDAR_ROS_RUNTIME", "host") == "host":
        command.append("--user")
    command.extend([operation, service_names[request.sensor_id]])
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except subprocess.TimeoutExpired as error:
        logger.warning(
            "Sensor service operation timed out: user=%s sensor=%s operation=%s",
            user["username"],
            request.sensor_id,
            request.operation,
        )
        raise HTTPException(
            status_code=504,
            detail="The managed sensor service operation timed out.",
        ) from error
    except OSError as error:
        logger.error("Could not execute managed sensor service operation: %s", error)
        raise HTTPException(
            status_code=503,
            detail="The managed sensor service controller is unavailable.",
        ) from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        logger.warning(
            "Sensor service operation failed: user=%s sensor=%s operation=%s status=%s",
            user["username"],
            request.sensor_id,
            request.operation,
            result.returncode,
        )
        raise HTTPException(
            status_code=409,
            detail=detail or "The managed sensor service operation failed.",
        )
    logger.info(
        "Sensor service operation completed: user=%s sensor=%s operation=%s",
        user["username"],
        request.sensor_id,
        request.operation,
    )
    return {
        "status": "accepted",
        "sensor_id": request.sensor_id,
        "operation": request.operation,
        "service": service_names[request.sensor_id],
    }


@app.get("/api/navigation/status")
def get_navigation_status(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    status = navigation_bridge_status()
    if status.get("map"):
        known_map_versions = record_navigation_map_version(status["map"])
    else:
        known_map_versions = list_navigation_map_versions()
    active_operation = active_navigation_operation()
    if active_operation:
        try:
            operation_status = navigation_operation_status(active_operation["operation_id"])
            operation_state = operation_status["status"]
            if operation_state == "succeeded":
                operation_state = "completed"
            update_navigation_operation(active_operation["operation_id"], operation_state)
            active_operation = {**operation_status, "status": operation_state}
            if operation_state not in _NAVIGATION_ACTIVE_STATES:
                active_operation = None
        except NavigationBridgeError as error:
            active_operation = {
                **active_operation,
                "status": "uncertain",
                "error": str(error),
            }
    return {
        **status,
        "knownMapVersions": known_map_versions,
        "activeOperation": active_operation,
    }


@app.get("/api/navigation/map")
def get_navigation_map(user: dict = Depends(auth_required)):
    snapshot = navigation_map_snapshot()
    if not snapshot["ready"]:
        raise HTTPException(status_code=503, detail=snapshot["error"])
    return {**snapshot, "knownMapVersions": record_navigation_map_version(snapshot["map"])}


@app.post("/api/lidar/scan")
def start_lidar_scan(
    request: LidarScanStartRequest,
    user: dict = Depends(auth_required),
):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if request.confirm_rotation is not True:
        raise HTTPException(
            status_code=400,
            detail="Teacher confirmation is required before the robot begins an in-place 360-degree scan.",
        )
    if not _MOTION_START_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Another robot motion operation is starting or running.")
    try:
        ensure_sdk_motion_available()
        if robot_status()["running"]:
            raise HTTPException(status_code=409, detail="Stop SDK motion before starting a room scan.")
        if active_navigation_operation():
            raise HTTPException(status_code=409, detail="Cannot scan while ROS navigation owns locomotion.")
        if active_lidar_scan():
            raise HTTPException(status_code=409, detail="A LiDAR room scan is already active.")
        try:
            scan = navigation_start_scan()
        except NavigationBridgeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        save_lidar_scan(
            scan["job_id"],
            scan["status"],
            user["username"],
            rotation_status=scan["rotation_status"],
            rotation_radians=scan["rotation_radians"],
            error=scan.get("error"),
        )
        return scan
    finally:
        _MOTION_START_LOCK.release()


@app.get("/api/lidar/scan/{job_id}")
def get_lidar_scan_status(job_id: str, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    stored = get_lidar_scan(job_id)
    if not stored:
        raise HTTPException(status_code=404, detail="LiDAR scan job not found.")
    if stored["status"] in {"scanning", "completed"} and not stored["map_snapshot"]:
        try:
            scan = navigation_scan_status(job_id)
        except NavigationBridgeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        if scan["status"] in {"failed", "canceled"}:
            save_lidar_scan(
                job_id,
                scan["status"],
                stored["username"],
                rotation_status=scan["rotation_status"],
                rotation_radians=scan["rotation_radians"],
                error=scan.get("error"),
            )
        return scan
    return {
        "job_id": stored["job_id"],
        "status": stored["status"],
        "point_count": stored["pointcloud"]["point_count"] if stored["pointcloud"] else 0,
        "map_version": stored["map_snapshot"]["map"]["version"] if stored["map_snapshot"] else None,
        "updated_at": stored["updated_at"],
        "rotation_status": stored["rotation_status"],
        "rotation_radians": stored["rotation_radians"],
        "error": stored["error"],
        "preview_points": [],
    }


@app.post("/api/lidar/scan/{job_id}/complete")
def complete_lidar_scan(job_id: str, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    stored = get_lidar_scan(job_id)
    if not stored:
        raise HTTPException(status_code=404, detail="LiDAR scan job not found.")
    if stored["status"] not in {"scanning", "completed"}:
        raise HTTPException(status_code=409, detail="Only an active LiDAR scan can be completed.")
    try:
        current_scan = navigation_scan_status(job_id)
        if current_scan["status"] in {"failed", "canceled"}:
            save_lidar_scan(
                job_id,
                current_scan["status"],
                stored["username"],
                rotation_status=current_scan["rotation_status"],
                rotation_radians=current_scan["rotation_radians"],
                error=current_scan.get("error"),
            )
            raise HTTPException(
                status_code=409,
                detail=current_scan.get("error") or "The 360-degree scan did not complete successfully.",
            )
        if current_scan.get("rotation_status") == "uncertain":
            raise HTTPException(
                status_code=503,
                detail=current_scan.get("error") or "Nav2 could not confirm the scan rotation state.",
            )
        if current_scan.get("rotation_status") == "cancel_requested":
            raise HTTPException(
                status_code=409,
                detail=current_scan.get("error") or "Nav2 has not confirmed that scan rotation stopped.",
            )
        if current_scan.get("rotation_status") != "completed":
            raise HTTPException(
                status_code=409,
                detail="Wait for the supervised 360-degree rotation to complete before validating the map.",
            )
        scan = navigation_complete_scan(job_id)
        if scan["status"] != "completed":
            save_lidar_scan(
                job_id,
                "failed",
                stored["username"],
                rotation_status=scan.get("rotation_status"),
                rotation_radians=scan.get("rotation_radians"),
                error=scan.get("error"),
            )
            raise HTTPException(status_code=409, detail=scan.get("error") or "LiDAR scan did not complete.")
        map_snapshot = navigation_scan_map_snapshot(job_id)
        if not map_snapshot["ready"]:
            raise NavigationBridgeError(map_snapshot.get("error") or "SLAM occupancy map is not ready.")
        if (
            map_snapshot["map"]["map_id"] != scan.get("map_id")
            or map_snapshot["map"]["version"] != scan.get("map_version")
        ):
            raise NavigationBridgeError("SLAM map changed while finalizing the scan; reload and scan again.")
        pointcloud = navigation_scan_pointcloud(job_id)
        if (
            pointcloud["frame_id"] != map_snapshot["map"]["frame_id"]
            or scan.get("frame_id") != map_snapshot["map"]["frame_id"]
        ):
            raise NavigationBridgeError("3D point cloud frame does not match the SLAM occupancy map.")
        if pointcloud["point_count"] < 1_000:
            raise NavigationBridgeError("The completed room scan contains too few unique 3D points.")
    except HTTPException:
        raise
    except NavigationBridgeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    save_lidar_scan(
        job_id, "completed", stored["username"],
        map_snapshot=map_snapshot, pointcloud=pointcloud,
        rotation_status=current_scan.get("rotation_status"),
        rotation_radians=current_scan.get("rotation_radians"),
    )
    return {
        "job_id": job_id,
        "status": "completed",
        "point_count": pointcloud["point_count"],
        "rotation_status": current_scan["rotation_status"],
        "rotation_radians": current_scan["rotation_radians"],
        "map": map_snapshot["map"],
    }


@app.post("/api/lidar/scan/{job_id}/cancel")
def cancel_lidar_scan(job_id: str, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    stored = get_lidar_scan(job_id)
    if not stored or stored["status"] != "scanning":
        raise HTTPException(status_code=409, detail="There is no active LiDAR scan to cancel.")
    try:
        scan = navigation_cancel_scan(job_id)
    except NavigationBridgeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    save_lidar_scan(
        job_id,
        scan["status"],
        stored["username"],
        rotation_status=scan["rotation_status"],
        rotation_radians=scan["rotation_radians"],
        error=scan.get("error"),
    )
    return scan


@app.post("/api/lidar/map/publish")
def publish_lidar_map(request: LidarMapPublishRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    scan = get_lidar_scan(request.job_id)
    if not scan or scan["status"] != "completed" or not scan["map_snapshot"] or not scan["pointcloud"]:
        raise HTTPException(status_code=409, detail="Publish requires a completed, validated 3D room scan.")
    save_shared_lidar_map(scan["map_snapshot"], scan["pointcloud"], user["username"])
    return {
        "status": "published",
        "map": scan["map_snapshot"]["map"],
        "point_count": scan["pointcloud"]["point_count"],
    }


@app.get("/api/lidar/map")
def get_shared_lidar_map_endpoint(user: dict = Depends(auth_required)):
    enabled = get_shared_lidar_overlay_enabled()
    shared_map = get_shared_lidar_map()
    if user["role"] != "teacher" and not enabled:
        return {"enabled": False, "map": None, "pointcloud": None}
    return {
        "enabled": enabled,
        **(shared_map or {"map": None, "pointcloud": None}),
    }


@app.get("/api/lidar/settings")
def get_lidar_settings(user: dict = Depends(auth_required)):
    return {"show_shared_overlay": get_shared_lidar_overlay_enabled()}


@app.put("/api/lidar/settings")
def update_lidar_settings(
    request: SharedLidarSettingsRequest,
    user: dict = Depends(auth_required),
):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    conn = get_db_connection()
    conn.execute(
        "UPDATE lidar_settings SET show_shared_overlay = ? WHERE id = 1",
        (int(request.show_shared_overlay),),
    )
    conn.commit()
    conn.close()
    return {"show_shared_overlay": request.show_shared_overlay}


@app.get("/api/planner/settings")
def get_planner_settings(user: dict = Depends(auth_required)):
    conn = get_db_connection()
    row = conn.execute("SELECT active_mode FROM planner_settings WHERE id = 1").fetchone()
    conn.close()
    if not row or row["active_mode"] not in {"manual", "sensor_corrected", "autonomous"}:
        raise HTTPException(status_code=503, detail="Path planner mode setting is unavailable or invalid.")
    return {"active_mode": row["active_mode"]}


@app.put("/api/planner/settings")
def update_planner_settings(
    request: PlannerSettingsRequest,
    user: dict = Depends(auth_required),
):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    conn = get_db_connection()
    conn.execute(
        "UPDATE planner_settings SET active_mode = ? WHERE id = 1",
        (request.active_mode,),
    )
    conn.commit()
    conn.close()
    return {"active_mode": request.active_mode}


@app.websocket("/api/lidar/live")
async def lidar_live_updates(websocket: WebSocket):
    protocol = next(
        (
            value.strip() for value in websocket.headers.get("sec-websocket-protocol", "").split(",")
            if value.strip().startswith("edu-auth.")
        ),
        None,
    )
    token = protocol.removeprefix("edu-auth.") if protocol else None
    user = get_user_from_token(token)
    if not user:
        await websocket.close(code=1008, reason="Authenticated classroom session required.")
        return
    await websocket.accept(subprotocol=protocol)
    try:
        while True:
            scan = await asyncio.to_thread(active_lidar_scan)
            scan_status = None
            if scan:
                try:
                    scan_status = await asyncio.to_thread(navigation_scan_status, scan["job_id"])
                    if scan_status["status"] in {"failed", "canceled"}:
                        await asyncio.to_thread(
                            save_lidar_scan, scan["job_id"], scan_status["status"], "teacher"
                        )
                except NavigationBridgeError as error:
                    scan_status = {
                        "job_id": scan["job_id"],
                        "status": "unavailable",
                        "error": str(error),
                    }
            bridge_status = await asyncio.to_thread(navigation_bridge_status)
            shared_map_version = await asyncio.to_thread(get_shared_lidar_map_version)
            await websocket.send_json({
                "type": "live_update",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "navigation": {
                    "ready": bridge_status["ready"],
                    "motion_ready": bridge_status.get("motionReady", False),
                    "estop": bridge_status.get("estop"),
                    "robot_health": bridge_status.get("robotHealth"),
                    "status": bridge_status["status"],
                    "map": bridge_status.get("map"),
                    "localization": bridge_status.get("localization"),
                    "pointcloud_ready": bridge_status.get("pointcloudReady"),
                    "pointcloud_age_ms": bridge_status.get("pointcloudAgeMs"),
                    "diagnostics": bridge_status.get("diagnostics"),
                    "live_avoidance_ready": bridge_status.get("liveAvoidanceReady", False),
                    "live_obstacles": bridge_status.get("liveObstacles"),
                    "error": bridge_status.get("error"),
                },
                "scan": scan_status,
                "shared_overlay_enabled": await asyncio.to_thread(get_shared_lidar_overlay_enabled),
                "shared_map_version": shared_map_version,
            })
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        return


@app.post("/api/navigation/start")
def start_navigation(request: NavigationStartRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if not _MOTION_START_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Another robot motion operation is starting or running.")
    try:
        ensure_sdk_motion_available()
        if active_lidar_scan():
            raise HTTPException(status_code=409, detail="Complete or cancel the active LiDAR scan before navigation.")
        if robot_status()["running"]:
            raise HTTPException(status_code=409, detail="Stop the active SDK robot program before starting navigation.")
        operation_id = str(uuid.uuid4())
        route = {
            "map_id": request.map_id,
            "version": request.version,
            "frame_id": request.frame_id,
            "waypoints": request.waypoints,
            "planner_mode": request.planner_mode,
        }
        static_map_snapshot = None
        if request.planner_mode == "static":
            shared_map = get_shared_lidar_map()
            static_map_snapshot = shared_map.get("map") if shared_map else None
        dispatch_started = False

        def persist_starting_operation():
            nonlocal dispatch_started
            save_navigation_operation(
                {"operation_id": operation_id, "status": "starting"},
                user["username"],
                route,
            )
            dispatch_started = True

        try:
            operation = navigation_start_route(
                request.map_id,
                request.version,
                request.frame_id,
                request.waypoints,
                operation_id,
                on_dispatch=persist_starting_operation,
                planner_mode=request.planner_mode,
                static_map_snapshot=static_map_snapshot,
            )
        except NavigationBridgeError as error:
            if dispatch_started:
                update_navigation_operation(operation_id, "uncertain")
            raise HTTPException(status_code=503, detail=str(error)) from error
        save_navigation_operation(
            {"operation_id": operation_id, "status": operation.get("status", "accepted")},
            user["username"],
            route,
        )
        operation_status = "completed" if operation["status"] == "succeeded" else operation["status"]
        update_navigation_operation(operation_id, operation_status)
        return {**operation, "status": operation_status}
    finally:
        _MOTION_START_LOCK.release()


@app.post("/api/navigation/plan")
def preview_navigation_route(request: NavigationStartRequest, user: dict = Depends(auth_required)):
    ensure_sdk_motion_available()
    if robot_status()["running"]:
        raise HTTPException(
            status_code=409,
            detail="Stop the active SDK robot program before requesting a route preview.",
        )
    try:
        static_map_snapshot = None
        if request.planner_mode == "static":
            shared_map = get_shared_lidar_map()
            static_map_snapshot = shared_map.get("map") if shared_map else None
        return navigation_plan_route(
            request.map_id,
            request.version,
            request.frame_id,
            request.waypoints,
            planner_mode=request.planner_mode,
            static_map_snapshot=static_map_snapshot,
        )
    except NavigationBridgeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/navigation/operation/{operation_id}")
def get_navigation_operation(operation_id: str, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    conn = get_db_connection()
    row = conn.execute(
        "SELECT operation_id, status, route, updated_at FROM navigation_operations WHERE operation_id = ?",
        (operation_id,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Navigation operation not found.")
    try:
        operation = navigation_operation_status(operation_id)
    except NavigationBridgeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    status = operation["status"]
    if status == "succeeded":
        status = "completed"
    update_navigation_operation(operation_id, status)
    return {
        **operation,
        "status": status,
        "route": json.loads(row["route"]),
        "updated_at": row["updated_at"],
    }


@app.post("/api/navigation/operation/{operation_id}/stop")
def stop_navigation(operation_id: str, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    if not active_navigation_operation():
        raise HTTPException(status_code=409, detail="There is no active navigation operation.")
    try:
        operation = navigation_cancel_route(operation_id)
    except NavigationBridgeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    operation_status = operation.get("status", "cancel_requested")
    if operation_status == "succeeded":
        operation_status = "completed"
    update_navigation_operation(operation_id, operation_status)
    return {**operation, "status": operation_status}

@app.post("/api/stop")
def stop_code(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    ensure_sdk_motion_available()
    return stop_robot()

@app.get("/api/status")
def get_status():
    return robot_status()


def find_available_port(start_port: int = 5179, max_tries: int = 20) -> int:
    for port in range(start_port, start_port + max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No available port found starting from {start_port}")


# 托管前端静态文件 (构建后的 React 产物放在 backend/static 目录下)
# 使用绝对路径，避免从项目根目录或其他目录启动时出现空白页
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn

    preferred_port = int(os.getenv("UNI_EDU_PORT", "5179"))
    port = preferred_port
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("0.0.0.0", preferred_port))
    except OSError:
        port = find_available_port(preferred_port)
        print(f"Port {preferred_port} is already in use. Falling back to port {port}.")

    # 监听 0.0.0.0 允许局域网访问
    uvicorn.run(app, host="0.0.0.0", port=port)