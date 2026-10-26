Overview

This is a ROS 2 (Humble) bridging workspace for Unitree G1 EDU.

The workspace is designed for a two-computer setup:

- `G1 PC2`: directly connected to the robot's onboard D435i and MID360; responsible for publishing sensor ROS 2 topics.
- `Jetson Orin AGX`: runs your navigation stack, subscribes to sensor topics, and converts `/cmd_vel` into G1 motion requests.

Workspace contents

- `src/unitree_api` — API message package extracted from the official `unitree_ros2`.
- `src/unitree_hg` — G1/H1 low-level state message package extracted from the official `unitree_ros2`.
- `src/g1_bridge_bringup` — bridging and launch package added in this repository.

Architecture

1. Motion control

`g1_bridge_bringup/g1_cmd_vel_bridge` subscribes to the standard ROS 2 `geometry_msgs/msg/Twist` and publishes G1 `LocoClient` velocity requests to the official ROS 2 topic `/api/sport/request`:

- API `7105`: `SetVelocity(vx, vy, omega, duration)`
- API `7101`: switch FSM, e.g. `Start=500`, `Damp=1`, `ZeroTorque=0`
- API `7104`: high/low stand

This means your navigation stack only needs to publish `/cmd_vel`.

2. Robot state

`g1_bridge_bringup/g1_low_state_bridge` subscribes to the G1 `lowstate` or `lf/lowstate` and converts them into standard ROS 2 topics:

- `/joint_states`
- `/imu/data`

This conversion makes it easier to integrate with RViz, `robot_state_publisher`, logging and diagnostic tools.

3. Sensors

The official public codebase does not provide a ready-made solution to have the G1's onboard D435i/MID360 publish raw ROS 2 topics directly on the Jetson. This workspace follows a safer approach consistent with the official setup:

- `D435i`: run `realsense2_camera` on `G1 PC2`
- `MID360`: run `livox_ros_driver2` on `G1 PC2`
- `Jetson`: subscribe to the topics published by `G1 PC2` over ROS 2 / CycloneDDS

External dependencies

This workspace does not include large third-party driver source code. Please import them as needed:

```bash
cd /path/to/unitree_g1_bridge
vcs import src < g1_sensor_drivers.repos
```

You will also need:

- `realsense-ros` / `librealsense2`
- `livox_ros_driver2` / `Livox-SDK2`
- `rmw_cyclonedds_cpp`

Recommended deployment

G1 PC2

1. Configure the ROS 2 / CycloneDDS network interface so it shares the subnet with the Jetson.
2. Assign the MID360 network interface according to the official default subnet, for example:
   - PC2 lidar NIC: `192.168.1.5`
   - MID360: `192.168.1.12`
3. Start sensors:

```bash
source /opt/ros/humble/setup.bash
source install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI="$(cat src/g1_bridge_bringup/config/cyclonedds_unitree.xml)"
ros2 launch g1_bridge_bringup pc2_sensors.launch.py
```

Jetson Orin AGX

1. Configure the CycloneDDS interface connected to the robot control network.
2. Start the bridge:

```bash
source /opt/ros/humble/setup.bash
source install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CYCLONEDDS_URI="$(cat src/g1_bridge_bringup/config/cyclonedds_unitree.xml)"
ros2 launch g1_bridge_bringup jetson_bridge.launch.py
```

3. Your navigation stack should publish to:

```text
/cmd_vel
```

Key topics

Standard sensor topics from G1 PC2

- MID360 point cloud: `/mid360/livox/lidar`
- MID360 IMU: `/mid360/livox/imu`
- D435i color image: `/head_camera/d435i/color/image_raw`
- D435i depth image: `/head_camera/d435i/depth/image_rect_raw`
- D435i aligned depth: `/head_camera/d435i/aligned_depth_to_color/image_raw`
- D435i point cloud: `/head_camera/d435i/depth/color/points`
- D435i IMU: `/head_camera/d435i/imu`
- D435i gyro: `/head_camera/d435i/gyro/sample`
- D435i accelerometer: `/head_camera/d435i/accel/sample`
- D435i RGBD: `/head_camera/d435i/rgbd`

Robot bridge topics

- Input velocity: `/cmd_vel`
- G1 raw low-level state: `/lowstate` or `/lf/lowstate`
- Standard joint states: `/joint_states`
- Standard IMU: `/imu/data`

Robot control services

`g1_cmd_vel_bridge` also exposes several convenient services:

- `/g1_cmd_vel_bridge/start`
- `/g1_cmd_vel_bridge/damp`
- `/g1_cmd_vel_bridge/zero_torque`
- `/g1_cmd_vel_bridge/stand_up`
- `/g1_cmd_vel_bridge/high_stand`
- `/g1_cmd_vel_bridge/low_stand`
- `/g1_cmd_vel_bridge/stop`

Build

```bash
source /opt/ros/humble/setup.bash
cd /path/to/unitree_g1_bridge
colcon build --symlink-install
```

If you copy this workspace from one host to another (for example from PC to Jetson), always run `colcon build` on the target host — do not reuse `build/` or `install/` artifacts from another machine.

Notes

- The `cmd_vel` bridge uses a conservative strategy of periodic re-sends combined with a timeout-based auto-stop to avoid leaving the robot moving if the node exits unexpectedly.
- MID360 `host_ip` and `lidar_ip` must match the actual NIC wiring; default values follow Livox official examples.
- This repository does not enforce sensor extrinsics or TF; head/body mounting can vary between batches or modifications, so perform on-site calibration.

Environment configuration

References:
https://support.unitree.com/home/zh/G1_developer/about_G1
https://github.com/unitreerobotics/unitree_sdk2
https://github.com/unitreerobotics/unitree_ros2

1. Install `unitree_sdk2`
Follow: https://github.com/unitreerobotics/unitree_sdk2
To verify installation:

```bash
source /opt/ros/humble/setup.bash

export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export CYCLONEDDS_URI='<CycloneDDS><Domain><General><Interfaces>
  <NetworkInterface name="eno1" priority="default" multicast="default" />
</Interfaces></General></Domain></CycloneDDS>'

ros2 daemon stop
ros2 daemon start

ros2 topic list
# if installation succeeded you should see topics published by the G1
```

2. Configure `unitree_g1_bridge`

Install base dependencies for this bridge:

```bash
sudo apt update
sudo apt install -y \
  ripgrep \
  python3-colcon-common-extensions \
  ros-humble-rmw-cyclonedds-cpp \
  ros-humble-geometry-msgs \
  ros-humble-sensor-msgs \
  ros-humble-std-srvs \
  ros-humble-rosidl-default-generators
```

# Note: `unitree_g1_bridge` already contains `unitree_api` and `unitree_hg`, so you don't need to compile the entire `unitree_ros2` separately.

# Configure workspace path:
```bash
export G1_BRIDGE_WS=~/xxxx/xxx/unitree_g1_bridge
cd $G1_BRIDGE_WS
```

# Configure DDS environment
# For each new terminal, run:
```bash
source /opt/ros/humble/setup.bash

export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export CYCLONEDDS_URI="$(cat $G1_BRIDGE_WS/src/g1_bridge_bringup/config/cyclonedds_unitree.xml)"

# then restart the ROS 2 daemon:
ros2 daemon stop
ros2 daemon start
```

Check basic communication:

```bash
ros2 topic list | rg '/api/sport/request|/lowstate|/utlidar/cloud_livox_mid360'
ros2 topic type /api/sport/request
ros2 topic type /lowstate
ros2 topic type /utlidar/cloud_livox_mid360
```

Build `unitree_g1_bridge`:

```bash
cd $G1_BRIDGE_WS
source /opt/ros/humble/setup.bash
colcon build --symlink-install
source $G1_BRIDGE_WS/install/setup.bash
```

# To make life easier, you can add the following to `~/.bashrc`:
```bash
source /opt/ros/humble/setup.bash
source ~/xx/xxx/unitree_g1_bridge/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export CYCLONEDDS_URI="$(cat ~/xx/xxx/unitree_g1_bridge/src/g1_bridge_bringup/config/cyclonedds_unitree.xml)"
```

Start the bridge (conservative config recommended):

```bash
source /opt/ros/humble/setup.bash
source $G1_BRIDGE_WS/install/setup.bash

ros2 launch g1_bridge_bringup jetson_bridge.launch.py \
  lowstate_topic:=lowstate \
  joint_layout:=g1_29dof \
  auto_start:=false
```

# This launches two nodes:
# g1_cmd_vel_bridge.cpp
# g1_low_state_bridge.cpp

# After launching, open another terminal with the same environment and check bridge output:
```bash
source /opt/ros/humble/setup.bash
source $G1_BRIDGE_WS/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export CYCLONEDDS_URI="$(cat $G1_BRIDGE_WS/src/g1_bridge_bringup/config/cyclonedds_unitree.xml)"

ros2 topic echo /joint_states --once
ros2 topic echo /imu/data --once
```

Motion control test

```bash
ros2 service list | rg 'start|damp|stop|zero|stand'
# Typically you'll see services like /start, /damp, /stop, /zero_torque, /stand_up

# First put the robot into a movable state:
ros2 service call /start std_srvs/srv/Trigger "{}"

# Then publish a small velocity:
ros2 topic pub /cmd_vel geometry_msgs/msg/Twist \
"{linear: {x: 0.10, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.0}}" -r 10

# Stop methods:
# 1. Ctrl+C the publisher
# 2. Wait for the bridge node to timeout and auto-stop (default 0.5s)
# 3. Actively call the stop service:
ros2 service call /stop std_srvs/srv/Trigger "{}"

# To auto-start the bridge on launch you can set:
ros2 launch g1_bridge_bringup jetson_bridge.launch.py \
  lowstate_topic:=lowstate \
  joint_layout:=g1_29dof \
  auto_start:=true
```

3. Forward D435i depth camera over DDS to an external compute unit
(If you don't need the onboard D435i data or you directly connect the D435i hardware to the external compute unit, skip this section and follow steps 1 and 2 above.)

Stop services that occupy D435i:

```bash
ps -ef | grep -E 'teleimager|image_server|videohub|realsense'
sudo apt update
sudo apt install -y lsof
sudo lsof /dev/video* /dev/media* 2>/dev/null
sudo systemctl list-units --type=service | grep -E 'video|camera|tele|image|realsense'

sudo kill -TERM $(pgrep -f /unitree/module/video_hub_pc4/videohub_pc4)
sleep 2
ps -ef | grep videohub_pc4
sudo lsof /dev/video* /dev/media* 2>/dev/null
```

Install librealsense following the official instructions:

```bash
sudo apt --fix-broken install
sudo apt update
sudo apt install -y git cmake build-essential pkg-config \
  libssl-dev libusb-1.0-0-dev libudev-dev libgtk-3-dev \
  libglfw3-dev libgl1-mesa-dev libglu1-mesa-dev \
  curl gnupg2 software-properties-common usbutils v4l-utils

df -h

cd ~
git clone https://github.com/realsenseai/librealsense.git

cd ~/librealsense
git fetch --tags
git checkout -- .
git clean -fd
git checkout v2.51.1
git describe --tags

sudo ./scripts/setup_udev_rules.sh
sudo udevadm control --reload-rules
sudo udevadm trigger

mkdir -p build && cd build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DFORCE_RSUSB_BACKEND=true \
  -DBUILD_EXAMPLES=true \
  -DBUILD_WITH_CUDA=false

make -j"$(nproc)"
sudo make install
sudo ldconfig

lsusb | grep 8086:0b3a
rs-enumerate-devices
rs-enumerate-devices -c
```

Build realsense-ros

```bash
sudo apt update
sudo apt install -y python3-colcon-common-extensions python3-rosdep python3-vcstool python3-pip

mkdir -p ~/g1_d435i_ws/src
cd ~/g1_d435i_ws/src
git config --global http.version HTTP/1.1
git clone https://github.com/realsenseai/realsense-ros.git -b ros2-master
cd ~/g1_d435i_ws/src/realsense-ros
git checkout 4.51.1

cd ~/g1_d435i_ws
source /opt/ros/foxy/setup.bash
export ROS_DISTRO=foxy
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export CMAKE_PREFIX_PATH=/usr/local:$CMAKE_PREFIX_PATH
export LD_LIBRARY_PATH=/usr/local/lib:$LD_LIBRARY_PATH
export PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:$PKG_CONFIG_PATH
export realsense2_DIR=/usr/local/lib/cmake/realsense2

colcon build --symlink-install
```

Configure PC2 -> AGX DDS
(PC2 IP is 192.168.123.164 and NIC is `eth0`. Change 192.168.123.99 below to your external compute unit address.)

```bash
cat > ~/pc2_d435i_env.sh <<'EOF'
source /opt/ros/foxy/setup.bash
source ~/g1_d435i_ws/install/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export ROS_LOCALHOST_ONLY=0
export CYCLONEDDS_URI='<CycloneDDS><Domain id="0"><General><Interfaces><NetworkInterface name="eth0" priority="default" multicast="default" /></Interfaces><AllowMulticast>true</AllowMulticast></General><Discovery><Peers><Peer address="192.168.123.99" /></Peers></Discovery></Domain></CycloneDDS>'
EOF

source ~/pc2_d435i_env.sh

ros2 launch realsense2_camera rs_launch.py \
  camera_name:=d435i \
  serial_no:=_243122076169 \
  enable_color:=true \
  enable_depth:=true \
  enable_infra1:=true \
  enable_infra2:=true \
  enable_gyro:=false \
  enable_accel:=false \
  enable_sync:=true \
  align_depth.enable:=true \
  pointcloud.enable:=true \
  depth_module.profile:=640x480x30 \
  depth_module.infra_profile:=640x480x30 \
  rgb_camera.profile:=640x480x30
```

External compute unit receive test

```bash
cat > ~/cyclonedds_agx.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8" ?>
<CycloneDDS xmlns="https://cdds.io/config"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
            xsi:schemaLocation="https://cdds.io/config https://raw.githubusercontent.com/eclipse-cyclonedds/cyclonedds/master/etc/cyclonedds.xsd">
  <Domain id="any">
    <General>
      <NetworkInterfaceAddress>eno1</NetworkInterfaceAddress>
      <AllowMulticast>true</AllowMulticast>
    </General>
    <Discovery>
      <ParticipantIndex>auto</ParticipantIndex>
      <Peers>
        <Peer Address="192.168.123.164"/>
      </Peers>
      <MaxAutoParticipantIndex>50</MaxAutoParticipantIndex>
    </Discovery>
  </Domain>
</CycloneDDS>
EOF

source /opt/ros/humble/setup.bash
source ~/xx/xx/unitree_g1_bridge/install/setup.bash

export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export ROS_LOCALHOST_ONLY=0
export CYCLONEDDS_URI=file://$HOME/cyclonedds_agx.xml

ros2 daemon stop
ros2 daemon start

ros2 topic list | grep /g1_head/d435i
ros2 topic echo /g1_head/d435i/imu --once
ros2 topic hz /g1_head/d435i/color/image_raw
ros2 topic hz /g1_head/d435i/depth/image_rect_raw
ros2 topic hz /g1_head/d435i/depth/color/points

# Generate D435i point cloud on the external compute unit
sudo apt update
sudo apt install -y ros-humble-depth-image-proc

source /opt/ros/humble/setup.bash
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export ROS_LOCALHOST_ONLY=0
export CYCLONEDDS_URI=file://$HOME/cyclonedds_agx.xml

ros2 run depth_image_proc point_cloud_xyzrgb_node --ros-args \
  -r depth_registered/image_rect:=/d435i/aligned_depth_to_color/image_raw \
  -r rgb/image_rect_color:=/d435i/color/image_raw \
  -r rgb/camera_info:=/d435i/color/camera_info \
  -r points:=/d435i/depth/color/points \
  -p queue_size:=10 \
  -p exact_sync:=false
```

Stop auto-starting `videohub_pc4`

```bash
sudo systemctl stop g1-d435i.service
sudo pkill -f /unitree/module/video_hub_pc4/videohub_pc4 || true
sleep 2

sudo mkdir -p /unitree/etc/master_service/disabled
sudo mv /unitree/etc/master_service/service/video_hub_pc4.disabled /unitree/etc/master_service/disabled/video_hub_pc4

sudo mkdir -p /unitree/etc/master_service/disabled
sudo mv /unitree/etc/master_service/service/video_hub_pc4 /unitree/etc/master_service/disabled/video_hub_pc4

sudo mv /unitree/etc/master_service/service/video_hub_pc4.bak /unitree/etc/master_service/disabled/video_hub_pc4.bak

ls /unitree/etc/master_service/service
ls /unitree/etc/master_service/disabled

sudo reboot

# After reboot, check that `videohub_pc4` did not start automatically:
ps -ef | grep videohub_pc4
sudo lsof /dev/video* /dev/media* 2>/dev/null
```

Auto-start configuration

PC2 configuration examples

```bash
cat > ~/cyclonedds_foxy.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8" ?>
<CycloneDDS xmlns="https://cdds.io/config"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
            xsi:schemaLocation="https://cdds.io/config https://raw.githubusercontent.com/eclipse-cyclonedds/cyclonedds/master/etc/cyclonedds.xsd">
  <Domain id="any">
    <General>
      <NetworkInterfaceAddress>eth0</NetworkInterfaceAddress>
      <AllowMulticast>true</AllowMulticast>
    </General>
    <Discovery>
      <ParticipantIndex>auto</ParticipantIndex>
      <Peers>
        <Peer Address="192.168.123.99"/>
      </Peers>
      <MaxAutoParticipantIndex>50</MaxAutoParticipantIndex>
    </Discovery>
  </Domain>
</CycloneDDS>
EOF
```

Create `~/pc2_realsense_env.sh`:

```bash
cat > ~/pc2_realsense_env.sh <<'EOF'
source /opt/ros/foxy/setup.bash
source ~/g1_d435i_ws/install/setup.bash

export ROS_DISTRO=foxy
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp

export CMAKE_PREFIX_PATH=/usr/local:${CMAKE_PREFIX_PATH:-}
export LD_LIBRARY_PATH=/usr/local/lib:${LD_LIBRARY_PATH:-}
export PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}
export realsense2_DIR=/usr/local/lib/cmake/realsense2

export ROS_DOMAIN_ID=0
export ROS_LOCALHOST_ONLY=0
export CYCLONEDDS_URI=file://$HOME/cyclonedds_foxy.xml
EOF

chmod +x ~/pc2_realsense_env.sh
```

Create startup script `~/start_g1_d435i.sh`:

```bash
cat > ~/start_g1_d435i.sh <<'EOF'
#!/usr/bin/env bash
set -e

source ~/pc2_realsense_env.sh

pkill -f realsense2_camera_node || true
sleep 2

exec ros2 launch realsense2_camera rs_launch.py \
  camera_name:=d435i \
  serial_no:=_243122076169 \
  enable_color:=true \
  enable_depth:=true \
  enable_infra1:=true \
  enable_infra2:=true \
  enable_gyro:=true \
  enable_accel:=true \
  unite_imu_method:=2 \
  enable_sync:=false \
  align_depth.enable:=false \
  pointcloud.enable:=false \
  depth_module.profile:=640x480x30 \
  depth_module.infra_profile:=640x480x30 \
  rgb_camera.profile:=640x480x30
EOF

chmod +x ~/start_g1_d435i.sh
```

Create a remote start wrapper `~/start_g1_d435i_remote.sh`:

```bash
cat > ~/start_g1_d435i_remote.sh <<'EOF'
#!/usr/bin/env bash
set -e

source ~/pc2_realsense_env.sh

pkill -f realsense2_camera_node || true
sleep 8

for i in $(seq 1 20); do
  if lsusb | grep -q '8086:0b3a'; then
    break
  fi
  sleep 1
done

echo "ENV_CHECK ROS_DISTRO=$ROS_DISTRO"
echo "ENV_CHECK RMW_IMPLEMENTATION=$RMW_IMPLEMENTATION"
echo "ENV_CHECK CMAKE_PREFIX_PATH=$CMAKE_PREFIX_PATH"
echo "ENV_CHECK LD_LIBRARY_PATH=$LD_LIBRARY_PATH"
echo "ENV_CHECK PKG_CONFIG_PATH=$PKG_CONFIG_PATH"
echo "ENV_CHECK realsense2_DIR=$realsense2_DIR"

exec ~/start_g1_d435i.sh
EOF

chmod +x ~/start_g1_d435i_remote.sh
```

Create `start_g1_d435i.sh` executable permission above already set.

Configure external compute unit (AGX)

```bash
# Network configuration
ip -br link
nmcli device status

# Suppose NIC is eno1, configure a static address for robot-dedicated link:
sudo nmcli con add type ethernet ifname eno1 con-name g1-eth \
  ipv4.method manual ipv4.addresses 192.168.123.99/24 \
  ipv4.never-default yes ipv6.method ignore connection.autoconnect yes 2>/dev/null || true

sudo nmcli con mod g1-eth \
  ipv4.method manual ipv4.addresses 192.168.123.99/24 \
  ipv4.never-default yes ipv6.method ignore connection.autoconnect yes

sudo nmcli con up g1-eth
ip addr show eno1
ping -c 3 192.168.123.164

# Install AGX dependencies
sudo apt update
sudo apt install -y \
  ros-humble-rmw-cyclonedds-cpp \
  ros-humble-depth-image-proc \
  tmux openssh-client rsync

sudo apt install -y ros-humble-rviz2 ros-humble-rqt-image-view
```

Configure CycloneDDS on AGX (`~/cyclonedds_agx.xml`):

```bash
cat > ~/cyclonedds_agx.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8" ?>
<CycloneDDS xmlns="https://cdds.io/config"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
            xsi:schemaLocation="https://cdds.io/config https://raw.githubusercontent.com/eclipse-cyclonedds/cyclonedds/master/etc/cyclonedds.xsd">
  <Domain id="any">
    <General>
      <NetworkInterfaceAddress>eno1</NetworkInterfaceAddress>
      <AllowMulticast>true</AllowMulticast>
    </General>
    <Discovery>
      <ParticipantIndex>auto</ParticipantIndex>
      <Peers>
        <Peer Address="192.168.123.164"/>
      </Peers>
      <MaxAutoParticipantIndex>50</MaxAutoParticipantIndex>
    </Discovery>
  </Domain>
</CycloneDDS>
EOF
```

Build `unitree_g1_bridge` workspace on AGX:

```bash
source /opt/ros/humble/setup.bash
cd ~/xxx/xxx/unitree_g1_bridge
colcon build --symlink-install
```

# Setup passwordless SSH to PC2 from external compute unit:
ssh-keygen -t ed25519
ssh-copy-id unitree@192.168.123.164
```

Create environment script `~/agx_g1_env.sh`:

```bash
cat > ~/agx_g1_env.sh <<'EOF'
__had_u=0
case $- in
  *u*) __had_u=1 ;;
esac

set +u
source /opt/ros/humble/setup.bash
source ~/xxxnitree_g1/unitree_g1_bridge/install/setup.bash
if [ "$__had_u" -eq 1 ]; then
  set -u
fi
unset __had_u

export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_DOMAIN_ID=0
export ROS_LOCALHOST_ONLY=0
export CYCLONEDDS_URI=file://$HOME/cyclonedds_agx.xml
EOF

chmod +x ~/agx_g1_env.sh
```

Configure AGX to PC2 passwordless SSH

```bash
ssh-keygen -t ed25519
ssh-copy-id unitree@192.168.123.164
ssh unitree@192.168.123.164 "hostname"
```

Create one-shot run script `run_g1_nav_stack.sh`:

```bash
cat > ~/xxx/xxx/unitree_g1_bridge/run_g1_nav_stack.sh <<'EOF'
#!/usr/bin/env bash
set -eo pipefail

export G1_PC2_IP=${G1_PC2_IP:-192.168.123.164}
export G1_PC2_USER=${G1_PC2_USER:-unitree}
export LOWSTATE_TOPIC=${LOWSTATE_TOPIC:-lowstate}

source ~/agx_g1_env.sh

ros2 daemon stop || true
ros2 daemon start

ssh ${G1_PC2_USER}@${G1_PC2_IP} "tmux kill-session -t g1_d435i 2>/dev/null || true"
ssh ${G1_PC2_USER}@${G1_PC2_IP} "tmux new-session -d -s g1_d435i bash"
ssh ${G1_PC2_USER}@${G1_PC2_IP} "tmux send-keys -t g1_d435i 'bash -lc \"~/start_g1_d435i_remote.sh\"' C-m"

cleanup() {
  pkill -f point_cloud_xyz_node || true
  pkill -f 'ros2 launch g1_bridge_bringup jetson_bridge.launch.py' || true
  pkill -f g1_cmd_vel_bridge || true
  pkill -f g1_low_state_bridge || true
}
trap cleanup EXIT INT TERM

sleep 12

ros2 launch g1_bridge_bringup jetson_bridge.launch.py lowstate_topic:=${LOWSTATE_TOPIC} auto_start:=false &
BRIDGE_PID=$!

sleep 3

ros2 run depth_image_proc point_cloud_xyz_node --ros-args \
  -r image_rect:=/d435i/depth/image_rect_raw \
  -r camera_info:=/d435i/depth/camera_info \
  -r points:=/d435i/depth/points &
PCD_PID=$!

wait $BRIDGE_PID $PCD_PID
EOF

chmod +x ~/xxx/xxx/unitree_g1_bridge/run_g1_nav_stack.sh
```

Create stop script `stop_g1_nav_stack.sh`:

```bash
cat > ~/xxxnitree_g1/unitree_g1_bridge/stop_g1_nav_stack.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

export G1_PC2_IP=${G1_PC2_IP:-192.168.123.164}
export G1_PC2_USER=${G1_PC2_USER:-unitree}

ssh ${G1_PC2_USER}@${G1_PC2_IP} "tmux kill-session -t g1_d435i 2>/dev/null || true"
pkill -f point_cloud_xyzrgb_node || true
pkill -f 'ros2 launch g1_bridge_bringup jetson_bridge.launch.py' || true
pkill -f g1_cmd_vel_bridge || true
pkill -f g1_low_state_bridge || true
EOF

chmod +x ~/xx/xxx/unitree_g1_bridge/stop_g1_
```

Startup flow

```bash
cd ~/xx/xx/unitree_g1_bridge
./run_g1_nav_stack.sh

# Stop
ros2 service call /stop std_srvs/srv/Trigger "{}"
ros2 service call /damp std_srvs/srv/Trigger "{}"

cd ~/xx/xxx/unitree_g1_bridge
./stop_g1_nav_stack.sh
```

Debugging

```bash
source ~/agx_g1_env.sh
timeout 10 ros2 topic list --no-daemon | grep -E '/d435i/|/utlidar/cloud_livox_mid360|/joint_states|/imu/data'
timeout 10 ros2 topic echo --once /joint_states --no-daemon
timeout 10 ros2 ros2 topic echo --once /d435i/depth/camera_info --no-daemon
timeout 10 ros2 topic hz /d435i/color/image_raw --no-daemon
timeout 10 ros2 topic hz /utlidar/cloud_livox_mid360 --no-daemon
```

Upper-layer interface tests

```bash
cd ~/xxx/xxxx/unitree_g1_bridge
source ~/agx_g1_env.sh

ros2 service call /stand_up std_srvs/srv/Trigger "{}"
ros2 service call /start std_srvs/srv/Trigger "{}"

timeout 2 ros2 topic pub -r 10 /cmd_vel geometry_msgs/msg/Twist "{linear: {x: 0.05, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.0}}"
ros2 service call /stop std_srvs/srv/Trigger "{}"

timeout 2 ros2 topic pub -r 10 /cmd_vel geometry_msgs/msg/Twist "{linear: {x: 0.0, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.10}}"
ros2 service call /stop std_srvs/srv/Trigger "{}"

ros2 service call /damp std_srvs/srv/Trigger "{}"
```