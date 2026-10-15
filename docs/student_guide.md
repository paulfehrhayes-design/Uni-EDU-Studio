# Student Guide

This is the easiest way to use the robot coding app.

## 1. Log in
- Open the app in your browser.
- Use a student account such as:
  - username: `student1`
  - password: `student1`
- If your teacher made a different account, use that instead.

## 2. Choose a tab
You will see tabs like:
- Blocks
- Camera Motion Tracker
- IDE

For beginners, start with `Blocks`.

## 3. Build a simple program
Try these steps:
1. Drag a `Walk Forward` block.
2. Add a `Turn` or `Sidestep` block.
3. Add another `Walk Forward` block.
4. Click `Run` in the preview or ask your teacher to run it.

Simple commands are best for learning:
- Stand / ready (selects normal locomotion-ready mode; it is not the squat-to-stand recovery action)
- Squat to stand, lie to stand, and stand to squat
- Walk forward or backward
- Sidestep left or right
- Turn left or right
- Slow or fast walk

## 4. Use the IDE if you prefer typing
The IDE reference and Blocks toolbox show the commands currently mapped by the G1 SDK adapter. Example:

```python
robot.stand()
robot.wait(2)
robot.squat_to_stand()
robot.lie_to_stand()
robot.stand_to_squat()
robot.walk(3)
robot.turn("left", 90)
robot.backwardtime(1)
```

Programs can also use bounded `for` loops. The legacy G1 arm presets are available with `robot.arm_action("hands up")` and the other names listed below. Each preset automatically runs `robot.arm_action("release arm")` afterward (unless a release command already follows) so the next gesture starts from the relaxed arm pose. Simulation shows approximate poses, not the SDK trajectories. The physical SDK reports whether it accepted a preset request, not when the motion finishes. The teacher's `Stop robot` button stops locomotion but cannot cancel an accepted arm preset, so keep the robot area clear and use direct teacher supervision.

Distance conditions can choose which supported commands run:

```python
if robot.front_distance_m() < 1:
    robot.walk(1)
else:
    robot.turn("left", 90)
```

`front_distance_m()` and `rear_distance_m()` read the closest valid obstacle in the forward or rear MID-360 sector. The simulator uses the closest scene obstacle in the selected sector; the physical backend obtains readings from the configured, read-only ROS 2 sensor provider. Physical readings must be valid, match the configured sensor and frame, and be no older than 500 ms. If the selected provider is unavailable or its reading is invalid or stale, the backend aborts the program and requests a locomotion stop; it does not silently run the `else` branch. Rear checks assume the sensor frame's x-axis is aligned with the robot's forward direction and require valid LiDAR returns behind the robot. A teacher should use **Test LiDAR** to check both sectors before running a physical conditional program.

Use `rear_distance_m()` to base a branch on obstacles behind the robot:

```python
if robot.rear_distance_m() < 1:
    robot.stand()
else:
    robot.backward(1)
```

The backend provider uses `G1_DISTANCE_PROVIDER_URL` for the forward sector and `G1_DISTANCE_REAR_PROVIDER_URL` for the rear sector, with shared `G1_DISTANCE_PROVIDER_TOKEN`, `G1_DISTANCE_SENSOR_ID`, and `G1_DISTANCE_FRAME_ID` settings. The separately deployed ROS 2 provider serves current JSON samples with `valid: true`, `sector` (`"forward"` or `"rear"`), `distance_m`, ISO-8601 `timestamp`, `sensor_id`, and `frame_id` fields. Keep the provider on the trusted robot network; its service token must not be exposed to the browser. This provider supplies sensor readings only and must not issue locomotion commands.

`stand()` sets the robot ready to move (SDK FSM 500). `squat_to_stand()` and `stand_to_squat()` use SDK FSM 706; `lie_to_stand()` uses FSM 702. The robot confirms each request, but the app does not know when the movement is finished. Simulator poses are approximate. `HighStand`, `LowStand`, and `Damp` are not included because their effects have not been confirmed for this setup.

Step-count walking estimates about 34.5 cm per step from observed steps of 33–36 cm. The robot moves for a calculated amount of time rather than measuring each step, so the actual distance can differ. Time-based walks and planned paths can also vary on the real robot.

For example, run a preset:

```python
robot.arm_action("hands up")
```

The available preset names are: `release arm`, `two-hand kiss`, `left kiss`, `right kiss`, `hands up`, `clap`, `high five`, `hug`, `heart`, `right heart`, `reject`, `right hand up`, `x-ray`, `face wave`, `high wave`, and `shake hand`.

`wait(seconds)` pauses the program for 0.1 to 10 seconds. The whole program is limited to 30 seconds.

Arm presets:
- Release arm: relax the arms.
- Two-hand kiss, left kiss, and right kiss: bring the hand(s) to the face.
- Hands up, right hand up, and high five: raise a hand or both hands.
- Clap: bring both hands together.
- Hug: open both arms.
- Heart and right heart: make a heart gesture.
- Reject: raise a hand to signal “no.”
- X-ray: make the X-ray pose.
- Face wave and high wave: wave near the face or overhead.
- Shake hand: offer the right hand.

Simulator poses are approximate; the real robot runs its built-in preset.

The audio blocks include speech, volume, head light color, and stopping audio from an app. `robot.playstop("example")` stops audio for an app called `example`; `example` is not a sound name. Available sounds depend on the audio apps installed on the robot, and this command does not list them. Diagnostic blocks can read the current movement mode, speaker volume, and available arm actions.

Example audio commands:

```python
robot.say("Hello, G1", 1)
robot.setvolume(50)
robot.led(0, 160, 255)
robot.getvolume()
```

## 5. Test first in the simulator
Before sending code to the robot, use the simulation preview.
- Check if the robot path looks correct.
- Look for obstacles or bad turns.
- Fix the code before submitting.
- Have a teacher check the motion before starting the physical robot.

## 6. Submit to the teacher
When your code is ready:
- Save it if needed.
- Submit it to the classroom queue.
- Wait for the teacher to start the robot.

## 7. Good habits
- Keep programs short and clear.
- Use small numbers first.
- Always check the preview before running on the robot.
- The teacher's Stop control stops timed locomotion; it does not cancel posture transitions or text-to-speech.

## 8. What to do if something goes wrong
- Check the code for unsupported commands or bad values.
- Reduce the steps or angle.
- Use a smaller movement command.
- Ask the teacher for help if the robot does not move as expected.

Remember: the goal is to learn coding, not to rush the robot.
