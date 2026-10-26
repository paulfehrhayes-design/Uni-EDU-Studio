# ws_slam

ROS 2 Humble workspace for SLAM mapping and Nav2-based autonomous navigation on the Unitree G1 robot with Livox MID-360 LiDAR.

## System Overview

```
Livox MID-360
    └─> pointcloud_to_laserscan (/scan_raw)
            └─> scan_restamper (/scan)        ← fixes Livox hardware clock offset
                    └─> slam_toolbox           ← builds map / localizes
                                               ← publishes map→odom TF
Unitree /dog_odom
    └─> odom_tf_broadcaster                   ← publishes odom→robot_center TF

Nav2 (navigation mode only)
    └─> controller_server (Regulated Pure Pursuit)
    └─> planner_server (NavFn / A*)
    └─> /cmd_vel
            └─> cmdvel_to_sport               ← bridges to Unitree Sport API
```

**Key notes:**
- Robot odometry frame is `robot_center` (not `base_link`)
- Livox hardware clock is offset from system clock — `scan_restamper` fixes this
- Both scan and TF are stamped with ROS system clock for consistency

---

## Prerequisites

### Install Nav2 (one time)
```bash
sudo apt update
sudo apt install ros-humble-slam-toolbox ros-humble-nav2-map-server \
  ros-humble-navigation2 ros-humble-nav2-bringup
```

### Build
```bash
# Build Livox driver first
cd /home/unitree/ws_livox
source /opt/ros/humble/setup.bash
colcon build

# Build this workspace
cd /home/unitree/ws_slam
source /opt/ros/humble/setup.bash
source /home/unitree/ws_livox/install/setup.bash
colcon build
source install/setup.bash
```

---

## Phase 1 — Mapping

Run this **once** to build and save the map. Skip if you already have map files in `/home/unitree/ws_slam/maps/`.

### Step 1 — Source and launch mapping

```bash
source /opt/ros/humble/setup.bash
source /home/unitree/ws_livox/install/setup.bash
source /home/unitree/ws_slam/install/setup.bash

ros2 launch g1_slam_bringup mapping.launch.py use_livox:=true
```

### Step 2 — Open RViz (separate terminal)

```bash
source /opt/ros/humble/setup.bash
source /home/unitree/ws_slam/install/setup.bash

ros2 run rviz2 rviz2 -d /home/unitree/ws_slam/install/g1_slam_bringup/share/g1_slam_bringup/config/mapping.rviz
```

Drive the robot around the entire area. Watch the occupancy grid fill in RViz (Fixed Frame: `map`).

### Step 3 — Save the map (while mapping is still running)

In a third terminal:

```bash
source /home/unitree/ws_slam/install/setup.bash

# Serialize pose graph for slam_toolbox localization
ros2 service call /slam_toolbox/serialize_map \
  slam_toolbox/srv/SerializePoseGraph \
  "{filename: '/home/unitree/ws_slam/maps/atrium_slam'}"

# Save 2D occupancy grid for Nav2 costmaps
ros2 service call /slam_toolbox/save_map \
  slam_toolbox/srv/SaveMap \
  "{name: {data: '/home/unitree/ws_slam/maps/atrium_2d'}}"
```

Verify 4 files were created:
```bash
ls -lh /home/unitree/ws_slam/maps/atrium_slam* /home/unitree/ws_slam/maps/atrium_2d*
```

Expected:
- `atrium_slam.posegraph`
- `atrium_slam.data`
- `atrium_2d.pgm`
- `atrium_2d.yaml`

Stop the mapping launch (Ctrl+C).

---

## Phase 2 — Navigation

Uses the saved map to localize and navigate autonomously.

### Step 1 — Launch navigation

```bash
source /opt/ros/humble/setup.bash
source /home/unitree/ws_livox/install/setup.bash
source /home/unitree/ws_slam/install/setup.bash

ros2 launch g1_slam_bringup navigation.launch.py \
  use_livox:=true \
  map:=/home/unitree/ws_slam/maps/atrium_2d.yaml
```

### Step 2 — Open RViz (separate terminal)

```bash
source /opt/ros/humble/setup.bash
source /home/unitree/ws_slam/install/setup.bash

ros2 run rviz2 rviz2 -d /home/unitree/ws_slam/install/g1_slam_bringup/share/g1_slam_bringup/config/mapping.rviz
```

### Step 3 — Send navigation goals

**Option A — From RViz:**
Use the **"2D Goal Pose"** button in the RViz toolbar, click and drag on the map.

**Option B — From terminal:**
```bash
ros2 topic pub --once /goal_pose geometry_msgs/PoseStamped \
  "{header: {frame_id: 'map'}, pose: {position: {x: 2.0, y: 1.0, z: 0.0}, orientation: {w: 1.0}}}"
```

---

## Map Files Reference

| File | Used by | Description |
|------|---------|-------------|
| `atrium_slam.posegraph` | slam_toolbox localization | Pose graph for relocalization |
| `atrium_slam.data` | slam_toolbox localization | Scan data associated with pose graph |
| `atrium_2d.pgm` | Nav2 costmaps | 2D occupancy grid image |
| `atrium_2d.yaml` | Nav2 costmaps | Map metadata (resolution, origin) |

Maps are stored in `/home/unitree/ws_slam/maps/`.

---

## Configuration Files

| File | Purpose |
|------|---------|
| `src/g1_slam_bringup/config/slam_toolbox.yaml` | SLAM parameters (mapping mode) |
| `src/g1_slam_bringup/config/localization.yaml` | slam_toolbox localization mode parameters |
| `src/g1_slam_bringup/config/nav2_params.yaml` | Nav2 controller, planner, costmap parameters |
| `src/g1_nav_bridge/config/nav_bridge.yaml` | Velocity limits and Sport API bridge params |

### Velocity limits (nav_bridge.yaml)
- Max forward speed: `0.20 m/s`
- Max yaw rate: `0.30 rad/s`
- Lateral motion: disabled (non-holonomic)

---

## Troubleshooting

**slam_toolbox drops all scans ("queue is full" / "earlier than transform cache")**
Both the Livox hardware clock and robot's internal clock are offset from the system clock.
This is handled by `scan_restamper` (stamps scans with ROS clock) and `odom_tf_broadcaster`
(stamps TF with ROS clock). If drops persist at startup, wait 2–3 seconds — the TF buffer
needs time to fill.

**Occupancy grid not visible in RViz**
Check that Fixed Frame is set to `map` in RViz Global Options.

**keyboard_teleop crash (`termios` error)**
Expected when launched as a subprocess. Launch it manually in its own terminal:
```bash
ros2 run g1_keyboard_teleop keyboard_teleop
```

**Map save fails (`result=1`)**
The robot hasn't moved enough to build a map. Drive around more before saving.
