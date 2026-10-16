#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_ENV_DIR="${G1_SDK_ENV_DIR:-$HOME/venvs/g1-sdk}"
if [[ ! -x "$SDK_ENV_DIR/bin/python" ]]; then
  SDK_ENV_DIR="$HOME/venvs/g1-sdk-py312"
fi
PYTHON="$SDK_ENV_DIR/bin/python"

if [[ ! -x "$PYTHON" ]]; then
  echo "Unitree SDK virtual environment not found. Set G1_SDK_ENV_DIR to its path." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required for the initial frontend build." >&2
  exit 1
fi

LIDAR_CONFIGURED=0
if [[ "${INSTALL_G1_LIDAR:-0}" == "1" ]]; then
  if bash "$PROJECT_DIR/backend/install_g1_lidar.sh"; then
    LIDAR_CONFIGURED=1
  else
    echo "WARNING: LiDAR setup did not complete; continuing with the G1 SDK backend and ordinary supported SDK commands." >&2
    echo "Distance-condition programs will remain fail-closed until LiDAR setup succeeds." >&2
  fi
elif [[ -f "$HOME/.config/uni-edu-studio/lidar-installed" ]]; then
  LIDAR_CONFIGURED=1
fi

echo "Checking Unitree SDK imports using $PYTHON"
CYCLONEDDS_HOME="$HOME/cyclonedds/install" "$PYTHON" -c \
  "from unitree_sdk2py.core.channel import ChannelFactoryInitialize; from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient"

echo "Installing backend dependencies"
"$PYTHON" -m pip install -r "$PROJECT_DIR/backend/requirements.txt"

echo "Building the hosted frontend"
cd "$PROJECT_DIR"
npm install
npm run build

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/uni-edu-studio.service" <<EOF
[Unit]
Description=Uni EDU Studio G1 robot control backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=CYCLONEDDS_HOME=$HOME/cyclonedds/install
Environment=UNITREE_DOMAIN_ID=0
Environment=UNITREE_INTERFACE=eth0
Environment=UNI_EDU_PORT=5179
ExecStart=$PYTHON $PROJECT_DIR/backend/server.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

if [[ "$LIDAR_CONFIGURED" == "1" ]]; then
  python3 - "$UNIT_DIR/uni-edu-studio.service" "$HOME/.config/uni-edu-studio/lidar.env" <<'PY'
from pathlib import Path
import sys

unit_path = Path(sys.argv[1])
environment_file = sys.argv[2]
unit = unit_path.read_text(encoding="utf-8")
environment = Path(environment_file).read_text(encoding="utf-8").splitlines()
settings = dict(line.split("=", 1) for line in environment if "=" in line)
runtime = settings.get("G1_LIDAR_ROS_RUNTIME", "")
axis_confirmed = settings.get("G1_LIDAR_AXIS_CONFIRMED") == "1"
if runtime == "host":
    dependencies = "uni-edu-lidar-driver.service"
    if axis_confirmed:
        dependencies += " uni-edu-lidar-provider.service"
    unit = unit.replace(
        "Wants=network-online.target\n",
        f"Wants=network-online.target {dependencies}\n",
    )
    unit = unit.replace(
        "After=network-online.target\n",
        f"After=network-online.target {dependencies}\n",
    )
unit = unit.replace("[Service]\n", f"[Service]\nEnvironmentFile={environment_file}\n")
unit_path.write_text(unit, encoding="utf-8")
PY
fi

systemctl --user daemon-reload
if [[ "$LIDAR_CONFIGURED" == "1" ]]; then
  AXIS_SETTING="$(grep '^G1_LIDAR_AXIS_CONFIRMED=' "$HOME/.config/uni-edu-studio/lidar.env" || printf 'G1_LIDAR_AXIS_CONFIRMED=1')"
  AXIS_CONFIRMED="${AXIS_SETTING#*=}"
  if grep -q '^G1_LIDAR_ROS_RUNTIME=host$' "$HOME/.config/uni-edu-studio/lidar.env"; then
    systemctl --user enable --now uni-edu-lidar-driver.service
    if [[ "$AXIS_CONFIRMED" == "1" ]]; then
      systemctl --user enable --now uni-edu-lidar-provider.service
    else
      systemctl --user disable --now uni-edu-lidar-provider.service >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$AXIS_CONFIRMED" != "1" ]]; then
    echo "MID-360 driver installed for diagnostics; distance provider/conditions remain disabled pending axis verification."
  elif ! command -v curl >/dev/null 2>&1; then
    echo "LiDAR services were started, but curl is unavailable for the initial provider readiness check." >&2
  else
  set -a
  source "$HOME/.config/uni-edu-studio/lidar.env"
  set +a
  SENSOR_READY=0
  REAR_SENSOR_READY=0
  for _ in $(seq 1 20); do
    if curl --silent --show-error --fail --max-time 1 \
      -H "Authorization: Bearer $G1_DISTANCE_PROVIDER_TOKEN" \
      "$G1_DISTANCE_PROVIDER_URL" -o /dev/null; then
      SENSOR_READY=1
    fi
    if curl --silent --show-error --fail --max-time 1 \
      -H "Authorization: Bearer $G1_DISTANCE_PROVIDER_TOKEN" \
      "$G1_DISTANCE_REAR_PROVIDER_URL" -o /dev/null; then
      REAR_SENSOR_READY=1
    fi
    if [[ "$SENSOR_READY" == "1" && "$REAR_SENSOR_READY" == "1" ]]; then
      break
    fi
    sleep 1
  done
  if [[ "$SENSOR_READY" == "1" ]]; then
    echo "MID-360 forward provider returned a fresh authenticated sample."
  else
    echo "LiDAR services started, but no fresh forward sample was received. Check sensor IP/topic and service logs before using forward distance conditions." >&2
  fi
  if [[ "$REAR_SENSOR_READY" == "1" ]]; then
    echo "MID-360 rear provider returned a fresh authenticated sample."
  else
    echo "No fresh rear sample was received. Rear distance conditions will remain fail-closed until valid rear returns are available." >&2
  fi
  fi
fi
systemctl --user enable --now uni-edu-studio.service
sudo loginctl enable-linger "$USER"

echo
echo "Uni EDU Studio is enabled and will start automatically at boot."
echo "Open http://<this-computer-wifi-ip>:5179 on a device connected to the same Wi-Fi."
echo "Check service status with: systemctl --user status uni-edu-studio"
if [[ "$LIDAR_CONFIGURED" != "1" ]]; then
  echo "The app/backend is installed without LiDAR. SDK connection and supported non-conditional SDK commands remain available."
fi
