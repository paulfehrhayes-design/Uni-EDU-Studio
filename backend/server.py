import json
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
try:
    from .g1_robot import connect_robot, execute_robot_program, robot_status, stop_robot
except ImportError:
    from g1_robot import connect_robot, execute_robot_program, robot_status, stop_robot

# 确保 unitree_sdk2py 在路径中
# 假设 backend 文件夹与 unitree_sdk2py 同级，或者已安装
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PROJECT_ROOT = os.path.dirname(BASE_DIR)
G1_URDF_PATH = os.path.join(PROJECT_ROOT, "g1_23dof.urdf.txt")

app = FastAPI()

# 允许跨域（方便开发调试）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class CodeRequest(BaseModel):
    code: str

class ConnectRobotRequest(BaseModel):
    interface: str

class HFTextMotionRequest(BaseModel):
    prompt: str

class LoginRequest(BaseModel):
    username: str
    password: str
    role: Optional[str] = None

class SaveCodeRequest(BaseModel):
    name: str
    code: str

class ProjectSaveRequest(BaseModel):
    name: str = "default"
    sceneObjects: List[dict] = []
    plannerWaypoints: List[dict] = []
    generatedCode: str = ""

class SignupRequest(BaseModel):
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


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def list_users():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT username, role FROM users ORDER BY role ASC, username ASC"
    ).fetchall()
    conn.close()
    return [{"username": row["username"], "role": row["role"]} for row in rows]


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
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            name TEXT NOT NULL,
            scene_objects TEXT NOT NULL DEFAULT '[]',
            planner_waypoints TEXT NOT NULL DEFAULT '[]',
            generated_code TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, name)
        )
        """
    )
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
        "SELECT id, student, name, code, status, created_at FROM queue ORDER BY created_at ASC"
    ).fetchall()
    conn.close()
    return [
        {
            "id": row["id"],
            "student": row["student"],
            "name": row["name"],
            "code": row["code"],
            "status": row["status"],
            "created_at": row["created_at"],
        }
        for row in rows
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


def insert_queue_item(student: str, name: str, code: str):
    item_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db_connection()
    conn.execute(
        "INSERT INTO queue (id, student, name, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (item_id, student, name, code, "queued", now),
    )
    conn.commit()
    conn.close()
    return {"id": item_id, "student": student, "name": name, "code": code, "status": "queued", "created_at": now}


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
        "SELECT username, name, scene_objects, planner_waypoints, generated_code FROM projects WHERE username = ? ORDER BY updated_at DESC",
        (username,),
    ).fetchall()
    conn.close()
    return [
        {
            "username": row["username"],
            "name": row["name"],
            "sceneObjects": __safe_json_load(row["scene_objects"]),
            "plannerWaypoints": __safe_json_load(row["planner_waypoints"]),
            "generatedCode": row["generated_code"],
        }
        for row in rows
    ]


def list_all_projects_for_teacher():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT username, name, scene_objects, planner_waypoints, generated_code FROM projects ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [
        {
            "username": row["username"],
            "name": row["name"],
            "sceneObjects": __safe_json_load(row["scene_objects"]),
            "plannerWaypoints": __safe_json_load(row["planner_waypoints"]),
            "generatedCode": row["generated_code"],
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


def get_project_for_user(username: str, name: str = "default"):
    conn = get_db_connection()
    row = conn.execute(
        "SELECT name, scene_objects, planner_waypoints, generated_code FROM projects WHERE username = ? AND name = ?",
        (username, name),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "name": row["name"],
        "sceneObjects": __safe_json_load(row["scene_objects"]),
        "plannerWaypoints": __safe_json_load(row["planner_waypoints"]),
        "generatedCode": row["generated_code"],
    }


def save_project_for_user(username: str, payload: dict):
    name = (payload.get("name") or "default").strip() or "default"
    conn = get_db_connection()
    conn.execute(
        """
        INSERT INTO projects (username, name, scene_objects, planner_waypoints, generated_code)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(username, name)
        DO UPDATE SET scene_objects = excluded.scene_objects,
                      planner_waypoints = excluded.planner_waypoints,
                      generated_code = excluded.generated_code,
                      updated_at = CURRENT_TIMESTAMP
        """,
        (
            username,
            name,
            json.dumps(payload.get("sceneObjects", [])),
            json.dumps(payload.get("plannerWaypoints", [])),
            payload.get("generatedCode", ""),
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


@app.post("/api/classroom/signup")
def classroom_signup(request: SignupRequest):
    username = request.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    if len(request.password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")

    role = request.role.strip().lower() if request.role else "student"
    if role not in {"teacher", "student"}:
        raise HTTPException(status_code=400, detail="Role must be teacher or student")

    existing = get_user_by_username(username)
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")

    conn = get_db_connection()
    conn.execute(
        "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
        (username, request.password, role),
    )
    conn.commit()
    conn.close()

    token = uuid.uuid4().hex
    SESSION_TOKENS[token] = username
    return {"token": token, "user": {"username": username, "role": role}}


@app.post("/api/classroom/login")
def classroom_login(request: LoginRequest):
    normalized = request.username.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Username is required")

    user = get_user_by_username(normalized)
    if user is None:
        user = {
            "username": normalized,
            "password": request.password,
            "role": request.role or "student",
        }
        conn = get_db_connection()
        conn.execute(
            "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
            (user["username"], user["password"], user["role"]),
        )
        conn.commit()
        conn.close()

    if user["password"] != request.password:
        raise HTTPException(status_code=401, detail="Incorrect password")

    if request.role and user["role"] != request.role:
        raise HTTPException(status_code=403, detail="This account is not allowed to log in as that role")

    token = uuid.uuid4().hex
    SESSION_TOKENS[token] = normalized
    return {"token": token, "user": {"username": normalized, "role": user["role"]}}


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
def submit_code(user: dict = Depends(auth_required), request: SaveCodeRequest = None):
    if not request:
        raise HTTPException(status_code=400, detail="Missing code payload")
    item = insert_queue_item(user["username"], request.name, request.code)
    return {"status": "submitted", "item": item}


@app.get("/api/classroom/queue")
def queue_items(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    return {"items": list_queue_items()}


@app.post("/api/classroom/run-next")
def run_next(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")

    if not _QUEUE_RUN_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A queued robot program is already running.")
    try:
        queue = list_queue_items()
        for item in queue:
            if item["status"] == "queued":
                set_queue_item_status(item["id"], "running")
                item["status"] = "running"
                try:
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

        raise HTTPException(status_code=404, detail="No queued student jobs")
    finally:
        _QUEUE_RUN_LOCK.release()


@app.post("/api/classroom/stop-current")
def stop_current(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
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


@app.post("/api/run")
def run_code(request: CodeRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    return execute_robot_program(request.code)

@app.post("/api/robot/connect")
def robot_connect(request: ConnectRobotRequest, user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    return connect_robot(request.interface)

@app.get("/api/robot/status")
def get_robot_status(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
    return robot_status()

@app.post("/api/stop")
def stop_code(user: dict = Depends(auth_required)):
    if user["role"] != "teacher":
        raise HTTPException(status_code=403, detail="Teacher role required")
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