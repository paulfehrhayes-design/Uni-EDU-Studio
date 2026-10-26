# G1_lidar_navigation — 2D Navigation Stack for the Unitree G1

A ROS 1 (Noetic) navigation stack for the Unitree G1 humanoid, built around a Livox **MID‑360** LiDAR and an **Intel RealSense** RGB camera. It produces a 2D occupancy grid from FAST‑LIO's 3D point cloud, relocalises against a saved prior map, and drives the robot with `move_base` on top of a custom 2D body frame.

Inspired by the `sentry_nav` repo and the standard ROS navigation stack, re-tuned for the G1's bipedal motion, retro‑fitted with a RealSense fusion node, and extended with a YOLOv5-driven goal selector.

---

## Repository layout

```
G1_lidar_navigation/
├── README.md                     <- this file
├── colored_pointcloud.py         <- LiDAR ↔ RealSense fusion (RGB-coloured cloud)
├── coloured_yolo_pt.py           <- fusion + YOLOv5 → /move_base_simple/goal
├── rosbag_to_video.py            <- pull camera frames out of a .bag into MP4
├── convert_all_rosbags.sh        <- batch wrapper for rosbag_to_video.py
├── doc/                          <- diagrams + demo media used in this README
├── g1_nav/                       <- move_base config, costmaps, frame transforms
│   ├── launch/                       g1_movebase.launch, g1_test.launch
│   ├── param/                        DWA + costmap YAMLs (tuned for G1)
│   └── src/                          Trans_TF_2d.cpp, Trans_TF_2d_odom.cpp, Trans_odom_2d.cpp
├── g1_tools/
│   ├── pcd2pgm_package/          <- offline PCD → 2D occupancy grid
│   └── velocity_smoother_ema/    <- EMA smoother on /cmd_vel
├── g1_comm/g1_serial/            <- /cmd_vel → serial bridge (legacy wheeled base)
├── g1_decision/                  <- random / mid-term goal generators
└── g1_onboard/
    └── g1_walk.py                <- runs ON the G1: /cmd_vel → Unitree LocoClient
```

The 3D SLAM half (FAST‑LIO + FAST‑LIO‑LOCALIZATION + livox_ros_driver2) is **not vendored** in this repo — install them upstream into the same workspace. See [Install](#install).

---

## Install

### A. Laptop — catkin workspace

#### 1. Drop into a catkin workspace

The whole repo is meant to live inside `catkin_ws/src/`. Clone it as a package:

```bash
cd ~/catkin_ws/src
git clone https://github.com/bethalageetachandraraju/G1_lidar_navigation.git
```

> The repo root **is** the package layout — there is no extra wrapper folder. After cloning, `~/catkin_ws/src/G1_lidar_navigation/g1_nav/`, `g1_tools/`, etc. are visible to `catkin_make` directly.

#### 2. Bring in the upstream SLAM stack

These packages live next to this repo under `catkin_ws/src/`:

| Package                                                                 | Purpose                                |
|-------------------------------------------------------------------------|----------------------------------------|
| [Livox-SDK/Livox-SDK2](https://github.com/Livox-SDK/Livox-SDK2)         | MID‑360 driver (system-level install)  |
| [livox_ros_driver2](https://github.com/Livox-SDK/livox_ros_driver2)     | ROS bringup for the MID‑360            |
| [hku-mars/FAST_LIO](https://github.com/hku-mars/FAST_LIO)               | Online LiDAR odometry + 3D mapping     |
| [HViktorTsoi/FAST_LIO_LOCALIZATION](https://github.com/HViktorTsoi/FAST_LIO_LOCALIZATION) | Relocalisation against a prior PCD     |
| [yolov5_ros](https://github.com/mats-robotics/yolov5_ros) + [detection_msgs](https://github.com/mats-robotics/detection_msgs) | YOLOv5 ROS wrapper (only for `coloured_yolo_pt.py`) |

Set both host and LiDAR IPs in the Livox driver config — the MID‑360 ships at `192.168.1.180`; pick a host on the same subnet (e.g. `192.168.1.50`).

#### 3. Apt deps

```bash
sudo apt install \
  ros-noetic-map-server ros-noetic-move-base \
  ros-noetic-octomap-server ros-noetic-octomap-ros ros-noetic-octomap-msgs ros-noetic-octomap-rviz-plugins \
  ros-noetic-cv-bridge ros-noetic-realsense2-camera \
  libeigen3-dev libpcl-dev
pip install numpy==1.21 open3d transforms3d
```

#### 4. Build

```bash
cd ~/catkin_ws
catkin_make
source devel/setup.bash
```

---

### B. G1 robot — Unitree SDK bridge

`/cmd_vel` is what `move_base` produces; the G1 doesn't consume `Twist` directly. The bridge that actually moves the robot is [`g1_onboard/g1_walk.py`](g1_onboard/g1_walk.py) — it subscribes to `/cmd_vel` and forwards each message into `unitree_sdk2py.g1.loco.g1_loco_client.LocoClient.Move(forward, lateral, rotate)`.

This script must run **on the G1's onboard PC**, not on the laptop.

#### 1. Install the Unitree SDK2 Python bindings

Follow the install steps at [unitreerobotics/unitree_sdk2_python](https://github.com/unitreerobotics/unitree_sdk2_python).

#### 2. Drop `g1_walk.py` into the SDK examples tree

The script is meant to live alongside the other G1 high-level locomotion examples:

```
unitree_sdk2_python/examples/g1/highlevel/g1_walk.py
```

Copy it from this repo:

```bash
cp g1_onboard/g1_walk.py ~/unitree_sdk2_python/examples/g1/highlevel/
```

`rospy` is also needed on the robot:

```bash
pip install rospkg pyyaml
sudo apt install ros-noetic-rospy ros-noetic-geometry-msgs
```

#### 3. Run it

Once the laptop's `move_base` is publishing `/cmd_vel` and the network is set up (Section C below):

```bash
cd ~/unitree_sdk2_python/examples/g1/highlevel
python3 g1_walk.py <network_interface>
# example:
# python3 g1_walk.py eth0
```

`<network_interface>` is the NIC the G1 uses for the **Unitree SDK channel** (commonly `eth0`) — this is **separate** from the ROS network.

---

### C. Network — shared ROS master across laptop & G1

The laptop publishes `/cmd_vel` and the G1 (`g1_walk.py`) subscribes to it, so both machines must talk to a **single ROS master** over the network.

#### 1. Connect both machines to the same LAN

Plug the G1 and the laptop into the same router/switch (or have them on the same Wi-Fi). Confirm they can ping each other:

```bash
# from the laptop
ping <g1-ip>
# from the G1
ping <laptop-ip>
```

If either ping fails, fix the network before going further (check firewall, VLAN, Wi-Fi isolation).

#### 2. Pick one machine as the ROS master

The laptop is the natural choice (it runs `roscore` for the LiDAR + RealSense anyway).

#### 3. Export `ROS_MASTER_URI` and `ROS_IP` in every shell

**On the laptop (master):**

```bash
export ROS_MASTER_URI=http://<laptop-ip>:11311
export ROS_IP=<laptop-ip>
roscore   # if not already running via roslaunch
```

**On the G1 (client):**

```bash
export ROS_MASTER_URI=http://<laptop-ip>:11311
export ROS_IP=<g1-ip>
```

Replace `<laptop-ip>` and `<g1-ip>` with the actual IPs (e.g. `192.168.1.10`). Use **IP addresses, not hostnames** — hostname resolution across machines is the most common failure mode.

To make this permanent, append the exports to `~/.bashrc` on each machine.

#### 4. Verify the bridge

On the laptop:

```bash
rostopic list                    # should show /cmd_vel once move_base is running
rostopic echo /cmd_vel           # should print Twist messages
```

On the G1, in a shell with the env vars set:

```bash
rostopic list                    # should see the same /cmd_vel topic
rosnode list                     # should see /move_base (running on the laptop)
```

If the G1 sees an empty topic list, the env vars aren't set, hostnames aren't resolvable, or the firewall is blocking port `11311` (master) and the dynamic ports ROS uses for direct node↔node TCP.

---

## Pipeline overview

```
 MID‑360 ──► livox_ros_driver2 ──► FAST‑LIO ──► /cloud_registered_body  ──┐
                                       │                                  │
                                       └─► /Odometry (3D)                 ▼
                                                                  octomap_server
                                                                          │
 prior PCD map ──► FAST‑LIO‑LOCALIZATION ──► /map → /odom → /body TF      ▼
                                                                  /projected_map (2D grid)
                                                                          │
 PointCloud2 ──► pointcloud_to_laserscan ──► /scan ──┐                    │
                                                     ▼                    ▼
 Trans_TF_2d ──► /body_2d frame ──────────────► move_base ──► /cmd_vel ──► velocity_smoother_ema ──► robot
                                                     ▲
                                          /move_base_simple/goal
                                          (RViz, g1_decision, or coloured_yolo_pt.py)
```

The two non-obvious bits:

- **Frame flattening** — FAST‑LIO publishes `body` in 3D (full SE(3)). `move_base` wants a 2D pose in `map`. [`g1_nav/src/Trans_TF_2d.cpp`](g1_nav/src/Trans_TF_2d.cpp) drops `z`, roll and pitch from `body`, leaving only `(x, y, yaw)` as `body_2d`. The local costmap and DWA both run in this 2D frame.
- **PCD → grid** — `octomap_server` builds the 2D occupancy grid online from FAST‑LIO's 3D cloud (no offline conversion step needed). `pcd2pgm_package` is kept for the offline path if you'd rather convert a saved PCD.

---

## Build a map

> The launch files `g1_build_map.launch`, `g1_localize.launch`, and `g1_localize_odom.launch` referenced below live inside the `fast_lio_localization` package. Drop them into `fast_lio_localization/launch/` before running the commands below.

```bash
# Terminal 1 — LiDAR driver
roslaunch livox_ros_driver2 msg_MID360.launch

# Terminal 2 — FAST‑LIO mapping + online 2D projection
roslaunch fast_lio_localization g1_build_map.launch
```

Drive the robot through the area, then save:

```bash
# 2D occupancy grid → PGM + YAML
rosrun map_server map_saver map:=/projected_map -f ~/catkin_ws/src/G1_lidar_navigation/maps/scans

# 3D point cloud (auto-saved by FAST‑LIO under FAST_LIO/PCD/)
```

Open `scans.yaml` and confirm `origin: [x, y, yaw]` does **not** contain `nan` — replace with zeros if so.

---

## Navigate

### Laptop terminals

```bash
# 1. LiDAR
roslaunch livox_ros_driver2 msg_MID360.launch

# 2. Relocalise against the saved PCD prior (or use g1_localize_odom.launch
#    for pure-odometry mode if you start from a known pose every time)
roslaunch fast_lio_localization g1_localize.launch

# 3. Seed the initial pose — RViz "2D Pose Estimate" or:
rosrun fast_lio_localization publish_initial_pose.py 0 0 0 0 0 0

# 4. move_base + velocity smoother + frame transforms
roslaunch g1_nav g1_movebase.launch

# 5. Send goals — RViz "2D Nav Goal", or g1_decision, or coloured_yolo_pt.py
```

### G1 terminal

In a shell with `ROS_MASTER_URI` / `ROS_IP` exported (see Setup C):

```bash
cd ~/unitree_sdk2_python/examples/g1/highlevel
python3 g1_walk.py eth0          # NIC for the Unitree SDK channel
```

`g1_walk.py` is what actually moves the robot — `move_base` outputs `/cmd_vel`, this node consumes it and calls `LocoClient.Move(forward, lateral, rotate)` on every Twist.

For wheeled bases (legacy use), the [`g1_serial`](g1_comm/g1_serial/) node serialises `/cmd_vel` over a USB‑TTL link instead.

---

## Tuning notes (what changed for the G1)

The defaults in [`g1_nav/param/`](g1_nav/param/) are tuned for the G1's bipedal motion. Headlines:

| File                              | Key change                                                  | Why                                                                                  |
|-----------------------------------|-------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `base_local_planner_params.yaml`  | `max_vel_x: 1.0`, `min_vel_x: -0.5`, `max_vel_y: ±0.3`      | Allow forward and a small backward, throttle sideways drift on legs                  |
| `base_local_planner_params.yaml`  | `acc_lim_x: 10`, `acc_lim_y: 5`                             | G1 can change forward speed quickly; lateral acceleration is slower and noisier      |
| `base_local_planner_params.yaml`  | `holonomic_robot: true`, `vy_samples: 5`                    | G1 *is* holonomic, but bias the planner away from sideways shuffling                 |
| `base_local_planner_params.yaml`  | `xy_goal_tolerance: 0.2`, `yaw_goal_tolerance: 0.05`        | Looser xy than upstream — the gait is jittery near zero velocity                     |
| `base_local_planner_params.yaml`  | `global_frame_id: robot_foot_init`                          | G1 uses a foot frame, not a wheel base frame                                         |
| `costmap_common_params.yaml`      | `robot_radius: 0.40`, `inflation_radius: 0.6`               | Wide footprint for the G1; conservative inflation around it                          |
| `velocity_smoother_ema/param/smoother.yaml` | `alpha_v / alpha_w: 0.4`                          | More responsive than upstream's `0.2` to keep up with the gait without judder        |

Re-tune these for your own G1 — the values above are a starting point, not gospel.

---

## RGB-LiDAR fusion & YOLO-driven goals

Two top-level Python nodes that are **independent of `move_base`** but plug into the same TF tree.

### `colored_pointcloud.py` — RGB-coloured LiDAR cloud

Projects every point of `/cloud_registered_body` (FAST‑LIO body-frame cloud) into the latest RealSense colour frame and re-publishes the point cloud with per-point RGB:

```
/cloud_registered_body   ┐
                         ├─►  colored_pointcloud_node  ──►  /colored_pointcloud (PointCloud2 + rgb)
/camera/color/image_raw  ┤
/camera/color/camera_info┘
```

Key implementation details:

- The body↔camera extrinsic is hard-coded as a 4×4 in [`get_camera_transform()`](colored_pointcloud.py) — adjust if your RealSense isn't roughly nose-mounted on the G1.
- Points behind the camera (`z ≤ 0` in optical frame) and points that fall outside the image are dropped silently; the node logs `(total / behind / outside / coloured)` counts at 1 Hz.
- A debug OpenCV window draws each projected point on the live RGB frame — useful when you're calibrating the extrinsic by eye.
- A second 4×4 (`R_adjust`) rotates the published cloud 90° around Z so it shows up "pointing forward" in RViz when the optical frame is mounted off-axis. Set it to identity if your TF tree is already correct.

```bash
python3 colored_pointcloud.py
# RViz: add PointCloud2 on /colored_pointcloud, set "Color Transformer" to RGB8
```

### `coloured_yolo_pt.py` — YOLO detections → navigation goals

Same fusion as above, plus a YOLOv5 hook:

```
/yolov5/detections (BoundingBoxes) ─┐
/cloud_registered_body              ├─►  coloured_yolo_pt_node  ──►  /move_base_simple/goal
/camera/color/image_raw             │                                /colored_pointcloud
/camera/color/camera_info           ┘
```

For each detection:

1. Take the bbox centre `(u, v)`.
2. Find LiDAR points whose projection lands inside a 5 px radius of the centre.
3. Median-filter their 3D positions in the body frame (rejects single-point depth noise).
4. Look up `body → map` (here, `robot_foot_init`) via `tf2`.
5. Publish a `PoseStamped` to `/move_base_simple/goal`.

Goals are **rate-limited to one every 10 seconds** — without this the goal flips faster than `move_base` can replan.

A target class can be passed on the command line:

```bash
python3 coloured_yolo_pt.py chair          # only chase chairs
python3 coloured_yolo_pt.py                # any class
```

The OpenCV preview shows bounding boxes (green = target class, orange = other detections) and a countdown to the next goal publish. Requires the [`detection_msgs`](https://github.com/mats-robotics/detection_msgs) package and a YOLOv5 ROS publisher.

A still from this pipeline:

![Projected points + bbox overlay](Projected%20Points_screenshot_07.04.2025.png)

---

## Recording playbacks

Logging the colour camera plus `/cmd_vel` to a rosbag is the easiest way to debug:

```bash
rosbag record -O run.bag /camera/color/image_raw/compressed /cmd_vel /move_base/goal
```

Then dump every `*.bag` in a folder to `*.mp4`:

```bash
./convert_all_rosbags.sh 10            # 10 fps
# or one bag at a time:
python3 rosbag_to_video.py run.bag --topic /camera/color/image_raw/compressed --fps 10
```

---

## Acknowledgments

- [**hku-mars/FAST_LIO**](https://github.com/hku-mars/FAST_LIO) and [**HViktorTsoi/FAST_LIO_LOCALIZATION**](https://github.com/HViktorTsoi/FAST_LIO_LOCALIZATION) — LiDAR odometry and relocalisation.
- [**Livox-SDK/livox_ros_driver2**](https://github.com/Livox-SDK/livox_ros_driver2) — MID‑360 driver.
- [**mats-robotics/yolov5_ros**](https://github.com/mats-robotics/yolov5_ros) — YOLOv5 publisher used by `coloured_yolo_pt.py`.
- [**ros-perception/pointcloud_to_laserscan**](https://github.com/ros-perception/pointcloud_to_laserscan) — 3D → 2D scan conversion feeding the local costmap.

## License

BSD-3-Clause. See [`LICENSE`](LICENSE).
