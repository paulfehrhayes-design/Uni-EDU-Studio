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
  const final = simulateDuetG1Edu23Program('duet.arm_pose("forward", 1)').at(-1);
  assert.ok(final.joints.left_shoulder_pitch_joint < 0);
  assert.equal(final.joints.left_elbow_joint, Number((0.87 * 180 / Math.PI).toFixed(2)));
  assert.equal(final.joints.right_shoulder_roll_joint < 0, true);
});

test('DUET simulator previews fixed arm sequences using only existing named poses', () => {
  const frames = simulateDuetG1Edu23Program('duet.arm_motion("reach_and_return", 1.5)');
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
