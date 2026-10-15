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
`G1_NAV_ACTION_NAME`, `G1_NAV_MAP_TOPIC`, `G1_NAV_POINTCLOUD_TOPIC`, `G1_NAV_MAP_FRAME`,
`G1_NAV_BASE_FRAME`, `G1_NAV_MAP_ID`, and
`G1_NAV_OCCUPIED_THRESHOLD`.
The ROS host also needs the Python ROS packages used by the gateway:
`rclpy`, `nav2_msgs`, `nav_msgs`, `geometry_msgs`, `action_msgs`, `tf2_ros`,
`sensor_msgs`, and `sensor_msgs_py`.

This gateway is not a replacement for SLAM, Nav2, or the Unitree velocity
bridge. It does not publish `/cmd_vel`, install sensor drivers, build a 2D
occupancy map, or configure the G1 bridge. The occupancy map must come from a
commissioned mapping system; the point cloud is transformed into that map
frame, voxel-downsampled at 5 cm, and capped at 300,000 points. Scan capture
does not start robot movement. The teacher/operator must manually sweep the
sensor while SLAM publishes valid map-frame transforms. A minimum of 1,000
unique points is required to finish capture. The app stores the resulting
point cloud and matching occupancy snapshot in its classroom SQLite database
when a teacher completes and publishes the scan.

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

The app's existing SDK executor is blocked while a Nav2
operation is active, but that application lock cannot arbitrate against
independent ROS publishers, terminals, or other controllers. Ensure Nav2 is
the only active ROS locomotion publisher and do not start SDK motion from
another process during navigation.

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

In the application, teachers start a scan, manually sweep the sensor, finish
and validate it, then explicitly publish it. Publishing stores the associated
2D occupancy grid and 3D scan centrally; it does not enable the student
overlay automatically. The API is teacher-authenticated for capture and
publishing; students can read the approved shared map only while the shared
overlay setting is on.

The classroom API exposes the workflow as:

| Route | Access | Purpose |
| --- | --- | --- |
| `POST /api/lidar/scan` | Teacher | Start a non-moving scan capture. |
| `GET /api/lidar/scan/{job_id}` | Teacher | Read capture progress and the bounded point preview. |
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
outside the map, unknown, or occupied. Nav2 plans between the goals and
executes through its `NavigateThroughPoses` action. The gateway caps a route at
20 goals and accepts it only when the submitted map ID, version, and frame
match the current map.

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
