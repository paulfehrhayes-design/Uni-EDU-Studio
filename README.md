# Uni++ EDU Studio

![1770285742977](image/README/1770285742977.png)

Uni++ EDU Studio It is an open graphical programming platform for Unitree robots base on Blockly.

Uni++ EDU Studio supports running on any Linux platform, but for convenience, it is recommended to deploy on:

* Unitree G1's PC2
* Unitree Go2's docking station

Uni++ EDU Studio supports controlling different robots by importing configurations. Built-in reference configurations in this repo:

* Unitree G1 (`block_configurations/g1_basic`)
  * High-level locomotion (safe actions only)
  * Arm actions (including recorded actions)
  * Audio & lights
* Unitree Go2 (`block_configurations/go2_basic`)
  * Sport / obstacles avoid / service switch / VUI / UTLidar switch
* Unitree AS2 (`block_configurations/as2_basic`)
  * Sport control (SportClient)
* Unitree R1 (`block_configurations/r1_basic`)
  * High-level locomotion (LocoClient)
* Unitree H2 (`block_configurations/h2_basic`)
  * High-level locomotion (LocoClient)

Configurations will be continuously updated, and custom configurations are also supported.

The Uni++ EDU Studio editor supports:

* One-click local execution
* Custom functions (Graphical or Python)
* Custom code snippets (Python)

---

## Quick Start

Note: The operations here require a certain foundation in Unitree robot development.

### 0000 Connect to the Robot

Taking Unitree G1 as an example, refer to this tutorial to connect the robot:

[Unitree Robotics Documentation Center](https://support.unitree.com/home/en/G1_developer/quick_development#heading-7)

### 0001 Copy the Program to the Robot's Internal Computer

It is recommended to use the SCP tool to transfer the program to the robot's internal computer after packaging it into a ZIP file.

Taking Unitree G1 as an example. (Replace `/path/to/your/zip` with the path of your packaged compressed file)

```bash
scp /path/to/your/zip.zip unitree@192.168.123.164:/home/unitree/
ssh unitree@192.168.123.164
password:123
mkdir unipp-edu-studio
mv /your/zip.zip unipp-edu-studio
cd unipp-edu-studio
unzip

```

Alternatively, you can use MobaXterm for graphical operations.

### 0002 Set Internal Computer to Connect to Wireless Network (To Configure Environment)

Replace `<ssid>` with your environment's Wi-Fi name and `<password>` with the password.

```bash
sudo nmcli device wifi connect <ssid> password <password>

```

Next, you need to remember the robot's IP address. Check it via `ifconfig`. Then open a new SSH session and **connect to the robot using the address you just noted**. Temporarily disable the local network card.

```bash
ssh unitree@<ip>
password:123
sudo ifconfig eth0 down

```

### 0003 Install Dependencies

Clone the dependencies in the `backend` directory (unitree sdk2 python).

```bash
cd backend
git clone https://github.com/unitree/unitree_sdk2_python.git

```

Return to the home directory, clone and install cyclone dds.

```bash
cd ~
git clone https://github.com/eclipse-cyclonedds/cyclonedds -b releases/0.10.x 
cd cyclonedds && mkdir build install && cd build
cmake .. -DCMAKE_INSTALL_PREFIX=../install
cmake --build . --target install

```

Return to the `backend` directory, create a virtual environment using miniconda (pre-installed in PC2), and configure the Unitree SDK2 Python dependencies.

```bash
cd ~/unipp-edu-studio
conda create -n UnippEduStudio python=3.10
conda activate UnippEduStudio
export CYCLONEDDS_HOME="/home/unitree/cyclonedds/install"
pip install -e .

```

Then install other required dependencies.

```bash
pip install fastapi uvicorn pydantic

```

### 0004 Startup

Return to the `backend` directory and start the program.

```bash
cd ~/unipp-edu-studio/backend
python -m server

```

Note that for future use, you need to activate the `UnippEduStudio` environment using conda first.

```bash
conda activate UnippEduStudio

```

Subsequently, you can access the robot's `IP address:5179` under the same Wi-Fi to enter Uni++ EDU Studio.

## Classroom Mode

This project now supports a simple classroom workflow for one robot and many students.

- Open the app at `http://<g1-ip>:5179`
- Teacher login: `teacher / teacher`
- Student login: `student1 / student1` or another username with the same password
- Each student can save their own code and submit it to the teacher queue
- The teacher dashboard shows queued submissions, previews them, can delete entries, pause the current run, resume the next job, and clear the queue

## DUET Version Two Preview

Teachers can enable **DUET version two preview** from Settings. This keeps the existing Blocks, IDE, prompt, and simulator surfaces, but gives the mode its own code buffer, DUET-only command catalog, parser, and API routes. Turning the setting off returns to the separate legacy code buffer. DUET programs cannot contain `robot.*` commands, and the DUET parser rejects unsupported statements and out-of-range values.

The DUET Blocks toolbox, IDE command list, prompt compiler, and simulator include bounded planar velocity commands, wait, bounded repeat loops, and stop. Directional presets use conservative velocity/yaw-rate inputs; turns are time-based, so a final angle is not guaranteed. The arm catalog includes approximate V2 command-space equivalents for every legacy arm-action preset and low/mid/high wave/raise command, with left/right mirrors where applicable; degree-based legacy variants map to discrete levels rather than exact angles, and no sequence reproduces the vendor SDK's internal animations. It also includes named poses such as raised, overhead, sideways, forward, chest-height, carrying, and open-arm positions. Each target is limited to the approved 10-joint command-space workspace; the G1 model has no finger joints, so hand shapes are approximations. Timed holds accept 1–30 seconds and return to carry; hold-until-reset poses require `duet.reset_arms()` or reset on program completion. Users can save up to 50 named arm-only sequences assembled from approved V2 poses and gestures. These sequences are stored in browser local storage per user, can be inserted into the current V2 program, and do not send commands directly to the robot. The simulator is an approximate command-space preview; it does not reproduce DUET's learned balance policy or verify that the robot reached a target. Vendored DUET policy files contain a base-height observation/configuration, but no verified app/gateway command route or confirmed deployed-policy contract for V2 height control exists, so no posture/height command is exposed. Step-count walking, angle-targeted turns, kicks, isolated knee raises, dance/mimic, unrestricted joint targets, path-planner export, and camera-to-motion inference are not available in this version.

DUET Blocks and IDE programs also support `if duet.front_distance_m() < 1:` and `if duet.rear_distance_m() < 1:` distance conditions, including `<`, `<=`, `>`, `>=`, `==`, and `!=` comparisons with literal thresholds from 0.1 to 40 m and optional `else` branches. These reuse the calibrated legacy MID-360 distance provider and its configured sensor/frame identity checks; hardware conditions require a fresh sample (at most 500 ms old) and valid calibration. A missing, stale, invalid, or ambiguous no-return sample aborts the DUET program and requests controller stop instead of guessing. The simulator evaluates the same conditions against its obstacle scene, which is an approximation and not a sensor or safety certification. Sensor discovery, camera, and LiDAR service UI flows remain separate and unchanged.

**DUET physical execution is disabled by default.** This checkout now contains the controller-side `uni-edu-duet-v1` Unix-socket gateway under `vendor/DUET/deploy`; the backend and controller must run as the same local user with the same absolute `DUET_CONTROL_DIR` (default: `~/.cache/uni-edu-duet`). The gateway feeds bounded velocity commands into DUET's existing policy observation and arm targets into the existing arm-command path. DUET remains the sole `rt/lowcmd` writer. The controller binary must still be rebuilt and installed on the G1 host; re-run CMake configuration before building so the new gateway source is included. Source in this repository is not proof that the deployed binary contains it.

### Teacher-only DUET commissioning

Before any physical movement, build and deploy the modified controller on the robot host, start DUET, and manually enter its Velocity state. On the controller set `DUET_GATEWAY_ENABLED=true`; on the backend set `DUET_PHYSICAL_ENABLED=true`, `DUET_COMMISSIONING_ENABLED=true`, `DUET_CONTROL_DIR` to the same private local directory, `DUET_EXPECTED_POLICY_ID=sha256:<policy-file-hash>`, and `DUET_ROBOT_ID` to the target robot serial or classroom asset label. Compute the policy hash from the exact deployed `policy.onnx` file with `sha256sum`. Arm targets require the gateway to advertise both `arm_targets` and measured `arm_feedback`; a legacy controller with only the old `arm_pose` presets will fail preflight. Every V2 pose, arm macro, gesture, and `move_and_arm` command uses bounded `arm_targets`; `DUET_ARM_ACCEPT=1` is not required for this V2 path.

In the teacher-only DUET V2 tab, connect the controller and press **Start full test sequence**. The preflight checks policy/model identity, controller ownership, idle state, no competing external arm-target stream, and required capabilities. The sequence then runs one bounded base/arm test at a time, covering every catalog pose, authored arm command, legacy gesture and mirror, base direction, both concurrent-control entry points, velocity-lease expiry, and explicit STOP/reset. After each test it pauses for the teacher to physically observe the result and explicitly pass or fail it. Joint feedback and controller results are shown in the panel and logged as JSON lines to the backend terminal and the report path shown there (under `DUET_CONTROL_DIR/commissioning.jsonl` by default). A failure prevents acceptance; **Abort and request STOP** is available during a running test.

Only after every step is passed and physically reviewed is a local acceptance report written. It is bound to the policy hash, controller-binary hash, robot model and configured robot label, arm-catalog hash, and backend implementation hash; changing those identities invalidates it. Normal teacher DUET program execution then becomes eligible while `DUET_PHYSICAL_ENABLED=true` remains the master switch. Student requests cannot connect, run, start commissioning, or review it; the legacy controller tab/backend remains unchanged. Do not treat a passed commissioning run as a guarantee for other conditions or future motions.

The sequence reports measured arm joints and command/controller state, but it cannot independently prove balance, distance traveled, safe surroundings, or emergency-stop hardware. A `STOP` acknowledgment is not proof of physical immobility. No physical motion has been executed or accepted from this development environment; the teacher must perform and review commissioning on the intended G1. Stop the DUET controller process before using the legacy SDK. Legacy SDK, ROS navigation, and scan motion remain blocked whenever DUET ownership is active or cannot be verified.

## Quick Guides

- [Student Guide](docs/student_guide.md)
- [Teacher Guide](docs/teacher_guide.md)
- [Environment and Host Setup](docs/environment_and_host_setup.md)

## Usage Instructions

### 1001 Import Configuration

Click the ⚙️ icon in the top left corner of the interface to expand the configuration menu. Click "**⬆️ Import Configuration**" to import a configuration file in `.json` format, such as the `g1_basic_en.json` file located in `/block_configurations`. Note that different robots/languages require different configuration files.

### 1002 Programming and Saving

Once configured, you are free to start programming. After completing your work, you can select "**Download Project File**" from the "File" menu. When reopening a project in the future, please ensure you import the corresponding configuration file first; otherwise, the import will fail.

When programming, remember that to use specific module functions, you must first import the corresponding module and complete its initialization. For specific usage details, please refer to the `Readme` file provided with the configuration package.

The editor also supports **exporting Python files**, though it does not support importing them. Exported Python files can run independently within the `UnippEduStudio` conda environment, but the editor cannot parse or import Python files back into blocks.

### 1003 Running

Before running, please ensure there are no stray, disconnected code blocks on the canvas. Make sure the area around the robot is clear and suitable for the program's execution. **Always be prepared to use "Damping Mode" to emergency stop the robot.**

Click the "**▶️ Run**" button to execute. Click it again to stop the program manually.
