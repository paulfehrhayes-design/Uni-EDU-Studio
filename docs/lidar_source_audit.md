# LiDAR and G1 ROS upstream source audit

This is a source/documentation review, not a build, license opinion, or proof of
compatibility with a particular G1. The snapshots below were reviewed on
2026-10-20. Verify revisions, licenses, frame/topic configuration, hardware
layout, firmware, and dependencies again before deployment or copying code.
None of these sources justifies running a second locomotion publisher.

| Repository / reviewed revision | License and ROS evidence | Scope and assumptions from upstream | Decision |
| --- | --- | --- | --- |
| [unitree_g1_bridge_navigation](https://github.com/zhangyuyu2023/unitree_g1_bridge_navigation/tree/ed8a354fa13a60cdda6ad9772ba022464493a57f) (`ed8a354`) | No root `LICENSE` was visible. README describes ROS 2 Humble. | Two-computer G1 PC2 sensor / Jetson Orin AGX navigation layout; `/cmd_vel` bridge to Unitree locomotion; D435i, MID-360, Livox, and CycloneDDS dependencies. These are author-described assumptions, not verified target hardware. | **Reference only.** Do not copy/adopt without license clarification and actual hardware validation. The deployment must still select one bridge. |
| [unitree_ros2](https://github.com/unitreerobotics/unitree_ros2/tree/668d1ec5a05d1c38d3306bdca7d59f2ba3581a88) (`668d1ec`) | BSD 3-Clause. README lists Ubuntu 20.04/Foxy and Ubuntu 22.04/Humble and a `colcon` build. | Official DDS/ROS interfaces; overview and examples cover multiple Unitree robot models, so G1 deployment compatibility must be checked against the exact SDK/messages and robot image. | **Interface reference.** Reuse supported upstream packages only where needed; do not duplicate vendor interfaces or mistake this for Nav2. |
| [livox_ros_driver2](https://github.com/Livox-SDK/livox_ros_driver2/tree/21445540f0d100dc86a7e6df312dd70bbdb4afdf) (`2144554`) | MIT. ROS 2 package uses `ament_cmake`; README lists Foxy, Humble, and Jazzy. | Livox ROS driver, including MID-360, with ROS message/PCL dependencies. Upstream describes it as a debugging/test-scenario base rather than a mass-production guarantee. | **Keep as the existing driver candidate.** Verify exact ROS distro, actual topic/frame, and hardware stream; do not vendor a duplicate. |
| [unitree-g1-slam-nav](https://github.com/guruadp/unitree-g1-slam-nav/tree/b9a1fbd5459bda72a056e71eb8f9aa9a437f0228) (`b9a1fbd`) | No root `LICENSE` was visible. README describes ROS 2 Humble/Nav2. | Example G1/MID-360 workspace converts LiDAR clouds to scans, compensates a Livox clock offset, uses `slam_toolbox`, and sends Nav2 velocity through a Sport API bridge. It uses a `robot_center` frame assumption. | **Reference only.** Do not copy until license is clarified; independently verify clock, frames, and bridge behavior. Avoid running alongside another locomotion owner. |
| [humanoid_lidar_elevation_map](https://github.com/apex-humanoid/humanoid_lidar_elevation_map/tree/f8c48f8f79a924fe1387a87d194d267740ee6688) (`f8c48f8`) | Root BSD 3-Clause; bundled components may carry separate terms. Requirements describe ROS 1 Noetic/catkin. | G1/MID-360 acquisition, FAST-LIO odometry, local elevation mapping, and calibration assumptions. | **Design reference only.** Not a ROS 2 drop-in; review bundled component licenses separately. |
| [G1_lidar_navigation](https://github.com/bethalageetachandraraju/G1_lidar_navigation/tree/f81abd97cd2c0b3b0c715b243d3c969ac5360780) (`f81abd9`) | MIT. README describes ROS 1 Noetic/catkin. | `move_base`, FAST-LIO/localization, occupancy mapping, MID-360, RealSense, and an onboard G1 `/cmd_vel` bridge. | **Reject as a direct ROS 2 stack.** Reference only if intentionally evaluating a ROS 1 migration. |
| [Livox-SDK2](https://github.com/Livox-SDK/Livox-SDK2/tree/c0796f04c143143899c87a773d9f6b7136453c0b) (`c0796f0`) | MIT. No ROS distribution specified. | C/C++ Livox device API, including MID-360; Ubuntu 18.04+, C++11-capable compiler, CMake, x86/ARM listed. | **Keep as the driver's SDK dependency**, not as a ROS driver or mapping system. |
| [FAST_LIO_LOCALIZATION_HUMANOID](https://github.com/deepglint/FAST_LIO_LOCALIZATION_HUMANOID/tree/e4234d4e559548bfe0afdf407990bfb206e183c0) (`e4234d4`) | No root license was visible. The inspected default `FAST_LIO/package.xml` declares catkin/BSD while its `FAST_LIO/LICENSE` starts with GPL v2; licensing is unresolved. README mentions a Humble branch, but that branch was not reviewed. | Modified Livox/FAST-LIO localization for an upside-down G1 MID-360 and offline point-cloud map. Default branch inspected here is ROS 1-oriented. | **Defer.** Do not treat as ROS 2-compatible or copy until the exact branch and conflicting licensing are reviewed. |
| [g1_lidar](https://github.com/syakaikungg/g1_lidar/tree/a321cd7ee114904edc8056ae6f801e818dbd3109) (`a321cd7`) | No root `LICENSE` was visible. Setup describes ROS 2 Jazzy-era components. | G1-specific sensor/calibration and Livox, FAST-LIO/FAST-LIVO2, GLIM, and D435i setup examples; warns built-in and external LiDAR drivers can conflict. | **Reference only.** Defer source/config reuse pending licensing, ROS distro, and hardware checks. |
| [realsense-ros](https://github.com/realsenseai/realsense-ros/tree/7a87097c499e3b0b69518d54a8e7a9ac1924e87c) (`7a87097`) | Apache 2.0; README lists ROS 2 Humble among supported distributions. | ROS wrapper for RealSense cameras, not a mapping/navigation stack. | **Defer.** Optional D435i depth fusion only after LiDAR-only mapping is reliable and the selected camera/distro is verified. |

## Integration consequences

- The workspace already builds/installs `Livox-SDK2` and `livox_ros_driver2`;
  keep that single sensor-driver path.
- This audit does not select or install a SLAM/Nav2 stack or a G1 locomotion
  bridge. Those remain deployment choices requiring ROS-distro, license,
  hardware-layout, and commissioning review.
- The navigation gateway reports controller ownership only as a deployment
  assertion. The owner must verify there is exactly one active locomotion
  path, with no competing SDK/ROS publisher, before setting
  `G1_NAV_CONTROLLER_OWNERSHIP_CONFIRMED=1`.
- No repository in this table was built, tested against the target robot, or
  used to infer calibration values.

## Evidence links

- Bridge architecture and hardware assumptions: [README, reviewed revision](https://github.com/zhangyuyu2023/unitree_g1_bridge_navigation/blob/ed8a354fa13a60cdda6ad9772ba022464493a57f/README.md)
- Official ROS interfaces and license: [README](https://github.com/unitreerobotics/unitree_ros2/blob/668d1ec5a05d1c38d3306bdca7d59f2ba3581a88/README.md), [LICENSE](https://github.com/unitreerobotics/unitree_ros2/blob/668d1ec5a05d1c38d3306bdca7d59f2ba3581a88/LICENSE)
- Livox driver support/package/license: [README](https://github.com/Livox-SDK/livox_ros_driver2/blob/21445540f0d100dc86a7e6df312dd70bbdb4afdf/README.md), [ROS 2 package manifest](https://github.com/Livox-SDK/livox_ros_driver2/blob/21445540f0d100dc86a7e6df312dd70bbdb4afdf/package_ROS2.xml), [LICENSE](https://github.com/Livox-SDK/livox_ros_driver2/blob/21445540f0d100dc86a7e6df312dd70bbdb4afdf/LICENSE.txt)
- Nav2/SLAM example: [README, reviewed revision](https://github.com/guruadp/unitree-g1-slam-nav/blob/b9a1fbd5459bda72a056e71eb8f9aa9a437f0228/README.md)
- Elevation map distro/license: [README](https://github.com/apex-humanoid/humanoid_lidar_elevation_map/blob/f8c48f8f79a924fe1387a87d194d267740ee6688/README.md), [LICENSE](https://github.com/apex-humanoid/humanoid_lidar_elevation_map/blob/f8c48f8f79a924fe1387a87d194d267740ee6688/LICENSE)
- ROS 1 navigation example: [README](https://github.com/bethalageetachandraraju/G1_lidar_navigation/blob/f81abd97cd2c0b3b0c715b243d3c969ac5360780/README.md), [LICENSE](https://github.com/bethalageetachandraraju/G1_lidar_navigation/blob/f81abd97cd2c0b3b0c715b243d3c969ac5360780/LICENSE)
- Livox SDK: [README](https://github.com/Livox-SDK/Livox-SDK2/blob/c0796f04c143143899c87a773d9f6b7136453c0b/README.md), [LICENSE](https://github.com/Livox-SDK/Livox-SDK2/blob/c0796f04c143143899c87a773d9f6b7136453c0b/LICENSE.txt)
- FAST-LIO branch and license ambiguity: [README](https://github.com/deepglint/FAST_LIO_LOCALIZATION_HUMANOID/blob/e4234d4e559548bfe0afdf407990bfb206e183c0/README.md), [package manifest](https://github.com/deepglint/FAST_LIO_LOCALIZATION_HUMANOID/blob/e4234d4e559548bfe0afdf407990bfb206e183c0/FAST_LIO/package.xml), [embedded license](https://github.com/deepglint/FAST_LIO_LOCALIZATION_HUMANOID/blob/e4234d4e559548bfe0afdf407990bfb206e183c0/FAST_LIO/LICENSE)
- Alternative G1 sensor configurations: [SETUP](https://github.com/syakaikungg/g1_lidar/blob/a321cd7ee114904edc8056ae6f801e818dbd3109/SETUP.md)
- Optional RealSense wrapper: [README](https://github.com/realsenseai/realsense-ros/blob/7a87097c499e3b0b69518d54a8e7a9ac1924e87c/README.md), [LICENSE](https://github.com/realsenseai/realsense-ros/blob/7a87097c499e3b0b69518d54a8e7a9ac1924e87c/LICENSE)
