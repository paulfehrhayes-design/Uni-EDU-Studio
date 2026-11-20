"""Content-based verification for the DUET no-command handoff executable."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


HANDOFF_BUILD_INPUTS = (
    "CMakeLists.txt",
    "main.cpp",
    "config/config.yaml",
    "../../include/FSM/State_Handoff.h",
    "../../include/FSM/State_FixStand.h",
    "../../include/FSM/CtrlFSM.h",
)
MANIFEST_NAME = "duet_handoff_build.json"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_digest(controller_dir: Path) -> str:
    digest = hashlib.sha256()
    for relative_path in HANDOFF_BUILD_INPUTS:
        source = controller_dir / relative_path
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        with source.open("rb") as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def record_handoff_build(controller_dir: Path) -> Path:
    """Record the exact relevant sources and executable after a successful build."""
    controller_dir = Path(controller_dir)
    binary = controller_dir / "build" / "g1_ctrl"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError(f"DUET controller binary is missing or not executable: {binary}")

    manifest = {
        "schema": 1,
        "sources_sha256": _source_digest(controller_dir),
        "binary_sha256": _sha256_file(binary),
    }
    manifest_path = binary.parent / MANIFEST_NAME
    temporary_path = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8")
    temporary_path.replace(manifest_path)
    return manifest_path


def verify_handoff_build(controller_dir: Path) -> None:
    """Reject missing, stale, or changed build artifacts without relying on clocks."""
    controller_dir = Path(controller_dir)
    binary = controller_dir / "build" / "g1_ctrl"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError(
            "The DUET controller binary is missing or not executable. "
            "Run backend/install_g1_service.sh on the G1 host to build it."
        )

    manifest_path = binary.parent / MANIFEST_NAME
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema") != 1:
            raise ValueError("unsupported build record")
        source_digest = _source_digest(controller_dir)
        binary_digest = _sha256_file(binary)
    except (OSError, json.JSONDecodeError, AttributeError, TypeError, ValueError) as error:
        raise ValueError(
            "The DUET controller has no valid handoff build record "
            f"({error}). Run backend/install_g1_service.sh on the G1 host before connecting."
        ) from error

    if manifest.get("sources_sha256") != source_digest:
        raise ValueError(
            "The DUET controller build does not match the current no-command handoff sources. "
            "Run backend/install_g1_service.sh on the G1 host before connecting."
        )
    if manifest.get("binary_sha256") != binary_digest:
        raise ValueError(
            "The DUET controller binary differs from its recorded handoff build. "
            "Run backend/install_g1_service.sh on the G1 host before connecting."
        )
