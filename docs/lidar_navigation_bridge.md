# LiDAR navigation gateway and execution contract

The onboard Ubuntu 20.04 LiDAR sensor driver may run in an isolated ROS 2 Humble
container, but this does not install or run Nav2. The Path Planner gateway below
still requires a separate, fully configured ROS 2 Humble/Nav2 environment.

The Path Planner can submit ordered map-frame goals to a separate ROS 2 Humble
Nav2 gateway. Nav2 owns route planning and publishes its controller output to
the `/cmd_vel` input of the separately installed Unitree G1 bridge. The browser
does not publish ROS messages or velocity commands. This is a software
integration path; it has not been commissioned or physically tested on a G1.
Upstream repository, license, ROS-distro, and hardware-assumption notes are
recorded in [the LiDAR source audit](./lidar_source_audit.md).

## Backend configuration

Configure the backend service with:

```text
G1_NAV_BRIDGE_URL=https://<trusted-navigation-host>/g1-navigation
G1_NAV_BRIDGE_TOKEN=<strong random gateway token>
G1_NAV_EXECUTION_ENABLED=1
G1_NAV_LOCOMOTION_OWNER=nav2_via_single_unitree_bridge
G1_NAV_CONTROLLER_OWNERSHIP_CONFIRMED=1
```

HTTP is accepted only for a loopback bridge. Use HTTPS for any remote bridge.
The same token is configured as `G1_NAV_GATEWAY_TOKEN` on the navigation host.
The token stays on the application backend and is sent as a bearer token. The
browser uses only teacher-authenticated application API routes and never
connects directly to ROS or receives the bridge token. `G1_NAV_EXECUTION_ENABLED`
defaults off; enable it only after commissioning the gateway and Nav2 deployment.
The two controller-ownership settings are an additional fail-closed motion gate.
Leave ownership unconfirmed until commissioning verifies that Nav2 sends through
the single intended Unitree bridge and no competing locomotion controller is
active. `G1_NAV_CONTROLLER_OWNERSHIP_CONFIRMED=1` does not itself detect other
ROS publishers; it records the deployment owner's commissioning decision.
The backend reports the execution-enable state in navigation diagnostics, and
both physical route execution and Spin scans remain blocked while that switch
is off.

## Deploy the ROS gateway

Run `backend/ros/navigation_gateway.py` on the ROS 2 host, after sourcing ROS 2
Humble and the SLAM/Nav2 workspace. The host must provide:

- a Nav2 `NavigateThroughPoses` action server (default
  `/navigate_through_poses`);
- a Nav2 `ComputePathThroughPoses` action server (default
  `/compute_path_through_poses`) for path previews that do not move the robot;
- a Nav2 `Spin` behavior action server (default `/spin`) that uses the same
  Nav2 velocity-output path and commissioned G1 `/cmd_vel` bridge;
- a live, correctly registered `OccupancyGrid` on `/map`, in the configured
  `map` frame;
- a `PointCloud2` stream from the MID-360, default topic
  `/mid360/livox/lidar`, with a time-valid TF transform from the cloud's frame
  into the configured `map` frame;
- a fresh TF transform from `map` to `base_link`;
- a `std_msgs/Bool` heartbeat on `G1_NAV_ESTOP_HEALTHY_TOPIC`; `true` must mean
  the independent physical e-stop is released and the verified safety chain is
  healthy, not merely that the bridge process is alive;
- a `std_msgs/Bool` heartbeat on `G1_NAV_ROBOT_HEALTHY_TOPIC`; `true` must mean
  the active G1 controller link is established and accepts commands;
- the specified Unitree `/cmd_vel` bridge connected to the robot.

The gateway listens on `127.0.0.1:8282` by default. For a separate app server,
expose it only behind a trusted network and TLS reverse proxy, then set the
backend URL to that proxy's HTTPS URL. Set `G1_NAV_GATEWAY_TOKEN` to a
cryptographically strong secret (at least 24 characters). Optional gateway
environment variables are `G1_NAV_GATEWAY_HOST`, `G1_NAV_GATEWAY_PORT`,
`G1_NAV_ACTION_NAME`, `G1_NAV_PLAN_ACTION_NAME`, `G1_NAV_PLANNER_ID`,
`G1_NAV_PLAN_TIMEOUT_SECONDS`, `G1_NAV_SPIN_ACTION_NAME`,
`G1_NAV_SCAN_ROTATION_TIMEOUT_SECONDS` (30–300 seconds, default 180),
`G1_NAV_MAP_TOPIC`, `G1_NAV_POINTCLOUD_TOPIC`, `G1_NAV_LOCAL_COSTMAP_TOPIC`
(default `/local_costmap/costmap`), `G1_NAV_LIVE_AVOIDANCE_ENABLED` (default
`0`), `G1_NAV_MAP_FRAME`,
`G1_NAV_BASE_FRAME`, `G1_NAV_MAP_ID`, `G1_NAV_OCCUPIED_THRESHOLD`,
`G1_NAV_ESTOP_HEALTHY_TOPIC`, `G1_NAV_ESTOP_MAX_AGE_MS`,
`G1_NAV_ROBOT_HEALTHY_TOPIC`, and `G1_NAV_ROBOT_HEALTH_MAX_AGE_MS` (100–5000 ms,
both freshness defaults are 1000). There are no default health topics because
their meaning and wiring must be verified for the actual bridge and hardware.
Motion remains disabled if either topic is unset, false, or stale; map viewing
and route preview remain available.
The additional motion gate uses `G1_NAV_LOCOMOTION_OWNER` (must be
`nav2_via_single_unitree_bridge`) and
`G1_NAV_CONTROLLER_OWNERSHIP_CONFIRMED` (must be `1`). The authenticated
navigation status reports configured point-cloud/map topics and frames,
observed point-cloud rate after a five-second measurement window, acquisition
stamp age, gateway callback duration, map age/resolution/origin/occupancy
threshold/version, localization freshness, action-server readiness, and
controller-ownership confirmation. The callback metric is not a DDS packet-drop
counter; verify delivery and loss independently on the robot with ROS tooling.
The ROS host also needs the Python ROS packages used by the gateway:
`rclpy`, `nav2_msgs`, `nav_msgs`, `geometry_msgs`, `action_msgs`, `tf2_ros`,
`sensor_msgs`, `sensor_msgs_py`, and `std_msgs`.

This gateway is not a replacement for SLAM, Nav2, or the Unitree velocity
bridge. It does not publish `/cmd_vel`, install sensor drivers, build a 2D
occupancy map, or configure the G1 bridge. The occupancy map must come from a
commissioned mapping system; the point cloud is transformed into that map
frame, voxel-downsampled at 5 cm, and capped at 300,000 points.

A teacher-started 360° scan sends a `Spin` action goal to Nav2, which must use
the same commissioned G1 velocity bridge as navigation. Before motion, the
gateway requires a fresh map, fresh point-cloud stream, valid sensor-to-map
transform, fresh `map -> base_link` localization, and a ready Spin action
server. It monitors those inputs during the turn, measures accumulated yaw,
and requests Nav2 cancellation if localization, map, or LiDAR data becomes
stale. The scan cannot be finalized unless Nav2 reports success and measured
rotation is within 0.15 radians of a full turn. Unknown action/cancel outcomes
keep the scan's locomotion lock reserved; operators must verify the robot is
stopped before restarting the gateway.

The teacher must confirm a clear rotation area, stable robot, continuous
supervision, and immediate access to the independent emergency stop. First
commission the Nav2 Spin behavior's angular speed/acceleration limits and
collision checking in a controlled, unoccupied area. Do not enable or test
Spin until the Nav2 action and G1 bridge have been verified together on the
actual hardware. This workspace cannot establish physical safety or prove
that the robot turned. A minimum of 1,000 unique points is also required to
finish capture. The app stores the resulting point cloud and matching metric
occupancy snapshot in its classroom SQLite database when a teacher completes
and publishes the scan.

The published overlay uses the ROS map resolution, width/height, origin and
origin rotation; grid coordinates are meters in the map frame. It overlays
the 2D occupancy projection and a height-colored top-down projection of the
3D point cloud. It is not a textured mesh or a guarantee of complete room
coverage: check the live sensor/SLAM alignment and physically compare known
distances before treating it as a measured room model. Students receive the
centrally published map only when a teacher enables **Show shared map on
student grids** in Settings. That setting is persisted on the app backend.
Authenticated `/api/lidar/live` WebSocket updates report navigation readiness,
scan progress, and shared-map version changes; map content is fetched through
the authenticated API.

The app's existing SDK executor is blocked while a Nav2 operation or LiDAR
scan is active. That application lock cannot arbitrate against independent ROS
publishers, terminals, or other controllers. Ensure the commissioned Nav2
stack is the only active ROS locomotion owner, and do not start SDK motion
from another process during navigation or scanning.

## Bridge API

### 3D scan lifecycle

- `POST /api/v1/scans/start` begins point-cloud capture; it never commands
  locomotion.
- `GET /api/v1/scans/{job_id}` returns progress and a bounded live preview.
- `GET /api/v1/scans/{job_id}/pointcloud` returns the completed map-frame
  point cloud.
- `POST /api/v1/scans/{job_id}/complete` freezes capture and requires at least
  1,000 unique points.
- `POST /api/v1/scans/{job_id}/cancel` discards the active capture.

In the application, a teacher explicitly confirms and starts a scan, waits for
the supervised 360° turn to complete, validates the map, then explicitly
publishes it. Publishing stores the associated
2D occupancy grid and 3D scan centrally; it does not enable the student
overlay automatically. The API is teacher-authenticated for capture and
publishing; students can read the approved shared map only while the shared
overlay setting is on.

The teacher's planner reconnects its live status stream after a dropped
connection and offers two planning modes:

- **Static 360° map** displays the approved shared scan snapshot. Before route
  preview or execution, the backend checks every waypoint against both that
  saved map and the current live SLAM map, and requires their map geometry and
  frame to match. A changed or stale scan therefore cannot silently authorize
  motion.
- **Live adaptive** overlays fresh occupied cells sampled from Nav2's local
  costmap on the current SLAM map, along with the live robot pose. Nav2's
  existing `NavigateThroughPoses` controller remains the only motion path and
  performs local obstacle avoidance; the app does not publish velocity
  commands or create a second planner/controller. This mode stays disabled
  unless the local costmap is fresh and
  `G1_NAV_LIVE_AVOIDANCE_ENABLED=1` is explicitly set after the local obstacle
  layer, controller behavior, and robot stop response have been commissioned
  together on the target robot. The flag is an operator commissioning
  attestation, not an automatic proof of collision avoidance.

Waypoints stay fixed in map-frame coordinates when map versions or costmaps
update. They are cleared only when the map ID or coordinate frame changes.
Goals that become blocked or unknown remain visible and are highlighted, but
the backend rejects them before planning or motion. The local costmap topic
may need an override for the deployed Nav2 namespace. These planner views are
separate from the approved shared student overlay: students continue to see
only the centrally published map controlled by the teacher setting.

For live-adaptive mode, configure the actual Nav2 local-costmap topic and keep
`G1_NAV_LIVE_AVOIDANCE_ENABLED` unset/`0` until the local obstacle layer and
Nav2 controller have been verified on hardware. The gateway transforms fresh
occupied local-costmap cells into the configured map frame for visualization
and rejects adaptive route requests when that data is missing or stale. A
live overlay is diagnostic context only; it is not an independent emergency
stop system or proof that Nav2 is avoiding obstacles correctly.

The classroom API exposes the workflow as:

| Route | Access | Purpose |
| --- | --- | --- |
| `POST /api/lidar/scan` | Teacher | Start a supervised 360° scan with `{"confirm_rotation":true}`. |
| `GET /api/lidar/scan/{job_id}` | Teacher | Read rotation progress, measured yaw, and bounded point preview. |
| `POST /api/lidar/scan/{job_id}/complete` | Teacher | Validate the 3D cloud against the current metric map and persist the scan. |
| `POST /api/lidar/scan/{job_id}/cancel` | Teacher | Discard an active scan. |
| `POST /api/lidar/map/publish` | Teacher | Publish a completed scan (`{"job_id":"…"}`) as the shared map. |
| `GET /api/lidar/map` | Authenticated | Retrieve the published map/cloud for teachers, or for students when enabled. |
| `GET /api/lidar/settings` | Authenticated | Read the central overlay setting. |
| `PUT /api/lidar/settings` | Teacher | Persist `{"show_shared_overlay":true|false}` for all student clients. |
| `WS /api/lidar/live` | Authenticated | Stream navigation readiness, scan progress, and shared-map version changes. |

The gateway implements authenticated status/map, scan-capture, and Nav2 route
endpoints:

### `GET /api/v1/status`

```json
{
  "ready": true,
  "planner_ready": true,
  "localization": {
    "ready": true,
    "frame_id": "map",
    "pose": {
      "x": 1.2,
      "y": -0.4,
      "yaw_rad": 0.3
    },
    "timestamp": "2026-10-14T17:00:00Z"
  }
}
```

Localization timestamps must be timezone-aware and no more than one second
old. The backend reports navigation readiness only when the bridge, planner,
and localization are all ready and the localization pose is finite.
Freshness also checks each received PointCloud2 acquisition stamp (maximum
1.5 seconds old, at most 100 ms in the future); a newly delivered stale cloud
does not refresh readiness. Point-cloud rate is initially reported as
unmeasured until one complete five-second sample window has elapsed.

### `GET /api/v1/map/metadata`

```json
{
  "map_id": "classroom",
  "version": "v4",
  "frame_id": "map",
  "resolution_m": 0.05,
  "width": 200,
  "height": 150,
  "origin": {
    "x": -5.0,
    "y": -3.75
  },
  "updated_at": "2026-10-13T17:00:00Z"
}
```

Map and localization frames must match. Resolution is restricted to 0.005–1 m,
dimensions must be positive, and the total cell count is capped. Each distinct
`map_id` and `version` observed by the backend is recorded in its local SQLite
database and surfaced with the status response. Map content/occupancy data is
not included in the metadata response. The gateway identifies map versions
from map metadata and occupancy contents.

### `GET /api/v1/map`

This authenticated read-only endpoint returns the same metadata fields plus a
row-major `data` array using ROS occupancy-grid values (`-1` unknown, `0` free,
`100` occupied):

```json
{
  "map_id": "classroom",
  "version": "v4",
  "frame_id": "map",
  "resolution_m": 0.05,
  "width": 2,
  "height": 2,
  "origin": {
    "x": -5.0,
    "y": -3.75,
    "yaw_rad": 0.0
  },
  "updated_at": "2026-10-13T17:00:00Z",
  "data": [0, 100, -1, 50]
}
```

Occupancy data length must equal `width × height`; values must be integers
between -1 and 100. The app limits read-only map previews to 250,000 cells.
Occupied cells at 65% or above are shown on the map. Teachers can add ordered
destination goals by clicking the map. The map origin/yaw transform converts
those clicks into the map frame; the app and gateway both reject targets
outside the map, unknown, or occupied. **Preview route • no motion** calls
the planner's `ComputePathThroughPoses` action and displays the returned
map-frame path; it does not send a movement action or velocity command. The
preview is invalidated if the map or selected goals change. Starting
navigation requires a current successful preview and an explicit teacher
confirmation, then executes through `NavigateThroughPoses`. The gateway caps
a route at 20 goals and accepts it only when the submitted map ID, version,
and frame match the current map.

Route preview and execution both fail closed when localization, the occupancy
map, or the MID-360 point-cloud stream is stale. The application cannot
electronically verify an independent hardware emergency stop unless the
deployed robot integration provides a verified E-stop state; keep the
physical stop reachable and prove it works during commissioning.

The teacher must explicitly confirm **Start Nav2**. The backend records the
operation and blocks this app's Unitree SDK connect/run/queue paths until Nav2
reports a terminal result. **Request stop** cancels the Nav2 action; the UI
continues to report cancellation pending until Nav2 reports the terminal
canceled state. If gateway status is lost or uncertain, the backend retains
the motion lock (fail closed). This software status is not a substitute for an
independent physical emergency stop.

## Three teacher-selected path planner modes

The IDE path planner selector is teacher-controlled and centrally persisted.
The normal mode compiles relative simulator waypoints into validated SDK
commands and remains open-loop.

Sensor-corrected mode displays that initial SDK plan, then offers a separate
checkpointed SDK run. The backend obtains a fresh localization pose before
each waypoint move and after each move, uses the SDK to move toward the
waypoint, and allows one SDK correction when the measured error exceeds 0.25 m.
This route is available only after `G1_SDK_CHECKPOINTED_PLANNER_ENABLED=1`
and `G1_SDK_CHECKPOINTED_PLANNER_OWNER_CONFIRMED=1` are explicitly set after
supervised commissioning. A checkpoint that is stale, unhealthy, in a
different frame, or still out of tolerance stops the run; it does not yield a
successful corrected path. The corrected variant is the list of SDK commands
actually submitted during that run, not proof of exact physical waypoint
attainment.

Autonomous mode requires Live adaptive Nav2 and commissioned local obstacle
avoidance. The gateway records bounded map-frame localization feedback while
the route executes. After a successful terminal Nav2 result, the app converts
that observed path into editable SDK commands for Blocks and IDE. This is a
best-effort replay approximation, not Nav2's original controller output and
not a safety-certified replay. If the feedback is missing, truncated, or in a
different frame, no editable final path is generated.

Both sensor-assisted modes retain an explicit **Save path project** action.
Saved projects include the waypoint display, mode, initial/corrected/final
variants, and editor code and are scoped to the saving user's account. They
are not automatically distributed to other accounts. Students can open their
own saved path projects; teachers can open their own and classroom projects.

A ready status or accepted goal does not prove safe physical operation.
Commission the correct map/base transforms, controller ownership, SDK/Nav2
handoff, cancellation, communication-loss response, localization tolerances,
and physical emergency stop in a controlled, supervised area before enabling
physical execution. The `unitree_g1_bridge_navigation` repository supplies
the `/cmd_vel` to G1 bridge, not Nav2 or route actions; the gateway relies on
a separately installed Nav2 action server.

### Teacher review and physical approval

Physical run endpoints remain teacher-role protected. Students may submit
their exact Blocks/IDE program or a planner request to the classroom queue.
Planner requests preserve the selected mode, grid waypoints, route variants,
and (for autonomous paths) Nav2 goals and map identity. The teacher queue
shows the command and route preview and can load a request into the teacher's
IDE or planner grid. Loading is review-only and never starts motion. The
teacher must explicitly approve execution; stale or mismatched map versions
must be reloaded and previewed before Nav2 execution.
