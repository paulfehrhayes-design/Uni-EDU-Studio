#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_ENV_DIR="${G1_SDK_ENV_DIR:-$HOME/venvs/g1-sdk}"
if [[ ! -x "$SDK_ENV_DIR/bin/python" ]]; then
  SDK_ENV_DIR="$HOME/venvs/g1-sdk-py312"
fi
PYTHON="$SDK_ENV_DIR/bin/python"
DUET_CONTROL_DIR="${DUET_CONTROL_DIR:-$HOME/.cache/uni-edu-duet}"
UNITREE_INTERFACE="${UNITREE_INTERFACE:-eth0}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Unitree SDK virtual environment not found. Set G1_SDK_ENV_DIR to its path." >&2
  exit 1
fi
voice_python_supported() {
  "$1" -c 'import sys; raise SystemExit(not ((3, 10) <= sys.version_info[:2] <= (3, 13)))' \
    >/dev/null 2>&1
}
UV_BIN=""
ensure_uv() {
  if [[ -n "$UV_BIN" && -x "$UV_BIN" ]]; then
    return
  fi
  if command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
  else
    "$PYTHON" -m pip install uv
    UV_BIN="$SDK_ENV_DIR/bin/uv"
  fi
  if [[ ! -x "$UV_BIN" ]]; then
    echo "Could not install uv to provision the voice-service Python runtime." >&2
    exit 1
  fi
}
VOICE_VENV="$PROJECT_DIR/.venv-audio312"
VOICE_PYTHON=""
for candidate in \
  "$VOICE_VENV/bin/python" \
  "$PROJECT_DIR/ai-agent/voice-service/.venv/bin/python" \
  python3.12 python3.11 python3.10 python3.13 python3 python; do
  if [[ "$candidate" == */* ]]; then
    [[ -x "$candidate" ]] || continue
  elif ! command -v "$candidate" >/dev/null 2>&1; then
    continue
  fi
  if voice_python_supported "$candidate"; then
    VOICE_PYTHON="$candidate"
    break
  fi
done
if [[ -z "$VOICE_PYTHON" ]]; then
  echo "Provisioning Python 3.12 for the Harry Botter voice service."
  ensure_uv
  if ! "$UV_BIN" python install 3.12; then
    echo "Could not install the Python 3.12 runtime required by the voice service." >&2
    exit 1
  fi
  VOICE_PYTHON="$("$UV_BIN" python find 3.12)"
  if ! voice_python_supported "$VOICE_PYTHON"; then
    echo "uv did not provide a compatible Python 3.12 runtime for the voice service." >&2
    exit 1
  fi
fi
if [[ "$VOICE_PYTHON" != "$VOICE_VENV/bin/python" &&
      "$VOICE_PYTHON" != "$PROJECT_DIR/ai-agent/voice-service/.venv/bin/python" ]]; then
  if [[ -e "$VOICE_VENV" ]]; then
    echo "The existing voice environment at $VOICE_VENV is incompatible; move it aside and rerun." >&2
    exit 1
  fi
  ensure_uv
  if ! "$UV_BIN" venv --seed --python "$VOICE_PYTHON" "$VOICE_VENV"; then
    echo "Could not create the Python 3.12 voice-service environment at $VOICE_VENV." >&2
    exit 1
  fi
  VOICE_PYTHON="$VOICE_VENV/bin/python"
fi
if [[ "$DUET_CONTROL_DIR" != /* ]]; then
  echo "DUET_CONTROL_DIR must be an absolute path." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required for the initial frontend build." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is required to launch the AI and backend services." >&2
  exit 1
fi
if ! command -v zstd >/dev/null 2>&1; then
  echo "Installing zstd, required to extract Ollama on first app startup."
  sudo apt-get update
  sudo apt-get install -y zstd
fi

LIDAR_CONFIGURED=0
LIDAR_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/uni-edu-studio"
LIDAR_ENV_FILE="$LIDAR_CONFIG_DIR/lidar.env"
LIDAR_PREVIOUSLY_INSTALLED=0
if [[ -f "$LIDAR_CONFIG_DIR/lidar-installed" && -f "$LIDAR_ENV_FILE" ]]; then
  LIDAR_PREVIOUSLY_INSTALLED=1
fi
if [[ "${INSTALL_G1_LIDAR:-0}" == "1" ]]; then
  if bash "$PROJECT_DIR/backend/install_g1_lidar.sh"; then
    LIDAR_CONFIGURED=1
  else
    echo "ERROR: requested LiDAR/ROS setup did not complete; stopping before reporting app setup success." >&2
    if [[ "$LIDAR_PREVIOUSLY_INSTALLED" == "1" ]]; then
      echo "The previous LiDAR installation/configuration may still be present; inspect its services and logs." >&2
    fi
    exit 1
  fi
elif [[ -f "$LIDAR_CONFIG_DIR/lidar-installed" ]]; then
  LIDAR_CONFIGURED=1
fi

echo "Checking Unitree SDK imports using $PYTHON"
CYCLONEDDS_HOME="$HOME/cyclonedds/install" "$PYTHON" -c \
  "from unitree_sdk2py.core.channel import ChannelFactoryInitialize; from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient"

echo "Preparing the vendored DUET G1 controller (without starting it)"
python3 "$PROJECT_DIR/backend/duet_setup.py" --prepare
DUET_EXPECTED_POLICY_ID="$(python3 "$PROJECT_DIR/backend/duet_setup.py" --policy-id)"
echo "DUET backend policy identity: $DUET_EXPECTED_POLICY_ID"
python3 "$PROJECT_DIR/vendor/DUET/deploy/robots/g1_23dof/install_user_service.py" \
  --interface "$UNITREE_INTERFACE" \
  --control-dir "$DUET_CONTROL_DIR"

echo "Installing backend dependencies"
"$PYTHON" -m pip install -r "$PROJECT_DIR/backend/requirements.txt"

mkdir -p "$LIDAR_CONFIG_DIR"
FRONTEND_DEPENDENCIES_SIGNATURE="$(
  sha256sum "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" \
    | sha256sum | awk '{print $1}'
)"
FRONTEND_DEPENDENCIES_MARKER="$LIDAR_CONFIG_DIR/frontend-dependencies.sha256"
cd "$PROJECT_DIR"
if [[ ! -d "$PROJECT_DIR/node_modules" ||
      ! -f "$FRONTEND_DEPENDENCIES_MARKER" ||
      "$(cat "$FRONTEND_DEPENDENCIES_MARKER")" != "$FRONTEND_DEPENDENCIES_SIGNATURE" ]]; then
  echo "Preparing hosted frontend dependencies (cached packages are preferred)"
  if ! npm install --prefer-offline --no-audit --no-fund; then
    echo "Frontend dependency installation failed; see npm output above." >&2
    exit 1
  fi
  FRONTEND_DEPENDENCIES_SIGNATURE="$(
    sha256sum "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" \
      | sha256sum | awk '{print $1}'
  )"
  printf '%s\n' "$FRONTEND_DEPENDENCIES_SIGNATURE" > "$FRONTEND_DEPENDENCIES_MARKER"
else
  echo "Frontend dependencies are unchanged; reusing node_modules."
fi
FRONTEND_BUILD_MARKER="$LIDAR_CONFIG_DIR/frontend-build.sha256"
FRONTEND_BUILD_SIGNATURE="$(
  {
    sha256sum \
      "$PROJECT_DIR/package.json" \
      "$PROJECT_DIR/package-lock.json" \
      "$PROJECT_DIR/index.html" \
      "$PROJECT_DIR/vite.config.js" \
      "$PROJECT_DIR/postcss.config.js" \
      "$PROJECT_DIR/tailwind.config.js"
    find "$PROJECT_DIR/src" "$PROJECT_DIR/public" -type f -print0 \
      | sort -z | xargs -0 -r sha256sum
  } | sha256sum | awk '{print $1}'
)"
if [[ ! -f "$PROJECT_DIR/backend/static/index.html" ||
      ! -f "$FRONTEND_BUILD_MARKER" ||
      "$(cat "$FRONTEND_BUILD_MARKER")" != "$FRONTEND_BUILD_SIGNATURE" ]]; then
  echo "Building the hosted frontend bundle"
  npm run build
  printf '%s\n' "$FRONTEND_BUILD_SIGNATURE" > "$FRONTEND_BUILD_MARKER"
else
  echo "Hosted frontend is unchanged; reusing the existing production bundle."
fi

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/uni-edu-studio.service" <<EOF
[Unit]
Description=Uni EDU Studio application and Harry Botter AI services
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=PATH=$PATH
Environment=CYCLONEDDS_HOME=$HOME/cyclonedds/install
Environment=UNITREE_DOMAIN_ID=0
Environment=UNITREE_INTERFACE=$UNITREE_INTERFACE
Environment=UNI_EDU_PORT=5179
Environment=UNI_EDU_PYTHON=$PYTHON
Environment=HARRY_BOTTER_SKIP_BUILD=1
Environment=DUET_CONTROL_DIR=$DUET_CONTROL_DIR
Environment=DUET_EXPECTED_POLICY_ID=$DUET_EXPECTED_POLICY_ID
EnvironmentFile=-$PROJECT_DIR/.env.harry-botter.local
ExecStart=$NODE_BIN $PROJECT_DIR/scripts/start-program.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

if [[ "$LIDAR_CONFIGURED" == "1" || -f "$LIDAR_ENV_FILE" ]]; then
  python3 - "$UNIT_DIR/uni-edu-studio.service" "$LIDAR_ENV_FILE" "$LIDAR_CONFIGURED" <<'PY'
from pathlib import Path
import sys

unit_path = Path(sys.argv[1])
environment_file = sys.argv[2]
lidar_setup_succeeded = sys.argv[3] == "1"
unit = unit_path.read_text(encoding="utf-8")
environment = Path(environment_file).read_text(encoding="utf-8").splitlines()
settings = dict(line.split("=", 1) for line in environment if "=" in line)
runtime = settings.get("G1_LIDAR_ROS_RUNTIME", "")
driver_required = settings.get("G1_LIDAR_DRIVER_REQUIRED", "1") == "1"
axis_confirmed = settings.get("G1_LIDAR_AXIS_CONFIRMED") == "1"
calibration_confirmed = settings.get("G1_DISTANCE_CALIBRATION_CONFIRMED") == "1"
if lidar_setup_succeeded and runtime == "host":
    dependencies = []
    if driver_required:
        dependencies.append("uni-edu-lidar-driver.service")
    if axis_confirmed and calibration_confirmed:
        dependencies.append("uni-edu-lidar-provider.service")
    if dependencies:
        dependency_list = " ".join(dependencies)
        unit = unit.replace(
            "Wants=network-online.target\n",
            f"Wants=network-online.target {dependency_list}\n",
        )
        unit = unit.replace(
            "After=network-online.target\n",
            f"After=network-online.target {dependency_list}\n",
        )
unit = unit.replace("[Service]\n", f"[Service]\nEnvironmentFile={environment_file}\n")
unit_path.write_text(unit, encoding="utf-8")
PY
fi

systemctl --user daemon-reload
if [[ "$LIDAR_CONFIGURED" == "1" ]]; then
  AXIS_SETTING="$(grep '^G1_LIDAR_AXIS_CONFIRMED=' "$LIDAR_ENV_FILE" || printf 'G1_LIDAR_AXIS_CONFIRMED=1')"
  AXIS_CONFIRMED="${AXIS_SETTING#*=}"
  CALIBRATION_SETTING="$(grep '^G1_DISTANCE_CALIBRATION_CONFIRMED=' "$LIDAR_ENV_FILE" || printf 'G1_DISTANCE_CALIBRATION_CONFIRMED=0')"
  CALIBRATION_CONFIRMED="${CALIBRATION_SETTING#*=}"
  DRIVER_SETTING="$(grep '^G1_LIDAR_DRIVER_REQUIRED=' "$LIDAR_ENV_FILE" || printf 'G1_LIDAR_DRIVER_REQUIRED=1')"
  DRIVER_REQUIRED="${DRIVER_SETTING#*=}"
  if grep -q '^G1_LIDAR_ROS_RUNTIME=host$' "$LIDAR_ENV_FILE"; then
    if [[ "$DRIVER_REQUIRED" == "1" ]]; then
      systemctl --user enable --now uni-edu-lidar-driver.service
    else
      echo "Reusing the discovered ROS point-cloud stream; no Livox driver service will be started."
    fi
    if [[ "$AXIS_CONFIRMED" == "1" && "$CALIBRATION_CONFIRMED" == "1" ]]; then
      systemctl --user enable --now uni-edu-lidar-provider.service
    else
      systemctl --user disable --now uni-edu-lidar-provider.service >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$AXIS_CONFIRMED" != "1" || "$CALIBRATION_CONFIRMED" != "1" ]]; then
    if [[ "$DRIVER_REQUIRED" == "1" ]]; then
      echo "MID-360 driver installed for diagnostics; distance provider/conditions remain disabled pending axis and metric calibration verification."
    else
      echo "Existing sensor stream is available for diagnostics; physical distance conditions remain disabled pending verified calibration."
    fi
  else
    echo "Sensor provider service is installed. Fresh sensor data will be checked only after a teacher clicks Connect."
  fi
elif [[ -f "$LIDAR_ENV_FILE" ]]; then
  echo "LiDAR setup did not complete; reusing the saved provider configuration for diagnostics."
  SAVED_ROS_RUNTIME="$(awk -F= '$1 == "G1_LIDAR_ROS_RUNTIME" {sub(/^[^=]*=/, ""); print; exit}' "$LIDAR_ENV_FILE")"
  if [[ "$SAVED_ROS_RUNTIME" == "container" ]]; then
    PROVIDER_SERVICE_MANAGER=(sudo systemctl)
  elif [[ "$SAVED_ROS_RUNTIME" == "host" ]]; then
    PROVIDER_SERVICE_MANAGER=(systemctl --user)
  else
    PROVIDER_SERVICE_MANAGER=()
  fi
  if [[ "${#PROVIDER_SERVICE_MANAGER[@]}" -gt 0 ]] &&
     "${PROVIDER_SERVICE_MANAGER[@]}" cat uni-edu-lidar-provider.service >/dev/null 2>&1; then
    echo "Starting the previously configured LiDAR provider for diagnostics; distance remains fail-closed without fresh validated data."
    if ! "${PROVIDER_SERVICE_MANAGER[@]}" restart uni-edu-lidar-provider.service; then
      echo "WARNING: The existing LiDAR provider could not be restarted; inspect its service logs." >&2
    fi
  else
    echo "No existing LiDAR provider service is available to start; sensor diagnostics will report it unavailable." >&2
  fi
fi
systemctl --user enable uni-edu-studio.service
systemctl --user restart uni-edu-studio.service
APP_READY=0
for attempt in {1..600}; do
  if "$PYTHON" -c \
    'from urllib.request import ProxyHandler, build_opener; build_opener(ProxyHandler({})).open("http://127.0.0.1:5179/", timeout=1).read(1)' \
    >/dev/null 2>&1; then
    APP_READY=1
    break
  fi
  if (( attempt % 30 == 0 )); then
    echo "Waiting for Uni-EDU HTTP service on 127.0.0.1:5179 ($attempt seconds elapsed)..."
    echo "Recent application service logs:"
    journalctl --user -u uni-edu-studio.service -n 30 --no-pager || true
  fi
  sleep 1
done
if [[ "$APP_READY" != "1" ]]; then
  echo "Uni EDU Studio did not serve its HTTP endpoint on http://127.0.0.1:5179 after restart." >&2
  echo "Service status and recent logs:" >&2
  systemctl --user --no-pager -l status uni-edu-studio.service >&2 || true
  journalctl --user -u uni-edu-studio.service -n 40 --no-pager >&2 || true
  exit 1
fi
report_voice_service_diagnostics() {
  echo "Loopback voice health probe:"
  curl -sS --max-time 2 -o /dev/null \
    -w 'HTTP response: %{http_code}\n' \
    http://127.0.0.1:8765/api/v1/health || true
  echo "Application service status:"
  systemctl --user --no-pager -l status uni-edu-studio.service || true
  echo "Recent application service logs:"
  local service_logs
  service_logs="$(journalctl --user -u uni-edu-studio.service -n 80 --no-pager 2>&1)" || true
  if [[ -n "$service_logs" ]]; then
    printf '%s\n' "$service_logs"
  else
    echo "No application service log entries were returned."
  fi
  if grep -Fq "No journal files were found" <<< "$service_logs"; then
    echo "The user journal is unavailable, so journalctl cannot show the voice startup error. This is a logging limitation, not the cause of the failed health check."
  fi
}
VOICE_READY=0
for attempt in {1..600}; do
  if curl -fsS --max-time 1 http://127.0.0.1:8765/api/v1/health >/dev/null 2>&1; then
    VOICE_READY=1
    break
  fi
  if (( attempt % 30 == 0 )); then
    echo "Waiting for Harry Botter voice service on 127.0.0.1:8765 ($attempt seconds elapsed)..."
    report_voice_service_diagnostics
  fi
  sleep 1
done
if [[ "$VOICE_READY" != "1" ]]; then
  echo "Uni EDU Studio started, but the Harry Botter voice service did not become healthy." >&2
  report_voice_service_diagnostics >&2
  exit 1
fi
sudo loginctl enable-linger "$USER"

echo
echo "Uni EDU Studio and the Harry Botter voice stack are serving the app and will start automatically at boot."
echo "Local model configuration: $PROJECT_DIR/.env.harry-botter.local (optional; see .env.harry-botter.example)."
echo "Open http://<this-computer-wifi-ip>:5179 on a device connected to the same Wi-Fi for text chat."
echo "Remote browser microphone access requires trusted HTTPS; localhost on this computer is supported."
echo "Check service status with: systemctl --user status uni-edu-studio"
echo "DUET controller unit is installed but is NOT enabled or started."
echo "Before any operator start: verify robot model, clear the area, have a qualified operator present, review the unit, and confirm the chosen DDS interface."
echo "Only when the operator is ready, start it explicitly with: systemctl --user start duet-g1-controller.service"
echo "DUET backend socket directory: $DUET_CONTROL_DIR"
if [[ "$LIDAR_CONFIGURED" != "1" && "$LIDAR_PREVIOUSLY_INSTALLED" != "1" ]]; then
  echo "The app/backend is installed without LiDAR. SDK connection and supported non-conditional SDK commands remain available."
elif [[ "$LIDAR_CONFIGURED" != "1" && "$LIDAR_PREVIOUSLY_INSTALLED" == "1" ]]; then
  echo "The existing LiDAR services/configuration were preserved; the latest LiDAR setup retry did not complete."
fi
