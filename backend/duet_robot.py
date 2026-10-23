from __future__ import annotations

import ast
import fcntl
import json
import math
import os
import socket
import threading
import time
import uuid
from pathlib import Path

DUET_ROBOT_MODEL = "g1_23dof"
DUET_PROTOCOL = "uni-edu-duet-v1"
DUET_BASE_CAPABILITIES = {"base_velocity", "wait", "stop"}
DUET_ALLOWED_CAPABILITIES = DUET_BASE_CAPABILITIES | {"arm_pose"}
DUET_MOVEMENT_PRESETS = {
    "forward": (0.15, 0.0, 0.0),
    "backward": (-0.1, 0.0, 0.0),
    "strafe_left": (0.0, 0.1, 0.0),
    "strafe_right": (0.0, -0.1, 0.0),
    "turn_left": (0.0, 0.0, 0.25),
    "turn_right": (0.0, 0.0, -0.25),
    "arc_forward_left": (0.12, 0.0, 0.2),
    "arc_forward_right": (0.12, 0.0, -0.2),
    "arc_backward_left": (-0.08, 0.0, 0.2),
    "arc_backward_right": (-0.08, 0.0, -0.2),
}
DUET_ARM_POSES = {"carry", "forward", "box_hold"}
DUET_ARM_MOTIONS = {
    "reach_and_return": ("forward", "carry"),
    "receive_and_hold": ("forward", "box_hold"),
    "hold_and_return": ("box_hold", "carry"),
    "receive_hold_return": ("forward", "box_hold", "carry"),
}
MAX_EXPANDED_COMMANDS = 100
MAX_PROGRAM_SECONDS = 30.0
COMMAND_LEASE_MS = 250
COMMAND_REFRESH_SECONDS = 0.1

_run_lock = threading.Lock()
_run_state_lock = threading.Lock()
_stop_requested = threading.Event()


class DuetControllerError(RuntimeError):
    pass


class DuetProgramValidationError(DuetControllerError):
    pass


def _gateway_configuration() -> tuple[Path, Path]:
    configured = os.getenv("DUET_CONTROL_DIR", "").strip()
    control_dir = Path(configured).expanduser() if configured else Path.home() / ".cache" / "uni-edu-duet"
    if not control_dir.is_absolute():
        raise DuetControllerError("DUET_CONTROL_DIR must be an absolute local directory path.")
    return control_dir / "controller.sock", control_dir / "controller.lock"


def _gateway_request(command: str) -> dict:
    socket_path, _ = _gateway_configuration()
    if not command or len(command) > 512 or "\n" in command or "\r" in command:
        raise DuetControllerError("Invalid DUET local gateway request.")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(1.0)
            client.connect(str(socket_path))
            client.sendall(f"{command}\n".encode("ascii"))
            response = bytearray()
            while len(response) <= 4096 and b"\n" not in response:
                chunk = client.recv(512)
                if not chunk:
                    break
                response.extend(chunk)
    except (OSError, UnicodeEncodeError) as error:
        raise DuetControllerError(f"DUET controller local gateway is unreachable: {error}") from error
    if len(response) > 4096 or b"\n" not in response:
        raise DuetControllerError("DUET controller local gateway returned an incomplete or oversized response.")
    try:
        result = json.loads(bytes(response).split(b"\n", 1)[0])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DuetControllerError("DUET controller local gateway returned invalid JSON.") from error
    if not isinstance(result, dict):
        raise DuetControllerError("DUET controller local gateway returned an invalid response shape.")
    if isinstance(result.get("error"), str):
        raise DuetControllerError(f"DUET controller rejected the request: {result['error']}")
    return result


def _controller_process_lock_held(lock_path: Path) -> bool:
    try:
        descriptor = os.open(lock_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return False
    except OSError as error:
        raise DuetControllerError(f"Could not verify DUET controller ownership lock: {error}") from error
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        else:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            return False
    finally:
        os.close(descriptor)


def _require_hardware_acceptance() -> str:
    if os.getenv("DUET_PHYSICAL_ENABLED", "").strip().lower() != "true":
        raise DuetControllerError(
            "DUET physical execution is disabled until supervised G1 hardware acceptance is completed."
        )
    policy_id = os.getenv("DUET_EXPECTED_POLICY_ID", "").strip()
    acceptance_id = os.getenv("DUET_HARDWARE_ACCEPTANCE_ID", "").strip()
    if not policy_id or policy_id == "unverified" or not acceptance_id:
        raise DuetControllerError(
            "A verified DUET_EXPECTED_POLICY_ID and DUET_HARDWARE_ACCEPTANCE_ID are required after hardware acceptance."
        )
    return policy_id


def _finite_number(value: ast.AST, label: str) -> float:
    sign = 1.0
    if isinstance(value, ast.UnaryOp) and isinstance(value.op, (ast.USub, ast.UAdd)):
        sign = -1.0 if isinstance(value.op, ast.USub) else 1.0
        value = value.operand
    if not isinstance(value, ast.Constant) or isinstance(value.value, bool):
        raise DuetControllerError(f"{label} must be a numeric literal.")
    if not isinstance(value.value, (int, float)):
        raise DuetControllerError(f"{label} must be a numeric literal.")
    number = sign * float(value.value)
    if not (-1e6 < number < 1e6):
        raise DuetControllerError(f"{label} is outside the supported numeric range.")
    return number


def _command_from_call(call: ast.Call, line_number: int) -> dict:
    function = call.func
    if (
        not isinstance(function, ast.Attribute)
        or not isinstance(function.value, ast.Name)
        or function.value.id != "duet"
    ):
        raise DuetControllerError(f"Only duet.* commands are allowed (line {line_number}).")
    if call.keywords:
        raise DuetControllerError(f"Keyword arguments are not supported (line {line_number}).")
    method = function.attr
    args = call.args

    if method == "move" and len(args) == 4:
        vx = _finite_number(args[0], "forward m/s")
        vy = _finite_number(args[1], "lateral m/s")
        yaw_rate = _finite_number(args[2], "yaw rad/s")
        duration = _finite_number(args[3], "duration")
        if not -0.2 <= vx <= 0.3:
            raise DuetControllerError("forward m/s must be between -0.2 and 0.3.")
        if not -0.15 <= vy <= 0.15:
            raise DuetControllerError("lateral m/s must be between -0.15 and 0.15.")
        if not -0.35 <= yaw_rate <= 0.35:
            raise DuetControllerError("yaw rad/s must be between -0.35 and 0.35.")
        if not 0.1 <= duration <= 3:
            raise DuetControllerError("duration must be between 0.1 and 3 seconds.")
        return {
            "type": "move",
            "vx_mps": vx,
            "vy_mps": vy,
            "yaw_rate_rps": yaw_rate,
            "duration_s": duration,
        }
    if method in DUET_MOVEMENT_PRESETS and len(args) == 1:
        duration = _finite_number(args[0], "duration")
        if not 0.1 <= duration <= 3:
            raise DuetControllerError("duration must be between 0.1 and 3 seconds.")
        vx, vy, yaw_rate = DUET_MOVEMENT_PRESETS[method]
        return {
            "type": "move",
            "vx_mps": vx,
            "vy_mps": vy,
            "yaw_rate_rps": yaw_rate,
            "duration_s": duration,
        }
    if method == "arm_pose" and len(args) == 2:
        pose = args[0]
        if not isinstance(pose, ast.Constant) or not isinstance(pose.value, str):
            raise DuetControllerError("arm pose must be a named preset string.")
        pose_name = pose.value.strip().lower()
        if pose_name not in DUET_ARM_POSES:
            raise DuetControllerError(f"Unsupported DUET arm pose '{pose_name}'.")
        duration = _finite_number(args[1], "arm pose lease duration")
        if not 1 <= duration <= 3:
            raise DuetControllerError("arm pose lease duration must be between 1 and 3 seconds.")
        return {"type": "arm_pose", "pose": pose_name, "duration_s": duration}
    if method == "arm_motion" and len(args) == 2:
        motion = args[0]
        if not isinstance(motion, ast.Constant) or not isinstance(motion.value, str):
            raise DuetControllerError("arm motion must be a named preset string.")
        motion_name = motion.value.strip().lower()
        poses = DUET_ARM_MOTIONS.get(motion_name)
        if poses is None:
            raise DuetControllerError(
                f"Unsupported DUET arm motion '{motion_name}'."
            )
        duration = _finite_number(args[1], "arm pose lease duration")
        if not 1 <= duration <= 3:
            raise DuetControllerError("arm pose lease duration must be between 1 and 3 seconds.")
        return [
            {"type": "arm_pose", "pose": pose, "duration_s": duration}
            for pose in poses
        ]
    if method == "wait" and len(args) == 1:
        duration = _finite_number(args[0], "duration")
        if not 0.1 <= duration <= 3:
            raise DuetControllerError("wait duration must be between 0.1 and 3 seconds.")
        return {"type": "wait", "duration_s": duration}
    if method == "stop" and not args:
        return {"type": "stop"}
    if method not in {"move", *DUET_MOVEMENT_PRESETS, "arm_pose", "arm_motion", "wait", "stop"}:
        raise DuetControllerError(f"Unknown DUET command 'duet.{method}' (line {line_number}).")
    raise DuetControllerError(f"duet.{method} has an invalid number of arguments (line {line_number}).")


def _parse_duet_program(code: str) -> list[dict]:
    if not isinstance(code, str) or len(code) > 20_000:
        raise DuetControllerError("DUET program must be text no longer than 20,000 characters.")
    try:
        tree = ast.parse(code or "", mode="exec")
    except SyntaxError as error:
        raise DuetControllerError(f"Invalid DUET program syntax on line {error.lineno}.") from error

    def visit(statements: list[ast.stmt], depth: int = 0) -> list[dict]:
        if depth > 5:
            raise DuetControllerError("DUET programs may be nested at most five levels.")
        parsed: list[dict] = []
        for statement in statements:
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                command = _command_from_call(statement.value, statement.lineno)
                parsed.extend(command if isinstance(command, list) else [command])
            elif (
                isinstance(statement, ast.For)
                and isinstance(statement.target, ast.Name)
                and statement.target.id == "_"
                and isinstance(statement.iter, ast.Call)
                and isinstance(statement.iter.func, ast.Name)
                and statement.iter.func.id == "range"
                and len(statement.iter.args) == 1
                and not statement.iter.keywords
                and isinstance(statement.iter.args[0], ast.Constant)
                and isinstance(statement.iter.args[0].value, int)
                and not isinstance(statement.iter.args[0].value, bool)
            ):
                repeat_count = statement.iter.args[0].value
                if not 1 <= repeat_count <= 10:
                    raise DuetControllerError(f"Loop count on line {statement.lineno} must be between 1 and 10.")
                if statement.orelse:
                    raise DuetControllerError("DUET loops may not contain else clauses.")
                nested = visit(statement.body, depth + 1)
                if not nested:
                    raise DuetControllerError(f"Loop on line {statement.lineno} has no commands.")
                parsed.extend(nested * repeat_count)
            else:
                raise DuetControllerError(f"Unsupported DUET statement on line {getattr(statement, 'lineno', 1)}.")
            if len(parsed) > MAX_EXPANDED_COMMANDS:
                raise DuetControllerError(f"DUET programs may contain at most {MAX_EXPANDED_COMMANDS} expanded commands.")
        return parsed

    commands = visit(tree.body)
    if not commands:
        raise DuetControllerError("DUET program contains no commands.")
    for index, command in enumerate(commands[:-1]):
        if command["type"] == "stop":
            raise DuetControllerError("duet.stop() must be the final command in a program.")
    total_seconds = sum(command.get("duration_s", 0.0) for command in commands)
    if total_seconds > MAX_PROGRAM_SECONDS:
        raise DuetControllerError(f"DUET program duration may not exceed {MAX_PROGRAM_SECONDS:g} seconds.")
    return commands


def parse_duet_program(code: str) -> list[dict]:
    try:
        return _parse_duet_program(code)
    except DuetProgramValidationError:
        raise
    except DuetControllerError as error:
        raise DuetProgramValidationError(str(error)) from error


def _validate_controller_status(status: dict) -> dict:
    expected_policy_id = os.getenv("DUET_EXPECTED_POLICY_ID", "").strip()
    if not expected_policy_id:
        raise DuetControllerError("DUET_EXPECTED_POLICY_ID is not configured for the deployed policy.")
    if status.get("protocol") != DUET_PROTOCOL:
        raise DuetControllerError(f"DUET controller protocol must be {DUET_PROTOCOL}.")
    if status.get("robot_model") != DUET_ROBOT_MODEL:
        raise DuetControllerError(f"Connected robot must report model {DUET_ROBOT_MODEL}.")
    if status.get("policy_id") != expected_policy_id:
        raise DuetControllerError("DUET controller policy identity does not match DUET_EXPECTED_POLICY_ID.")
    if status.get("lowcmd_owner") not in {"duet", "none", "unknown"}:
        raise DuetControllerError("DUET controller reported an invalid rt/lowcmd owner.")
    if not all(
        isinstance(status.get(field), bool)
        for field in ("connected", "ready", "motion_active", "control_lease")
    ):
        raise DuetControllerError(
            "DUET controller must report boolean connected, ready, motion_active, and control_lease fields."
        )
    capabilities = status.get("capabilities")
    if (
        not isinstance(capabilities, list)
        or not all(isinstance(capability, str) for capability in capabilities)
        or len(capabilities) != len(set(capabilities))
        or not DUET_BASE_CAPABILITIES.issubset(capabilities)
        or not set(capabilities).issubset(DUET_ALLOWED_CAPABILITIES)
    ):
        raise DuetControllerError("DUET controller capabilities do not match the approved command allowlist.")
    if "arm_pose" in capabilities and not isinstance(status.get("arm_pose_active"), bool):
        raise DuetControllerError("An arm-pose capable controller must report boolean arm_pose_active status.")
    if status.get("ready") is True and status.get("connected") is not True:
        raise DuetControllerError("A ready DUET controller must also report connected.")
    if status.get("control_lease") is True and status.get("ready") is not True:
        raise DuetControllerError("A DUET control lease requires a ready controller.")
    if (
        status.get("connected") is True
        or status.get("ready") is True
        or status.get("motion_active") is True
        or status.get("control_lease") is True
    ) and status.get("lowcmd_owner") != "duet":
        raise DuetControllerError("An active DUET controller must be the sole rt/lowcmd owner.")
    if status.get("lowcmd_owner") == "unknown":
        raise DuetControllerError("DUET controller ownership is unknown.")
    return status


def controller_status() -> dict:
    try:
        socket_path, lock_path = _gateway_configuration()
    except DuetControllerError as error:
        return {
            "status": "unavailable",
            "connected": False,
            "ready": False,
            "controlLease": False,
            "motionOwner": "unknown",
            "motionActive": None,
            "programActive": _run_lock.locked(),
            "error": str(error),
        }
    try:
        status = _gateway_request("STATUS")
    except DuetControllerError as error:
        try:
            controller_running = _controller_process_lock_held(lock_path)
        except DuetControllerError as lock_error:
            return {
                "status": "unavailable",
                "connected": False,
                "ready": False,
                "controlLease": False,
                "motionOwner": "unknown",
                "motionActive": None,
                "programActive": _run_lock.locked(),
                "error": str(lock_error),
            }
        if not controller_running:
            return {
                "status": "disconnected",
                "connected": False,
                "ready": False,
                "controlLease": False,
                "motionOwner": "none",
                "motionActive": False,
                "programActive": _run_lock.locked(),
                "error": None,
            }
        return {
            "status": "unavailable",
            "connected": False,
            "ready": False,
            "controlLease": False,
            "motionOwner": "unknown",
            "motionActive": None,
            "programActive": _run_lock.locked(),
            "error": str(error),
        }
    try:
        _validate_controller_status(status)
    except DuetControllerError as error:
        return {
            "status": "unavailable",
            "connected": False,
            "ready": False,
            "controlLease": False,
            "motionOwner": "unknown",
            "motionActive": None,
            "programActive": _run_lock.locked(),
            "error": str(error),
        }
    return {
        "status": "connected" if status.get("connected") is True else "disconnected",
        "connected": status.get("connected") is True,
        "ready": status.get("ready") is True,
        "controlLease": status.get("control_lease") is True,
        "motionOwner": status.get("lowcmd_owner"),
        "motionActive": status.get("motion_active") is True,
        "armPoseActive": status.get("arm_pose_active") is True,
        "programActive": _run_lock.locked(),
        "robotModel": status.get("robot_model"),
        "policyId": status.get("policy_id"),
        "capabilities": status.get("capabilities", []),
        "error": None,
    }


def controller_owns_motion() -> tuple[bool, str | None]:
    status = controller_status()
    if status["motionOwner"] == "unknown":
        return True, f"DUET ownership could not be verified: {status['error']}"
    return status["motionOwner"] == "duet", None


def _stop_gateway_command() -> dict:
    status = _validate_controller_status(_gateway_request("STOP"))
    if status.get("motion_active") is not False:
        raise DuetControllerError("DUET gateway did not confirm an inactive velocity command after STOP.")
    if "arm_pose" in status["capabilities"] and status.get("arm_pose_active") is not False:
        raise DuetControllerError("DUET gateway did not confirm that the arm-pose lease ended after STOP.")
    return status


def connect_controller() -> dict:
    _require_hardware_acceptance()
    result = _gateway_request("ACQUIRE")
    _validate_controller_status(result)
    if (
        result.get("connected") is not True
        or result.get("ready") is not True
        or result.get("control_lease") is not True
        or result.get("lowcmd_owner") != "duet"
    ):
        raise DuetControllerError("DUET controller did not confirm readiness and an acquired control lease.")
    return {
        "status": "connected",
        "connected": True,
        "ready": True,
        "controlLease": True,
        "motionOwner": "duet",
        "motionActive": result.get("motion_active") is True,
        "armPoseActive": result.get("arm_pose_active") is True,
        "programActive": _run_lock.locked(),
        "robotModel": result.get("robot_model"),
        "policyId": result.get("policy_id"),
        "capabilities": result.get("capabilities", []),
        "error": None,
    }


def execute_program(code: str) -> dict:
    commands = parse_duet_program(code)
    _require_hardware_acceptance()
    with _run_state_lock:
        if not _run_lock.acquire(blocking=False):
            raise DuetControllerError("A DUET program is already running.")
        _stop_requested.clear()
    program_id = str(uuid.uuid4())
    executed = 0
    try:
        status = _validate_controller_status(_gateway_request("STATUS"))
        if (
            status.get("connected") is not True
            or status.get("ready") is not True
            or status.get("control_lease") is not True
            or status.get("lowcmd_owner") != "duet"
        ):
            raise DuetControllerError("DUET controller must be ready and connected before running a program.")
        if any(command["type"] == "arm_pose" for command in commands) and "arm_pose" not in status["capabilities"]:
            raise DuetControllerError("The DUET controller has not enabled its separately accepted arm-pose capability.")

        for command in parse_duet_program(code):
            if _stop_requested.is_set():
                break
            if command["type"] == "move":
                deadline = time.monotonic() + command["duration_s"]
                while time.monotonic() < deadline:
                    if _stop_requested.is_set():
                        break
                    request = (
                        f"MOVE {command['vx_mps']:.6f} {command['vy_mps']:.6f} "
                        f"{command['yaw_rate_rps']:.6f} {COMMAND_LEASE_MS}"
                    )
                    status = _validate_controller_status(_gateway_request(request))
                    if status.get("control_lease") is not True or status.get("ready") is not True:
                        raise DuetControllerError("DUET control lease or controller readiness was lost during motion.")
                    remaining = deadline - time.monotonic()
                    if remaining > 0 and _stop_requested.wait(min(COMMAND_REFRESH_SECONDS, remaining)):
                        break
                status = _stop_gateway_command()
                if _stop_requested.is_set():
                    break
            elif command["type"] == "wait":
                _stop_gateway_command()
                _stop_requested.wait(command["duration_s"])
                if _stop_requested.is_set():
                    break
            elif command["type"] == "arm_pose":
                duration_ms = int(command["duration_s"] * 1000)
                status = _validate_controller_status(_gateway_request(
                    f"ARM_POSE {command['pose']} {duration_ms}"
                ))
                if (
                    status.get("control_lease") is not True
                    or status.get("ready") is not True
                    or "arm_pose" not in status["capabilities"]
                    or status.get("arm_pose_active") is not True
                ):
                    raise DuetControllerError(
                        "DUET gateway did not confirm the requested arm pose, acceptance gate, and active lease."
                    )
                if _stop_requested.wait(command["duration_s"]):
                    break
            elif command["type"] == "stop":
                _stop_requested.set()
                _stop_gateway_command()
                break
            executed += 1
        return {
            "status": "stopped" if _stop_requested.is_set() else "completed",
            "programId": program_id,
            "commandsExecuted": executed,
            "physicalMovementVerified": False,
        }
    except DuetControllerError as error:
        try:
            _stop_gateway_command()
        except DuetControllerError as stop_error:
            raise DuetControllerError(
                f"{error} A stop could not be confirmed: {stop_error}"
            ) from stop_error
        raise
    finally:
        _run_lock.release()


def stop_controller() -> dict:
    with _run_state_lock:
        _stop_requested.set()
        if not _run_lock.acquire(timeout=5):
            raise DuetControllerError("Could not confirm that the active DUET program stopped.")
        try:
            status = _stop_gateway_command()
        finally:
            _run_lock.release()
    return {
        "status": "stopped",
        "connected": status.get("connected"),
        "ready": status.get("ready"),
        "controlLease": status.get("control_lease"),
        "motionOwner": status.get("lowcmd_owner"),
        "motionActive": status.get("motion_active"),
        "zeroCommandConfirmed": True,
        "physicalStopVerified": False,
        "programActive": _run_lock.locked(),
        "warning": (
            "DUET confirmed a zero velocity command and cleared its arm-pose lease, "
            "requesting the controller's carry/default return; physical immobility or pose attainment is not verified. "
            "The controller still owns rt/lowcmd until its process is stopped."
        ),
    }


def disconnect_controller() -> dict:
    with _run_state_lock:
        _stop_requested.set()
        if not _run_lock.acquire(timeout=5):
            raise DuetControllerError("Could not confirm that the active DUET program stopped; control lease was not released.")
        try:
            _stop_gateway_command()
            result = _gateway_request("RELEASE")
            _validate_controller_status(result)
            if result.get("control_lease") is True or result.get("motion_active") is True:
                raise DuetControllerError("DUET controller did not confirm zero motion and release of the app control lease.")
        finally:
            _run_lock.release()
    return {
        "status": "released",
        "connected": result.get("connected"),
        "ready": result.get("ready"),
        "controlLease": result.get("control_lease"),
        "motionOwner": result.get("lowcmd_owner"),
        "programActive": _run_lock.locked(),
        "warning": (
            "The app control lease is released, the arm-pose request is cleared, and joystick input may resume in Velocity mode. "
            "Stop the DUET controller process before using the legacy SDK."
        ),
    }
