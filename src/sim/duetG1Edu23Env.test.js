import assert from 'node:assert/strict';
import test from 'node:test';
import { getDuetSimulationModelInfo, simulateDuetG1Edu23Program } from './duetG1Edu23Env.js';

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
  assert.equal(final.time, 7);
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

test('DUET simulator previews only the three named arm-pose presets', () => {
  const final = simulateDuetG1Edu23Program('duet.arm_reach(1)').at(-1);
  assert.ok(final.joints.left_shoulder_pitch_joint < 0);
  assert.equal(final.joints.left_elbow_joint, Number((0.87 * 180 / Math.PI).toFixed(2)));
  assert.equal(final.joints.right_shoulder_roll_joint < 0, true);
});

test('DUET simulator previews fixed arm sequences using only existing named poses', () => {
  const frames = simulateDuetG1Edu23Program('duet.reach_and_return(1.5)');
  const final = frames.at(-1);
  assert.equal(final.actions.length, 2);
  assert.equal(final.actions.at(-1).summary, 'Preview the carry preset over 1.5 s');
  assert.ok(final.joints.left_shoulder_pitch_joint > 0);
});

test('DUET locomotion preview leaves arm joints at their neutral command-space values', () => {
  const final = simulateDuetG1Edu23Program('duet.move(0.2, 0, 0, 1)').at(-1);
  assert.equal(final.joints.left_shoulder_pitch_joint, 0);
  assert.equal(final.joints.right_shoulder_pitch_joint, 0);
});

test('DUET preview rejects legacy commands', () => {
  assert.throws(() => simulateDuetG1Edu23Program('robot.walk(1)'), /Unsupported statement/);
});
