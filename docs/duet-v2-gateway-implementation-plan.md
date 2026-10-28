# DUET v2 Gateway and Hardware-Verified Commands

## Goal

Keep the existing Uni-EDU legacy SDK path intact while making DUET v2 a separate, teacher-gated controller path. The DUET controller must remain the sole writer of `rt/lowcmd`. The app must not issue physical DUET motion until a real controller-side command ingress, fail-safe behavior, and supervised acceptance on the exact G1 EDU 23-DOF robot are verified.

## Recommended architecture

Do not copy or modify the legacy SDK motion path to emulate DUET. Keep `robot.*`, its SDK connection, and legacy APIs as-is. Extend the upstream DUET deployment in a separate checkout/branch and add a narrow, local-only command ingress to the existing DUET controller. The ingress must update high-level velocity setpoints consumed by DUET's policy; it must never publish low-level joint commands or create a second `rt/lowcmd` writer.

The physical base-motion allowlist is:

- `move(vx, vy, yaw_rate, duration)` within the existing DUET preview limits and duration bounds.
- `wait(duration)` as a program-timing operation.
- `stop()` as an explicit stop request.

The original `arm_pose` protocol is limited to the named `carry`, `forward`, and `box_hold` presets and the separate `DUET_ARM_ACCEPT=1` gate. The V2 named-pose and legacy-gesture extension uses a distinct `arm_targets` capability: a bounded, catalog-validated ten-joint target and an explicit reset request. That protocol is not implemented by the gateway source present in this checkout, so the backend must reject physical arm-target programs unless a controller advertises the capability. Neither a lease nor status is feedback that the robot reached a target; simulator output is only an approximate command-space preview.

## Implementation phases

1. **Pin and extend DUET source**
   - Clone the upstream `bae-air-lab/DUET` source into a separate, clearly identified checkout or fork; preserve its license and attribution.
   - Record the exact upstream commit and deployed policy/config identity.
   - Add a controller-side velocity-command ingress that updates the policy's existing velocity command fields without changing its action space or low-level writer.
   - Add input validation, sequence/timestamp checks, stale-command timeout, explicit zero-command behavior, and gating to the expected controller state.

2. **Add the local gateway service**
   - Implement a narrow gateway in the DUET controller on the robot PC that translates same-user local IPC requests into the controller's high-level velocity observation.
   - Bind the service to a private Unix-domain socket; do not expose a new motion API on an untrusted network.
   - Report protocol version, robot model, policy/config identity, readiness, controller state, `rt/lowcmd` owner, command capabilities, active program ID, and explicit stop/disconnect outcomes.
   - Reject unsupported commands and report failures rather than returning success-shaped defaults.

3. **Wire the app and backend**
   - Replace the placeholder external-gateway assumption with the concrete local service transport and protocol.
   - Keep separate DUET connect/status/run/stop/disconnect routes and preserve the existing SDK path unchanged.
   - Enforce the same base-motion limits and catalog/workspace-bounded arm-target allowlist in the browser, backend, and controller ingress; reject arm programs before execution if the controller does not advertise the required arm capability.
   - Add an additive ownership interlock across legacy SDK routes, navigation, scans, and other physical motion entry points; fail closed if ownership cannot be verified.
   - Add controller-version metadata to queued classroom programs or explicitly disallow DUET queue execution until queue routing is version-aware; never send DUET code through the legacy SDK executor.

4. **Verify and stage hardware acceptance**
   - Add parser, route, protocol, ownership, stale-command, stop, controller-loss, and legacy non-regression tests.
   - Build the DUET deployment and test the command ingress without motor execution first.
   - With the user operating the exact robot, follow a supervised checklist: confirm model/policy and FSM readiness; verify idle ownership; issue one low-speed, short-duration axis command in a clear test area; verify command timeout and zero-command confirmation; verify controller-link/process loss; test the joystick handoff on app-lease release with neutral controls; verify SDK motion is blocked while DUET owns the controller; verify ownership release before allowing legacy motion.
   - Keep physical run disabled until all acceptance checks are recorded. Simulator tests do not satisfy this gate.

## Acceptance criteria

- Legacy behavior and SDK routing remain unchanged when DUET is not active.
- DUET and legacy programs remain isolated in editors, saved projects, and classroom queues.
- No code path except the DUET controller writes `rt/lowcmd` during DUET operation.
- Browser, backend, gateway, and controller reject legacy syntax, arbitrary arm commands/joint targets, and values outside the approved velocity/time envelope; named arm presets require the separately accepted controller capability.
- Stale input, controller loss, stop failure, unknown model/policy, and unknown ownership are surfaced and fail closed.
- Physical DUET execution remains disabled until exact-robot supervised acceptance is documented.

## Detailed status updates — 2026-10-23

- **Completed:** Removed `raise_arm` and `wave` from the DUET Blocks/IDE catalog, prompt compiler, simulator, and backend parser. The physical-facing command subset is now bounded planar velocity/yaw-rate, wait, and stop only.
- **Completed:** Added rejection tests for arm gestures in both frontend and backend paths. Focused frontend tests pass (14/14); DUET backend tests pass (12/12). Frontend lint has no errors; three pre-existing `App.jsx` hook-dependency warnings remain.
- **Completed:** Rebuilt the production frontend assets so the reduced command catalog is what the backend serves.
- **Completed in this workspace:** Cloned the public upstream DUET repository into a separate sibling checkout, pinned at upstream commit `439c21bd2817feedd519475e8301195b95cb6fcb`, and added a C++ Unix-domain-socket gateway to that checkout. It holds a process ownership lock, uses a private same-user socket, reports controller readiness, accepts only bounded velocity/wait/stop protocol operations, and expires velocity commands to zero.
- **Completed in this workspace:** Connected the Uni-EDU backend routes to the local socket protocol; physical motion remains gated by explicit backend configuration. The classroom queue now records controller version and refuses to send DUET queue entries to the legacy SDK executor. The legacy controller implementation and connection setup were not changed.
- **Verified without robot motion:** The gateway C++ source compiles standalone with `-Wall -Wextra -Werror`; a socket-level C++ test covers status, lease acquisition/release, bounded input, velocity expiry, stop, and fail-closed connection status. DUET backend unit tests, frontend build/lint, and diff checks pass. The full controller CMake configure was attempted but is blocked here because Boost headers and `program_options` are not installed.
- **Not installed/validated:** The modified controller checkout is separate and is not bundled or installed on the G1 host. Supervised hardware acceptance has not been performed. The controller's policy ID is currently environment-supplied rather than verified against the ONNX actually loaded. The connection monitor uses the controller's existing low-state timeout; it does not independently prove `rt/lowcmd` publisher exclusivity.
- **Physical gate:** Keep `DUET_PHYSICAL_ENABLED` unset until the controller gateway is installed and the exact robot/policy acceptance checklist is completed. The Settings warning must remain while installation and hardware validation are outstanding. Stop confirms an inactive velocity command, not physical immobility. Releasing the app lease may return velocity input to the joystick; the DUET process must be stopped before legacy SDK motion is allowed.
- **Remaining:** Install the gateway on the robot with the backend sharing the same local user and `DUET_CONTROL_DIR`, bind the reported policy identity to the actual deployed model, complete the full controller build, then perform the supervised hardware acceptance checklist.

## Latest status — Named DUET arm-pose commands

- **Implemented in Uni-EDU:** DUET Blocks, the IDE command catalog, and quick actions expose only the fixed `carry`, `forward`, and `box_hold` arm presets. The parser accepts a 1–3 second lease (1.5-second UI default); arbitrary joint values, wave/raise gestures, and other pose names are rejected. The DUET simulator previews the named poses using the project G1 23-DOF model.
- **Implemented in the separate DUET controller checkout:** `ARM_POSE <preset> <duration_ms>` is accepted only for those three names and bounded by the gateway. `DUET_ARM_ACCEPT=1` is a separate controller-process gate; when it is absent, the capability is not advertised and arm requests are rejected. Stop clears the arm lease and requests a return to carry/default. Existing `rt/arm_targets` data retains priority.
- **Backend/UI safety behavior:** Arm programs are rejected before execution unless the connected controller advertises `arm_pose`; the app makes the unavailable preview-only state explicit. Stop/disconnect messaging reports lease clearing and return-to-default request without claiming physical immobility or pose attainment.
- **Still unverified:** The controller gateway is not installed on the robot, a complete controller build has not passed in this environment, and no supervised physical arm or base-motion acceptance has been completed. Keep both `DUET_PHYSICAL_ENABLED` and `DUET_ARM_ACCEPT` unset until their respective supervised acceptance gates are complete. The controller-supplied policy ID is not independently verified against the loaded ONNX.
- **Verification completed for this update:** 18 focused frontend tests passed; 22 DUET backend and route tests passed; the standalone controller socket/gate C++ test passed; frontend production build and lint completed. Lint reports four existing hook-dependency warnings, and the build reports existing externalization/chunk-size/browser-data warnings. No physical movement was attempted.

## Latest status — Fixed arm sequences and mode-toggle recovery — 2026-10-23

- **Added more arm motions without new joint targets:** DUET now has `reach_and_return`, `receive_and_hold`, `hold_and_return`, and `receive_hold_return` macros. The frontend simulator previews them; the backend expands them into bounded `ARM_POSE` calls for the existing `forward`, `box_hold`, and `carry` presets only. This adds sequences, not new hardware-validated poses; all physical arm execution remains gated.
- **Token-expiry mode toggle:** Switching back to Legacy no longer gets blocked by a 401 while querying DUET status. It selects Legacy preview locally and clearly requires sign-in again before status checks or physical commands. The backend ownership interlock remains in force, so this does not bypass the motion-safety checks.
- **Full controller build remains blocked:** The controller CMake project requires Boost/program_options, yaml-cpp, fmt, Eigen, DDS C/C++, iceoryx headers/libraries, and Unitree SDK2. The required Boost headers/program_options are missing, and required SDK/DDS libraries and include directories are unavailable here. The controller was not fully built; installing only the first missing package would not complete the target build.
- **Hardware acceptance remains outstanding:** This environment has no supervised access to the exact G1 EDU and deployed policy, and the gateway is not installed there. Do not set `DUET_PHYSICAL_ENABLED` or `DUET_ARM_ACCEPT`; physical base and arm acceptance must be completed by a qualified operator on the target robot.
- **Checks for these updates:** 20 focused frontend tests and 23 DUET backend/route tests pass; the standalone controller gateway protocol test passes. Frontend lint/build and `git diff --check` pass with only the existing hook-dependency and bundler warnings. No robot motion was attempted.
- **Requested capabilities intentionally not added:** Audio remains on the separate legacy Unitree audio client; invoking it from DUET would require a designed and reviewed non-motion service boundary rather than routing DUET through the legacy robot connection. Distance conditions and condition-driven `while` loops are not added to DUET yet. The app has a calibrated sensor provider for the legacy runtime, but reusing it in DUET needs structured conditional parsing in both IDE and Blocks, bounded loop semantics, stale-sample abort/stop behavior, simulation behavior, and physical-path validation. Existing DUET repeat loops remain statically bounded `for _ in range(n)` loops.
- **Physical gate request:** The user asked for the physical gate to be opened to test on a robot. It remains closed: this environment cannot perform a full controller build or supervised tests on the exact robot and deployed policy. Enabling it without those acceptance results would remove the required safeguard rather than complete validation.

## Latest status — Full controller build — 2026-10-23

- **Completed:** Installed the missing host development headers and resolved the SDK2 include/library paths. Updated the separate DUET checkout's G1 controller CMake configuration to discover Unitree SDK2, bundled Cyclone DDS, and host iceoryx paths from `UNITREE_SDK_ROOT`, replacing the previous hard-coded DDS/iceoryx include paths.
- **Verified:** Configured and built the complete `g1_ctrl` target successfully, including the modified controller FSM and gateway sources. The build used the checked-out x86_64 Unitree SDK2 at `/tmp/unitree_sdk2-checkout`; the resulting binary links when the SDK's DDS library directory is included in the runtime library path. This was compile/link verification only; the executable was not started.
- **Verified separately:** The controller gateway protocol test source covers bounded base leases, arm acceptance gating, named-pose validation, lease expiry, stop/release, and disconnected-controller behavior. It does not connect to the SDK or send robot commands.
- **Remaining:** The built binary/gateway is not installed on the G1. No supervised acceptance has been performed on the exact robot and policy, and the reported policy ID is still not independently bound to the ONNX actually loaded.
- **Physical gates:** `DUET_PHYSICAL_ENABLED` and `DUET_ARM_ACCEPT` remain unset. The successful desktop build does not enable physical base or arm execution and is not hardware acceptance. Both gates must remain closed until the corresponding supervised acceptance is completed.

## Latest status — Onboard build and command scope — 2026-10-23

- **Added:** The separate DUET checkout now includes `deploy/robots/g1_23dof/build_controller.sh`, a native build helper that accepts `UNITREE_SDK_ROOT`, builds serially by default, and produces `g1_ctrl` without starting it. It avoids an active Conda package prefix when selecting system C++ dependencies, preventing the fmt/spdlog header mismatch found on this workstation.
- **Verified:** The helper configured and built the complete controller successfully using the checked-out x86_64 SDK2. The standalone gateway protocol test passed, and both worktrees pass `git diff --check`.
- **Current complete command set:** Custom bounded planar velocity; forward/backward, lateral, turn, and arc presets; `wait`; static bounded `for` loops; `stop`; three named arm poses; and four macros composed only from those three poses. The Blocks and IDE catalog exposes this implemented set. SDK2 being linked does not automatically make other SDK2 APIs or robot motions available through DUET.
- **Not added:** Direct pelvis-height control, arbitrary joint-angle input, additional arm targets, audio, distance-triggered conditions, or `while` loops. The gateway does not currently route height commands, and no additional arm trajectories have been independently validated for this robot/policy. These should not be presented as test-ready physical commands merely because SDK2 is available.
- **Deployment requirements:** Build on the robot computer for its native architecture, keep the DUET policy/config assets with the checkout, provide the SDK DDS runtime library path, and run the app backend on the same host and local user as the controller gateway. The build helper does not install or start the controller.
- **Physical status unchanged:** `DUET_PHYSICAL_ENABLED` and `DUET_ARM_ACCEPT` remain unset. The robot-side test still requires supervised acceptance of the exact installed controller and policy; this workstation build is not that acceptance.

## Latest status — Concurrent base and arm command preview

- **Program and repeat bounds:** DUET v2 and legacy v1 have no aggregate program-duration cap. Both allow up to 20 repetitions per loop and cap expanded programs at 400 commands (v1 counts the maximum execution path); each individual command's duration remains bounded.
- **Added in Uni-EDU:** `duet.move_and_arm(vx, vy, yaw_rate, move_seconds, pose, arm_seconds)` is available to the DUET Blocks/IDE parser and simulator. It accepts only bounded base velocity and an existing named arm pose; the arm lease must outlast the base movement by at least 0.25 seconds. The simulator previews both command streams over the same timeline.
- **Blocks/IDE behavior:** The paired action is shown under **Concurrent actions** and is also available from the DUET IDE command catalog. All other commands remain sequential. Place the paired action inside the existing bounded repeat/`for _ in range(n)` block to repeat concurrent pairs; each iteration completes both leases before the next command begins. There is no unbounded `while` loop.
- **Backend behavior:** The runner requests the named arm-pose lease, refreshes bounded base velocity while checking that both leases remain active, then requests zero base velocity while preserving the arm lease until it ends. It fails closed with a stop request if controller readiness or either lease is lost.
- **Not hardware-verified:** This repository does not include the robot-side gateway source or deployment artifact needed to verify that `ARM_POSE` and `MOVE` remain independent simultaneously. The target gateway must preserve both leases and report arm-lease status during every `MOVE` response before this feature can be considered physically executable. Keep `DUET_PHYSICAL_ENABLED` and `DUET_ARM_ACCEPT` unset until that controller integration is built and supervised acceptance is completed on the exact robot and policy.

## Latest status — Named arm targets, mirrored gestures, and pose holds

- **V2 UI/catalog:** DUET V2 has a shared arm catalog in `src/sim/duetArmCatalog.json`, containing bounded ten-joint targets, left/right mirrors, static pose targets, and trajectories corresponding to the legacy arm-action names. Each gesture is a separate Blockly/IDE command; static poses are draggable output blocks for the shared timed-hold and until-reset commands.
- **Hold/reset behavior:** Timed holds accept 1–30 seconds and return to carry. Until-reset holds require `duet.reset_arms()` before another arm motion; the backend also requests a return to carry/default when a program completes, is stopped, or is disconnected. The simulator previews these paths but does not validate physical safety or target attainment.
- **Backend protocol and deployment gap:** DUET backend arm targets require the controller to advertise `arm_targets`; requests use `ARM_TARGETS <lease_ms> <10 joint positions in radians>` and `RESET_ARMS`. Existing gateway support for the separate `arm_pose` capability does not imply support for these new requests. The matching gateway implementation is not present in this checkout, so physical arm-target execution remains fail-closed until that controller protocol is implemented and accepted.
- **Physical gate:** Keep `DUET_PHYSICAL_ENABLED` unset until the target gateway implements the advertised arm-target contract and supervised acceptance is completed on the exact robot and policy. Catalog targets and simulator previews are not hardware acceptance.
