# Teacher Guide

This is a simple classroom workflow for one robot and many students.

## 1. First-time setup
Before class:
1. Make sure the robot or host computer is connected to the same Wi-Fi as the students.
2. Start the app on the teacher machine or robot host.
3. Open the browser to the host address, for example:
   - `http://<robot-ip>:5179`
   - or `http://localhost:5173` for local development

## 2. Log in as teacher
Use the default teacher login:
- username: `teacher`
- password: `teacher`

This is the main account for classroom management.

## 3. Manage student accounts
Open the teacher **Open queue** panel and use **Manage classroom accounts** to create a student login:
- usernames are 3–32 characters and may contain letters, numbers, `_` or `-`
- initial passwords must be 8–128 characters and cannot be only whitespace
- students may register their own student accounts; public registration cannot create teacher accounts. Teachers can create student or teacher accounts and remove classroom accounts from the Open queue panel.

Use **Delete** beside an account to remove it. The currently signed-in teacher cannot delete their own account, and the last teacher account is protected. A running classroom job or active robot operation associated with the account must finish before deletion. Deletion permanently removes that user's saved programs, projects, submissions, and account-owned navigation/scan records; their login sessions are revoked. The shared classroom map is retained, with its publisher label changed to `deleted account`.

## 4. Check the classroom
The teacher view lets you:
- see student submissions
- inspect the exact queued SDK/DUET code preview and planner mode, waypoint, and map details
- load a submitted program into the teacher IDE or planner grid for review
- create and remove classroom accounts
- delete queue items
- pause or stop the current robot run
- clear the queue

## 5. Review student work
For each student submission:
1. Open **Review exact command preview** and inspect the submitted code and, for planner requests, the mode, waypoints, route variants, and map identity.
2. Use **Load for teacher review** to repopulate the IDE or planner grid. Autonomous requests are only shown on a map with the matching map ID, version, and frame.
3. Look for problems and use the simulator preview when appropriate.
4. Approve physical execution explicitly. The IDE/Blocks run prompt displays the exact program; planner run prompts show the route or initial SDK commands. Students cannot call physical execution endpoints.

## 6. Start the robot queue
When the robot is ready:
- review the exact preview for the next queued request
- click **Run next** and confirm the teacher-approval prompt to authorize that specific displayed program
- watch the simulation first if needed
- run the student code only when safe

## DUET v2 supervised commissioning

DUET v2 commissioning is a separate teacher-only workflow and never uses the legacy SDK executor. Do not run it unless a qualified operator has prepared the exact G1 EDU 23-DOF robot, the deployed policy, a clear work area, and a reachable emergency stop. Hardware acceptance has not been performed by this workspace.

On the robot host, build the modified DUET controller. Teacher-confirmed **Connect** may start it in a no-command Handoff state when no Legacy SDK program is active. An idle SDK client may remain initialized, but legacy motion commands are blocked while the DUET service is active. If DUET is already in Velocity, **Connect** acquires the app lease without changing the FSM. Connect does not otherwise change the FSM or implement a physical ownership handoff. If the robot is already in Velocity, leave it there; do not send it through FixStand. The gateway-unavailable status does not establish the robot's actual FSM or posture. A qualified onsite operator must verify the controller and robot state and use the configured FixStand → Velocity controls only if that verified state and the model-specific procedure require the transition. If the state cannot be verified, do not guess or issue a mode transition. For the backend commissioning controls, set `DUET_PHYSICAL_ENABLED=true`, `DUET_COMMISSIONING_ENABLED=true`, the matching private `DUET_CONTROL_DIR`, the exact policy hash in `DUET_EXPECTED_POLICY_ID`, and the configured robot label in `DUET_ROBOT_ID`. The controller requires `DUET_GATEWAY_ENABLED=true`. Do not set `DUET_HARDWARE_ACCEPTANCE_ID` as part of commissioning.

In the DUET V2 connection panel, use **Start full test sequence**. Review the expected result before each bounded step, including the `duet.stop()` program command and the separate direct controller STOP/reset test. You may use **Run again** while a result is awaiting review; this creates another logged attempt without discarding the prior attempt. Record what actually occurred, then select **Next** only when the physical result and measured feedback are acceptable. Fail or abort immediately on unexpected behavior. At the end, use **Copy evidence** to preserve the full report and append-only event log.

A passed software commissioning report is not supervised hardware acceptance and does not unlock normal DUET runs. Only after a qualified operator separately records acceptance on the exact G1 and deployed policy may `DUET_HARDWARE_ACCEPTANCE_ID` be configured to the report ID. Keep physical motion disabled if any acceptance item is outstanding. A STOP acknowledgement does not prove physical immobility; stop the DUET controller process before using the legacy SDK.

## Record and export a measured robot motion

Teachers can open **Settings → Record a real robot motion** with either controller selected:

- **DUET v2** requires a ready controller that advertises arm feedback. Enter an approved arm-only DUET command; the recorder stores the ten measured arm joints.
- **Legacy SDK** requires the SDK connection and fresh ROS `/joint_states` telemetry from the installed read-only G1 state bridge. The recorder stores all 23 measured joint positions. SDK status alone is not proof that telemetry is available.

Enter a unique name, review the command, confirm the robot workspace is clear, keep the emergency stop accessible, and select **Run & record on robot**. The app runs the command on the physical robot while sampling positions. Only arm actions/static poses and waits are accepted for legacy capture. DUET commands are restricted to approved arm-only operations. Captures are limited to 30 seconds and 601 samples. Use **Stop robot** if needed; a capture or feedback error does not automatically stop the active command, and a stop acknowledgement does not prove physical immobility.

Saved recordings are teacher-owned and can be previewed on the 23-DOF simulator. DUET recordings animate the ten measured arm joints with the other joints neutral; legacy recordings animate the full 23-joint trajectory. **Export JSON** downloads one recording and **Export all JSON** downloads the teacher's complete recording set. The versioned JSON includes the robot model, controller, original command, named joint order, radians, capture time, and timestamped samples. Keep this export and provide it when requesting a permanent simulator trajectory; exporting does not itself alter the simulator's built-in motions.

These are position recordings, not safety certification or confirmation that the robot physically followed the expected command. Legacy capture requires the sensor/ROS runtime to be configured and live; hardware capture and command-to-trajectory correspondence still require operator-supervised validation.

## DUET prompt and vision motion

When DUET v2 is selected, **Prompt to Motion** and **Vision to Motion** both offer two modes:

- **DUET library** compiles prompts or observed poses into approved DUET commands and presets only. Unsupported requests are reported instead of being translated into arbitrary joint targets.
- **Follow and save** creates a bounded command series. Vision currently maps visible arm poses and waves to approved arm commands; it does not infer base movement or reproduce human joint angles. Vision retargeting is approximate.

Vision processing runs in the browser. The MediaPipe Tasks Vision runtime is licensed under Apache-2.0 and is fetched from jsDelivr; the Pose Landmarker Lite model is fetched from Google's MediaPipe model storage. The browser needs network access to those asset hosts. Camera and uploaded-video frames are not sent to Uni-EDU-Studio or saved by this feature.

Review the generated program before running it. Teacher-submitted classroom requests use the regular review queue; only a successfully completed DUET run enables the option to confirm physical review and save a reusable teacher-owned command. The backend validates saved command code, and saved commands appear as a single `duet.saved_motion(...)` call in Blockly and the IDE. Saving does not bypass teacher authorization, controller readiness, hardware acceptance, or the DUET gateway.

## 7. Keep the robot safe
Use these classroom rules:
- only one robot run at a time
- keep the robot area clear
- test commands in simulation before live run
- use simple commands for younger students
- stop immediately if the robot does not behave normally

## 8. Best practice for beginner classes
Good beginner commands:
- Walk Forward
- Walk Backward
- Turn Left
- Turn Right
- Wait
- Stop
- Raise Both Arms

Use simple challenge tasks such as:
- walk to a target
- turn and walk around an obstacle
- follow a path with only a few commands

## 9. Student workflow summary
Students:
- log in
- use an account created by the teacher
- build code in Blocks or IDE
- preview the program
- submit to the queue
- wait for teacher approval

Students can also send Normal path, Sensor-corrected path, or Autonomous
obstacle-aware path requests. These include the generated command preview and
the route details needed for a teacher to load the request into their own
planner workspace. Loading a request does not execute it; a teacher must
review and explicitly approve any physical run.

Teacher:
- review queue
- start approved work
- stop or pause when needed
- keep the class organized

This keeps the robot safe and still allows multiple students to work from different devices.
