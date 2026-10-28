import assert from 'node:assert/strict';
import test from 'node:test';
import { getDuetSimulationModelInfo, simulateDuetG1Edu23Program } from './duetG1Edu23Env.js';
import { getDuetArmCatalog, getDuetArmPoseTarget } from './duetArmCatalog.js';

test('DUET simulator uses the exact 23-DOF project model mapping', () => {
  const info = getDuetSimulationModelInfo();
  assert.equal(info.robotType, 'Unitree G1');
  assert.equal(info.jointCount, 23);
  assert.equal(info.jointNames.length, 23);
});

test('DUET simulator applies bounded base velocity to the path', () => {
  const frames = simulateDuetG1Edu23Program('duet.move(0.2, 0, 0, 1)');
  const final = frames.at(-1);
  assert.ok(Math.abs(final.x - 0.2) < 1e-6);
  assert.equal(final.y, 0);
  assert.equal(final.mode, 'duet-preview');
});

test('DUET simulator previews base movement and named arm pose over the same interval', () => {
  const frames = simulateDuetG1Edu23Program(
    'with duet.concurrent():\n'
    + '    duet.forward(1)\n'
    + '    duet.arm_reach(1.5)',
  );
  const overlapFrame = frames.find((frame) => frame.x > 0 && frame.joints.left_shoulder_pitch_joint < 0);
  const final = frames.at(-1);

  assert.ok(overlapFrame, 'base path and arm target should both change during the preview');
  assert.ok(Math.abs(final.x - 0.15) < 1e-6);
  assert.equal(final.time, 1.5);
  assert.equal(final.actions.at(-1).label, 'DUET concurrent move + arm');
});

test('DUET simulator overlaps locomotion with multi-stage gestures and keeps surrounding commands sequential', () => {
  const frames = simulateDuetG1Edu23Program(
    'duet.wait(0.5)\n'
    + 'for _ in range(2):\n'
    + '    with duet.concurrent():\n'
    + '        duet.backward(1)\n'
    + '        duet.wave_left_mid(1)\n'
    + 'duet.wait(0.5)',
  );
  const final = frames.at(-1);
  const pairedActions = final.actions.filter(({ label }) => label === 'DUET concurrent move + arm');

  assert.equal(pairedActions.length, 2);
  assert.equal(final.time, 11);
  assert.ok(Math.abs(final.x + 0.2) < 1e-6);
});

test('DUET simulator maps preset locomotion blocks to the same bounded velocity space', () => {
  const final = simulateDuetG1Edu23Program(
    'duet.forward(1)\n'
    + 'duet.turn_left(1)\n'
    + 'duet.arc_forward_right(1)',
  ).at(-1);

  assert.ok(final.x > 0.25);
  assert.ok(final.heading > 0);
  assert.equal(final.mode, 'duet-preview');
});

test('DUET simulator previews named arm-pose presets', () => {
  const final = simulateDuetG1Edu23Program('duet.arm_reach(1)').at(-1);
  assert.ok(final.joints.left_shoulder_pitch_joint < 0);
  assert.equal(final.joints.left_elbow_joint, Number((0.87 * 180 / Math.PI).toFixed(2)));
  assert.equal(final.joints.right_shoulder_roll_joint < 0, true);
});

test('DUET simulator selects front and rear distance branches from obstacle clearance', () => {
  const frontFrames = simulateDuetG1Edu23Program(
    'if duet.front_distance_m() < 0.5:\n'
    + '    duet.stop()\n'
    + 'else:\n'
    + '    duet.forward(1)',
    { obstacles: [{ x: 0.5, y: 0, radius: 0.1 }] },
  );
  const rearFrames = simulateDuetG1Edu23Program(
    'if duet.rear_distance_m() <= 0.5:\n'
    + '    duet.stop()\n'
    + 'else:\n'
    + '    duet.backward(1)',
    { obstacles: [{ x: -0.5, y: 0, radius: 0.1 }] },
  );

  assert.equal(frontFrames.at(-1).status, 'Stopped');
  assert.match(frontFrames.at(-1).timeline[0].summary, /forward obstacle: 0\.40 m < 0\.5 m -> then/);
  assert.equal(rearFrames.at(-1).status, 'Stopped');
  assert.match(rearFrames.at(-1).timeline[0].summary, /rear obstacle: 0\.40 m <= 0\.5 m -> then/);
});

test('expanded approved pose targets are exposed to Blockly and simulated as arm targets', () => {
  const poseNames = ['both_forward_low', 'both_open_bent', 'left_arm_forward', 'right_arm_forward'];
  const catalog = getDuetArmCatalog();

  poseNames.forEach((poseName) => {
    const target = getDuetArmPoseTarget(poseName);
    const frames = simulateDuetG1Edu23Program(
      `duet.hold_pose(duet.pose("${poseName}"), 1)`,
    );
    const targetFrame = frames.find((frame) => frame.time === 1);
    assert.ok(targetFrame, `${poseName} should have a target frame`);
    catalog.jointOrder.forEach((jointName, index) => {
      assert.equal(
        targetFrame.joints[jointName],
        Number((target[index] * 180 / Math.PI).toFixed(2)),
        `${poseName} should target ${jointName}`,
      );
    });
  });
});

test('DUET simulator previews fixed arm sequences using named targets', () => {
  const frames = simulateDuetG1Edu23Program('duet.reach_and_return(1.5)');
  const final = frames.at(-1);
  assert.equal(final.actions.length, 2);
  assert.equal(final.actions.at(-1).summary, 'Preview the carry preset over 1.5 s');
  assert.ok(final.joints.left_shoulder_pitch_joint > 0);
});

test('DUET simulator holds a named pose for the requested interval then returns to carry', () => {
  const frames = simulateDuetG1Edu23Program('duet.hold_pose(duet.pose("both_overhead"), 12)');
  const final = frames.at(-1);
  const held = frames.find((frame) => Math.abs(frame.time - 2) < 0.001);

  assert.ok(held);
  assert.ok(held.joints.left_shoulder_pitch_joint < -90);
  assert.ok(held.joints.right_shoulder_pitch_joint < -90);
  assert.equal(final.time, 14);
  assert.ok(final.joints.left_shoulder_pitch_joint > 0);
});

test('DUET simulator retains until-reset poses, resets explicitly, and resets held poses on completion', () => {
  const explicitlyReset = simulateDuetG1Edu23Program(
    'duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\n'
    + 'duet.wait(1)\n'
    + 'duet.reset_arms()',
  );
  const duringWait = explicitlyReset.find((frame) => Math.abs(frame.time - 1.5) < 0.001);
  assert.ok(duringWait.joints.left_shoulder_pitch_joint < -50);
  assert.ok(explicitlyReset.at(-1).joints.left_shoulder_pitch_joint > 0);

  const completed = simulateDuetG1Edu23Program(
    'duet.hold_pose_until_reset(duet.pose("both_overhead"))',
  );
  assert.ok(completed.find((frame) => frame.time === 1).joints.left_shoulder_pitch_joint < -90);
  assert.ok(completed.at(-1).joints.left_shoulder_pitch_joint > 0);
});

test('DUET simulator can hold a named pose concurrently with locomotion', () => {
  const frames = simulateDuetG1Edu23Program(
    'with duet.concurrent():\n'
    + '    duet.forward(1)\n'
    + '    duet.hold_pose(duet.pose("both_sideways"), 2)',
  );
  const overlapping = frames.find((frame) => frame.x > 0 && frame.joints.left_shoulder_roll_joint > 50);

  assert.ok(overlapping);
  assert.equal(frames.at(-1).time, 4);
  assert.ok(frames.at(-1).joints.left_shoulder_pitch_joint > 0);
});

test('DUET side-specific wave gestures move only the selected mirrored arm', () => {
  const leftFrame = simulateDuetG1Edu23Program('duet.wave_left_mid(1)').find((frame) => frame.time === 1);
  const rightFrame = simulateDuetG1Edu23Program('duet.wave_right_mid(1)').find((frame) => frame.time === 1);

  assert.ok(leftFrame.joints.left_shoulder_pitch_joint < -50);
  assert.ok(leftFrame.joints.right_shoulder_pitch_joint > 0);
  assert.ok(rightFrame.joints.right_shoulder_pitch_joint < -50);
  assert.ok(rightFrame.joints.left_shoulder_pitch_joint > 0);
});

test('DUET locomotion preview leaves arm joints at their neutral command-space values', () => {
  const final = simulateDuetG1Edu23Program('duet.move(0.2, 0, 0, 1)').at(-1);
  assert.equal(final.joints.left_shoulder_pitch_joint, 0);
  assert.equal(final.joints.right_shoulder_pitch_joint, 0);
});

test('DUET preview rejects legacy commands', () => {
  assert.throws(() => simulateDuetG1Edu23Program('robot.walk(1)'), /Unsupported statement/);
});
