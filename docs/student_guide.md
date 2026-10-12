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
- Sit
- Squat to stand, lie to stand, and stand to squat
- Walk forward or backward
- Sidestep left or right
- Turn left or right
- Slow or fast walk

## 4. Use the IDE if you prefer typing
The IDE reference and Blocks toolbox show the commands currently mapped by the G1 SDK adapter. Example:

```python
robot.stand()
robot.sit()
robot.squat_to_stand()
robot.lie_to_stand()
robot.stand_to_squat()
robot.walk(3)
robot.turn("left", 90)
robot.backwardtime(1)
```

Programs can also use bounded `for` loops. The legacy G1 arm presets are available with `robot.arm_action("hands up")` and the other names listed below. Simulation shows approximate poses, not the SDK trajectories. The physical SDK reports whether it accepted a preset request, not when the motion finishes. The teacher's `Stop robot` button stops locomotion but cannot cancel an accepted arm preset, so keep the robot area clear and use direct teacher supervision.

The `stand` command selects the SDK's normal locomotion-ready state (FSM 500). The separate `squat_to_stand()` and `stand_to_squat()` posture transitions both use FSM 706 in the Python SDK; `lie_to_stand()` uses FSM 702. These SDK transitions report request acceptance, not completion. Simulator poses are approximate, and `HighStand`, `LowStand`, and `Damp` remain unavailable because their effects are not verified for this robot setup.

Step-count walking commands use an estimated 34.5 cm per count, based on observed steps of about 33–36 cm. The robot receives timed velocity commands; this is a nominal estimate, not measured odometry. `walktime` commands and planner paths remain velocity-based and are not snapped to individual footfalls, so actual hardware paths may differ.

For example, run a preset:

```python
robot.arm_action("hands up")
```

The available preset names are: `release arm`, `two-hand kiss`, `left kiss`, `right kiss`, `hands up`, `clap`, `high five`, `hug`, `heart`, `right heart`, `reject`, `right hand up`, `x-ray`, `face wave`, `high wave`, and `shake hand`.

The SDK-backed audio blocks include text-to-speech, volume (capped at 70), head LED color, and stopping an audio app. Diagnostic blocks can read the current motion state, speaker volume, and the arm-action list reported by the robot. Reading the arm-action list does not execute an arm action. Raw FSM controls and arbitrary recorded-action names are not exposed as runnable blocks.

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
