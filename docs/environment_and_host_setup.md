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

### DUET v2 controller connection (separate from SDK2)

DUET does not connect through the browser or the legacy Unitree SDK adapter. The DUET backend talks to the modified DUET controller over a private Unix-domain socket on the **same host**. In this repository, the modified DUET source is under `vendor/DUET`; its CMake entry point builds `deploy/robots/g1_23dof/build/g1_ctrl`.

The normal G1 installer command below now also prepares this controller: it installs missing Ubuntu/Debian build packages, builds `g1_ctrl` when no executable is present, derives the SHA-256 identity of the policy selected by the controller's `config/config.yaml`, writes the backend's `DUET_EXPECTED_POLICY_ID`, and installs the manual-start controller user unit. It passes the same `UNITREE_INTERFACE` and `DUET_CONTROL_DIR` values to both services. The existing defaults remain `eth0` and `$HOME/.cache/uni-edu-duet`; set `UNITREE_INTERFACE` to the actual G1 DDS interface and `DUET_CONTROL_DIR` to an absolute path when yours differ.

The automatic setup does **not** install Unitree's proprietary/host-installed SDK2 C++ libraries or DDS/Iceoryx libraries. Those must already be available to the vendor CMake build at the locations expected by `vendor/DUET/deploy/robots/g1_23dof/CMakeLists.txt` (`/usr/local/include/ddscxx`, `/usr/local/include/iceoryx/v2.0.2`, and linkable `unitree_sdk2`, `ddsc`, and `ddscxx` libraries). CMake fails with its dependency diagnostic if this host toolchain is incomplete. The backend's Python SDK environment is separate from those C++ build dependencies.

The unit is created for the same non-root user as the backend, but deliberately is not enabled or started by installation. A teacher-confirmed **Connect** may start the unit when no legacy SDK program, navigation job, or LiDAR scan is active. An idle SDK client may remain initialized, but legacy motion commands are blocked while the DUET service is active. This API interlock does not itself switch the robot's FSM or implement a physical ownership handoff. The controller must start in a no-command handoff state: it must not publish the Passive state's damping commands at process startup. Connect does not transition the FSM or issue motion. If the robot is already in Velocity, leave it there; do not press L2+Up/F1 to transition back to FixStand. If the gateway is unavailable, the app cannot determine the FSM from that fact. Do not attempt a mode transition based only on app status; have a qualified onsite operator verify the controller and robot state. Finding no unit with `duet` in its name means this deployment helper has not installed that unit; it does not prove whether some other launcher is running the controller.

The controller process must wait without publishing low-level commands in Handoff. The local gateway socket becomes available only in the configured Velocity state. Do not transition from Velocity back to FixStand just to make the gateway appear. If the controller is in Handoff and the robot's actual FSM cannot be verified, do not guess at a transition; have a qualified onsite operator inspect the robot and deployed controller. For the installer-generated unit, `DUET_CONTROL_DIR` is the absolute `$HOME/.cache/uni-edu-duet`; when the backend's `DUET_CONTROL_DIR` is unset, its default is also `$HOME/.cache/uni-edu-duet`. Confirm both services run as the same local user and home directory. The supplied interface must be the G1 host's actual DDS interface; discovering that the interface exists does not prove DDS connectivity. The socket is local IPC, not a network address; opening the app from a classroom browser does not provide that connection.

The backend needs `DUET_EXPECTED_POLICY_ID` set to the exact policy identity reported by the deployed controller. The G1 installer derives it from the `policy_dir` in the controller's `config/config.yaml`, follows the same version-directory selection as `deploy/include/param.h`, hashes that directory's `exported/policy.onnx`, and writes the resulting `sha256:<hex>` identity to the backend unit. Rerun the setup command after changing the controller's configured policy so the backend and controller identities stay aligned. If configuring the backend service manually, add these environment entries to `~/.config/systemd/user/uni-edu-studio.service` under `[Service]`, then reload and restart that service:

```ini
Environment=DUET_CONTROL_DIR=/home/<g1-user>/.cache/uni-edu-duet
Environment=DUET_EXPECTED_POLICY_ID=sha256:<exact-controller-policy-hash>
```

After editing the backend service, run `systemctl --user daemon-reload && systemctl --user restart uni-edu-studio`. Set `DUET_CONTROL_DIR` to the actual directory shared by both processes; do not copy the example user path literally. Connect can start the checked-in controller unit only after teacher confirmation. Do not add `DUET_GATEWAY_ENABLED` only to `uni-edu-studio.service`: that setting must reach the controller process. `DUET_PHYSICAL_ENABLED=true` and `DUET_COMMISSIONING_ENABLED=true` are additional explicit gates for teacher commissioning, not substitutes for a running gateway or matching policy. Do not enable normal physical runs until the exact robot and policy have passed the documented supervised hardware acceptance.

Select **DUET v2** in the teacher panel and press **Connect**. After explicit teacher confirmation, Connect starts the checked-in unit in its no-command handoff state if it is inactive; it does not enter FixStand or Velocity. If the DUET controller is already in Velocity, Connect acquires the app lease without changing the FSM. If the robot is already in Velocity, leave it there; do not transition it back to FixStand. If the service is active but the gateway is unavailable, the app cannot determine the robot's actual FSM or posture. Do not attempt a mode transition based only on that status. Only a qualified onsite operator who has verified the robot and controller state may decide whether the configured FixStand → Velocity procedure is appropriate. If the state cannot be verified, do not guess at a transition. To diagnose a missing socket, compare the effective variables of both processes:

```bash
systemctl --user show uni-edu-studio.service -p MainPID
backend_pid=$(systemctl --user show uni-edu-studio.service -p MainPID --value)
tr '\0' '\n' < "/proc/$backend_pid/environ" | grep '^DUET_CONTROL_DIR='
```

For the checked-in unit, inspect `systemctl --user status duet-g1-controller.service` and its journal; for another launcher, inspect that process's service or startup script. Confirm the controller environment contains both `DUET_GATEWAY_ENABLED=true` and the same `DUET_CONTROL_DIR`. If either process omits `DUET_CONTROL_DIR`, its default is `$HOME/.cache/uni-edu-duet`; this only matches if both run as the same user with the same home directory. A missing socket while the service is active does not establish the robot's FSM or physical condition. Do not try a mode transition based only on app status; have a qualified operator inspect the robot and logs and follow the model-specific procedure. Connect/status checks are not proof of safe physical behavior and connection never starts a motion. See [the DUET gateway and hardware-verified commands guide](./duet-v2-gateway-implementation-plan.md) and [teacher guide](./teacher_guide.md) for commissioning and acceptance requirements.

Switching back to the legacy SDK path requires confirmed absence of DUET `rt/lowcmd` ownership. If DUET still owns the command path or backend status cannot verify ownership, the UI blocks the switch and does not disconnect/stop the controller automatically. The operator must first return the G1 controller to Passive. This DUET gateway reports status only while its RL Velocity state runs; if the gateway becomes unavailable in Passive and ownership cannot be confirmed as released, do not bypass the block. Resolve that state locally and safely (including manually stopping the service only after confirming Passive, if needed), then retry the switch. SDK backend ownership interlocks remain in force regardless of UI selection.

Install the Unitree SDK2 Python package using the vendor-supported setup for the robot image, then start the backend with the correct DDS domain:

```bash
export UNITREE_DOMAIN_ID=0
python backend/server.py
```

In the teacher G1 connection panel, enter the network interface name used by the robot computer (commonly `eth0`) and connect. A successful status means the SDK locomotion client initialized; it does not replace the robot's physical safety checks or enable unsupported actions.

### Arm gesture targets: hardware versus simulator

The official [Unitree SDK2 G1 arm-action client](https://github.com/unitreerobotics/unitree_sdk2/blob/main/include/unitree/robot/g1/arm/g1_arm_action_client.hpp) provides named preset IDs and an action-list query; it does not publish the preset joint trajectories. Its [arm-action example](https://github.com/unitreerobotics/unitree_sdk2/blob/main/example/g1/high_level/g1_arm_action_example.cpp) executes those presets by ID. The official [7-DOF arm SDK example](https://github.com/unitreerobotics/unitree_sdk2/blob/main/example/g1/high_level/g1_arm7_sdk_dds_example.cpp) demonstrates joint-position control, but its sample pose leaves wrist pitch and yaw at zero and is not a gesture reference. The current upstream convenience map lists `right kiss` as ID 12, while this backend's existing mapping uses ID 13; this task does not alter physical action IDs. Verify the robot's live `GetActionList` and the installed SDK/firmware mapping before running that preset.

Accordingly, the simulator uses the existing pose catalog for shoulder/elbow/wrist-roll motion and adds small, explicitly approximate wrist-pitch/yaw angles to legacy gesture previews. They are visual-only, mirrored for the other arm, and remain within the G1 model's wrist ranges (±1.61443 rad); they are not extracted SDK trajectories and must not be used as physical targets. The bundled [`public/g1/g1.xml`](../public/g1/g1.xml) is the source for simulator axes and ranges, not evidence that a gesture is safe on hardware. Physical arm gestures continue to use only the SDK's named built-in actions and their documented stop/hold limitations.

### Run the app from the G1 computer without opening a terminal each class

For a normal browser-only classroom experience, host the website and SDK2 backend on the G1's onboard Ubuntu computer. Students' iPads/desktops open the G1 computer's Wi-Fi address in a browser; the backend uses its configured Ethernet DDS interface to communicate with the robot. This uses the G1 computer as the SDK host; it is not a direct browser-to-robot WebRTC connection.

One-time setup on a compatible G1 Ubuntu computer requires the project checkout, Node.js/npm, and the already working SDK virtual environment. For a fresh checkout:

```bash
git clone https://github.com/paulfehrhayes-design/Uni-EDU-Studio.git ~/Uni-EDU-Studio
cd ~/Uni-EDU-Studio
G1_SDK_ENV_DIR="$HOME/venvs/g1-sdk" INSTALL_G1_LIDAR=1 bash backend/install_g1_service.sh
```

For an existing checkout, run `git pull` in the project directory before the install command.
If LiDAR was installed before rear-distance support was added, rerun the same install command after pulling the update so the generated service environment includes the rear provider endpoint and the startup check can report both sectors.

Set `G1_SDK_ENV_DIR` to the actual, already-installed Unitree SDK environment path if yours differs. This command installs/checks sensor dependencies, Python backend requirements, frontend dependencies, builds the hosted frontend, and prepares DUET. The DUET build installs missing standard C++ development packages when needed, but the vendor Unitree SDK2 C++ and DDS/Iceoryx libraries must already be installed on the host. The policy hash configured for backend DUET status is derived from the exact policy path selected by the controller configuration. `UNITREE_INTERFACE` defaults to the existing `eth0` setting; set it explicitly when the DDS interface differs. An optional custom `DUET_CONTROL_DIR` must be absolute and is shared by the backend and controller unit. The selected Python SDK environment must already exist and pass its import check; the installer does not install the vendor Unitree Python SDK. For Ubuntu 20.04, the LiDAR runtime uses a native-architecture ROS 2 Humble container and host networking, leaving the JetPack host image unchanged; Ubuntu's `docker.io` package is installed if needed. Ubuntu 22.04 uses native ROS 2 Humble. ROS 2 Foxy is not used.

DUET remains a separate physical controller. The installer writes its unit and reloads the systemd user unit definitions but does **not** start or enable it. App Connect may start the unit only after teacher confirmation and only when no SDK program is running. An idle legacy SDK client may remain initialized, but backend SDK motion is blocked while the DUET service is active. The controller remains no-command in Handoff. If the robot is already in Velocity, do not transition it through FixStand; if its actual FSM or posture cannot be verified, do not guess at a transition. A qualified onsite operator must verify the state and decide whether the configured FixStand → Velocity procedure is needed. Do not start it as part of unattended boot or a software test.

Before installing, `backend/sensor_discovery.py` reports the OS/architecture, active interfaces, service state, available ROS topic names/types, and PointCloud2 frame/timestamp freshness. It samples `ros2 topic echo` using best-effort/volatile QoS so it can receive sensor-data publishers, and bounds the read to the message header. Generic obstacle/grid cloud topics are not treated as LiDAR candidates. A single fresh compatible stream is reused rather than starting a second Livox driver. If the saved LiDAR topic still exists but has not delivered a fresh message, setup can rebuild/restart the provider for diagnostics using that saved topic/frame; the provider and distance conditions remain unavailable until fresh data is received. If no saved compatible source is available, the direct-Livox path proceeds only when saved or explicitly supplied host-NIC and MID-360 addresses are present and validate against the active network. The installer never substitutes guessed network addresses. For example, if discovery identifies the need for a direct driver but cannot infer the actual IPs, rerun with the real values for your sensor network:

```bash
G1_LIDAR_HOST_IP=<actual-pc2-sensor-nic-ip> \
G1_LIDAR_DEVICE_IP=<actual-mid360-ip> \
INSTALL_G1_LIDAR=1 \
bash backend/install_g1_service.sh
```

On the direct-driver path, the Livox launch configuration supplies the output topic/frame defaults (`/mid360/livox/lidar`, `mid360_link`); `G1_LIDAR_TOPIC` and `G1_DISTANCE_FRAME_ID` can override them. Existing ROS streams use their discovered topic and frame. The driver publish frequency defaults to 20 Hz and can be set with `G1_LIDAR_PUBLISH_FREQ`; confirm actual rate and packet health on the robot. The installer derives a conservative footprint and nominal sensor mount from the supported G1 model without asking for tape measurements. The provider prefers live TF when it agrees with the model; if that sensor-to-parent edge is absent, it uses the URDF mount locally and reports `model_derived` provisional status. A live transform that conflicts with the model remains unavailable rather than being silently accepted.

Supplemental PointCloud2 sources are opt-in and must be selected explicitly with `G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON` when running the installer. Supply a compact JSON array; each entry requires a unique `id`, fully qualified `topic`, expected `frame_id`, and `coverage` containing `forward`, `rear`, or both. For example, after discovery confirms the actual topic/frame and TF on the target G1:

```bash
G1_DISTANCE_EXTRA_POINTCLOUD_SOURCES_JSON='[{"id":"front-depth","topic":"/camera/depth/points","frame_id":"camera_depth_frame","coverage":["forward"]}]' \
INSTALL_G1_LIDAR=1 bash backend/install_g1_service.sh
```

Do not use the example names without verifying the actual ROS graph. The provider rejects duplicate topics/IDs and unknown frames, and supplemental clouds require a fresh timestamp-valid TF transform directly into the checked-in G1 model root (`pelvis`). Only the primary source whose frame exactly matches the URDF `mid360_link` can use its nominal URDF mount as a fallback. Fresh transformed sources within 100 ms are combined as footprint-clearance minima for each declared sector; stale, untransformable, out-of-coverage, or time-skewed sources are reported as excluded while remaining usable coverage stays available. If no valid source covers a requested sector, the distance provider returns unavailable and the motion condition remains fail-closed. This does not start another sensor driver, fuse camera data, or validate physical sensor placement.

If the optional LiDAR installation or hardware configuration fails, the script prints a warning and continues installing the G1 SDK backend and web app. Supported non-conditional SDK programs remain available after backend setup succeeds; distance conditions remain fail-closed until the LiDAR provider returns a fresh, valid sample. A failed LiDAR setup does not count as a connected or working sensor.

Run discovery directly when diagnosing a setup:

```bash
python3 backend/sensor_discovery.py
```

The report is read-only. A nonzero exit status means no usable fresh stream or validated direct-driver configuration was found. It lists actionable diagnostics, including stale or unsupported topics, missing ROS tools, and missing/invalid network prerequisites. If a point-cloud timestamp is ahead of host time, compare `date -u` and the ROS header stamp and verify the G1/ROS/LiDAR clock sources. The provider only normalizes a future timestamp after five stable observations; it rejects unstable or out-of-range offsets and continues enforcing the corrected sample-age limit. Do not disable timestamp validation. For a manual sensor-data QoS check, use `ros2 topic echo --once <pointcloud-topic> --qos-reliability best_effort --qos-durability volatile`. Docker reuses a cached Humble base image when available; if it is not cached, the initial build needs access to Docker Hub.

The setup provides a read-only ROS point-cloud subscriber and an authenticated HTTP provider bound to `127.0.0.1:8181`; it does not install a ROS locomotion bridge. Its separate G1 state bridge subscribes to the read-only `/lowstate` stream and publishes `sensor_msgs/JointState` on `/joint_states` using the official 23-DoF G1 motor ordering; ROS `robot_state_publisher` then publishes the supported URDF tree rooted at `pelvis`. The provider also exposes only a fresh, validated `/joint_state` snapshot to the authenticated backend, which proxies it through the teacher-only `/api/robot/joint-state` route for supervised legacy-SDK motion capture. No browser receives the provider token, and the bridge never publishes robot commands. Distance calculations use the model root, not the unsupported `base_link` name. The backend service uses the model files from the checkout, while the Ubuntu 20.04 provider container uses copies under `/opt/uni-edu`; these paths are configured separately. If an older host service still points at container-only model files, calibration uses the bundled checkout models and reports that recovery in its status.

The provider learns a future LiDAR timestamp offset only after five observations agree within 100 ms, corrects that offset for TF lookup, and continues to reject stale samples using the corrected acquisition timestamp and a 500 ms maximum age. An offset over 30 seconds, an unstable offset, missing required parent-to-base TF, mismatched frames, or malformed clouds keep readings unavailable. The supported URDF places MID-360 under `torso_link`; when TF does not contain the cloud-frame-to-`torso_link` edge, the provider uses that nominal fixed mount locally without publishing a duplicate TF alias. `G1_LIDAR_MOUNT_CONFIRMED` is retained as provenance metadata, not a prerequisite for model-derived distance reporting. Check bridge status with `ros2 topic info -v /lowstate`, `ros2 topic echo /joint_states`, and `ros2 run tf2_ros tf2_echo pelvis torso_link`. The provider returns the calibration source and sensor/base frames. A `model_derived` result means the footprint/mount came from the bundled G1 model; it does not independently prove physical mounting or real-world distance accuracy. Compare it with known references on the target robot before relying on it as safety-rated sensing.

For a detected existing point-cloud stream, the installer does not enable or restart a second Livox driver, and the Ubuntu 20.04 container build skips compiling Livox SDK/driver packages. Those packages are built only when discovery requires the installer to start the direct MID-360 driver. The initial Humble runtime image still needs to be built; Docker reports build steps and caches completed layers for subsequent installs. For a direct-Livox setup on Ubuntu 22.04, `uni-edu-lidar-driver` is a user service; on Ubuntu 20.04, it is a system container service. The installer enables the provider service, but the backend distance consumer additionally requires `calibration_status.ready` and a fresh provider sample. Ubuntu 20.04 uses host networking and UDPv4 Fast DDS transport, without granting the classroom user Docker-group/root-equivalent access. A teacher's **Connect** action initializes the G1 SDK and checks provider readiness; **Test LiDAR** can independently read authenticated backend sensor status without connecting the SDK or issuing robot motion. The generated provider token is stored in `~/.config/uni-edu-studio/lidar.env` with owner-only permissions. Check container-runtime logs with `sudo journalctl -u uni-edu-lidar-driver -u uni-edu-lidar-provider -e` and app logs with `journalctl --user -u uni-edu-studio -e`.

The teacher-only Sensors diagnostics panel reports the discovered LiDAR connection, automatic calibration status, ROS camera topics, camera frame freshness, and valid `CameraInfo` intrinsics. Sensor controls remain in this teacher-only panel. `model_derived` status means fresh readings use the supported model's nominal mount and footprint; it is deliberately distinct from independent physical-mount verification. The panel's repair action only restarts the allowlisted managed LiDAR driver service; arbitrary shell commands and user-editable service routes are not exposed.

The external projects were considered as design references, not installed dependencies: `KaiFeng-Frank/lidar-camera-imu-calibration` focuses on rigid-rig/offline sensor calibration with reference data; `RaaSaaR-org/g1-sensor-toolkit` helps discover and read G1 sensor streams but does not validate mounting geometry; `botbotrobotics/BotBrain` provides G1 mount/footprint geometry used as a conservative cross-check, not live hardware evidence. No code from these projects is required at runtime.

Camera discovery identifies fresh ROS Image topics, frame IDs, image freshness, matching `CameraInfo` intrinsics, and supported Intel RealSense USB devices. Setup records up to eight fresh image topic/frame pairs in the provider allowlist; it does not install or start a camera driver. In **Vision to Motion**, a teacher must explicitly select one discovered G1 ROS image topic before the browser requests frames. The backend requires teacher authentication and the provider token, and only the configured topics are streamable. Frames stay in memory, use no-store responses, are limited to 1280×720 and 4 MiB, and must have a matching frame ID and capture timestamp within 500 ms. The provider samples each image topic at no more than 2 frames/second, and the browser polls at approximately 1.3 frames/second; polling stops when the camera view/source changes. Supported raw RGB/BGR/RGBA/BGRA/mono image encodings are rendered locally; depth topics are not streamed. Camera/IMU/joint visibility is diagnostic-only and does not enable autonomy, inference, LiDAR fusion, or motion. If a desired camera topic appears after installation, rerun setup to refresh the provider's allowlist before selecting it. The browser-device preview remains local to the tab, requires explicit permission, and is never sent to the backend. Safari requires a trusted HTTPS origin for device-camera permission (localhost is a browser exception); `http://<g1-wlan-address>` is insufficient on iPad.

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

For hardware acceptance, deploy the reviewed branch/commit to a supported G1 using the install procedure above. Keep the robot stationary and maintain access to the physical emergency stop. Treat model-derived distances as provisional until compared with known references on that exact robot; do not treat model/TF agreement alone as proof of physical accuracy.

1. In the teacher Sensors panel, run **Discover sensors**. Confirm the reported connection method, ROS topic, message type, frame, camera serial (if present), and freshness match the actual devices. Do not treat a network address or a URDF candidate as proof of sensor identity or mounting.
2. Compare the reported point-cloud topic/frame with `ros2 topic list -t`, check its live rate with `ros2 topic hz <pointcloud-topic>`, and inspect the configured base-to-sensor transform with `ros2 run tf2_ros tf2_echo <base-frame> <sensor-frame>`. Have the robot's actual mounting and coordinate convention independently verified; this application does not perform or persist a physical calibration.
3. Confirm the provider reports fresh, correctly framed footprint-clearance samples and identifies whether its source is model-derived or a live-transform match. A conflicting transform or missing required parent-to-base transform must remain unavailable. Compare front/rear clearances with known distances before treating model-derived readings as physically verified; the legacy confirmation flags are not independent calibration evidence.
4. If a managed LiDAR service restart is needed, use the teacher-only **Restart managed LiDAR driver** action. Re-run discovery, confirm exactly one driver path is active, check the service logs, and verify that fresh point-cloud samples resume. Do not restart a driver when discovery reports that an existing Unitree point-cloud stream is being reused.
5. For each installed camera, verify its identity and serial against the physical unit and check the ROS image/frame and matching CameraInfo topics for freshness. A teacher can explicitly select one discovered fresh RGB `sensor_msgs/msg/Image` topic for the authenticated, bounded browser preview; confirm the displayed frame and age continue to update and become unavailable on stream loss. The integration does not install a RealSense or Unitree camera driver, stream depth, or use camera data for motion/autonomy; discovery alone is not a live preview test.
6. On an iPad, open the reviewed app from a trusted HTTPS origin, explicitly grant Safari camera permission, verify the personal-device preview, then switch sources or leave **Vision to Motion** and confirm the local camera stops. The preview is local to the browser and is not uploaded or saved.
7. Test localization, mapping, navigation, and physical motion only under their separate robot commissioning procedures. Sensor discovery is not navigation readiness, and this application does not enable autonomous movement based on camera preview.

If the G1 PC2 is not Ubuntu 20.04 or 22.04, or discovery reports an unsupported/ambiguous interface or missing network configuration, do not force the direct-driver path. Discovery recognizes ROS-visible point-cloud topics; it does not prove a native Unitree DDS interface is compatible unless it is exposed as a fresh `sensor_msgs/msg/PointCloud2` topic. The Ubuntu 20.04 container uses host networking and exposes the authenticated provider only on loopback; it does not use `--privileged` or install ROS on the host. A separate compatible ROS 2 computer can host the driver/provider, but that requires manual setup; expose its authenticated provider only through a  trusted network and put a TLS reverse proxy in front of it before configuring the backend to use HTTPS. LiDAR setup is opt-in with `INSTALL_G1_LIDAR=1`; the existing backend-only installer remains available without that setting.

LiDAR room scanning and path navigation require a separate ROS 2/SLAM/Nav2 deployment and are not installed by this command. The onboard installer configures MID-360 streaming and fresh distance samples with ROS 2 Humble; it does not install SLAM, Nav2, an occupancy-map publisher, or the planner gateway. The documented navigation gateway currently targets ROS 2 Humble and needs a compatible ROS 2/Nav2 host, live SLAM occupancy map, fresh MID-360 point cloud (default `/mid360/livox/lidar`), valid sensor/map transform, and fresh localization. A teacher-confirmed scan uses Nav2's `/spin` action to rotate in place through 360° via the same Nav2/G1 velocity bridge; it does not create a second velocity publisher. The teacher must supervise from a clear area with the robot stable and the independent emergency stop immediately available. Configure and commission Nav2 Spin speed/acceleration and collision checking on the actual hardware before enabling its action server for this workflow. Scan capture fails closed on stale LiDAR/map/localization or an incomplete turn. The teacher validates and explicitly publishes the map for student grids; the shared overlay toggle is stored centrally by the app backend. The app's SDK motion path remains locked while a scan or navigation operation owns locomotion, but this does not arbitrate against independent ROS publishers, terminals, or external controllers. The navigation bridge remains a separately deployed and commissioned service. See [the navigation gateway contract](./lidar_navigation_bridge.md) for prerequisites, map calibration, and hardware-validation boundaries.

The installer builds the frontend, installs backend requirements into the SDK environment, enables user `systemd` services at boot, and verifies that the frontend responds on port 5179 before reporting success. If this check fails, inspect the service status and recent logs printed by the installer. It asks for sudo permission for ROS/SDK installation and service persistence. To use a different DDS interface/domain, edit the generated `~/.config/systemd/user/uni-edu-studio.service`, then run `systemctl --user daemon-reload && systemctl --user restart uni-edu-studio`.

Find the G1 computer's Wi-Fi address with `ip -br addr` (the `wlan0` row), then open `http://<wlan0-address>:5179` on the iPad/desktop while it is on the same trusted Wi-Fi. The G1 Ethernet interface remains `eth0` for DDS by default. In the app, log in with the teacher account, press **Connect**, confirm **Connected**, then run a supported program. The Connect button uses `UNITREE_INTERFACE=eth0` by default and no longer asks classroom users for an interface name.

Each connection creates a private JSON Lines session file under `/home/unitree/harry_botter` by default. It records connection attempts/results and validated command/program start, completion, stop, or failure events. Set `G1_DATA_DIR` in the service unit to change the destination. The backend must run as a user with write access to this directory; the SSH password is not used or stored by the app.

Check service startup/errors with `systemctl --user status uni-edu-studio` and `journalctl --user -u uni-edu-studio -e`. Keep the service and port on a trusted local network; do not expose port 5179 to the public internet or configure router port forwarding. Physical motion is not verified by service startup or a Connected status. Keep a clear supervised area and the robot's independent emergency stop available.

### Ubuntu 20.04 ROS container and directional sensing checks

On Ubuntu 20.04, ROS 2 Humble runs inside the `uni-edu-lidar-humble:local` Docker image; it is not installed into the host OS. The installer enables the system-level `uni-edu-lidar-driver` container service when it must start the MID-360 driver, and the `uni-edu-lidar-provider` container service for read-only distance processing. Check them on the robot computer with:

```bash
sudo systemctl status docker uni-edu-lidar-driver uni-edu-lidar-provider
sudo journalctl -u uni-edu-lidar-driver -u uni-edu-lidar-provider -b --no-pager
```

The installer may reuse a compatible existing point-cloud stream and then will not start a duplicate Livox driver. In that case, the provider can still run in Docker and subscribe through host networking. A successful image build or active service does not prove that the MID-360 is powered, reachable, publishing fresh data, or physically mounted as modeled.

After teacher login, inspect **Settings → Sensors** or request the authenticated `GET /api/sensors/status`. A usable reading must report `lidar.distance.ready: true` for forward and `lidar.distance.rear.ready: true` for rear, with fresh samples. IDE conditions `robot.front_distance_m()` and `robot.rear_distance_m()` read the corresponding footprint-clearance sectors from the same 360-degree cloud; distances and comparison thresholds are in meters. Model-derived footprint and nominal MID-360 mount readings are reportable without `G1_LIDAR_MOUNT_CONFIRMED=1` when the supported model, expected frames, provider evidence, and fresh point-cloud checks pass. These readings must remain labeled model-derived/provisional until compared with known references on the exact robot. A model/TF match is not physical calibration or safety acceptance. If either direction is unavailable, use the status error and service logs to diagnose it; do not bypass the transform, source-health, or freshness gates.

The backend accepts only the shared, bounded `robot.*` command language and bounded `for ... in range(...)` loops. Physical execution currently maps stand, forward/backward walking, timed/slow/fast walking, turns, and sidesteps to the SDK locomotion client. Step-count walking commands accept whole numbers from 1 to 20 steps. Sidesteps accept `robot.sidestep("left", 2)` or `robot.sidestep("right", 2)`; omitting the count retains the one-step behavior for older programs. `robot.wait()` accepts whole seconds from 1 to 10; timed locomotion and arm holds retain fractional durations. Supported arm presets use the G1 arm-action SDK; they are sent exactly as written and do not implicitly append a `release arm` action. `robot.hold_arm("hands up", 3)` runs one of the supported static presets and waits at least the requested 0.1–10 seconds before continuing; it does not actively maintain joint targets or verify that the pose has completed. The SDK reports acceptance rather than completion, so wait for a preset or posture transition to finish before walking. Before every locomotion command the backend checks `GetFsmId()` and only sends velocity in ready FSM 500; otherwise it rejects the command and directs the program to use `robot.stand()` and wait. Kicks and knee actions remain unavailable for physical runs unless a verified SDK mapping is configured.

The teacher queue's **Clear queue** action removes waiting and finished entries, while leaving any currently running job visible. **Run next** sends the oldest queued program to the same physical G1 SDK executor; if the robot is not ready, that job remains queued so the teacher can reconnect and retry.

After connecting, teachers can use **Test motion** for one confirmed 0.5-second slow forward command (about 10 cm at the configured SDK speed). It does not run automatically on connection and does not verify physical movement. Use it only when the robot is upright and stable, the area is clear, and someone is ready at the emergency stop.

The teacher-selected path planner mode is stored centrally and has three workflows:

- **Normal path** compiles simulator waypoints to the existing validated SDK command language. It remains open-loop.
- **Sensor-corrected path** first compiles and displays the initial SDK commands. Its separate **Run SDK path • checkpoint and correct** action requires fresh localization, LiDAR, robot-link, and E-stop health at each waypoint. It uses the SDK to move, checks each waypoint to a 0.25 m tolerance, and permits one measured correction. It is deployment-disabled unless both `G1_SDK_CHECKPOINTED_PLANNER_ENABLED=1` and `G1_SDK_CHECKPOINTED_PLANNER_OWNER_CONFIRMED=1` are set after supervised commissioning. The returned corrected code contains the SDK commands actually sent; failed or unverified checkpoints stop the route and do not produce a successful corrected path.
- **Autonomous obstacle-aware path** requires Live adaptive Nav2 and its commissioned local obstacle-avoidance costmap. Only after Nav2 reports successful completion with a valid localization feedback trace does the app convert that trace into editable SDK commands. This conversion is a replay approximation, not an exact reproduction of Nav2's controller output or a guarantee of safe replay.

Teacher Safe Mode remains opt-in and applies during legacy and DUET physical program execution. It combines direction-matched front/rear footprint clearance with timestamped LiDAR returns transformed into the map frame. The gateway retains a bounded two-second voxel history and exposes nearby observations within 3 m; the motion guard checks the robot's sampled swept footprint and stops when a fresh obstacle or a stale observation intersects the active path. Missing or stale registered coverage fails closed for Safe Mode. Stale observations outside the current swept area do not block that action. Sideways and turning motion can be checked when registered coverage is ready.

Arm commands use a conservative spherical envelope derived from the bundled G1 collision model, inflated by 0.20 m. This is a geometric estimate, not a validated physical envelope. A missing/stale registered cloud or missing robot height skips the arm command; a relevant obstacle also skips it. Confirm the point-cloud stream filters robot self-returns; otherwise arm checks may conservatively suppress commands. DUET can stop its renewable active lease, but legacy arm SDK actions are only checked before dispatch because mid-action cancellation is unverified.

Autonomous mode 3 and Return to Origin continue to require Nav2's commissioned, fresh live local costmap. When that costmap is available, the gateway additionally requests route cancellation if a fresh obstacle overlaps the robot footprint with a 0.20 m inflation. If this optional check's costmap data is unavailable during an active route, Nav2 remains the fallback; missing added data alone does not disable these routes. This is an extra software check, not an independent safety-rated stop.

The 0.20 m arm inflation does not prove that the bundled model matches the installed robot, that sensor occlusions are resolved, or that end-to-end latency and braking distance are adequate. Do not rely on Safe Mode or navigation checks as collision-prevention guarantees around students until the actual robot, sensors, local costmap, stop behavior, and arm motion have been validated under supervised conditions. Keep the physical emergency stop accessible.

The initial and corrected/final variants synchronize to Blocks and IDE. Saving a labeled path project is an explicit user action; the route is saved to that user's project library rather than automatically applied to every account. Reopening the project restores its waypoints, mode, variants, and editable code. The simulator remains an approximate command-space preview. Physical accuracy and ownership require supervised acceptance on the exact robot.

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

The hosted frontend includes the Unitree G1 mesh rig under `public/g1`. Run `npm run build` after changing or replacing these assets so the backend serves the updated model. The browser loads the STL meshes and `g1.xml` asynchronously; the procedural model remains visible briefly while the full mesh rig loads. Joint rotations in the mesh rig are converted from the MuJoCo axes into the viewer's coordinate basis using each joint's declared or inherited axis; the procedural fallback uses its own approximate axes.
