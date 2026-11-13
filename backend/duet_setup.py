#!/usr/bin/env python3
"""Prepare the vendored DUET G1 controller and identify its loaded policy."""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path


PACKAGE_NAMES = (
    "build-essential",
    "cmake",
    "libboost-program-options-dev",
    "libyaml-cpp-dev",
    "zlib1g-dev",
    "libfmt-dev",
    "libeigen3-dev",
)
SUPPORTED_ARCHES = {"x86_64", "aarch64"}


def controller_path(project_dir: Path) -> Path:
    return project_dir / "vendor" / "DUET" / "deploy" / "robots" / "g1_23dof"


def resolve_loaded_policy(controller_dir: Path) -> Path:
    """Mirror param::parser_policy_dir for the configured Velocity FSM state."""
    config_path = controller_dir / "config" / "config.yaml"
    if not config_path.is_file():
        raise ValueError(f"DUET controller configuration is missing: {config_path}")
    config = config_path.read_text(encoding="utf-8")
    configured = re.findall(r"^    policy_dir:\s*(\S+)\s*$", config, flags=re.MULTILINE)
    if len(configured) != 1:
        raise ValueError(
            f"Expected exactly one FSM policy_dir in {config_path}; found {len(configured)}."
        )
    root = Path(configured[0])
    if not root.is_absolute():
        root = controller_dir / root

    # This follows deploy/include/param.h: when `exported` is not directly
    # present, choose the lexicographically last child containing `exported`.
    policy_dir = root
    if not (policy_dir / "exported").is_dir():
        candidates = sorted(
            child for child in policy_dir.iterdir()
            if child.is_dir() and (child / "exported").is_dir()
        ) if policy_dir.is_dir() else []
        if not candidates:
            raise ValueError(
                f"No exported policy directory exists under configured path {root}."
            )
        policy_dir = candidates[-1]

    policy = policy_dir / "exported" / "policy.onnx"
    if not policy.is_file():
        raise ValueError(f"Configured DUET policy file is missing: {policy}")
    return policy.resolve()


def policy_identity(controller_dir: Path) -> str:
    policy = resolve_loaded_policy(controller_dir)
    digest = hashlib.sha256(policy.read_bytes()).hexdigest()
    return f"sha256:{digest}"


def _missing_apt_packages() -> list[str]:
    if not shutil.which("dpkg-query"):
        raise RuntimeError("dpkg-query is unavailable; automatic DUET dependency setup requires Ubuntu/Debian.")
    missing = []
    for package in PACKAGE_NAMES:
        result = subprocess.run(
            ["dpkg-query", "-W", "-f=${Status}", package],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        if result.returncode != 0 or result.stdout.strip() != "install ok installed":
            missing.append(package)
    return missing


def prepare_controller(project_dir: Path) -> str:
    controller = controller_path(project_dir).resolve()
    cmake_file = controller / "CMakeLists.txt"
    if not cmake_file.is_file():
        raise ValueError(f"DUET source is not present; expected {cmake_file}.")

    architecture = platform.machine()
    if architecture not in SUPPORTED_ARCHES:
        raise ValueError(
            f"DUET controller build is supported by this checkout only on "
            f"{', '.join(sorted(SUPPORTED_ARCHES))}; detected {architecture}."
        )
    onnx_runtime = controller.parent.parent / "thirdparty" / (
        f"onnxruntime-linux-{'x64' if architecture == 'x86_64' else 'aarch64'}-1.22.0"
    )
    if not (onnx_runtime / "lib" / "libonnxruntime.so.1.22.0").is_file():
        raise ValueError(f"Vendored ONNX Runtime for {architecture} is missing: {onnx_runtime}")

    binary = controller / "build" / "g1_ctrl"
    missing = _missing_apt_packages()
    if missing:
        if not shutil.which("sudo"):
            raise RuntimeError(
                "Missing DUET build packages: " + ", ".join(missing)
                + "; install them with sudo apt-get install."
            )
        print("Installing missing DUET C++ build packages: " + ", ".join(missing), flush=True)
        subprocess.run(["sudo", "apt-get", "update"], check=True)
        subprocess.run(["sudo", "apt-get", "install", "-y", *missing], check=True)

    build_dir = controller / "build"
    build_dir.mkdir(parents=True, exist_ok=True)
    # Reconfigure and incrementally rebuild so setup cannot leave an older binary
    # beside newer vendored controller sources. CMake also checks host SDK/DDS deps.
    subprocess.run(["cmake", "-S", str(controller), "-B", str(build_dir)], check=True)
    subprocess.run(["cmake", "--build", str(build_dir), "--parallel", "2"], check=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError(f"CMake completed without producing an executable: {binary}")
    print(f"Built DUET controller: {binary}")
    return str(binary)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--policy-id", action="store_true")
    args = parser.parse_args()
    controller = controller_path(args.project_dir).resolve()
    try:
        if args.prepare:
            prepare_controller(args.project_dir.resolve())
        if args.policy_id:
            print(policy_identity(controller))
        if not args.prepare and not args.policy_id:
            parser.error("select --prepare and/or --policy-id")
    except (OSError, RuntimeError, subprocess.CalledProcessError, ValueError) as error:
        print(f"DUET setup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
