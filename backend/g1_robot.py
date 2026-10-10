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
from pathlib import Path
from typing import Any

from fastapi import HTTPException

_client = None
_connected_interface = None
_connection_log_path: Path | None = None
_log_lock = threading.Lock()
_run_lock = threading.Lock()
_stop_requested = threading.Event()
_MAX_PROGRAM_SECONDS = 30.0
_MAX_EXPANDED_COMMANDS = 100
_CONTINUOUS_MOVE_DURATION = 864000.0
_STEP_METERS = 0.4
_FORWARD_METERS_PER_SECOND = 0.4
_TURN_RADIANS_PER_SECOND = 0.6


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

    if method == "stand":
        if args:
            raise CommandValidationError("robot.stand() takes no arguments.")
        return {"method": method}
    if method in {"walk", "backward", "slowwalk", "fastwalk"}:
        if len(args) != 1:
            raise CommandValidationError(f"robot.{method}() expects a step count.")
        return {"method": method, "steps": _number(args[0], "steps", 1, 10)}
    if method in {"walktime", "backwardtime", "slowwalktime", "fastwalktime"}:
        if len(args) != 1:
            raise CommandValidationError(f"robot.{method}() expects a duration in seconds.")
        return {"method": method, "seconds": _number(args[0], "seconds", 0.1, 10)}
    if method == "turn":
        if len(args) not in {1, 2}:
            raise CommandValidationError('robot.turn() expects a direction and optional angle, e.g. robot.turn("left", 90).')
        result = {"method": method, "direction": _choice(args[0], "direction", ("left", "right"))}
        result["degrees"] = _number(args[1], "degrees", 5, 180) if len(args) == 2 else 90
        return result
    if method == "sidestep":
        if len(args) != 1:
            raise CommandValidationError('robot.sidestep() expects "left" or "right".')
        return {"method": method, "direction": _choice(args[0], "direction", ("left", "right"))}

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


def parse_robot_program(code: str) -> list[dict[str, Any]]:
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as error:
        raise CommandValidationError(f"Invalid command syntax on line {error.lineno}: {error.msg}") from error

    commands: list[dict[str, Any]] = []

    def visit(statements: list[ast.stmt], depth: int = 0) -> None:
        if depth > 5:
            raise CommandValidationError("Loops may be nested at most five levels.")
        for statement in statements:
            if isinstance(statement, ast.For):
                count = _loop_count(statement)
                nested: list[dict[str, Any]] = []
                previous = commands[:]
                commands.clear()
                visit(statement.body, depth + 1)
                nested.extend(commands)
                commands[:] = previous
                if len(commands) + len(nested) * count > _MAX_EXPANDED_COMMANDS:
                    raise CommandValidationError(f"Programs may contain at most {_MAX_EXPANDED_COMMANDS} expanded commands.")
                for _ in range(count):
                    commands.extend(nested)
            else:
                commands.append(_validate_call(statement))
            if len(commands) > _MAX_EXPANDED_COMMANDS:
                raise CommandValidationError(f"Programs may contain at most {_MAX_EXPANDED_COMMANDS} expanded commands.")

    visit(tree.body)
    if not commands:
        raise CommandValidationError("Program contains no robot commands.")
    duration = sum(_estimated_duration(command) for command in commands)
    if duration > _MAX_PROGRAM_SECONDS:
        raise CommandValidationError(f"Program duration cannot exceed {_MAX_PROGRAM_SECONDS:g} seconds.")
    return commands


def _estimated_duration(command: dict[str, Any]) -> float:
    method = command["method"]
    if method == "stand":
        return 0
    if method == "turn":
        return math.radians(command["degrees"]) / _TURN_RADIANS_PER_SECOND
    if method == "sidestep":
        return _STEP_METERS / 0.2
    speed = 0.2 if method.startswith("slow") else 0.8 if method.startswith("fast") else _FORWARD_METERS_PER_SECOND
    if method.endswith("time"):
        return command["seconds"]
    return command["steps"] * _STEP_METERS / speed


def connect_robot(interface: str) -> dict[str, Any]:
    global _client, _connected_interface
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
    except Exception as error:
        _client = None
        _connected_interface = None
        _log_event("connection_failed", error=str(error))
        raise HTTPException(status_code=502, detail=f"Could not initialize the G1 locomotion SDK: {error}") from error

    _log_event("connected", interface=interface, domain=domain)
    _client = client
    _connected_interface = interface
    return {
        "status": "connected",
        "interface": interface,
        "domain": domain,
        "logFile": str(_connection_log_path),
    }


def robot_status() -> dict[str, Any]:
    return {
        "status": "connected" if _client is not None else "disconnected",
        "interface": _connected_interface,
        "sdkAvailable": _client is not None,
        "running": _run_lock.locked(),
    }


def _sdk_result(result: Any, operation: str) -> None:
    if result not in (None, 0):
        raise RuntimeError(f"G1 SDK operation {operation} failed with code {result}.")


def _move(vx: float, vy: float, vyaw: float, seconds: float) -> None:
    if _client is None:
        raise HTTPException(status_code=409, detail="Connect the G1 SDK before running a robot program.")
    try:
        _sdk_result(
            _client.SetVelocity(vx, vy, vyaw, _CONTINUOUS_MOVE_DURATION),
            "SetVelocity",
        )
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if _stop_requested.is_set():
                break
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    finally:
        _sdk_result(_client.SetVelocity(0.0, 0.0, 0.0, 1.0), "StopMove")
    if _stop_requested.is_set():
        raise HTTPException(status_code=409, detail="Robot program stopped by teacher.")


def execute_robot_program(code: str) -> dict[str, Any]:
    try:
        commands = parse_robot_program(code)
    except CommandValidationError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if _client is None:
        raise HTTPException(status_code=409, detail="Connect the G1 SDK before running a robot program.")
    if not _run_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A robot program is already running.")

    _stop_requested.clear()
    try:
        _log_event("program_started", command_count=len(commands), commands=commands)
        for index, command in enumerate(commands, start=1):
            method = command["method"]
            _log_event("command_started", index=index, command=command)
            try:
                if method == "stand":
                    _sdk_result(_client.SetFsmId(706), "Squat2StandUp")
                elif method == "turn":
                    yaw = _TURN_RADIANS_PER_SECOND * (1 if command["direction"] == "left" else -1)
                    _move(0, 0, yaw, math.radians(command["degrees"]) / _TURN_RADIANS_PER_SECOND)
                elif method == "sidestep":
                    lateral_speed = 0.2 * (1 if command["direction"] == "left" else -1)
                    _move(0, lateral_speed, 0, _STEP_METERS / abs(lateral_speed))
                else:
                    speed = 0.2 if method.startswith("slow") else 0.8 if method.startswith("fast") else _FORWARD_METERS_PER_SECOND
                    if method in {"backward", "backwardtime"}:
                        speed *= -1
                    duration = command["seconds"] if method.endswith("time") else command["steps"] * _STEP_METERS / abs(speed)
                    _move(speed, 0, 0, duration)
            except Exception as error:
                _log_event("command_failed", index=index, command=command, error=str(error))
                raise
            _log_event("command_completed", index=index, command=command)
        _log_event("program_completed", command_count=len(commands))
        return {
            "status": "completed",
            "commandsExecuted": len(commands),
            "physicalMotionVerified": False,
        }
    except HTTPException as error:
        _log_event("program_failed", error=str(error.detail))
        raise
    except Exception as error:
        _log_event("program_failed", error=str(error))
        raise HTTPException(status_code=502, detail=f"G1 command failed: {error}") from error
    finally:
        _stop_requested.clear()
        _run_lock.release()


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
