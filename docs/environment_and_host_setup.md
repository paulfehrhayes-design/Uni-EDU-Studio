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

One-time setup on a compatible G1 Ubuntu computer requires the project checkout, Node.js/npm, and the already working SDK virtual environment. For a fresh checkout:

```bash
git clone https://github.com/paulfehrhayes-design/Uni-EDU-Studio.git ~/Uni-EDU-Studio
cd ~/Uni-EDU-Studio
G1_SDK_ENV_DIR="$HOME/venvs/g1-sdk" INSTALL_G1_LIDAR=1 bash backend/install_g1_service.sh
```

For an existing checkout, run `git pull` in the project directory before the install command.
If LiDAR was installed before rear-distance support was added, rerun the same install command after pulling the update so the generated service environment includes the rear provider endpoint and the startup check can report both sectors.

Set `G1_SDK_ENV_DIR` to the actual, already-installed Unitree SDK environment path if yours differs. This single command installs/checks sensor dependencies, Python backend requirements, frontend dependencies, and the hosted frontend. It does not install the vendor Unitree SDK; the selected SDK environment must already exist and pass its import check. For Ubuntu 20.04, the LiDAR runtime uses a native-architecture ROS 2 Humble container and host networking, leaving the JetPack host image unchanged; Ubuntu's `docker.io` package is installed if needed. Ubuntu 22.04 uses native ROS 2 Humble. ROS 2 Foxy is not used.

Before installing, `backend/sensor_discovery.py` reports the OS/architecture, active interfaces, service state, available ROS topic names/types, and PointCloud2 frame/timestamp freshness. It samples `ros2 topic echo` using best-effort/volatile QoS so it can receive sensor-data publishers, and bounds the read to the message header. Generic obstacle/grid cloud topics are not treated as LiDAR candidates. A single fresh compatible stream is reused rather than starting a second Livox driver. If the saved LiDAR topic still exists but has not delivered a fresh message, setup can rebuild/restart the provider for diagnostics using that saved topic/frame; the provider and distance conditions remain unavailable until fresh data is received. If no saved compatible source is available, the direct-Livox path proceeds only when saved or explicitly supplied host-NIC and MID-360 addresses are present and validate against the active network. The installer never substitutes guessed network addresses. For example, if discovery identifies the need for a direct driver but cannot infer the actual IPs, rerun with the real values for your sensor network:

```bash
G1_LIDAR_HOST_IP=<actual-pc2-sensor-nic-ip> \
G1_LIDAR_DEVICE_IP=<actual-mid360-ip> \
INSTALL_G1_LIDAR=1 \
bash backend/install_g1_service.sh
```

On the direct-driver path, the Livox launch configuration supplies the output topic/frame defaults (`/mid360/livox/lidar`, `mid360_link`); `G1_LIDAR_TOPIC` and `G1_DISTANCE_FRAME_ID` can override them. Existing ROS streams use their discovered topic and frame. The driver publish frequency defaults to 20 Hz and can be set with `G1_LIDAR_PUBLISH_FREQ`; confirm actual rate and packet health on the robot. The installer derives a conservative footprint from the supported G1 collision model; it does not ask for target measurements or treat old confirmation flags as proof. Different driver frame labels are accepted only when live TF from the model parent frame matches the supported MID-360 mount geometry within configured tolerances.

If the optional LiDAR installation or hardware configuration fails, the script prints a warning and continues installing the G1 SDK backend and web app. Supported non-conditional SDK programs remain available after backend setup succeeds; distance conditions remain fail-closed until the LiDAR provider returns a fresh, valid sample. A failed LiDAR setup does not count as a connected or working sensor.

Run discovery directly when diagnosing a setup:

```bash
python3 backend/sensor_discovery.py
```

The report is read-only. A nonzero exit status means no usable fresh stream or validated direct-driver configuration was found. It lists actionable diagnostics, including stale or unsupported topics, missing ROS tools, and missing/invalid network prerequisites. Docker reuses a cached Humble base image when available; if it is not cached, the initial build needs access to Docker Hub.

The setup provides a read-only ROS point-cloud subscriber and an authenticated HTTP distance provider bound to `127.0.0.1:8181`; it does not install a ROS locomotion bridge. The backend service uses the model files from the checkout, while the Ubuntu 20.04 provider container uses the copies under `/opt/uni-edu`; these paths are configured separately. The provider derives the rectangular footprint from the G1 collision model, requires a timestamp-valid TF transform into the configured robot base frame, and only serves samples whose acquisition timestamp is at most 500 ms old. Calibration status is live: it requires a fresh point cloud, the matching G1 model fingerprint, and a torso-to-sensor TF that agrees with the model candidate within configured tolerances. A fresh cloud with no obstacle is reported with a conservative footprint-adjusted maximum clearance based on the actual TF translation. Missing TF, mismatched frames, stale acquisition timestamps, or malformed clouds keep physical conditions unavailable. Confirm topic rates and transforms on the robot with `ros2 topic hz`, `ros2 topic echo --once`, and `ros2 run tf2_ros tf2_echo <base-frame> <sensor-frame>`. The provider returns both sensor and measurement/base frames so the backend can verify the calibrated contract. A TF published from the same URDF is not independent proof that the physical sensor is mounted as modeled; verify the actual installation before enabling physical distance-dependent behavior.

For a detected existing point-cloud stream, the installer does not enable or restart a second Livox driver. For a direct-Livox setup on Ubuntu 22.04, `uni-edu-lidar-driver` is a user service; on Ubuntu 20.04, it is a system container service. The installer enables the provider service, but the backend distance consumer additionally requires `calibration_status.ready` and a fresh provider sample. Ubuntu 20.04 uses host networking and UDPv4 Fast DDS transport, without granting the classroom user Docker-group/root-equivalent access. A teacher's **Connect** action initializes the G1 SDK and checks provider readiness; **Test LiDAR** can independently read authenticated backend sensor status without connecting the SDK or issuing robot motion. The generated provider token is stored in `~/.config/uni-edu-studio/lidar.env` with owner-only permissions. Check container-runtime logs with `sudo journalctl -u uni-edu-lidar-driver -u uni-edu-lidar-provider -e` and app logs with `journalctl --user -u uni-edu-studio -e`.

The teacher-only Sensors diagnostics panel reports the discovered LiDAR connection, live automatic calibration status, ROS camera topics, camera frame freshness, and valid `CameraInfo` intrinsics. Sensor controls remain in this teacher-only panel. The calibration status reports whether the supported G1 model, fresh stream, and live TF agree; it does not prove that the physical installation matches the URDF, especially if the transform is published from that same URDF. Have the mounting independently checked before using physical distance conditions. The panel's repair action only restarts the allowlisted managed LiDAR driver service; arbitrary shell commands and user-editable service routes are not exposed.

The external projects were considered as design references, not installed dependencies: `KaiFeng-Frank/lidar-camera-imu-calibration` focuses on rigid-rig/offline sensor calibration with reference data; `RaaSaaR-org/g1-sensor-toolkit` helps discover and read G1 sensor streams but does not validate mounting geometry; `botbotrobotics/BotBrain` provides G1 mount/footprint geometry used as a conservative cross-check, not live hardware evidence. No code from these projects is required at runtime.

Camera discovery is diagnostic only: it can identify Intel RealSense USB devices, ROS image topics, fresh camera headers, and valid camera intrinsics. This setup does not install a RealSense ROS driver or provide a browser stream from G1/Unitree/RealSense ROS topics. The **Vision to Motion** panel can show a camera preview from the browser device only after an explicit permission action; that preview is local to the browser and its video frames are never sent to the backend, recorded, or saved. It is not the robot camera feed. Pose inference, motion extraction, camera-to-LiDAR fusion, and robot-camera browser streaming are not implemented. The example-program action inserts a fixed sample and does not use video. Safari requires a trusted HTTPS origin for camera permission (localhost is a browser exception); `http://<g1-wlan-address>` is insufficient for camera preview on iPad.

### Phase 5: software checks and G1 acceptance

Software verification does not establish that a sensor is physically mounted, correctly oriented, or safe to use. On the development checkout, run the backend regression suite and focused sensor UI checks:

```bash
(cd backend && python -m unittest discover -p 'test_*.py')
npx playwright test tests/app-runtime.spec.js --grep "camera preview|sensor diagnostics"
```

Build the frontend to a temporary output directory when checking a worktree that has locally managed static assets:

```bash
npm run build -- --outDir /tmp/uni-edu-studio-build
```

For hardware acceptance, deploy the reviewed branch/commit to a supported G1 using the install procedure above. Keep the robot stationary, maintain access to the physical emergency stop, and leave physical distance-dependent conditions disabled until all independent calibration evidence passes.

1. In the teacher Sensors panel, run **Discover sensors**. Confirm the reported connection method, ROS topic, message type, frame, camera serial (if present), and freshness match the actual devices. Do not treat a network address or a URDF candidate as proof of sensor identity or mounting.
2. Compare the reported point-cloud topic/frame with `ros2 topic list -t`, check its live rate with `ros2 topic hz <pointcloud-topic>`, and inspect the configured base-to-sensor transform with `ros2 run tf2_ros tf2_echo <base-frame> <sensor-frame>`. Have the robot's actual mounting and coordinate convention independently verified; this application does not perform or persist a physical calibration.
3. Confirm calibration reports a live verified status only when fresh TF agrees with the supported model and the provider returns fresh, correctly framed footprint-clearance samples. A frame mismatch or missing TF must remain unavailable. Do not enable physical distance conditions based on model/TF agreement alone until the physical mount is independently verified; legacy confirmation flags do not establish calibration.
4. If a managed LiDAR service restart is needed, use the teacher-only **Restart managed LiDAR driver** action. Re-run discovery, confirm exactly one driver path is active, check the service logs, and verify that fresh point-cloud samples resume. Do not restart a driver when discovery reports that an existing Unitree point-cloud stream is being reused.
5. For a USB RealSense device, verify its identity and serial against the physical unit and check that the ROS image and matching CameraInfo topics are fresh. The current integration does not install a RealSense driver, validate RGB/depth stream health, or provide a robot-camera browser stream; report those capabilities as unavailable rather than accepting discovery alone as a live preview test. Unitree camera transport is likewise not commissioned by ROS topic discovery alone.
6. On an iPad, open the reviewed app from a trusted HTTPS origin, explicitly grant Safari camera permission, verify the personal-device preview, then switch sources or leave **Vision to Motion** and confirm the local camera stops. The preview is local to the browser and is not uploaded or saved.
7. Test localization, mapping, navigation, and physical motion only under their separate robot commissioning procedures. Sensor discovery is not navigation readiness, and this application does not enable autonomous movement based on camera preview.

If the G1 PC2 is not Ubuntu 20.04 or 22.04, or discovery reports an unsupported/ambiguous interface or missing network configuration, do not force the direct-driver path. Discovery recognizes ROS-visible point-cloud topics; it does not prove a native Unitree DDS interface is compatible unless it is exposed as a fresh `sensor_msgs/msg/PointCloud2` topic. The Ubuntu 20.04 container uses host networking and exposes the authenticated provider only on loopback; it does not use `--privileged` or install ROS on the host. A separate compatible ROS 2 computer can host the driver/provider, but that requires manual setup; expose its authenticated provider only through a  trusted network and put a TLS reverse proxy in front of it before configuring the backend to use HTTPS. LiDAR setup is opt-in with `INSTALL_G1_LIDAR=1`; the existing backend-only installer remains available without that setting.

LiDAR room scanning and path navigation require a separate ROS 2/SLAM/Nav2 deployment and are not installed by this command. The onboard installer configures MID-360 streaming and fresh distance samples with ROS 2 Humble; it does not install SLAM, Nav2, an occupancy-map publisher, or the planner gateway. The documented navigation gateway currently targets ROS 2 Humble and needs a compatible ROS 2/Nav2 host, live SLAM occupancy map, fresh MID-360 point cloud (default `/mid360/livox/lidar`), valid sensor/map transform, and fresh localization. A teacher-confirmed scan uses Nav2's `/spin` action to rotate in place through 360° via the same Nav2/G1 velocity bridge; it does not create a second velocity publisher. The teacher must supervise from a clear area with the robot stable and the independent emergency stop immediately available. Configure and commission Nav2 Spin speed/acceleration and collision checking on the actual hardware before enabling its action server for this workflow. Scan capture fails closed on stale LiDAR/map/localization or an incomplete turn. The teacher validates and explicitly publishes the map for student grids; the shared overlay toggle is stored centrally by the app backend. The app's SDK motion path remains locked while a scan or navigation operation owns locomotion, but this does not arbitrate against independent ROS publishers, terminals, or external controllers. The navigation bridge remains a separately deployed and commissioned service. See [the navigation gateway contract](./lidar_navigation_bridge.md) for prerequisites, map calibration, and hardware-validation boundaries.

The installer builds the frontend, installs backend requirements into the SDK environment, and enables user `systemd` services at boot. It asks for sudo permission for ROS/SDK installation and service persistence. To use a different DDS interface/domain, edit the generated `~/.config/systemd/user/uni-edu-studio.service`, then run `systemctl --user daemon-reload && systemctl --user restart uni-edu-studio`.

Find the G1 computer's Wi-Fi address with `ip -br addr` (the `wlan0` row), then open `http://<wlan0-address>:5179` on the iPad/desktop while it is on the same trusted Wi-Fi. The G1 Ethernet interface remains `eth0` for DDS by default. In the app, log in with the teacher account, press **Connect**, confirm **Connected**, then run a supported program. The Connect button uses `UNITREE_INTERFACE=eth0` by default and no longer asks classroom users for an interface name.

Each connection creates a private JSON Lines session file under `/home/unitree/harry_botter` by default. It records connection attempts/results and validated command/program start, completion, stop, or failure events. Set `G1_DATA_DIR` in the service unit to change the destination. The backend must run as a user with write access to this directory; the SSH password is not used or stored by the app.

Check service startup/errors with `systemctl --user status uni-edu-studio` and `journalctl --user -u uni-edu-studio -e`. Keep the service and port on a trusted local network; do not expose port 5179 to the public internet or configure router port forwarding. Physical motion is not verified by service startup or a Connected status. Keep a clear supervised area and the robot's independent emergency stop available.

The backend accepts only the shared, bounded `robot.*` command language and bounded `for ... in range(...)` loops. Physical execution currently maps stand, forward/backward walking, timed/slow/fast walking, turns, and one-step sidesteps to the SDK locomotion client. Supported arm presets use the G1 arm-action SDK; they are sent exactly as written and do not implicitly append a `release arm` action. `robot.hold_arm("hands up", 3)` runs one of the supported static presets and waits at least the requested 0.1–10 seconds before continuing; it does not actively maintain joint targets or verify that the pose has completed. The SDK reports acceptance rather than completion, so wait for a preset or posture transition to finish before walking. Before every locomotion command the backend checks `GetFsmId()` and only sends velocity in ready FSM 500; otherwise it rejects the command and directs the program to use `robot.stand()` and wait. Kicks and knee actions remain unavailable for physical runs unless a verified SDK mapping is configured.

The teacher queue's **Clear queue** action removes waiting and finished entries, while leaving any currently running job visible. **Run next** sends the oldest queued program to the same physical G1 SDK executor; if the robot is not ready, that job remains queued so the teacher can reconnect and retry.

After connecting, teachers can use **Test motion** for one confirmed 0.5-second slow forward command (about 10 cm at the configured SDK speed). It does not run automatically on connection and does not verify physical movement. Use it only when the robot is upright and stable, the area is clear, and someone is ready at the emergency stop.

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
