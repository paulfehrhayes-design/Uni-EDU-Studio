# DUET command naming audit

## Scope and compatibility rule

DUET and Legacy have separate parsers, backends, transports, and motion mappings.
Matching a method name does not make the commands interchangeable, nor does it
mean a Legacy SDK command is being used by DUET. New DUET examples use the
Legacy-aligned spelling only where it is a useful naming improvement without
changing the underlying DUET motion. Previously saved DUET source remains valid.

## Base command mapping

| DUET name (new code) | Legacy convention | Decision |
| --- | --- | --- |
| `walk(seconds)` | `robot.walk(steps)` | Canonical DUET spelling now matches Legacy. DUET remains a bounded timed velocity; the argument is seconds, **not steps**. |
| `forward(seconds)` | `robot.walk(steps)` | Kept as a source compatibility alias for `walk`; parser normalization emits `duet.walk(...)`. |
| `backward(seconds)` | `robot.backward(steps)` | Name aligned already. DUET duration and conservative velocity remain unchanged; Legacy counts steps. |
| `turn_around_180()` | `robot.turn_around_180()` | Exact spelling aligned. Both are approximate timed-yaw motions, not closed-loop heading commands. |
| `turn_left(seconds)`, `turn_right(seconds)` | `robot.turn(direction, degrees)` | Retained. Replacing the explicit timed-yaw interface with the Legacy degree argument would misstate DUET behavior. |
| `strafe_left(seconds)`, `strafe_right(seconds)` | `robot.sidestep(direction, steps)` | Retained. DUET lateral motion is timed velocity, not Legacy step-count sidestepping. |
| `arc_forward_left(seconds)`, `arc_forward_right(seconds)`, `arc_backward_left(seconds)`, `arc_backward_right(seconds)` | No direct Legacy equivalent | DUET-only bounded velocity presets. |
| `move(vx, vy, yaw_rate, seconds)` | No direct Legacy equivalent | DUET-only custom bounded velocity vector. Input bounds and timed execution are unchanged. |
| `wait(seconds)` | `robot.wait(seconds)` | Name aligned; DUET allows fractional seconds while Legacy uses whole seconds. |
| `stop()` | No direct Legacy program command | DUET controller stop. Not renamed to `stand()`: standing is not an equivalent stop request. |
| `front_distance_m()`, `rear_distance_m()` | Same sensor names in Legacy | Names retained. DUET still requires fresh calibrated distance samples and uses its backend's fail-closed sensor checks. |

The UI labels for DUET timed walking make the time unit explicit. The parser
accepts `duet.forward(...)` for older programs and exposes it through the command
lookup as the canonical `walk` definition. New toolbox blocks, generated examples,
and prompt-generated walking code use `duet.walk(...)`.

Legacy names without same-name DUET commands include `stand`, `walktime`,
`backwardtime`, `sidestep`, `slowwalk`/`slowwalktime`,
`fastwalk`/`fastwalktime`, and the posture transitions `squat_to_stand`,
`lie_to_stand`, and `stand_to_squat`. DUET's `walk`/`backward` are timed
conservative motions and `strafe_left`/`strafe_right` are timed lateral motions,
but no Legacy speed-mode or step/FSM semantics were copied into those commands.
Likewise, Legacy audio (`say`, `getvolume`, `setvolume`, `led`, `playstop`),
diagnostics (`getfsm`, `getactions`), and arm-action calls do not imply DUET
gateway support.

## Arm and gesture audit

DUET arm commands use catalogued pose targets and trajectories through the DUET
gateway. Legacy `robot.arm_action("...")` and `robot.hold_arm("...", seconds)`
invoke Unitree arm-action IDs. They are different mappings and are not aliases.
Legacy simulator-only helpers such as `waveleftDegrees`, `raisebotharms`, and
`simulate_arm_action` are not treated as physical DUET capabilities.

| DUET names | Legacy comparison | Decision |
| --- | --- | --- |
| `arm_carry`, `arm_reach`, `arm_box_hold` | No equivalent fixed-pose target interface | Retain DUET-specific names and catalog mappings. |
| `hold_pose(pose, seconds)`, `hold_pose_until_reset(pose)`, `reset_arms()` | No equivalent named-pose lifecycle | Retain. Duration bounds, required reset flow, and backend completion/stop cleanup are unchanged. |
| `reach_and_return`, `receive_and_hold`, `hold_and_return`, `receive_hold_return` | No equivalent DUET target trajectory | Retain snake_case names and fixed trajectories; when a trajectory ends raised, hold that final target for 20 seconds, then return to carry. |
| `wave_left_{low,mid,high}`, `wave_right_{low,mid,high}` | Legacy wave blocks are simulator-only | Retain. These are DUET catalog trajectories, not Legacy gestures; hold a raised final target for 20 seconds before returning to carry. |
| `raise_left_arm_{low,mid,high}`, `raise_right_arm_{low,mid,high}`, `raise_both_arms_{low,mid,high}` | Legacy raise-arm blocks are simulator-only | Retain. These are DUET catalog trajectories; hold a raised final target for 20 seconds before returning to carry. |
| `gesture_kiss_{both,left,right}`, `gesture_hands_up`, `gesture_clap`, `gesture_high_five_{left,right}`, `gesture_hug`, `gesture_heart_{both,left,right}`, `gesture_reject_{left,right}`, `gesture_hand_up_{left,right}`, `gesture_xray`, `gesture_face_wave_{left,right}`, `gesture_high_wave_{left,right}`, `gesture_shake_hand_{left,right}` | Similar labels exist among Legacy vendor arm-action presets, but target and execution mappings differ | Retain the explicit `gesture_` prefix and snake_case. Do not silently substitute Legacy action IDs; hold a raised final target for 20 seconds before returning to carry. |

The parser also supports older/text-oriented DUET shorthands (`arm_pose`,
`arm_motion`, `wave_left(level, seconds)`, `wave_right(level, seconds)`, and
`raise_*_arm(s)(level, seconds)`); these resolve only to the same fixed DUET
catalog commands. `move_and_arm(...)` is the bounded text form for a concurrent
move and named DUET arm pose. The toolbox's explicit concurrent container remains
the preferred visible form.

Legacy simulator-only arm previews, including the irregular `waveleft`,
`waveleftDegrees`, `waveright`, `waverightDegrees`, `raise*`, `kick*`, `knee*`,
and `simulate_arm_action` names, were not copied as DUET physical commands. The
DUET replacements remain the validated fixed catalog trajectories listed above.

## DUET-only language and approval path

`saved_motion(...)`, `with duet.concurrent():`, bounded `for/range` loops, and
sensor conditions are DUET-specific program features. They are not renamed to
Legacy APIs. They continue to pass through DUET parsing, validation, authorization,
and its own controller gateway. Naming changes do not bypass classroom approval,
teacher authorization, an explicit operator run action, or stop handling.

The code audit does not establish hardware support by itself. Physical DUET
execution still depends on the configured supported gateway and its commissioned
capabilities. No hardware motion is run by the automated tests.
