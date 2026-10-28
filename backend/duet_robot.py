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

try:
    from .lidar_distance import (
        DistanceSensorError,
        get_front_distance_sample,
        get_rear_distance_sample,
    )
except ImportError:
    from lidar_distance import (
        DistanceSensorError,
        get_front_distance_sample,
        get_rear_distance_sample,
    )

DUET_ROBOT_MODEL = "g1_23dof"
DUET_PROTOCOL = "uni-edu-duet-v1"
DUET_BASE_CAPABILITIES = {"base_velocity", "wait", "stop"}
DUET_ALLOWED_CAPABILITIES = DUET_BASE_CAPABILITIES | {"arm_pose", "arm_targets"}
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
DUET_ARM_CATALOG_PATH = Path(__file__).resolve().parent.parent / "src" / "sim" / "duetArmCatalog.json"
with DUET_ARM_CATALOG_PATH.open(encoding="utf-8") as _catalog_file:
    DUET_ARM_CATALOG = json.load(_catalog_file)

_ARM_DEFAULT = DUET_ARM_CATALOG["defaultArm"]
_ARM_WORKSPACE = (
    (-2.0, 1.0), (-0.25, 1.6), (-1.0, 1.0), (-0.5, 1.6), (-1.5, 1.5),
    (-2.0, 1.0), (-1.6, 0.25), (-1.0, 1.0), (-0.5, 1.6), (-1.5, 1.5),
)


def _mirror_arm_target(target: list[float]) -> list[float]:
    return [target[0], -target[1], -target[2], target[3], -target[4]]


def _resolve_arm_pose_target(pose_name: str) -> list[float]:
    definition = DUET_ARM_CATALOG["poses"].get(pose_name)
    if definition is None and pose_name.startswith("right_"):
        definition = DUET_ARM_CATALOG["poses"].get(pose_name.replace("right_", "left_", 1))
    if definition is None:
        raise DuetProgramValidationError(f"Unsupported DUET arm pose '{pose_name}'.")

    if "left" in definition and "right" in definition:
        target = [*definition["left"], *definition["right"]]
    else:
        side = definition.get("side", "right" if pose_name.startswith("right_") else "left")
        arm_target = definition["target"]
        left = _ARM_DEFAULT.copy()
        right = _mirror_arm_target(_ARM_DEFAULT)
        if pose_name.startswith("right_") and definition.get("side") == "left":
            right = _mirror_arm_target(arm_target)
        elif side == "left":
            left = arm_target
        else:
            right = arm_target
        target = [*left, *right]

    if len(target) != 10 or any(
        not math.isfinite(value) or value < _ARM_WORKSPACE[index][0] or value > _ARM_WORKSPACE[index][1]
        for index, value in enumerate(target)
    ):
        raise DuetProgramValidationError(f"DUET arm pose '{pose_name}' exceeds the approved joint workspace.")
    return [float(value) for value in target]


DUET_ARM_POSE_TARGETS = {
    pose_name: _resolve_arm_pose_target(pose_name)
    for pose_name in DUET_ARM_CATALOG["poses"]
}
for _pose_name in tuple(DUET_ARM_POSE_TARGETS):
    if _pose_name.startswith("left_"):
        _right_name = _pose_name.replace("left_", "right_", 1)
        DUET_ARM_POSE_TARGETS.setdefault(_right_name, _resolve_arm_pose_target(_right_name))
DUET_ARM_POSES = set(DUET_ARM_POSE_TARGETS)
DUET_ARM_LEVELS = {"low", "mid", "high"}
DUET_ARM_MOTIONS = {
    "reach_and_return": ("forward", "carry"),
    "receive_and_hold": ("forward", "box_hold"),
    "hold_and_return": ("box_hold", "carry"),
    "receive_hold_return": ("forward", "box_hold", "carry"),
    "wave_left": {
        "low": ("left_wave_low", "left_wave_low_out", "left_wave_low", "left_wave_low_out", "carry"),
        "mid": ("left_wave_mid", "left_wave_mid_out", "left_wave_mid", "left_wave_mid_out", "carry"),
        "high": ("left_wave_high", "left_wave_high_out", "left_wave_high", "left_wave_high_out", "carry"),
    },
    "wave_right": {
        "low": ("right_wave_low", "right_wave_low_out", "right_wave_low", "right_wave_low_out", "carry"),
        "mid": ("right_wave_mid", "right_wave_mid_out", "right_wave_mid", "right_wave_mid_out", "carry"),
        "high": ("right_wave_high", "right_wave_high_out", "right_wave_high", "right_wave_high_out", "carry"),
    },
    "raise_left_arm": {
        "low": ("left_raise_low", "carry"),
        "mid": ("left_raise_mid", "carry"),
        "high": ("left_raise_high", "carry"),
    },
    "raise_right_arm": {
        "low": ("right_raise_low", "carry"),
        "mid": ("right_raise_mid", "carry"),
        "high": ("right_raise_high", "carry"),
    },
    "raise_both_arms": {
        "low": ("both_raise_low", "carry"),
        "mid": ("both_raise_mid", "carry"),
        "high": ("both_raise_high", "carry"),
    },
}
DUET_ARM_COMMANDS = {
    "arm_carry": ("carry",),
    "arm_reach": ("forward",),
    "arm_box_hold": ("box_hold",),
    "reach_and_return": DUET_ARM_MOTIONS["reach_and_return"],
    "receive_and_hold": DUET_ARM_MOTIONS["receive_and_hold"],
    "hold_and_return": DUET_ARM_MOTIONS["hold_and_return"],
    "receive_hold_return": DUET_ARM_MOTIONS["receive_hold_return"],
    **{
        f"{method}_{level}": poses
        for method, levels in DUET_ARM_MOTIONS.items()
        if isinstance(levels, dict)
        for level, poses in levels.items()
    },
}
DUET_ARM_GESTURES = {
    f"gesture_{name.removeprefix('legacy_')}": tuple(
        {"pose": pose, "target": _resolve_arm_pose_target(pose)}
        for pose in definition["poses"]
    )
    for name, definition in DUET_ARM_CATALOG["gestures"].items()
}
MAX_EXPANDED_COMMANDS = 400
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


def _named_pose_argument(value: ast.AST, label: str) -> str:
    if (
        not isinstance(value, ast.Call)
        or not isinstance(value.func, ast.Attribute)
        or not isinstance(value.func.value, ast.Name)
        or value.func.value.id != "duet"
        or value.func.attr != "pose"
        or value.keywords
        or len(value.args) != 1
        or not isinstance(value.args[0], ast.Constant)
        or not isinstance(value.args[0].value, str)
    ):
        raise DuetProgramValidationError(
            f"{label} must use a named draggable pose target, e.g. duet.pose(\"left_raise_mid\")."
        )
    pose_name = value.args[0].value.strip().lower()
    if pose_name not in DUET_ARM_POSE_TARGETS:
        raise DuetProgramValidationError(f"Unsupported DUET arm pose '{pose_name}'.")
    return pose_name


def _distance_condition(statement: ast.If) -> dict:
    comparison = statement.test
    if (
        not isinstance(comparison, ast.Compare)
        or len(comparison.ops) != 1
        or len(comparison.comparators) != 1
    ):
        raise DuetProgramValidationError(
            "DUET conditions must compare a front or rear distance sensor with one numeric threshold."
        )
    sensor = comparison.left
    if (
        not isinstance(sensor, ast.Call)
        or not isinstance(sensor.func, ast.Attribute)
        or not isinstance(sensor.func.value, ast.Name)
        or sensor.func.value.id != "duet"
        or sensor.func.attr not in {"front_distance_m", "rear_distance_m"}
        or sensor.args
        or sensor.keywords
    ):
        raise DuetProgramValidationError(
            "Distance conditions may only read duet.front_distance_m() or duet.rear_distance_m()."
        )
    operator_map = {
        ast.Lt: "<",
        ast.LtE: "<=",
        ast.Gt: ">",
        ast.GtE: ">=",
        ast.Eq: "==",
        ast.NotEq: "!=",
    }
    operator = operator_map.get(type(comparison.ops[0]))
    threshold_node = comparison.comparators[0]
    if operator is None:
        raise DuetProgramValidationError(
            "Distance conditions support <, <=, >, >=, ==, and != comparisons only."
        )
    if (
        not isinstance(threshold_node, ast.Constant)
        or isinstance(threshold_node.value, bool)
        or not isinstance(threshold_node.value, (int, float))
        or not math.isfinite(float(threshold_node.value))
        or not 0.1 <= float(threshold_node.value) <= 40
    ):
        raise DuetProgramValidationError(
            "Distance thresholds must be numeric literals between 0.1 and 40 meters."
        )
    return {
        "type": "distance_condition",
        "sensor": sensor.func.attr,
        "operator": operator,
        "threshold": float(threshold_node.value),
    }


def _distance_condition_result(sample: dict, operator: str, threshold: float) -> bool:
    operators = {
        "<": lambda measured, target: measured < target,
        "<=": lambda measured, target: measured <= target,
        ">": lambda measured, target: measured > target,
        ">=": lambda measured, target: measured >= target,
        "==": lambda measured, target: measured == target,
        "!=": lambda measured, target: measured != target,
    }
    if not sample.get("clear"):
        return operators[operator](float(sample["distance_m"]), threshold)

    minimum_clearance = float(sample["max_range_m"])
    if not math.isfinite(minimum_clearance) or minimum_clearance <= 0:
        raise DistanceSensorError("Clear LiDAR sample did not include a valid minimum clearance.")
    if operator == "<" and minimum_clearance >= threshold:
        return False
    if operator == "<=" and minimum_clearance > threshold:
        return False
    if operator == ">" and minimum_clearance > threshold:
        return True
    if operator == ">=" and minimum_clearance >= threshold:
        return True
    if operator == "==" and minimum_clearance > threshold:
        return False
    if operator == "!=" and minimum_clearance > threshold:
        return True
    raise DistanceSensorError(
        f"No-return LiDAR sample only confirms clearance of at least {minimum_clearance:.2f} m; "
        f"comparison {operator} {threshold:g} m is ambiguous."
    )


def _arm_motion_command(method: str, poses: tuple[str, ...], duration: float) -> dict | list[dict]:
    if any(pose not in {"carry", "forward", "box_hold"} for pose in poses):
        return {
            "type": "arm_trajectory",
            "gesture": method,
            "arm_commands": [
                {
                    "type": "arm_target",
                    "pose": pose,
                    "target": DUET_ARM_POSE_TARGETS[pose],
                    "duration_s": duration,
                }
                for pose in poses
            ],
        }
    return [
        {"type": "arm_pose", "pose": pose, "duration_s": duration}
        for pose in poses
    ]


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

    if method in {"hold_pose", "hold_pose_until_reset"}:
        expected = 2 if method == "hold_pose" else 1
        if len(args) != expected:
            raise DuetProgramValidationError(
                f"duet.{method} expects {expected} argument{'s' if expected != 1 else ''} (line {line_number})."
            )
        pose_name = _named_pose_argument(args[0], f"duet.{method}")
        duration = _finite_number(args[1], "arm pose hold duration") if expected == 2 else None
        if duration is not None and not 1 <= duration <= 30:
            raise DuetProgramValidationError("arm pose hold duration must be between 1 and 30 seconds.")
        return {
            "type": "arm_target_hold",
            "pose": pose_name,
            "target": DUET_ARM_POSE_TARGETS[pose_name],
            "duration_s": duration,
            "until_reset": expected == 1,
        }
    if method == "reset_arms" and not args:
        return {"type": "reset_arms"}
    if method == "pose":
        raise DuetProgramValidationError("duet.pose() is a pose target; place it inside a pose hold command.")
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
    if method == "move_and_arm" and len(args) == 6:
        vx = _finite_number(args[0], "forward m/s")
        vy = _finite_number(args[1], "lateral m/s")
        yaw_rate = _finite_number(args[2], "yaw rad/s")
        move_duration = _finite_number(args[3], "move duration")
        pose = args[4]
        if not isinstance(pose, ast.Constant) or not isinstance(pose.value, str):
            raise DuetControllerError("arm pose must be a named preset string.")
        pose_name = pose.value.strip().lower()
        arm_duration = _finite_number(args[5], "arm pose lease duration")
        if not -0.2 <= vx <= 0.3:
            raise DuetControllerError("forward m/s must be between -0.2 and 0.3.")
        if not -0.15 <= vy <= 0.15:
            raise DuetControllerError("lateral m/s must be between -0.15 and 0.15.")
        if not -0.35 <= yaw_rate <= 0.35:
            raise DuetControllerError("yaw rad/s must be between -0.35 and 0.35.")
        if not 0.1 <= move_duration <= 2.5:
            raise DuetControllerError("move duration must be between 0.1 and 2.5 seconds.")
        if pose_name not in DUET_ARM_POSES:
            raise DuetControllerError(f"Unsupported DUET arm pose '{pose_name}'.")
        if not 1 <= arm_duration <= 3:
            raise DuetControllerError("arm pose lease duration must be between 1 and 3 seconds.")
        if arm_duration < move_duration + 0.25:
            raise DuetControllerError("arm pose lease must exceed move duration by at least 0.25 seconds.")
        return {
            "type": "move_and_arm",
            "vx_mps": vx,
            "vy_mps": vy,
            "yaw_rate_rps": yaw_rate,
            "duration_s": move_duration,
            "pose": pose_name,
            "arm_duration_s": arm_duration,
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
    if method in DUET_ARM_GESTURES and len(args) == 1:
        duration = _finite_number(args[0], "seconds per gesture pose")
        if not 1 <= duration <= 3:
            raise DuetControllerError("seconds per gesture pose must be between 1 and 3 seconds.")
        return {
            "type": "arm_trajectory",
            "gesture": method,
            "arm_commands": [
                {
                    "type": "arm_target",
                    "pose": step["pose"],
                    "target": step["target"],
                    "duration_s": duration,
                }
                for step in DUET_ARM_GESTURES[method]
            ],
        }
    if method in DUET_ARM_COMMANDS and len(args) == 1:
        duration = _finite_number(args[0], "arm pose lease duration")
        if not 1 <= duration <= 3:
            raise DuetControllerError("arm pose lease duration must be between 1 and 3 seconds.")
        return _arm_motion_command(method, DUET_ARM_COMMANDS[method], duration)
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
        if isinstance(poses, dict):
            poses = poses.get("mid", tuple())
        return _arm_motion_command(motion_name, poses, duration)
    if method in {"wave_left", "wave_right", "raise_left_arm", "raise_right_arm", "raise_both_arms"} and len(args) == 2:
        level = args[0]
        if not isinstance(level, ast.Constant) or not isinstance(level.value, str):
            raise DuetControllerError(f"{method} requires a named level string.")
        level_name = level.value.strip().lower()
        if level_name not in DUET_ARM_LEVELS:
            raise DuetControllerError(f"Unsupported DUET arm level '{level_name}'.")
        duration = _finite_number(args[1], "arm pose lease duration")
        if not 1 <= duration <= 3:
            raise DuetControllerError("arm pose lease duration must be between 1 and 3 seconds.")
        poses = DUET_ARM_MOTIONS[method][level_name]
        return _arm_motion_command(method, poses, duration)
    if method == "wait" and len(args) == 1:
        duration = _finite_number(args[0], "duration")
        if not 0.1 <= duration <= 3:
            raise DuetControllerError("wait duration must be between 0.1 and 3 seconds.")
        return {"type": "wait", "duration_s": duration}
    if method == "stop" and not args:
        return {"type": "stop"}
    if method not in {"move", "move_and_arm", *DUET_MOVEMENT_PRESETS, "arm_pose", "arm_motion", "wait", "stop"}:
        raise DuetControllerError(f"Unknown DUET command 'duet.{method}' (line {line_number}).")
    raise DuetControllerError(f"duet.{method} has an invalid number of arguments (line {line_number}).")


def _parse_duet_program(code: str) -> list[dict]:
    if not isinstance(code, str) or len(code) > 20_000:
        raise DuetControllerError("DUET program must be text no longer than 20,000 characters.")
    try:
        tree = ast.parse(code or "", mode="exec")
    except SyntaxError as error:
        raise DuetControllerError(f"Invalid DUET program syntax on line {error.lineno}.") from error

    def command_count(command: dict) -> int:
        if command.get("type") == "distance_condition":
            return 1 + max(
                sum(command_count(child) for child in command["then"]),
                sum(command_count(child) for child in command["else"]),
            )
        if command.get("type") == "concurrent":
            return 1 + len(command["arm_commands"])
        if command.get("type") == "arm_trajectory":
            return len(command["arm_commands"])
        return 1

    def visit(statements: list[ast.stmt], depth: int = 0) -> list[dict]:
        if depth > 5:
            raise DuetControllerError("DUET programs may be nested at most five levels.")
        parsed: list[dict] = []
        for statement in statements:
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                command = _command_from_call(statement.value, statement.lineno)
                parsed.extend(command if isinstance(command, list) else [command])
            elif isinstance(statement, ast.If):
                condition = _distance_condition(statement)
                if not statement.body:
                    raise DuetProgramValidationError(
                        f"Distance condition on line {statement.lineno} has no body."
                    )
                condition["then"] = visit(statement.body, depth + 1)
                condition["else"] = visit(statement.orelse, depth + 1) if statement.orelse else []
                parsed.append(condition)
            elif (
                isinstance(statement, ast.With)
                and len(statement.items) == 1
                and statement.items[0].optional_vars is None
                and isinstance(statement.items[0].context_expr, ast.Call)
                and isinstance(statement.items[0].context_expr.func, ast.Attribute)
                and isinstance(statement.items[0].context_expr.func.value, ast.Name)
                and statement.items[0].context_expr.func.value.id == "duet"
                and statement.items[0].context_expr.func.attr == "concurrent"
                and not statement.items[0].context_expr.args
                and not statement.items[0].context_expr.keywords
            ):
                body = statement.body
                if len(body) != 2 or any(
                    not isinstance(item, ast.Expr) or not isinstance(item.value, ast.Call)
                    for item in body
                ):
                    raise DuetControllerError(
                        f"Concurrent action on line {statement.lineno} must contain exactly one locomotion and one arm command."
                    )
                first = _command_from_call(body[0].value, body[0].lineno)
                second = _command_from_call(body[1].value, body[1].lineno)
                children = [first, second]
                movement = next(
                    (child for child in children if isinstance(child, dict) and child.get("type") == "move"),
                    None,
                )
                gesture = next(
                    (
                        child if isinstance(child, list) else (
                            child.get("arm_commands") or [child] if isinstance(child, dict)
                            and child.get("type") in {"arm_trajectory", "arm_target_hold"}
                            else None
                        )
                        for child in children
                        if (
                            isinstance(child, list) and child and all(
                                item.get("type") in {"arm_pose", "arm_target"} for item in child
                            )
                        ) or (
                            isinstance(child, dict)
                            and child.get("type") in {"arm_trajectory", "arm_target_hold"}
                        )
                    ),
                    None,
                )
                if movement is None or gesture is None:
                    raise DuetControllerError(
                        f"Concurrent action on line {statement.lineno} needs one supported locomotion command and one arm gesture."
                    )
                parsed.append({
                    "type": "concurrent",
                    "movement": movement,
                    "arm_commands": gesture,
                })
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
                if not 1 <= repeat_count <= 20:
                    raise DuetControllerError(f"Loop count on line {statement.lineno} must be between 1 and 20.")
                if statement.orelse:
                    raise DuetControllerError("DUET loops may not contain else clauses.")
                nested = visit(statement.body, depth + 1)
                if not nested:
                    raise DuetControllerError(f"Loop on line {statement.lineno} has no commands.")
                parsed.extend(nested * repeat_count)
            else:
                raise DuetControllerError(f"Unsupported DUET statement on line {getattr(statement, 'lineno', 1)}.")
            expanded_count = sum(command_count(item) for item in parsed)
            if expanded_count > MAX_EXPANDED_COMMANDS:
                raise DuetControllerError(f"DUET programs may contain at most {MAX_EXPANDED_COMMANDS} expanded commands.")
        return parsed

    commands = visit(tree.body)
    if not commands:
        raise DuetControllerError("DUET program contains no commands.")

    pose_held_until_reset = False
    for command in commands:
        arm_commands = command.get("arm_commands", []) if command.get("type") == "concurrent" else (
            command.get("arm_commands", []) if command.get("type") == "arm_trajectory" else [command]
        )
        starts_arm_motion = any(
            item.get("type") in {"arm_pose", "arm_target", "arm_target_hold", "arm_trajectory"}
            for item in arm_commands
        )
        if pose_held_until_reset and starts_arm_motion:
            raise DuetProgramValidationError(
                "Reset arms with duet.reset_arms() before starting another arm motion."
            )
        if command.get("type") == "reset_arms":
            pose_held_until_reset = False
        elif any(item.get("type") == "arm_target_hold" and item.get("until_reset") for item in arm_commands):
            pose_held_until_reset = True
    def validate_stop_placement(sequence: list[dict], final_in_parent: bool = True) -> None:
        for index, command in enumerate(sequence):
            final = final_in_parent and index == len(sequence) - 1
            if command["type"] == "stop" and not final:
                raise DuetProgramValidationError(
                    "duet.stop() must be the final command on every execution path."
                )
            if command["type"] == "distance_condition":
                validate_stop_placement(command["then"], final)
                validate_stop_placement(command["else"], final)
            elif command["type"] == "concurrent":
                continue

    validate_stop_placement(commands)

    def validate_arm_reset_flow(sequence: list[dict], possible_states: set[bool]) -> set[bool]:
        states = possible_states
        for command in sequence:
            if command["type"] == "distance_condition":
                states = (
                    validate_arm_reset_flow(command["then"], set(states))
                    | validate_arm_reset_flow(command["else"], set(states))
                )
                continue
            if command["type"] == "concurrent":
                arm_commands = command["arm_commands"]
            elif command["type"] == "arm_trajectory":
                arm_commands = command["arm_commands"]
            else:
                arm_commands = [command]
            starts_arm_motion = any(
                item.get("type") in {"arm_pose", "arm_target", "arm_target_hold", "arm_trajectory"}
                for item in arm_commands
            )
            if True in states and starts_arm_motion:
                raise DuetProgramValidationError(
                    "Reset arms with duet.reset_arms() before starting another arm motion."
                )
            if command["type"] == "reset_arms":
                states = {False}
            elif any(
                item.get("type") == "arm_target_hold" and item.get("until_reset")
                for item in arm_commands
            ):
                states = {True}
        return states

    validate_arm_reset_flow(commands, {False})
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
    if "arm_targets" in capabilities and not isinstance(status.get("arm_targets_active"), bool):
        raise DuetControllerError("An arm-target capable controller must report boolean arm_targets_active status.")
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
        "armTargetsActive": status.get("arm_targets_active") is True,
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
    if "arm_targets" in status["capabilities"] and status.get("arm_targets_active") is not False:
        raise DuetControllerError("DUET gateway did not confirm that the arm-target lease ended after STOP.")
    if "arm_targets" in status["capabilities"]:
        status = _validate_controller_status(_gateway_request("RESET_ARMS"))
        if (
            status.get("motion_active") is not False
            or status.get("arm_targets_active") is not False
            or "arm_pose" in status["capabilities"] and status.get("arm_pose_active") is not False
        ):
            raise DuetControllerError("DUET gateway did not confirm the arms returned to carry/default after STOP.")
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
        "armTargetsActive": result.get("arm_targets_active") is True,
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
        def all_commands(sequence: list[dict]):
            for item in sequence:
                yield item
                if item.get("type") == "distance_condition":
                    yield from all_commands(item["then"])
                    yield from all_commands(item["else"])

        program_commands = list(all_commands(commands))
        requires_arm_pose = any(
            command.get("type") in {"arm_pose", "move_and_arm"}
            or command.get("type") == "concurrent"
            and any(item.get("type") == "arm_pose" for item in command.get("arm_commands", []))
            for command in program_commands
        )
        if requires_arm_pose and "arm_pose" not in status["capabilities"]:
            raise DuetControllerError("The DUET controller has not enabled its separately accepted arm-pose capability.")
        if any(
            command.get("type") in {"arm_target", "arm_target_hold", "arm_trajectory", "reset_arms"}
            or any(item.get("type") in {"arm_target", "arm_target_hold"} for item in command.get("arm_commands", []))
            for command in program_commands
        ) and "arm_targets" not in status["capabilities"]:
            raise DuetControllerError(
                "The installed DUET gateway does not advertise the required bounded arm-target capability."
            )

        active_arm_command: dict | None = None

        def send_arm_command(arm_command: dict, lease_ms: int | None = None) -> dict:
            if arm_command.get("type") == "arm_pose":
                pose_lease_ms = lease_ms or int(arm_command["duration_s"] * 1000)
                request = f"ARM_POSE {arm_command['pose']} {pose_lease_ms}"
                active_field = "arm_pose_active"
            else:
                target = arm_command.get("target")
                if not isinstance(target, list) or len(target) != 10:
                    raise DuetControllerError("DUET arm target must contain exactly ten validated joint positions.")
                target_lease_ms = lease_ms or COMMAND_LEASE_MS
                request = f"ARM_TARGETS {target_lease_ms} " + " ".join(f"{value:.6f}" for value in target)
                active_field = "arm_targets_active"
            result = _validate_controller_status(_gateway_request(request))
            if (
                result.get("control_lease") is not True
                or result.get("ready") is not True
                or active_field not in result
                or result.get(active_field) is not True
            ):
                raise DuetControllerError(
                    f"DUET gateway did not confirm the requested {active_field.replace('_active', '').replace('_', ' ')} lease."
                )
            return result

        def refresh_arm_command() -> None:
            if active_arm_command is not None and active_arm_command.get("type") != "arm_pose":
                send_arm_command(active_arm_command)

        def wait_with_arm_refresh(duration_s: float) -> bool:
            deadline = time.monotonic() + duration_s
            while time.monotonic() < deadline:
                if _stop_requested.is_set():
                    return True
                refresh_arm_command()
                remaining = deadline - time.monotonic()
                if remaining > 0 and _stop_requested.wait(min(COMMAND_REFRESH_SECONDS, remaining)):
                    return True
            return _stop_requested.is_set()

        def reset_arms() -> dict:
            nonlocal active_arm_command
            result = _validate_controller_status(_gateway_request("RESET_ARMS"))
            if result.get("arm_targets_active") is True or result.get("arm_pose_active") is True:
                raise DuetControllerError("DUET gateway did not confirm that the arms reset to carry/default.")
            active_arm_command = None
            return result

        conditions_evaluated: list[dict] = []
        pending_commands = list(reversed(commands))
        while pending_commands:
            command = pending_commands.pop()
            if _stop_requested.is_set():
                break
            if command["type"] == "distance_condition":
                sensor = command["sensor"]
                try:
                    sample = (
                        get_front_distance_sample()
                        if sensor == "front_distance_m"
                        else get_rear_distance_sample()
                    )
                    selected_then = _distance_condition_result(
                        sample,
                        command["operator"],
                        command["threshold"],
                    )
                except DistanceSensorError as error:
                    raise DuetControllerError(
                        f"DUET distance condition aborted safely: {error}. A controller stop was requested."
                    ) from error
                decision = {
                    "sensor": sensor,
                    "operator": command["operator"],
                    "threshold_m": command["threshold"],
                    "distance_m": sample["distance_m"],
                    "clear": bool(sample.get("clear")),
                    "max_range_m": sample.get("max_range_m", 40.0),
                    "age_ms": sample["age_ms"],
                    "branch": "then" if selected_then else "else",
                }
                conditions_evaluated.append(decision)
                pending_commands.extend(reversed(command["then"] if selected_then else command["else"]))
                executed += 1
                continue
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
                    refresh_arm_command()
                    remaining = deadline - time.monotonic()
                    if remaining > 0 and _stop_requested.wait(min(COMMAND_REFRESH_SECONDS, remaining)):
                        break
                if active_arm_command and active_arm_command.get("type") != "arm_pose":
                    _validate_controller_status(_gateway_request(f"MOVE 0 0 0 {COMMAND_LEASE_MS}"))
                    refresh_arm_command()
                else:
                    _stop_gateway_command()
                if _stop_requested.is_set():
                    break
            elif command["type"] == "concurrent":
                movement = command["movement"]
                arm_commands = command["arm_commands"]
                if not arm_commands:
                    raise DuetControllerError("DUET concurrent action has no validated arm commands.")

                started_at = time.monotonic()
                move_deadline = started_at + movement["duration_s"]
                persistent_hold = any(
                    item.get("type") == "arm_target_hold" and item.get("until_reset")
                    for item in arm_commands
                )
                arm_durations = [item.get("duration_s") or 0 for item in arm_commands]
                arm_deadline = started_at + sum(arm_durations)
                if persistent_hold:
                    arm_deadline = move_deadline
                first_arm = arm_commands[0]
                active_arm_command = first_arm
                status = send_arm_command(first_arm)

                pose_index = 0
                next_pose_at = started_at + arm_durations[0]
                while time.monotonic() < max(move_deadline, arm_deadline):
                    if _stop_requested.is_set():
                        _stop_gateway_command()
                        break

                    now = time.monotonic()
                    while pose_index + 1 < len(arm_commands) and now >= next_pose_at:
                        pose_index += 1
                        next_arm = arm_commands[pose_index]
                        active_arm_command = next_arm
                        status = send_arm_command(next_arm)
                        next_pose_at += arm_durations[pose_index]

                    now = time.monotonic()
                    moving = now < move_deadline
                    velocity = movement if moving else {
                        "vx_mps": 0.0,
                        "vy_mps": 0.0,
                        "yaw_rate_rps": 0.0,
                    }
                    request = (
                        f"MOVE {velocity['vx_mps']:.6f} {velocity['vy_mps']:.6f} "
                        f"{velocity['yaw_rate_rps']:.6f} {COMMAND_LEASE_MS}"
                    )
                    status = _validate_controller_status(_gateway_request(request))
                    if status.get("control_lease") is not True or status.get("ready") is not True:
                        raise DuetControllerError(
                            "DUET control lease or controller readiness was lost during concurrent execution."
                        )
                    if now < arm_deadline:
                        refresh_arm_command()
                    if status.get("motion_active") is not moving:
                        expectation = "active" if moving else "inactive"
                        raise DuetControllerError(
                            f"DUET gateway did not confirm {expectation} base motion during concurrent execution."
                        )
                    arm_active = now < arm_deadline
                    active_status_field = (
                        "arm_targets_active"
                        if active_arm_command and active_arm_command.get("type") != "arm_pose"
                        else "arm_pose_active"
                    )
                    if status.get(active_status_field) is not arm_active:
                        expectation = "active" if arm_active else "inactive"
                        raise DuetControllerError(
                            f"DUET gateway did not confirm the arm lease was {expectation} during concurrent execution."
                        )

                    now = time.monotonic()
                    deadline = max(move_deadline, arm_deadline)
                    next_deadline = min(deadline, now + COMMAND_REFRESH_SECONDS)
                    if now < move_deadline:
                        next_deadline = min(next_deadline, move_deadline)
                    if pose_index + 1 < len(arm_commands) and arm_durations[pose_index + 1] > 0:
                        next_deadline = min(next_deadline, next_pose_at)
                    remaining = next_deadline - now
                    if remaining > 0 and _stop_requested.wait(remaining):
                        _stop_gateway_command()
                        break
                else:
                    if persistent_hold:
                        status = _validate_controller_status(_gateway_request(
                            f"MOVE 0 0 0 {COMMAND_LEASE_MS}"
                        ))
                        if (
                            status.get("motion_active") is not False
                            or status.get("arm_targets_active") is not True
                        ):
                            raise DuetControllerError(
                                "DUET gateway did not confirm stopped locomotion while retaining the until-reset arm pose."
                            )
                    elif any(item.get("type") in {"arm_target", "arm_target_hold"} for item in arm_commands):
                        reset_arms()
                    else:
                        _stop_gateway_command()
                if _stop_requested.is_set():
                    break
            elif command["type"] == "move_and_arm":
                arm_duration_ms = int(command["arm_duration_s"] * 1000)
                status = _validate_controller_status(_gateway_request(
                    f"ARM_POSE {command['pose']} {arm_duration_ms}"
                ))
                if (
                    status.get("control_lease") is not True
                    or status.get("ready") is not True
                    or "arm_pose" not in status["capabilities"]
                    or status.get("arm_pose_active") is not True
                ):
                    raise DuetControllerError(
                        "DUET gateway did not confirm the arm pose lease before concurrent movement."
                    )
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
                        raise DuetControllerError("DUET control lease or controller readiness was lost during concurrent motion.")
                    if status.get("motion_active") is not True:
                        raise DuetControllerError("DUET gateway did not confirm active base motion during concurrent execution.")
                    if status.get("arm_pose_active") is not True:
                        raise DuetControllerError("DUET arm-pose lease ended before concurrent movement completed.")
                    remaining = deadline - time.monotonic()
                    if remaining > 0 and _stop_requested.wait(min(COMMAND_REFRESH_SECONDS, remaining)):
                        break
                if _stop_requested.is_set():
                    _stop_gateway_command()
                    break
                status = _validate_controller_status(_gateway_request(
                    f"MOVE 0 0 0 {COMMAND_LEASE_MS}"
                ))
                if (
                    status.get("control_lease") is not True
                    or status.get("ready") is not True
                    or status.get("motion_active") is not False
                    or status.get("arm_pose_active") is not True
                ):
                    raise DuetControllerError(
                        "DUET gateway did not confirm zero base velocity while preserving the arm-pose lease."
                    )
                arm_deadline = time.monotonic() + command["arm_duration_s"] - command["duration_s"]
                while time.monotonic() < arm_deadline:
                    if _stop_requested.is_set():
                        break
                    status = _validate_controller_status(_gateway_request(
                        f"MOVE 0 0 0 {COMMAND_LEASE_MS}"
                    ))
                    if (
                        status.get("control_lease") is not True
                        or status.get("ready") is not True
                        or status.get("motion_active") is not False
                        or status.get("arm_pose_active") is not True
                    ):
                        raise DuetControllerError(
                            "DUET gateway lost zero base velocity or the arm-pose lease during concurrent execution."
                        )
                    remaining = arm_deadline - time.monotonic()
                    if remaining > 0 and _stop_requested.wait(min(COMMAND_REFRESH_SECONDS, remaining)):
                        break
                _stop_gateway_command()
                if _stop_requested.is_set():
                    break
            elif command["type"] == "wait":
                if wait_with_arm_refresh(command["duration_s"]):
                    break
            elif command["type"] == "arm_trajectory":
                for arm_command in command["arm_commands"]:
                    active_arm_command = arm_command
                    send_arm_command(arm_command)
                    if wait_with_arm_refresh(arm_command["duration_s"]):
                        break
                if _stop_requested.is_set():
                    break
            elif command["type"] == "arm_target_hold":
                active_arm_command = command
                send_arm_command(command)
                if not command["until_reset"] and wait_with_arm_refresh(command["duration_s"]):
                    break
                if not command["until_reset"]:
                    reset_arms()
            elif command["type"] == "reset_arms":
                reset_arms()
            elif command["type"] == "arm_pose":
                duration_ms = int(command["duration_s"] * 1000)
                status = send_arm_command(command, duration_ms)
                if (
                    status.get("control_lease") is not True
                    or status.get("ready") is not True
                    or "arm_pose" not in status["capabilities"]
                    or status.get("arm_pose_active") is not True
                ):
                    raise DuetControllerError(
                        "DUET gateway did not confirm the requested arm pose, acceptance gate, and active lease."
                    )
                active_arm_command = command
                if wait_with_arm_refresh(command["duration_s"]):
                    break
                active_arm_command = None
            elif command["type"] == "stop":
                _stop_requested.set()
                _stop_gateway_command()
                active_arm_command = None
                break
            executed += 1
        if active_arm_command is not None:
            if _stop_requested.is_set() or active_arm_command.get("type") == "arm_pose":
                _stop_gateway_command()
            else:
                reset_arms()
        return {
            "status": "stopped" if _stop_requested.is_set() else "completed",
            "programId": program_id,
            "commandsExecuted": executed,
            "physicalMovementVerified": False,
            "conditionsEvaluated": conditions_evaluated,
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
            "DUET confirmed zero velocity, ended active arm leases, and requested the carry/default arm reset; "
            "physical immobility or pose attainment is not verified. "
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
            "The app control lease is released and a carry/default arm reset is requested; joystick input may resume in Velocity mode. "
            "Stop the DUET controller process before using the legacy SDK."
        ),
    }
