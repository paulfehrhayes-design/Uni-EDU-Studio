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

The DUET Blocks toolbox and IDE command list/quick actions provide bounded custom `move`, forward/backward, strafe left/right, turn left/right, and forward/backward arcs in either direction; `wait`, bounded repeat loops, and `stop` are also available. These are the complete command families currently implemented by the controller gateway. Directional presets compile to conservative planar-velocity/yaw-rate inputs; turns are time-based, so a final angle is not guaranteed. The arm options include three fixed named poses (`carry`, `forward`, and `box_hold`) and four fixed `duet.arm_motion(...)` sequences (reach-and-return, receive-and-hold, hold-and-return, receive-hold-return) that compose only those same targets. They add no user-defined joint targets, and neither a lease nor sequence confirms the robot reached a pose. When a lease expires, control returns to the controller's existing default/gamepad behavior; `stop` clears the pose request and asks the controller to return to carry/default. A live `rt/arm_targets` stream has priority over named presets. DUET does not dispatch audio through the legacy SDK or support sensor-driven distance/`while` control flow; bounded `for` repeats are the only loop form. The deployment has a native build helper in the separate DUET checkout, but building does not constitute hardware acceptance. The 3D view is a command-space visualization using the project G1 23-DOF model; it does not reproduce DUET's learned balance policy or verify real robot motion. Step-count walking, angle-targeted turns, kicks, isolated knee raises, dance/mimic, arbitrary joint targets, direct height control, path-planner export, and camera-to-motion inference are not available in this version.

**Physical DUET motion remains unavailable until a separately validated controller gateway is installed.** The app backend speaks protocol `uni-edu-duet-v1` over a local Unix-domain socket; it does not use the earlier HTTP URL/token contract. The matching controller-side gateway prototype is in a separate DUET checkout based on upstream commit `439c21bd2817feedd519475e8301195b95cb6fcb`, and is not bundled or installed by this application. It must be built and installed with the DUET G1 23-DOF controller on the robot host. The controller and Uni-EDU backend must run as the same local user and use the same absolute `DUET_CONTROL_DIR` (default: `~/.cache/uni-edu-duet`); the socket is private to that user. The gateway supports bounded base velocity, wait, stop, and only the three named arm presets; the arm-motion sequences are expanded by the backend into those same presets. It never writes `rt/lowcmd` itself. The controller omits `arm_pose` from its capabilities and rejects arm requests unless its separate process-level `DUET_ARM_ACCEPT=1` gate is enabled. The backend also preflights that advertised capability before it will execute a program containing arm commands. With the gate disabled, arm blocks remain available for editing and simulation but cannot be physically dispatched.

Physical execution is disabled by default. Keep `DUET_PHYSICAL_ENABLED` unset and `DUET_ARM_ACCEPT` unset until the gateway is installed and supervised acceptance is completed on the exact robot and policy; arm acceptance must be reviewed separately from base-motion acceptance. Enabling backend execution requires `DUET_PHYSICAL_ENABLED=true`, `DUET_EXPECTED_POLICY_ID`, and `DUET_HARDWARE_ACCEPTANCE_ID` in the backend environment. Only after the arm-specific acceptance is documented should the controller process be configured with `DUET_ARM_ACCEPT=1`. `DUET_POLICY_ID` is currently supplied to the controller process by its environment; matching that value is not proof that it identifies the ONNX actually loaded. Do not enable physical operation until the policy identity is independently verified and the acceptance checks are recorded. No live hardware motion has been validated by this repository change.

The operator must start DUET and manually enter its Velocity state before connecting the app. Disconnecting from the app releases its command lease and clears the arm-pose request, not the controller's `rt/lowcmd` ownership; joystick input may resume in Velocity mode. A gateway-reported active lease or `STOP` acknowledgment does not confirm that a physical arm pose was reached or that the robot is immobile. Stop the DUET controller process before using the legacy SDK. Legacy SDK, ROS navigation, and scan motion remain blocked whenever DUET ownership is active or cannot be verified. The legacy controller implementation and connection setup are unchanged.

This keeps the robot safe by allowing only one active run at a time, while still letting students work from their own devices.

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
