# LiDAR navigation gateway and execution contract

The Path Planner can submit ordered map-frame goals to a separate ROS 2 Humble
Nav2 gateway. Nav2 owns route planning and publishes its controller output to
the `/cmd_vel` input of the separately installed Unitree G1 bridge. The browser
does not publish ROS messages or velocity commands. This is a software
integration path; it has not been commissioned or physically tested on a G1.

## Backend configuration

Configure the backend service with:

```text
G1_NAV_BRIDGE_URL=https://<trusted-navigation-host>/g1-navigation
G1_NAV_BRIDGE_TOKEN=<strong random gateway token>
G1_NAV_EXECUTION_ENABLED=1
```

HTTP is accepted only for a loopback bridge. Use HTTPS for any remote bridge.
The same token is configured as `G1_NAV_GATEWAY_TOKEN` on the navigation host.
The token stays on the application backend and is sent as a bearer token. The
browser uses only teacher-authenticated application API routes and never
connects directly to ROS or receives the bridge token. `G1_NAV_EXECUTION_ENABLED`
defaults off; enable it only after commissioning the gateway and Nav2 deployment.

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
- the specified Unitree `/cmd_vel` bridge connected to the robot.

The gateway listens on `127.0.0.1:8282` by default. For a separate app server,
expose it only behind a trusted network and TLS reverse proxy, then set the
backend URL to that proxy's HTTPS URL. Set `G1_NAV_GATEWAY_TOKEN` to a
cryptographically strong secret (at least 24 characters). Optional gateway
environment variables are `G1_NAV_GATEWAY_HOST`, `G1_NAV_GATEWAY_PORT`,
`G1_NAV_ACTION_NAME`, `G1_NAV_PLAN_ACTION_NAME`, `G1_NAV_PLANNER_ID`,
`G1_NAV_PLAN_TIMEOUT_SECONDS`, `G1_NAV_SPIN_ACTION_NAME`,
`G1_NAV_SCAN_ROTATION_TIMEOUT_SECONDS` (30–300 seconds, default 180),
`G1_NAV_MAP_TOPIC`, `G1_NAV_POINTCLOUD_TOPIC`, `G1_NAV_MAP_FRAME`,
`G1_NAV_BASE_FRAME`, `G1_NAV_MAP_ID`, and `G1_NAV_OCCUPIED_THRESHOLD`.
The ROS host also needs the Python ROS packages used by the gateway:
`rclpy`, `nav2_msgs`, `nav_msgs`, `geometry_msgs`, `action_msgs`, `tf2_ros`,
`sensor_msgs`, and `sensor_msgs_py`.

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

The teacher's planner refreshes its loaded occupancy map when the live map
version changes and reconnects its live status stream after a dropped
connection. Destinations are retained only while they remain inside known
free cells; they are cleared when map geometry changes and removed when their
cells become occupied or unknown. This live planner preview is separate from
the approved shared student overlay: students continue to see only the
centrally published map controlled by the teacher setting.

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

## Current boundary

The existing **Compile** button still creates timed SDK commands from simulator
waypoints; it is not map-based navigation. Use the separate map goals and
**Start Nav2** path for ROS navigation. A ready status or accepted goal does
not prove safe physical operation. Before enabling execution on a real robot,
commission the correct map/base transforms, Nav2 behavior, controller
ownership, cancellation, communication-loss response, and physical emergency
stop in a controlled, supervised area. The `unitree_g1_bridge_navigation`
repository supplies the `/cmd_vel` to G1 bridge, not Nav2 or route actions;
the gateway relies on a separately installed Nav2 action server.
