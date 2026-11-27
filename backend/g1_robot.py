from __future__ import annotations

import ast
import json
import math
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException

try:
    from .g1_low_state import G1LowStateCache
    from .lidar_distance import DistanceSensorError, distance_sensor_status, get_front_distance_sample, get_rear_distance_sample
    from .safe_mode import (
        SAFE_MODE_STOP_MARGIN_METERS,
        current_navigation_safety_snapshot,
        obstacle_within_margin,
        registered_arm_obstacle,
        registered_base_obstacle,
    )
    from .velocity_slew import configured_velocity_slew_limits, slew_velocity
except ImportError:
    from g1_low_state import G1LowStateCache
    from lidar_distance import DistanceSensorError, distance_sensor_status, get_front_distance_sample, get_rear_distance_sample
    from safe_mode import (
        SAFE_MODE_STOP_MARGIN_METERS,
        current_navigation_safety_snapshot,
        obstacle_within_margin,
        registered_arm_obstacle,
        registered_base_obstacle,
    )
    from velocity_slew import configured_velocity_slew_limits, slew_velocity

_client = None
_arm_client = None
_audio_client = None
_low_state_subscriber = None
_low_state_cache = G1LowStateCache()
_connected_interface = None
_connection_log_path: Path | None = None
_log_lock = threading.Lock()
_run_lock = threading.Lock()
_stop_requested = threading.Event()
_MAX_EXPANDED_COMMANDS = 400
_ARM_ACTION_REQUEST_SPACING_SECONDS = 2.0
_LEGACY_HELD_ACTION_EXTRA_HOLD_SECONDS = 20.0
_DURABLE_LOG_EVENTS = {
    "connection_attempt",
    "connection_failed",
    "connected",
    "program_started",
    "program_completed",
    "program_failed",
    "command_failed",
    "safe_mode_motion_stopped",
    "safe_mode_sensor_failed",
    "safety_stop_failed",
    "safety_stop_requested",
    "stop_requested",
    "stop_failed",
}
_CONTINUOUS_MOVE_DURATION = 864000.0
_STEP_METERS = 0.345
_FORWARD_METERS_PER_SECOND = 0.4
_TURN_RADIANS_PER_SECOND = 0.6
_SAFE_MODE_POLL_INTERVAL_SECONDS = 0.1
_NAVIGATION_VELOCITY_LEASE_SECONDS = 0.25
_NAVIGATION_MAX_LINEAR_VELOCITY = 0.20
_NAVIGATION_MAX_YAW_RATE = 0.30
_NAVIGATION_REFRESH_INTERVAL_SECONDS = 0.1
_navigation_command_lock = threading.Lock()
_navigation_velocity = (0.0, 0.0, 0.0)
_navigation_velocity_updated_at: float | None = None
_POSTURE_TRANSITION_FSM_IDS = {
    "squat_to_stand": 706,
    "lie_to_stand": 702,
    "stand_to_squat": 706,
}
_ARM_ACTION_IDS = {
    "release arm": 99,
    "two-hand kiss": 11,
    "left kiss": 12,
    "right kiss": 13,
    "hands up": 15,
    "clap": 17,
    "high five": 18,
    "hug": 19,
    "reject": 22,
    "right hand up": 23,
    "x-ray": 24,
    "face wave": 25,
    "high wave": 26,
    "shake hand": 27,
}
_ARM_HOLD_ACTION_IDS = {
    action: _ARM_ACTION_IDS[action]
    for action in (
        "two-hand kiss",
        "left kiss",
        "right kiss",
        "hands up",
        "high five",
        "hug",
        "reject",
        "right hand up",
        "x-ray",
    )
}
_ARM_ACTIONS_THAT_MAY_HOLD = {
    "hands up",
    "high five",
    "hug",
    "reject",
    "right hand up",
    "shake hand",
    "x-ray",
}


@lru_cache(maxsize=1)
def _legacy_arm_action_run_times() -> dict[str, float]:
    recordings_path = Path(__file__).resolve().parent.parent / "g1-recorded-motions.json"
    with recordings_path.open(encoding="utf-8") as recordings_file:
        recordings = json.load(recordings_file)
    if not isinstance(recordings, dict) or not isinstance(recordings.get("recordings"), list):
        raise RuntimeError(f"Legacy arm-action recordings are invalid: {recordings_path}")

    durations: dict[str, float] = {}
    for recording in recordings["recordings"]:
        if not isinstance(recording, dict) or recording.get("controller_version") != "legacy":
            continue
        command = recording.get("command")
        if not isinstance(command, str):
            continue
        match = re.fullmatch(r"""robot\.arm_action\(["']([^"']+)["']\)""", command)
        if not match or match.group(1) not in _ARM_ACTIONS_THAT_MAY_HOLD:
            continue
        frames = recording.get("frames")
        if not isinstance(frames, list) or not frames or not isinstance(frames[-1], dict):
            continue
        duration = frames[-1].get("time_s")
        if (
            isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or not math.isfinite(float(duration))
            or duration <= 0
        ):
            continue
        durations[match.group(1)] = float(duration)

    missing_actions = _ARM_ACTIONS_THAT_MAY_HOLD - durations.keys()
    if missing_actions:
        raise RuntimeError(
            "Recorded runtimes are missing for held Legacy arm actions: "
            + ", ".join(sorted(missing_actions))
        )
    return durations


class CommandValidationError(ValueError):
    pass


def _log_event(event: str, **details: Any) -> None:
    if _connection_log_path is None:
        return
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **details,
    }
    with _log_lock:
        with _connection_log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(record, separators=(",", ":")) + "\n")
            log_file.flush()
            if event in _DURABLE_LOG_EVENTS:
                os.fsync(log_file.fileno())


def _start_connection_log(interface: str, domain: int) -> None:
    global _connection_log_path
    log_dir = Path(os.getenv("G1_DATA_DIR", "/home/unitree/harry_botter"))
    try:
        log_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        log_path = log_dir / f"robot-session-{timestamp}-{uuid.uuid4().hex[:8]}.jsonl"
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as log_file:
            log_file.write("")
        _connection_log_path = log_path
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail=f"Could not create the robot session log under {log_dir}: {error}",
        ) from error
    _log_event("connection_attempt", interface=interface, domain=domain)


def _start_low_state_subscriber() -> None:
    global _low_state_subscriber
    try:
        from unitree_sdk2py.core.channel import ChannelSubscriber
        from unitree_sdk2py.idl.unitree_hg.msg.dds_ import LowState_

        subscriber = ChannelSubscriber("rt/lowstate", LowState_)
        result = subscriber.Init(_low_state_cache.update, 10)
        if result not in (None, 0):
            raise RuntimeError(f"Unitree LowState subscriber initialization failed with code {result}.")
        _low_state_subscriber = subscriber
    except Exception as error:
        _low_state_cache.mark_unavailable(f"Unitree rt/lowstate subscription is unavailable: {error}")
        _log_event("low_state_subscription_failed", error=str(error))


def robot_low_state() -> dict[str, Any]:
    mapping = _low_state_cache.joint_mapping()
    if _client is None:
        return {
            "status": "unavailable",
            "reason": "Connect the Legacy SDK before reading Unitree LowState.",
            "motor_joint_mapping": mapping,
        }
    return {
        **_low_state_cache.snapshot(),
        "motor_joint_mapping": mapping,
    }


def _number(value: ast.AST, name: str, minimum: float, maximum: float) -> float:
    if not isinstance(value, ast.Constant) or isinstance(value.value, bool) or not isinstance(value.value, (int, float)):
        raise CommandValidationError(f"{name} must be a numeric literal.")
    number = float(value.value)
    if not math.isfinite(number):
        raise CommandValidationError(f"{name} must be finite.")
    return min(maximum, max(minimum, number))


def _choice(value: ast.AST, name: str, choices: tuple[str, ...]) -> str:
    if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
        raise CommandValidationError(f"{name} must be a quoted string.")
    result = value.value.lower()
    if result not in choices:
        raise CommandValidationError(f"{name} must be one of: {', '.join(choices)}.")
    return result


def _integer_literal(value: ast.AST, name: str) -> int:
    if isinstance(value, ast.Constant) and not isinstance(value.value, bool) and isinstance(value.value, int):
        return value.value
    if (
        isinstance(value, ast.UnaryOp)
        and isinstance(value.op, ast.USub)
        and isinstance(value.operand, ast.Constant)
        and not isinstance(value.operand.value, bool)
        and isinstance(value.operand.value, int)
    ):
        return -value.operand.value
    raise CommandValidationError(f"{name} must be an integer literal.")


def _integer(value: ast.AST, name: str, minimum: int, maximum: int) -> int:
    number = _integer_literal(value, name)
    return min(maximum, max(minimum, number))


def _integer_choice(value: ast.AST, name: str, choices: tuple[int, ...]) -> int:
    number = _integer_literal(value, name)
    if number not in choices:
        raise CommandValidationError(f"{name} must be one of: {', '.join(map(str, choices))}.")
    return number


def _text(value: ast.AST, name: str, maximum: int = 120) -> str:
    if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
        raise CommandValidationError(f"{name} must be a quoted string.")
    text = value.value
    if not text.strip() or len(text) > maximum or any(ord(character) < 32 or ord(character) == 127 for character in text):
        raise CommandValidationError(f"{name} must contain 1 to {maximum} printable characters.")
    return text


def _validate_call(node: ast.AST) -> dict[str, Any]:
    if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
        raise CommandValidationError("Only robot commands and bounded for/range loops are allowed.")
    call = node.value
    if not isinstance(call.func, ast.Attribute) or not isinstance(call.func.value, ast.Name) or call.func.value.id != "robot":
        raise CommandValidationError("Only robot.<command>(...) calls are allowed.")
    if call.keywords:
        raise CommandValidationError("Keyword arguments are not supported.")
    method = call.func.attr
    args = call.args

    if method in {"stand", *_POSTURE_TRANSITION_FSM_IDS}:
        if args:
            raise CommandValidationError(f"robot.{method}() takes no arguments.")
        return {"method": method}
    if method in {"walk", "backward", "slowwalk", "fastwalk"}:
        if len(args) != 1:
            raise CommandValidationError(f"robot.{method}() expects a step count.")
        return {"method": method, "steps": _integer(args[0], "steps", 1, 20)}
    if method in {"walktime", "backwardtime", "slowwalktime", "fastwalktime"}:
        if len(args) != 1:
            raise CommandValidationError(f"robot.{method}() expects a duration in seconds.")
        return {"method": method, "seconds": _number(args[0], "seconds", 0.1, 10)}
    if method == "wait":
        if len(args) != 1:
            raise CommandValidationError("robot.wait() expects a whole number duration from 1 to 20 seconds.")
        return {"method": method, "seconds": _integer(args[0], "seconds", 1, 20)}
    if method == "turn_around_180":
        if args:
            raise CommandValidationError("robot.turn_around_180() takes no arguments.")
        return {"method": method, "direction": "left", "degrees": 180}
    if method == "turn":
        if len(args) not in {1, 2}:
            raise CommandValidationError('robot.turn() expects a direction and optional angle, e.g. robot.turn("left", 90).')
        result = {"method": method, "direction": _choice(args[0], "direction", ("left", "right"))}
        result["degrees"] = _number(args[1], "degrees", 5, 180) if len(args) == 2 else 90
        return result
    if method == "sidestep":
        if len(args) not in {1, 2}:
            raise CommandValidationError('robot.sidestep() expects a direction and optional step count, e.g. robot.sidestep("left", 2).')
        return {
            "method": method,
            "direction": _choice(args[0], "direction", ("left", "right")),
            "steps": _integer(args[1], "steps", 1, 20) if len(args) == 2 else 1,
        }
    if method in {"getfsm", "getactions", "getvolume"}:
        if args:
            raise CommandValidationError(f"robot.{method}() takes no arguments.")
        return {"method": method}
    if method == "say":
        if len(args) != 2:
            raise CommandValidationError('robot.say() expects text and a speaker ID (0 for Chinese or 1 for English).')
        return {
            "method": method,
            "text": _text(args[0], "text"),
            "speaker": _integer_choice(args[1], "speaker", (0, 1)),
        }
    if method == "setvolume":
        if len(args) != 1:
            raise CommandValidationError("robot.setvolume() expects a volume from 0 to 100.")
        return {"method": method, "volume": _integer(args[0], "volume", 0, 100)}
    if method == "led":
        if len(args) != 3:
            raise CommandValidationError("robot.led() expects red, green, and blue values from 0 to 255.")
        return {
            "method": method,
            "red": _integer(args[0], "red", 0, 255),
            "green": _integer(args[1], "green", 0, 255),
            "blue": _integer(args[2], "blue", 0, 255),
        }
    if method == "playstop":
        if len(args) != 1:
            raise CommandValidationError('robot.playstop() expects an audio app name, e.g. robot.playstop("example").')
        app_name = _text(args[0], "app name", maximum=32)
        if not re.fullmatch(r"[A-Za-z0-9 _-]+", app_name):
            raise CommandValidationError("Audio app name may contain only letters, numbers, spaces, underscores, or hyphens.")
        return {"method": method, "app_name": app_name}

    if method == "arm_action":
        if len(args) != 1:
            raise CommandValidationError("robot.arm_action() expects one preset name from the built-in G1 arm-action list.")
        action = _choice(args[0], "arm preset", tuple(_ARM_ACTION_IDS))
        return {"method": method, "action": action, "action_id": _ARM_ACTION_IDS[action]}
    if method == "hold_arm":
        if len(args) != 2:
            raise CommandValidationError('robot.hold_arm() expects a static pose name and hold duration in seconds.')
        action = _choice(args[0], "static arm pose", tuple(_ARM_HOLD_ACTION_IDS))
        return {
            "method": method,
            "action": action,
            "action_id": _ARM_HOLD_ACTION_IDS[action],
            "seconds": _number(args[1], "hold duration", 0.1, 10),
        }

    if method == "simulate_arm_action":
        raise CommandValidationError(
            "robot.simulate_arm_action is simulation-only: the G1 SDK arm preset has no verified stop/cancel path for physical execution."
        )
    if method in {
        "waveleft", "waveleftDegrees", "waveright", "waverightDegrees",
        "raisebotharms", "raisebotharmsDegrees", "raiseleftarm", "raiseleftarmDegrees",
        "raiserightarm", "raiserightarmDegrees", "kickleft", "kickleftDegrees",
        "kickright", "kickrightDegrees", "kneeleft", "kneeright",
    }:
        raise CommandValidationError(
            f"robot.{method} is not enabled for physical execution: the installed high-level G1 SDK does not provide a verified safe action mapping."
        )
    raise CommandValidationError(f"Unknown robot command: {method}")


def _loop_count(node: ast.For) -> int:
    if not isinstance(node.target, ast.Name) or node.orelse:
        raise CommandValidationError("Only simple for/range loops without else branches are allowed.")
    call = node.iter
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "range" or call.keywords:
        raise CommandValidationError("Loops must use range() with a constant count.")
    values = call.args
    def count_value(value: ast.AST) -> int:
        if not isinstance(value, ast.Constant) or isinstance(value.value, bool) or not isinstance(value.value, int):
            raise CommandValidationError("Loop counts must be integer literals.")
        if not 1 <= value.value <= 20:
            raise CommandValidationError("Loop count must be between 1 and 20.")
        return value.value

    if len(values) == 1:
        start, stop, step = 0, count_value(values[0]), 1
    elif len(values) == 2:
        if not isinstance(values[0], ast.Constant) or values[0].value != 0:
            raise CommandValidationError("Loops must start at zero.")
        start = 0
        stop = count_value(values[1])
        step = 1
    else:
        raise CommandValidationError("Loops must use range(count) or range(0, count).")
    if start != 0 or step != 1:
        raise CommandValidationError("Loops must start at zero and count upward by one.")
    return int(stop)


def _validate_arm_action_release_flow(nodes: list[dict[str, Any]]) -> None:
    def unique_states(states: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return list({
            (
                state["explicit_hold"],
                round(state["auto_hold_remaining"], 3),
                state["held_gesture"],
            ): state
            for state in states
        }.values())

    def apply(
        program_nodes: list[dict[str, Any]],
        states: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
        for node in program_nodes:
            node_type = node.get("type")
            if node_type == "repeat":
                for _ in range(node["times"]):
                    states, conflict = apply(node["body"], states)
                    if conflict:
                        return states, conflict
                continue
            if node_type == "condition":
                branch_results = [
                    apply(branch, [dict(state) for state in states])
                    for branch in (node["then"], node["else"])
                ]
                conflict = next((result[1] for result in branch_results if result[1]), None)
                if conflict:
                    return states, conflict
                states = unique_states([
                    state
                    for branch_states, _ in branch_results
                    for state in branch_states
                ])
                continue
            if node_type is not None or node.get("method") not in {"arm_action", "hold_arm"}:
                duration = _estimated_duration(node) if node_type is None else 0
                states = unique_states([
                    {
                        **state,
                        "auto_hold_remaining": max(0.0, state["auto_hold_remaining"] - duration),
                        "held_gesture": (
                            state["held_gesture"]
                            if state["auto_hold_remaining"] > duration
                            else None
                        ),
                    }
                    for state in states
                ])
                continue

            next_states = []
            for state in states:
                action = node["action"]
                if node["method"] == "arm_action" and action == "release arm":
                    if state["explicit_hold"] is not None:
                        next_states.append({
                            "explicit_hold": None,
                            "auto_hold_remaining": 0.0,
                            "held_gesture": None,
                        })
                    elif state["auto_hold_remaining"] > 0:
                        return states, {
                            "previous_action": state["held_gesture"],
                            "next_action": action,
                            "remaining": state["auto_hold_remaining"],
                        }
                    else:
                        next_states.append({
                            "explicit_hold": None,
                            "auto_hold_remaining": 0.0,
                            "held_gesture": None,
                        })
                    continue
                if state["explicit_hold"] is not None:
                    return states, {
                        "previous_action": state["explicit_hold"],
                        "next_action": action,
                        "explicit": True,
                    }
                if state["auto_hold_remaining"] > 0:
                    return states, {
                        "previous_action": state["held_gesture"],
                        "next_action": action,
                        "remaining": state["auto_hold_remaining"],
                    }
                if node["method"] == "hold_arm":
                    next_states.append({
                        "explicit_hold": action,
                        "auto_hold_remaining": 0.0,
                        "held_gesture": None,
                    })
                elif action in _ARM_ACTIONS_THAT_MAY_HOLD:
                    next_states.append({
                        "explicit_hold": None,
                        "auto_hold_remaining": _LEGACY_HELD_ACTION_EXTRA_HOLD_SECONDS,
                        "held_gesture": action,
                    })
                else:
                    next_states.append({
                        **state,
                        "auto_hold_remaining": max(
                            0.0,
                            state["auto_hold_remaining"] - _estimated_duration(node),
                        ),
                    })
            states = unique_states(next_states)
        return states, None

    _, conflict = apply(nodes, [{
        "explicit_hold": None,
        "auto_hold_remaining": 0.0,
        "held_gesture": None,
    }])
    if not conflict:
        return
    if conflict.get("explicit"):
        raise CommandValidationError(
            f'Cannot submit or run this Legacy sequence: the {conflict["previous_action"]} pose is intentionally held. '
            f'The arm action "{conflict["next_action"]}" cannot run until robot.arm_action("release arm") is used '
            "to release the pose."
        )
    raise CommandValidationError(
        f'Cannot submit or run this Legacy sequence: the {conflict["previous_action"]} gesture is still active '
        f'for about {conflict["remaining"]:.1f} more seconds. The arm action "{conflict["next_action"]}" cannot '
        "run during that 20-second hold. Add a wait until the gesture returns to its default position, or move "
        f'"{conflict["next_action"]}" after it.'
    )


def parse_robot_program(code: str) -> list[dict[str, Any]]:
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as error:
        raise CommandValidationError(f"Invalid command syntax on line {error.lineno}: {error.msg}") from error

    def contains_condition(nodes: list[dict[str, Any]]) -> bool:
        return any(
            node.get("type") == "condition"
            or (node.get("type") == "repeat" and contains_condition(node["body"]))
            for node in nodes
        )

    def visit(
        statements: list[ast.stmt],
        depth: int = 0,
        boolean_variables: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        if depth > 5:
            raise CommandValidationError("Programs may be nested at most five levels.")
        assigned_booleans = set() if boolean_variables is None else boolean_variables
        nodes: list[dict[str, Any]] = []
        for statement in statements:
            if isinstance(statement, ast.For):
                count = _loop_count(statement)
                loop_variables = set(assigned_booleans)
                nested = visit(statement.body, depth + 1, loop_variables)
                if not nested:
                    raise CommandValidationError("Loops must contain at least one supported command.")
                if contains_condition(nested):
                    nodes.append({"type": "repeat", "times": count, "body": nested})
                else:
                    for _ in range(count):
                        nodes.extend(nested)
                assigned_booleans.update(loop_variables)
            elif isinstance(statement, ast.Assign):
                if (
                    len(statement.targets) != 1
                    or not isinstance(statement.targets[0], ast.Name)
                    or not isinstance(statement.value, ast.Constant)
                    or not isinstance(statement.value.value, bool)
                ):
                    raise CommandValidationError("Only assignments of True or False to one Boolean variable are supported.")
                name = statement.targets[0].id
                assigned_booleans.add(name)
                nodes.append({
                    "type": "boolean_assignment",
                    "name": name,
                    "value": statement.value.value,
                })
            elif isinstance(statement, ast.If):
                variable = None
                sensor_name = None
                operator = None
                threshold_value = None
                if isinstance(statement.test, ast.Name):
                    variable = statement.test.id
                    if variable not in assigned_booleans:
                        raise CommandValidationError(
                            f"Boolean variable {variable!r} must be assigned True or False before use."
                        )
                else:
                    if (
                        not isinstance(statement.test, ast.Compare)
                        or len(statement.test.ops) != 1
                        or len(statement.test.comparators) != 1
                    ):
                        raise CommandValidationError(
                            "Conditions must use an assigned Boolean variable or compare a robot distance sensor with one numeric threshold."
                        )
                    comparison = statement.test
                    sensor = comparison.left
                    if (
                        not isinstance(sensor, ast.Call)
                        or not isinstance(sensor.func, ast.Attribute)
                        or not isinstance(sensor.func.value, ast.Name)
                        or sensor.func.value.id != "robot"
                        or sensor.func.attr not in {"front_distance_m", "rear_distance_m"}
                        or sensor.args
                        or sensor.keywords
                    ):
                        raise CommandValidationError(
                            "Distance conditions may only read robot.front_distance_m() or robot.rear_distance_m()."
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
                    threshold = comparison.comparators[0]
                    if operator is None:
                        raise CommandValidationError(
                            "Distance conditions support <, <=, >, >=, ==, and != comparisons only."
                        )
                    if (
                        not isinstance(threshold, ast.Constant)
                        or isinstance(threshold.value, bool)
                        or not isinstance(threshold.value, (int, float))
                        or not math.isfinite(float(threshold.value))
                        or not 0.1 <= float(threshold.value) <= 40
                    ):
                        raise CommandValidationError(
                            "Distance thresholds must be numeric literals between 0.1 and 40 meters."
                        )
                    sensor_name = sensor.func.attr
                    threshold_value = float(threshold.value)
                if not statement.body:
                    raise CommandValidationError("Condition then-branches must contain at least one supported statement.")
                if any(isinstance(item, ast.If) for item in statement.orelse):
                    raise CommandValidationError("elif is not supported; use a single if/else condition.")
                then_nodes = visit(statement.body, depth + 1, set(assigned_booleans))
                else_nodes = visit(statement.orelse, depth + 1, set(assigned_booleans))
                condition = {"type": "condition", "then": then_nodes, "else": else_nodes}
                if variable is not None:
                    condition["variable"] = variable
                else:
                    condition.update({
                        "sensor": sensor_name,
                        "operator": operator,
                        "threshold": threshold_value,
                    })
                nodes.append(condition)
            else:
                nodes.append(_validate_call(statement))
        return nodes

    nodes = visit(tree.body)
    if not nodes:
        raise CommandValidationError("Program contains no robot commands.")

    def path_command_count(program_nodes: list[dict[str, Any]]) -> int:
        count = 0
        for node in program_nodes:
            if node.get("type") == "boolean_assignment":
                continue
            if node.get("type") not in {"repeat", "condition"}:
                count += 1
            elif node["type"] == "repeat":
                count += node["times"] * path_command_count(node["body"])
            else:
                count += max(
                    path_command_count(node["then"]),
                    path_command_count(node["else"]),
                )
        return count

    command_count = path_command_count(nodes)
    if command_count == 0:
        raise CommandValidationError("Program contains no robot commands.")
    if command_count > _MAX_EXPANDED_COMMANDS:
        raise CommandValidationError(f"Programs may contain at most {_MAX_EXPANDED_COMMANDS} expanded commands.")
    _validate_arm_action_release_flow(nodes)
    return nodes


def _estimated_duration(command: dict[str, Any]) -> float:
    method = command["method"]
    if method == "wait":
        return command["seconds"]
    if method == "say":
        return len(command["text"]) / 12
    if method in {"stand", *_POSTURE_TRANSITION_FSM_IDS, "getfsm", "getactions", "getvolume", "setvolume", "led", "playstop"}:
        return 0
    if method == "arm_action":
        return _ARM_ACTION_REQUEST_SPACING_SECONDS
    if method == "hold_arm":
        return max(_ARM_ACTION_REQUEST_SPACING_SECONDS, command["seconds"])
    if method in {"turn", "turn_around_180"}:
        return math.radians(command["degrees"]) / _TURN_RADIANS_PER_SECOND
    if method == "sidestep":
        return command["steps"] * _STEP_METERS / 0.2
    speed = 0.2 if method.startswith("slow") else 0.8 if method.startswith("fast") else _FORWARD_METERS_PER_SECOND
    if method.endswith("time"):
        return command["seconds"]
    return command["steps"] * _STEP_METERS / speed


def connect_robot(interface: str) -> dict[str, Any]:
    global _client, _arm_client, _audio_client, _connected_interface
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,32}", interface):
        raise HTTPException(status_code=400, detail="Network interface name is invalid.")
    if _run_lock.locked():
        raise HTTPException(status_code=409, detail="Cannot reconnect while a robot program is running.")

    try:
        domain = int(os.getenv("UNITREE_DOMAIN_ID", "0"))
    except ValueError as error:
        raise HTTPException(status_code=500, detail="UNITREE_DOMAIN_ID must be an integer.") from error

    _start_connection_log(interface, domain)
    try:
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize
        from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient
        from unitree_sdk2py.g1.arm.g1_arm_action_client import G1ArmActionClient
        from unitree_sdk2py.g1.audio.g1_audio_client import AudioClient
    except ImportError as error:
        _log_event("connection_failed", error=str(error))
        raise HTTPException(
            status_code=503,
            detail="Unitree SDK2 Python is not installed on this backend host. Deploy this backend on the G1 computer and install the supported SDK.",
        ) from error

    try:
        ChannelFactoryInitialize(domain, interface)
        client = LocoClient()
        client.SetTimeout(10.0)
        result = client.Init()
        if result not in (None, 0):
            raise RuntimeError(f"G1 locomotion client initialization failed with code {result}.")
        probe = client.GetFsmId()
        probe_code = probe[0] if isinstance(probe, tuple) else probe
        if probe_code not in (None, 0):
            raise RuntimeError(f"G1 locomotion RPC probe failed with code {probe_code}.")
        arm_client = G1ArmActionClient()
        arm_client.SetTimeout(10.0)
        arm_result = arm_client.Init()
        if arm_result not in (None, 0):
            raise RuntimeError(f"G1 arm-action client initialization failed with code {arm_result}.")
        audio_client = AudioClient()
        audio_client.SetTimeout(10.0)
        audio_result = audio_client.Init()
        if audio_result not in (None, 0):
            raise RuntimeError(f"G1 audio client initialization failed with code {audio_result}.")
    except Exception as error:
        _client = None
        _arm_client = None
        _audio_client = None
        _connected_interface = None
        _log_event("connection_failed", error=str(error))
        raise HTTPException(status_code=502, detail=f"Could not initialize the G1 locomotion SDK: {error}") from error

    _log_event("connected", interface=interface, domain=domain)
    _client = client
    _arm_client = arm_client
    _audio_client = audio_client
    _connected_interface = interface
    _start_low_state_subscriber()
    return {
        "status": "connected",
        "interface": interface,
        "domain": domain,
        "distanceSensor": distance_sensor_status(),
        "capabilities": {
            "locomotion": True,
            "armActions": True,
            "armActionsReadOnly": False,
            "audio": True,
        },
        "lowStateTelemetry": robot_low_state(),
        "logFile": str(_connection_log_path),
    }


def robot_status() -> dict[str, Any]:
    return {
        "status": "connected" if _client is not None else "disconnected",
        "interface": _connected_interface,
        "sdkAvailable": _client is not None,
        "capabilities": {
            "locomotion": _client is not None,
            "armActions": _arm_client is not None,
            "armActionsReadOnly": False,
            "audio": _audio_client is not None,
        },
        "running": _run_lock.locked(),
    }


def _sdk_result(result: Any, operation: str) -> None:
    if result not in (None, 0):
        raise RuntimeError(f"G1 SDK operation {operation} failed with code {result}.")


def _validate_safe_mode_commands(nodes: list[dict[str, Any]]) -> None:
    for node in nodes:
        if node.get("type") == "repeat":
            _validate_safe_mode_commands(node["body"])
        elif node.get("type") == "condition" or node.get("variable") is not None:
            _validate_safe_mode_commands(node["then"])
            _validate_safe_mode_commands(node["else"])


def _safe_mode_arm_block_reason(margin_m: float) -> str | None:
    for sector, sample_reader in (
        ("front", get_front_distance_sample),
        ("rear", get_rear_distance_sample),
    ):
        try:
            sample = sample_reader()
            if obstacle_within_margin(sample, margin_m):
                clearance = sample.get("distance_m")
                return f"{sector} obstacle is within the {margin_m:.2f} m Safe Mode margin ({clearance:.2f} m)."
        except DistanceSensorError as error:
            return f"{sector} obstacle sensing is unavailable: {error}"
    try:
        obstacle = registered_arm_obstacle(current_navigation_safety_snapshot())
    except DistanceSensorError as error:
        return f"Registered arm-envelope sensing is unavailable: {error}"
    if obstacle:
        return obstacle["reason"]
    return None


def _safe_mode_movement_obstacle(
    vx: float,
    vy: float,
    vyaw: float,
    margin_m: float,
    horizon_s: float,
) -> dict[str, Any] | None:
    if abs(vx) > 0.001:
        sector = "front" if vx > 0 else "rear"
        sample_reader = get_front_distance_sample if vx > 0 else get_rear_distance_sample
        sample = sample_reader()
        if obstacle_within_margin(sample, margin_m):
            return {
                "sector": sector,
                "distance_m": sample.get("distance_m"),
                "stop_margin_m": margin_m,
                "reason": (
                    f"{sector} clearance {sample.get('distance_m'):.2f} m "
                    f"reached the {margin_m:.2f} m stop margin."
                ),
            }
    obstacle = registered_base_obstacle(
        current_navigation_safety_snapshot(),
        vx,
        vy,
        vyaw,
        horizon_s,
        margin_m,
    )
    if not obstacle:
        return None
    return {
        "sector": "registered",
        "distance_m": obstacle["distance_m"],
        "stop_margin_m": margin_m,
        "reason": obstacle["reason"],
    }


def _move(
    vx: float,
    vy: float,
    vyaw: float,
    seconds: float,
    *,
    initial_velocity: tuple[float, float, float] = (0.0, 0.0, 0.0),
    continue_to_next: bool = False,
    safe_mode: bool = False,
    safe_mode_stop_margin_m: float = SAFE_MODE_STOP_MARGIN_METERS,
) -> tuple[dict[str, Any] | None, tuple[float, float, float]]:
    if _client is None:
        raise HTTPException(status_code=409, detail="Connect the G1 SDK before running a robot program.")
    try:
        slew_limits = configured_velocity_slew_limits()
    except ValueError as error:
        raise HTTPException(status_code=503, detail=f"Invalid G1 velocity slew configuration: {error}") from error
    preserved_velocity = False
    try:
        if safe_mode:
            initial_obstacle = _safe_mode_movement_obstacle(
                vx, vy, vyaw, safe_mode_stop_margin_m, min(seconds, 0.2)
            )
            if initial_obstacle:
                _log_event("safe_mode_motion_stopped", **initial_obstacle)
                return initial_obstacle, (0.0, 0.0, 0.0)
        deadline = time.monotonic() + seconds
        previous_velocity = initial_velocity
        previous_update = time.monotonic()
        refresh_interval = _SAFE_MODE_POLL_INTERVAL_SECONDS if safe_mode else 0.05
        while True:
            if _stop_requested.is_set():
                break
            now = time.monotonic()
            moving = now < deadline
            if not moving and (
                previous_velocity == (0.0, 0.0, 0.0) or continue_to_next
            ):
                preserved_velocity = continue_to_next
                break
            if safe_mode:
                checked_velocity = (vx, vy, vyaw) if moving else previous_velocity
                obstacle = _safe_mode_movement_obstacle(
                    *checked_velocity,
                    safe_mode_stop_margin_m,
                    min(0.2, max(0.05, deadline - now)),
                )
                if obstacle:
                    _log_event("safe_mode_motion_stopped", **obstacle)
                    return obstacle, (0.0, 0.0, 0.0)
            target_velocity = (vx, vy, vyaw) if moving else (0.0, 0.0, 0.0)
            current_velocity = slew_velocity(
                previous_velocity,
                target_velocity,
                min(refresh_interval, max(0.0, now - previous_update)),
                slew_limits,
            )
            _sdk_result(
                _client.SetVelocity(*current_velocity, _CONTINUOUS_MOVE_DURATION),
                "SetVelocity",
            )
            previous_velocity = current_velocity
            previous_update = now
            if not moving and current_velocity == (0.0, 0.0, 0.0):
                break
            time.sleep(min(
                refresh_interval,
                max(0, deadline - now) if moving else 0.05,
            ))
    except DistanceSensorError as error:
        _log_event("safe_mode_sensor_failed", error=str(error))
        raise HTTPException(
            status_code=503,
            detail=f"Safe Mode stopped the G1 because live distance sensing failed: {error}",
        ) from error
    finally:
        if not preserved_velocity:
            _sdk_result(_client.SetVelocity(0.0, 0.0, 0.0, 1.0), "StopMove")
    if _stop_requested.is_set():
        raise HTTPException(status_code=409, detail="Robot program stopped by teacher.")
    return None, previous_velocity if preserved_velocity else (0.0, 0.0, 0.0)


def _require_locomotion_ready() -> None:
    if _client is None:
        raise HTTPException(status_code=409, detail="Connect the G1 SDK before running a robot program.")
    try:
        response = _client.GetFsmId()
    except Exception as error:
        raise RuntimeError(f"Could not verify G1 locomotion mode before walking: {error}") from error
    if not isinstance(response, tuple) or len(response) != 2:
        raise RuntimeError("G1 GetFsmId returned an invalid response; locomotion command was not sent.")
    result, fsm_id = response
    _sdk_result(result, "GetFsmId")
    if isinstance(fsm_id, bool) or not isinstance(fsm_id, int):
        raise RuntimeError("G1 GetFsmId returned an invalid FSM ID; locomotion command was not sent.")
    if fsm_id != 500:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Locomotion command was not sent because the G1 is in FSM {fsm_id}, not walking-ready FSM 500. "
                "Use robot.stand() and wait for that transition to finish before walking."
            ),
        )


def navigation_set_velocity(vx: float, vyaw: float) -> dict[str, Any]:
    """Send one short, bounded SDK velocity lease for an owned Nav2 operation."""
    global _navigation_velocity, _navigation_velocity_updated_at
    if (
        not math.isfinite(vx)
        or not math.isfinite(vyaw)
        or abs(vx) > _NAVIGATION_MAX_LINEAR_VELOCITY
        or abs(vyaw) > _NAVIGATION_MAX_YAW_RATE
    ):
        raise HTTPException(status_code=422, detail="Navigation velocity exceeds the bounded SDK limits.")
    if _client is None:
        raise HTTPException(status_code=409, detail="The legacy SDK controller is not connected.")
    if _run_lock.locked():
        raise HTTPException(status_code=409, detail="An SDK program owns locomotion.")
    with _navigation_command_lock:
        _require_locomotion_ready()
        now = time.monotonic()
        elapsed = (
            _NAVIGATION_REFRESH_INTERVAL_SECONDS
            if _navigation_velocity_updated_at is None
            else min(
                _NAVIGATION_REFRESH_INTERVAL_SECONDS,
                max(0.0, now - _navigation_velocity_updated_at),
            )
        )
        try:
            target_velocity = slew_velocity(
                _navigation_velocity,
                (vx, 0.0, vyaw),
                elapsed,
                configured_velocity_slew_limits(),
            )
        except ValueError as error:
            raise HTTPException(
                status_code=503,
                detail=f"Invalid G1 velocity slew configuration: {error}",
            ) from error
        try:
            _sdk_result(
                _client.SetVelocity(*target_velocity, _NAVIGATION_VELOCITY_LEASE_SECONDS),
                "SetVelocity",
            )
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"SDK navigation velocity failed: {error}") from error
        _navigation_velocity = target_velocity
        _navigation_velocity_updated_at = now
    return {"status": "accepted", "lease_seconds": _NAVIGATION_VELOCITY_LEASE_SECONDS}


def stop_navigation_velocity() -> dict[str, Any]:
    """Request the SDK's existing StopMove and require a successful RPC result."""
    global _navigation_velocity, _navigation_velocity_updated_at
    if _client is None:
        raise HTTPException(status_code=409, detail="The legacy SDK controller is not connected; stop is unconfirmed.")
    with _navigation_command_lock:
        try:
            _sdk_result(_client.StopMove(), "StopMove")
        except Exception as error:
            _log_event("safety_stop_failed", error=str(error), source="navigation")
            raise HTTPException(status_code=502, detail=f"SDK navigation stop was not confirmed: {error}") from error
        _navigation_velocity = (0.0, 0.0, 0.0)
        _navigation_velocity_updated_at = None
    return {"status": "stopped", "stop_request_accepted": True, "physical_stop_verified": False}


def _distance_condition_result(sample: dict[str, Any], operator: str, threshold: float) -> bool:
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


def execute_robot_program(
    code: str,
    *,
    reset_stop_request: bool = True,
    clear_stop_request: bool = True,
    safe_mode: bool = False,
    safe_mode_stop_margin_m: float = SAFE_MODE_STOP_MARGIN_METERS,
) -> dict[str, Any]:
    try:
        commands = parse_robot_program(code)
    except CommandValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if safe_mode:
        if (
            isinstance(safe_mode_stop_margin_m, bool)
            or not isinstance(safe_mode_stop_margin_m, (int, float))
            or not math.isfinite(float(safe_mode_stop_margin_m))
            or not 0 < float(safe_mode_stop_margin_m) <= 5
        ):
            raise HTTPException(status_code=503, detail="Safe Mode stop margin is invalid.")
        _validate_safe_mode_commands(commands)
    if _client is None:
        raise HTTPException(status_code=409, detail="Connect the G1 SDK before running a robot program.")
    if not _run_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A robot program is already running.")

    if reset_stop_request:
        _stop_requested.clear()
    results: list[dict[str, Any]] = []
    conditions_evaluated: list[dict[str, Any]] = []
    boolean_variables: dict[str, bool] = {}
    executed_count = 0
    safety_interventions: list[dict[str, Any]] = []
    pending_auto_release: dict[str, Any] | None = None
    locomotion_velocity = (0.0, 0.0, 0.0)
    try:
        _log_event("program_started", command_count=len(commands), commands=commands)

        def finish_pending_auto_release() -> None:
            nonlocal pending_auto_release
            if pending_auto_release is None:
                return
            pending_auto_release["completed"].wait()
            pending_auto_release["timer"].join()
            error = pending_auto_release["error"]
            pending_auto_release = None
            if error is not None:
                raise HTTPException(
                    status_code=502,
                    detail=f"Could not return the held arm gesture to the down pose: {error}",
                ) from error

        def cancel_pending_auto_release() -> None:
            nonlocal pending_auto_release
            if pending_auto_release is None:
                return
            pending = pending_auto_release
            with pending["lock"]:
                pending["cancelled"] = True
                pending["timer"].cancel()
                pending["completed"].set()
            pending["timer"].join()
            pending_auto_release = None

        def execute_arm_action(
            command: dict[str, Any],
            index: int,
            hold_seconds: float,
            return_to_down: bool = False,
        ) -> None:
            nonlocal pending_auto_release
            if _arm_client is None:
                raise HTTPException(status_code=409, detail="Connect the G1 arm-action SDK before running an arm preset.")
            if command["action"] == "release arm":
                cancel_pending_auto_release()
            elif pending_auto_release is not None:
                finish_pending_auto_release()
            _sdk_result(
                _arm_client.ExecuteAction(command["action_id"]),
                "ExecuteAction",
            )
            _log_event(
                "arm_action_accepted",
                index=index,
                action=command["action"],
                action_id=command["action_id"],
                hold_seconds=hold_seconds,
                note="SDK acceptance does not confirm pose completion; the hold is a timed delay, not active joint control.",
            )
            action_runtime = (
                _legacy_arm_action_run_times()[command["action"]]
                if return_to_down
                else max(_ARM_ACTION_REQUEST_SPACING_SECONDS, hold_seconds)
            )
            if return_to_down:
                pending = {
                    "completed": threading.Event(),
                    "error": None,
                    "cancelled": False,
                    "lock": threading.Lock(),
                }

                def release_after_hold() -> None:
                    with pending["lock"]:
                        if pending["cancelled"]:
                            pending["completed"].set()
                            return
                        try:
                            _sdk_result(
                                _arm_client.ExecuteAction(_ARM_ACTION_IDS["release arm"]),
                                "ExecuteAction (release arm)",
                            )
                            _log_event(
                                "arm_action_return_to_down",
                                index=index,
                                action=command["action"],
                                release_action_id=_ARM_ACTION_IDS["release arm"],
                                note="The release preset was accepted; the SDK does not confirm pose completion.",
                            )
                        except Exception as error:
                            pending["error"] = error
                            _log_event(
                                "arm_action_return_to_down_failed",
                                index=index,
                                action=command["action"],
                                error=str(error),
                            )
                        finally:
                            pending["completed"].set()

                timer = threading.Timer(
                    action_runtime + _LEGACY_HELD_ACTION_EXTRA_HOLD_SECONDS,
                    release_after_hold,
                )
                timer.daemon = True
                pending["timer"] = timer
                pending_auto_release = pending
                timer.start()
            if _stop_requested.wait(action_runtime):
                raise HTTPException(
                    status_code=409,
                    detail="Stop requested after the arm preset was accepted. The SDK has no verified way to cancel the active arm motion.",
                )
            if return_to_down:
                return

        def locomotion_target(command: dict[str, Any]) -> tuple[float, float, float] | None:
            method = command.get("method")
            if method in {"turn", "turn_around_180"}:
                yaw = _TURN_RADIANS_PER_SECOND * (1 if command["direction"] == "left" else -1)
                return 0.0, 0.0, yaw
            if method == "sidestep":
                lateral_speed = 0.2 * (1 if command["direction"] == "left" else -1)
                return 0.0, lateral_speed, 0.0
            if method in {
                "walk", "backward", "slowwalk", "fastwalk",
                "walktime", "backwardtime", "slowwalktime", "fastwalktime",
            }:
                speed = (
                    0.2 if method.startswith("slow")
                    else 0.8 if method.startswith("fast")
                    else _FORWARD_METERS_PER_SECOND
                )
                if method in {"backward", "backwardtime"}:
                    speed *= -1
                return speed, 0.0, 0.0
            return None

        def execute_locomotion(
            vx: float,
            vy: float,
            vyaw: float,
            duration: float,
            *,
            continue_to_next: bool,
        ) -> dict[str, Any] | None:
            nonlocal locomotion_velocity
            if safe_mode:
                obstacle, locomotion_velocity = _move(
                    vx,
                    vy,
                    vyaw,
                    duration,
                    initial_velocity=locomotion_velocity,
                    continue_to_next=continue_to_next,
                    safe_mode=True,
                    safe_mode_stop_margin_m=float(safe_mode_stop_margin_m),
                )
                return obstacle
            obstacle, locomotion_velocity = _move(
                vx,
                vy,
                vyaw,
                duration,
                initial_velocity=locomotion_velocity,
                continue_to_next=continue_to_next,
            )
            return obstacle

        def execute_command(
            command: dict[str, Any],
            next_node: dict[str, Any] | None = None,
        ) -> None:
            nonlocal executed_count
            method = command["method"]
            if safe_mode and method in {"arm_action", "hold_arm"}:
                blocked_reason = _safe_mode_arm_block_reason(float(safe_mode_stop_margin_m))
                if blocked_reason:
                    intervention = {
                        "command": method,
                        "status": "skipped",
                        "reason": blocked_reason,
                    }
                    safety_interventions.append(intervention)
                    _log_event("safe_mode_arm_skipped", **intervention)
                    results.append(intervention)
                    return
            executed_count += 1
            index = executed_count
            _log_event("command_started", index=index, command=command)
            try:
                current_target = locomotion_target(command)
                next_target = locomotion_target(next_node) if next_node else None
                continue_to_next = (
                    current_target is not None
                    and next_target is not None
                    and not any(
                        current * target < 0
                        for current, target in zip(current_target, next_target)
                    )
                )
                if method == "stand":
                    _sdk_result(_client.SetFsmId(500), "Start")
                elif method in _POSTURE_TRANSITION_FSM_IDS:
                    _sdk_result(
                        _client.SetFsmId(_POSTURE_TRANSITION_FSM_IDS[method]),
                        method,
                    )
                elif method == "wait":
                    if _stop_requested.wait(command["seconds"]):
                        raise HTTPException(status_code=409, detail="Robot program stopped by teacher.")
                elif method == "getfsm":
                    _sdk_result_if_available(_client.GetFsmId(), "GetFsmId", results, method)
                elif method == "getactions":
                    if _arm_client is None:
                        raise HTTPException(status_code=409, detail="Connect the G1 arm-action SDK before listing arm actions.")
                    _sdk_result_if_available(_arm_client.GetActionList(), "GetActionList", results, method)
                elif method == "arm_action":
                    execute_arm_action(
                        command,
                        index,
                        _ARM_ACTION_REQUEST_SPACING_SECONDS,
                        return_to_down=(
                            command["action"] in _ARM_ACTIONS_THAT_MAY_HOLD
                            and not (
                                next_node
                                and next_node.get("method") == "arm_action"
                                and next_node.get("action") == "release arm"
                            )
                        ),
                    )
                elif method == "hold_arm":
                    execute_arm_action(command, index, command["seconds"])
                elif method == "getvolume":
                    if _audio_client is None:
                        raise HTTPException(status_code=409, detail="Connect the G1 audio SDK before reading speaker volume.")
                    _sdk_result_if_available(_audio_client.GetVolume(), "GetVolume", results, method)
                elif method == "say":
                    if _audio_client is None:
                        raise HTTPException(status_code=409, detail="Connect the G1 audio SDK before using text-to-speech.")
                    _sdk_result(_audio_client.TtsMaker(command["text"], command["speaker"]), "TtsMaker")
                elif method == "setvolume":
                    if _audio_client is None:
                        raise HTTPException(status_code=409, detail="Connect the G1 audio SDK before setting speaker volume.")
                    _sdk_result(_audio_client.SetVolume(command["volume"]), "SetVolume")
                elif method == "led":
                    if _audio_client is None:
                        raise HTTPException(status_code=409, detail="Connect the G1 audio SDK before controlling the head LED.")
                    _sdk_result(
                        _audio_client.LedControl(command["red"], command["green"], command["blue"]),
                        "LedControl",
                    )
                elif method == "playstop":
                    if _audio_client is None:
                        raise HTTPException(status_code=409, detail="Connect the G1 audio SDK before stopping audio playback.")
                    _sdk_result(_audio_client.PlayStop(command["app_name"]), "PlayStop")
                elif method in {"turn", "turn_around_180"}:
                    yaw = _TURN_RADIANS_PER_SECOND * (1 if command["direction"] == "left" else -1)
                    _require_locomotion_ready()
                    execute_locomotion(
                        0,
                        0,
                        yaw,
                        math.radians(command["degrees"]) / _TURN_RADIANS_PER_SECOND,
                        continue_to_next=continue_to_next,
                    )
                elif method == "sidestep":
                    lateral_speed = 0.2 * (1 if command["direction"] == "left" else -1)
                    _require_locomotion_ready()
                    execute_locomotion(
                        0,
                        lateral_speed,
                        0,
                        command["steps"] * _STEP_METERS / abs(lateral_speed),
                        continue_to_next=continue_to_next,
                    )
                else:
                    speed = 0.2 if method.startswith("slow") else 0.8 if method.startswith("fast") else _FORWARD_METERS_PER_SECOND
                    if method in {"backward", "backwardtime"}:
                        speed *= -1
                    duration = command["seconds"] if method.endswith("time") else command["steps"] * _STEP_METERS / abs(speed)
                    _require_locomotion_ready()
                    obstacle = execute_locomotion(
                        speed,
                        0,
                        0,
                        duration,
                        continue_to_next=continue_to_next,
                    )
                    if obstacle:
                        intervention = {
                            "command": method,
                            "status": "stopped",
                            "reason": obstacle.get("reason") or (
                                f"{obstacle['sector']} clearance {obstacle['distance_m']:.2f} m "
                                f"reached the {obstacle['stop_margin_m']:.2f} m stop margin."
                            ),
                        }
                        safety_interventions.append(intervention)
                        results.append(intervention)
            except Exception as error:
                _log_event("command_failed", index=index, command=command, error=str(error))
                raise
            _log_event("command_completed", index=index, command=command)

        def execute_nodes(nodes: list[dict[str, Any]]) -> None:
            for index, node in enumerate(nodes):
                if _stop_requested.is_set():
                    raise HTTPException(status_code=409, detail="Robot program stopped by teacher.")
                node_type = node.get("type")
                if node_type is None:
                    execute_command(node, nodes[index + 1] if index + 1 < len(nodes) else None)
                    continue
                if node_type == "repeat":
                    for _ in range(node["times"]):
                        execute_nodes(node["body"])
                    continue
                if node_type == "boolean_assignment":
                    boolean_variables[node["name"]] = node["value"]
                    _log_event("boolean_variable_assigned", name=node["name"], value=node["value"])
                    continue
                if node.get("variable") is not None:
                    variable = node["variable"]
                    if variable not in boolean_variables:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Boolean variable {variable!r} was not assigned before use.",
                        )
                    selected_then = boolean_variables[variable]
                    decision = {
                        "variable": variable,
                        "value": selected_then,
                        "branch": "then" if selected_then else "else",
                    }
                    conditions_evaluated.append(decision)
                    _log_event("boolean_condition_evaluated", **decision)
                    execute_nodes(node["then"] if selected_then else node["else"])
                    continue
                try:
                    sensor = node["sensor"]
                    sample = (
                        get_front_distance_sample()
                        if sensor == "front_distance_m"
                        else get_rear_distance_sample()
                    )
                except DistanceSensorError as error:
                    _log_event("distance_condition_failed", sensor=node["sensor"], error=str(error), condition=node)
                    _stop_requested.set()
                    try:
                        _sdk_result(_client.StopMove(), "StopMove")
                    except Exception as stop_error:
                        _log_event("safety_stop_failed", reason=str(error), error=str(stop_error))
                        raise HTTPException(
                            status_code=502,
                            detail=f"Distance condition failed: {error}. The G1 stop request also failed: {stop_error}",
                        ) from stop_error
                    _log_event("safety_stop_requested", reason="invalid_or_stale_distance_sample")
                    raise HTTPException(
                        status_code=503,
                        detail=f"Distance condition aborted safely: {error}. G1 locomotion stop was requested.",
                    ) from error
                if _stop_requested.is_set():
                    raise HTTPException(status_code=409, detail="Robot program stopped by teacher.")

                try:
                    selected_then = _distance_condition_result(
                        sample,
                        node["operator"],
                        node["threshold"],
                    )
                except DistanceSensorError as error:
                    _log_event("distance_condition_failed", sensor=node["sensor"], error=str(error), condition=node)
                    _stop_requested.set()
                    try:
                        _sdk_result(_client.StopMove(), "StopMove")
                    except Exception as stop_error:
                        _log_event("safety_stop_failed", reason=str(error), error=str(stop_error))
                        raise HTTPException(
                            status_code=502,
                            detail=f"Distance condition failed: {error}. The G1 stop request also failed: {stop_error}",
                        ) from stop_error
                    _log_event("safety_stop_requested", reason="ambiguous_distance_condition")
                    raise HTTPException(
                        status_code=503,
                        detail=f"Distance condition aborted safely: {error}. G1 locomotion stop was requested.",
                    ) from error
                decision = {
                    "sensor": sensor,
                    "operator": node["operator"],
                    "threshold_m": node["threshold"],
                    "distance_m": sample["distance_m"],
                    "clear": bool(sample.get("clear")),
                    "max_range_m": sample.get("max_range_m", 40.0),
                    "age_ms": sample["age_ms"],
                    "branch": "then" if selected_then else "else",
                }
                conditions_evaluated.append(decision)
                _log_event("distance_condition_evaluated", **decision)
                execute_nodes(node["then"] if selected_then else node["else"])

        execute_nodes(commands)
        finish_pending_auto_release()
        _log_event("program_completed", command_count=executed_count)
        response = {
            "status": "completed",
            "commandsExecuted": executed_count,
            "results": results,
            "physicalMotionVerified": False,
        }
        if conditions_evaluated:
            response["conditionsEvaluated"] = conditions_evaluated
        if safety_interventions:
            response["safetyInterventions"] = safety_interventions
        return response
    except HTTPException as error:
        _log_event("program_failed", error=str(error.detail))
        raise
    except Exception as error:
        _log_event("program_failed", error=str(error))
        raise HTTPException(status_code=502, detail=f"G1 command failed: {error}") from error
    finally:
        if clear_stop_request:
            _stop_requested.clear()
        _run_lock.release()


def clear_robot_stop_request() -> None:
    _stop_requested.clear()


def stop_robot() -> dict[str, str]:
    _stop_requested.set()
    if _client is None:
        _log_event("stop_requested", status="not_connected")
        return {"status": "not_connected"}
    try:
        _sdk_result(_client.StopMove(), "StopMove")
    except Exception as error:
        _log_event("stop_failed", error=str(error))
        raise HTTPException(status_code=502, detail=f"Failed to stop the G1: {error}") from error
    _log_event("stop_requested", status="stopping")
    return {"status": "stopping"}


def _sdk_result_if_available(result: Any, operation: str, outputs: list[dict[str, Any]], command: str) -> None:
    if not isinstance(result, tuple) or len(result) != 2:
        raise RuntimeError(f"G1 SDK operation {operation} returned an invalid response.")
    code, value = result
    _sdk_result(code, operation)
    outputs.append({"command": command, "value": value})
