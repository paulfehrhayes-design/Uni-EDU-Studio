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

systemctl --user daemon-reload
systemctl --user enable --now uni-edu-studio.service
sudo loginctl enable-linger "$USER"

echo
echo "Uni EDU Studio is enabled and will start automatically at boot."
echo "Open http://<this-computer-wifi-ip>:5179 on a device connected to the same Wi-Fi."
echo "Check service status with: systemctl --user status uni-edu-studio"
