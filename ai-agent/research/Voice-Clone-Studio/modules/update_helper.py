"""
Utility to update a vendored module from its upstream repo.

Usage:
    .\venv\Scripts\python.exe scripts\update_vendor.py <module_name> [--commit <hash>]

Examples:
    .\venv\Scripts\python.exe scripts\update_vendor.py deepfilternet
    .\venv\Scripts\python.exe scripts\update_vendor.py vibevoice_tts --commit abc1234

This script:
  1. Clones the upstream repo into a temp directory
  2. Optionally checks out a specific commit/tag
  3. Copies the relevant files into modules/<name>/
  4. Removes the .git directory (so it's plain vendored files)
  5. Updates vendor_manifest.json with the new commit info
  6. Reminds you to re-apply any local patches
"""

import json
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path


PROJECT_ROOT = Path(__file__).parent.parent
MANIFEST_PATH = PROJECT_ROOT / "modules" / "vendor_manifest.json"


def load_manifest():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_manifest(manifest):
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=4, ensure_ascii=False)
    print(f"[OK] Updated {MANIFEST_PATH.name}")


def get_current_commit(repo_dir):
    """Get the HEAD commit hash from a cloned repo."""
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_dir,
        capture_output=True,
        text=True
    )
    return result.stdout.strip()[:7]


def get_latest_tag(repo_dir):
    """Try to get the latest tag for version tracking."""
    result = subprocess.run(
        ["git", "describe", "--tags", "--abbrev=0"],
        cwd=repo_dir,
        capture_output=True,
        text=True
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return "unknown"


def update_module(module_name, target_commit=None):
    manifest = load_manifest()

    if module_name not in manifest:
        print(f"[ERROR] '{module_name}' not found in vendor_manifest.json")
        print(f"Available modules: {', '.join(manifest.keys())}")
        return False

    entry = manifest[module_name]
    source_url = entry["source"]
    dest_path = PROJECT_ROOT / entry["path"]

    print(f"Updating '{module_name}' from {source_url}")
    print(f"Destination: {dest_path}")

    # Clone into temp directory
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_repo = Path(tmp_dir) / "repo"

        print("Cloning upstream repo...")
        result = subprocess.run(
            ["git", "clone", "--depth", "50", source_url, str(tmp_repo)],
            capture_output=True,
            text=True
        )
        if result.returncode != 0:
            print(f"[ERROR] Clone failed: {result.stderr}")
            return False

        # Checkout specific commit if requested
        if target_commit:
            print(f"Checking out commit: {target_commit}")
            result = subprocess.run(
                ["git", "checkout", target_commit],
                cwd=tmp_repo,
                capture_output=True,
                text=True
            )
            if result.returncode != 0:
                print(f"[ERROR] Checkout failed: {result.stderr}")
                return False

        new_commit = get_current_commit(tmp_repo)
        new_version = get_latest_tag(tmp_repo)

        print(f"Upstream commit: {new_commit}")
        print(f"Upstream version: {new_version}")

        if new_commit == entry.get("commit"):
            print("[OK] Already up to date!")
            return True

        # Show what changed
        old_commit = entry.get("commit", "unknown")
        print(f"\nUpdating: {old_commit} -> {new_commit}")
        print(f"Version:  {entry.get('version', 'unknown')} -> {new_version}")

        # Confirm before overwriting
        response = input("\nProceed? This will overwrite the vendored files. (y/N): ")
        if response.lower() != "y":
            print("Aborted.")
            return False

        # Back up current vendored code
        backup_path = dest_path.parent / f"_{module_name}_backup"
        if dest_path.exists():
            print(f"Backing up current code to {backup_path.name}/")
            if backup_path.exists():
                shutil.rmtree(backup_path)
            shutil.copytree(dest_path, backup_path)

        # Remove old vendored code
        if dest_path.exists():
            shutil.rmtree(dest_path)

        # Copy new code (excluding .git)
        shutil.copytree(tmp_repo, dest_path, ignore=shutil.ignore_patterns(".git"))
        print(f"[OK] Copied fresh code to {dest_path}")

        # Remove files we don't need from the vendored copy
        for unwanted in ["requirements.txt", "setup.py", "setup.cfg", "pyproject.toml"]:
            unwanted_path = dest_path / unwanted
            if unwanted_path.exists():
                unwanted_path.unlink()
                print(f"  Removed {unwanted} (dependencies managed in root requirements.txt)")

        # Update manifest
        entry["commit"] = new_commit
        entry["version"] = new_version
        entry["vendored_date"] = str(date.today())
        save_manifest(manifest)

        print(f"\n{'='*60}")
        print(f"[OK] '{module_name}' updated successfully!")
        print(f"{'='*60}")
        print(f"\nIMPORTANT - Next steps:")
        print(f"  1. Check if imports still work:")
        print(f"     .\\venv\\Scripts\\python.exe -c \"import modules.{module_name.replace('/', '.')}\"")
        print(f"  2. Re-apply any local patches (check backup at {backup_path.name}/)")
        print(f"  3. Test the affected tools")
        print(f"  4. Delete the backup when satisfied:")
        print(f"     rmdir /s /q modules\\_{module_name}_backup")
        print(f"  5. Check requirements.txt for new/changed dependencies")

    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: .\\venv\\Scripts\\python.exe scripts\\update_vendor.py <module_name> [--commit <hash>]")
        print()
        manifest = load_manifest()
        print("Available modules:")
        for name, info in manifest.items():
            print(f"  {name:20s}  {info['source']}")
            print(f"  {'':20s}  commit: {info.get('commit', '?')}  vendored: {info.get('vendored_date', '?')}")
        sys.exit(1)

    mod_name = sys.argv[1]
    commit = None
    if "--commit" in sys.argv:
        idx = sys.argv.index("--commit")
        if idx + 1 < len(sys.argv):
            commit = sys.argv[idx + 1]

    success = update_module(mod_name, commit)
    sys.exit(0 if success else 1)