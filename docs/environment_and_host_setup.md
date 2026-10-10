# Environment and Host Setup

This guide explains the exact startup steps. Follow the correct option for your situation. Do not mix the two modes.

## Important: two different modes

There are two valid ways to run this app:

1. Local development mode
   - Use this when you are working on a laptop or desktop.
   - The browser loads the frontend directly from Vite.
   - Open: `http://localhost:5173`

2. Hosted classroom mode
   - Use this when the app is being served from a classroom computer or robot host.
   - The backend serves the built frontend from the `backend/static` directory.
   - Open: `http://<host-ip>:5179`

Important: the backend now resolves the frontend directory using an absolute path, so it works whether you start it from the repo root or from the `backend` folder. The blank gray page happened because the app was being launched in the wrong mode or from the wrong folder before the frontend was built.

If you start only the Python backend without building the frontend, the page may look blank or fail to load.

---

## Option A: Local development mode
Use this if you are running the app on your own computer.

### Step 1: Go to the project folder
```bash
cd /workspaces/Uni-EDU-Studio
```

### Step 2: Install dependencies
```bash
npm install
```

Install the Python backend dependencies:

```bash
python -m pip install -r backend/requirements.txt
```

### Step 3: Start the frontend in development mode
```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

### Step 4: Open the browser
```text
http://localhost:5173
```

### What this mode does
- Starts the React/Vite frontend
- Lets you edit and view the app in real time
- Does not require the backend to serve the UI

---

## Option B: Hosted classroom mode
Use this when the app is running from a robot host, classroom computer, or other networked machine.

### Step 1: Go to the project folder
```bash
cd /workspaces/Uni-EDU-Studio
```

### Step 2: Install dependencies
```bash
npm install
```

### Step 3: Build the frontend for hosting
```bash
npm run build
```

This creates the files needed by the backend in `backend/static`.

### Step 4: Start the backend server
You can start it from either location:

From the project root:
```bash
cd /workspaces/Uni-EDU-Studio
python backend/server.py
```

Or from the backend folder:
```bash
cd /workspaces/Uni-EDU-Studio/backend
python server.py
```

Alternative:

```bash
cd /workspaces/Uni-EDU-Studio/backend
uvicorn server:app --host 0.0.0.0 --port 5179
```

If port 5179 is already in use, the server will automatically try the next available port and print the new one in the terminal. You should then open that actual port shown in the output instead of assuming 5179 is always available.

### Step 5: Open the app in a browser
From another device on the same network:

```text
http://<host-ip>:5179
```

Example:

```text
http://192.168.123.164:5179
```

### What this mode does
- Builds the frontend once
- Starts the FastAPI backend
- Serves the app from the backend on port 5179

> If you skip `npm run build`, the backend has nothing to serve and the page can appear blank.

---

## Quick summary

### For local testing
```bash
cd /workspaces/Uni-EDU-Studio
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

Open:
```text
http://localhost:5173
```

### For classroom hosting
```bash
cd /workspaces/Uni-EDU-Studio
npm install
npm run build
python -m pip install -r backend/requirements.txt
python backend/server.py
```

Alternative from the backend folder:
```bash
cd /workspaces/Uni-EDU-Studio/backend
python server.py
```

Open:
```text
http://<host-ip>:5179
```

> Use either of the two backend-start commands above, but do not start the Vite dev server and the Python backend together unless you intentionally want the two modes mixed.

## Physical G1 control

The robot-control backend must run on the G1 computer (or a host with the supported Unitree SDK2 Python and DDS network access). A Codespace or ordinary classroom server does not control a robot just because the browser can reach its IP address.

Install the Unitree SDK2 Python package using the vendor-supported setup for the robot image, then start the backend with the correct DDS domain:

```bash
export UNITREE_DOMAIN_ID=0
python backend/server.py
```

In the teacher G1 connection panel, enter the network interface name used by the robot computer (commonly `eth0`) and connect. A successful status means the SDK locomotion client initialized; it does not replace the robot's physical safety checks or enable unsupported actions.

### Run the app from the G1 computer without opening a terminal each class

For a normal browser-only classroom experience, host the website and SDK2 backend on the G1's onboard Ubuntu computer. Students' iPads/desktops open the G1 computer's Wi-Fi address in a browser; the backend uses its Ethernet DDS interface to communicate with the robot. This uses the G1 computer as the SDK host; it is not a direct browser-to-robot WebRTC connection.

One-time setup on the G1 Ubuntu computer requires the project checkout, Node.js/npm, and the already working SDK virtual environment:

```bash
cd ~/Uni-EDU-Studio
git pull
G1_SDK_ENV_DIR="$HOME/venvs/g1-sdk" bash backend/install_g1_service.sh
```

Set `G1_SDK_ENV_DIR` to the actual SDK environment path if yours differs. The installer builds the frontend, installs backend requirements into that environment, and enables a user `systemd` service at boot. It asks for sudo permission to enable service persistence. To use a different DDS interface/domain, edit the generated `~/.config/systemd/user/uni-edu-studio.service`, then run `systemctl --user daemon-reload && systemctl --user restart uni-edu-studio`.

Find the G1 computer's Wi-Fi address with `ip -br addr` (the `wlan0` row), then open `http://<wlan0-address>:5179` on the iPad/desktop while it is on the same trusted Wi-Fi. The G1 Ethernet interface remains `eth0` for DDS by default. In the app, log in with the teacher account, press **Connect**, confirm **Connected**, then run a supported program. The Connect button uses `UNITREE_INTERFACE=eth0` by default and no longer asks classroom users for an interface name.

Each connection creates a private JSON Lines session file under `/home/unitree/harry_botter` by default. It records connection attempts/results and validated command/program start, completion, stop, or failure events. Set `G1_DATA_DIR` in the service unit to change the destination. The backend must run as a user with write access to this directory; the SSH password is not used or stored by the app.

Check service startup/errors with `systemctl --user status uni-edu-studio` and `journalctl --user -u uni-edu-studio -e`. Keep the service and port on a trusted local network; do not expose port 5179 to the public internet or configure router port forwarding. Physical motion is not verified by service startup or a Connected status. Keep a clear supervised area and the robot's independent emergency stop available.

The backend accepts only the shared, bounded `robot.*` command language and bounded `for ... in range(...)` loops. Physical execution currently maps stand, forward/backward walking, timed/slow/fast walking, turns, and one-step sidesteps to the SDK locomotion client. Arm gestures, kicks, and knee actions remain simulation-only until a verified G1 SDK action or controller mapping is configured; those commands are rejected for physical runs rather than simulated as success.

The teacher queue's **Clear queue** action removes waiting and finished entries, while leaving any currently running job visible. **Run next** sends the oldest queued program to the same physical G1 SDK executor; if the robot is not ready, that job remains queued so the teacher can reconnect and retry.

Planner paths are converted to timed walking and turn commands. The G1 SDK interface used here is open-loop and does not read localization, so a physical route cannot stop exactly at its plotted waypoint coordinates. The simulation may show the intended waypoints; physical accuracy requires a localization/odometry feedback integration and real-robot calibration.

The browser uses a connection adapter interface (`src/robot/RobotConnection.js`) for status, connect, run, and stop. The SDK adapter wraps the existing authenticated backend routes; a mock adapter exercises the same bounded command catalog in tests. The WebRTC adapter requires an explicitly supplied transport and command encoders, and no WebRTC command is marked supported until its G1 protocol mapping is verified. It parses the shared command language and sends structured encoded commands, never arbitrary Python source.

---

## Default login accounts
- Teacher: `teacher` / `teacher`
- Student: `student1` / `student1`

## Optional Hugging Face prompt generation

The Prompt to Motion tab works locally by default. To enable the optional Hugging Face generator, configure the backend process environment before starting the server:

```bash
export HUGGINGFACE_API_TOKEN="your-token"
export HF_TEXT_TO_MOTION_MODEL="HuggingFaceTB/SmolLM3-3B"
python backend/server.py
```

The token stays on the backend and is never sent to the browser. Hugging Face output is treated as plain text and passed through the local safe motion compiler before it can update Blocks, IDE, or the simulator. If the service is unavailable, the app automatically uses the local compiler.

## Recommended classroom setup
- One robot
- One teacher account
- Many student accounts
- Students submit code to the queue
- Teacher runs the robot in order

## Important reminder
This app is designed for classroom learning and safe robot use. Students should test in simulation before running on the physical robot.

## G1 3D model assets

The hosted frontend includes the Unitree G1 mesh rig under `public/g1`. Run `npm run build` after changing or replacing these assets so the backend serves the updated model. The browser loads the STL meshes and `g1.xml` asynchronously; the procedural model remains visible briefly while the full mesh rig loads.
