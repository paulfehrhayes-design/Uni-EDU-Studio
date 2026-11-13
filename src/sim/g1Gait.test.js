import assert from 'node:assert/strict';
import test from 'node:test';
import { getG1GaitEnvelope, getG1GaitJointTargets } from './g1Gait.js';
import { buildLegacyG1SimulationFrames, createEmptyG1Edu23State } from './g1Edu23Env.js';
import { simulateDuetG1Edu23Program } from './duetG1Edu23Env.js';
import { getMujocoJointAngle, G1_MESH_ARM_JOINT_NAMES } from './g1MeshRigAxes.js';
import { G1_MODEL_INFO } from './g1ModelRuntime.js';

test('G1 gait alternates flexion and coordinates opposite arm swing across the full joint set', () => {
  const targets = getG1GaitJointTargets(Math.PI / 3);

  assert.equal(Object.keys(targets).length, 23);
  assert.ok(targets.left_hip_pitch_joint > 0);
  assert.ok(targets.right_hip_pitch_joint < 0);
  assert.ok(targets.left_knee_joint > 0);
  assert.equal(targets.right_knee_joint, 0);
  assert.ok(targets.left_shoulder_pitch_joint < 0);
  assert.ok(targets.right_shoulder_pitch_joint > 0);
  assert.ok(targets.left_elbow_joint > 0);
  assert.ok(targets.right_elbow_joint > 0);
  assert.notEqual(targets.left_shoulder_yaw_joint, 0);
  assert.notEqual(targets.right_shoulder_yaw_joint, 0);
  assert.equal(targets.waist_yaw_joint, 0);
  const oppositePhase = getG1GaitJointTargets(4 * Math.PI / 3);
  assert.notEqual(targets.left_elbow_joint, oppositePhase.left_elbow_joint);
  assert.notEqual(targets.right_elbow_joint, oppositePhase.right_elbow_joint);
  assert.ok(G1_MESH_ARM_JOINT_NAMES.every((joint) => Object.hasOwn(targets, joint)));
  assert.equal(Object.hasOwn(targets, 'left_wrist_pitch_joint'), false);
  assert.equal(Object.hasOwn(targets, 'waist_pitch_joint'), false);
});

test('G1 gait ramps in and out rather than freezing mid-stride', () => {
  assert.equal(getG1GaitEnvelope(0), 0);
  assert.ok(getG1GaitEnvelope(0.1) > 0 && getG1GaitEnvelope(0.1) < 1);
  assert.equal(getG1GaitEnvelope(0.5), 1);
  assert.ok(getG1GaitEnvelope(0.9) > 0 && getG1GaitEnvelope(0.9) < 1);
  assert.equal(getG1GaitEnvelope(1), 0);
});

test('empty simulator state initializes every rendered joint to numeric neutral', () => {
  const { joints } = createEmptyG1Edu23State();

  assert.equal(Object.keys(joints).length, 23);
  assert.equal(Object.keys(joints).length, G1_MODEL_INFO.jointCount);
  G1_MESH_ARM_JOINT_NAMES.forEach((joint) => assert.ok(Object.hasOwn(joints, joint)));
  assert.ok(Object.values(joints).every((angle) => angle === 0));
});

test('legacy walking alternates both legs, swings articulated arms, and ends neutral', () => {
  const frames = buildLegacyG1SimulationFrames('robot.walk(2)');
  const joints = frames.map(({ joints: frameJoints }) => frameJoints);

  assert.ok(joints.every((frameJoints) => Object.keys(frameJoints).length === 23));
  assert.ok(joints.some(({ left_knee_joint: left, right_knee_joint: right }) => left > 0 && right === 0));
  assert.ok(joints.some(({ right_knee_joint: right, left_knee_joint: left }) => right > 0 && left === 0));
  assert.ok(joints.some(({ left_elbow_joint: left, right_elbow_joint: right }) => left > 0 && right > 0));
  assert.equal(frames.at(-1).joints.left_knee_joint, 0);
  assert.equal(frames.at(-1).joints.right_knee_joint, 0);
  assert.equal(frames.at(-1).joints.left_elbow_joint, 0);
  assert.equal(frames.at(-1).joints.right_elbow_joint, 0);
});

test('legacy turns step in place while rotating the base without duplicating waist yaw', () => {
  const frames = buildLegacyG1SimulationFrames('robot.turn("left", 90)');

  assert.ok(Math.abs(frames.at(-1).heading - 90) < 1e-9);
  assert.ok(frames.every(({ joints }) => joints.waist_yaw_joint === 0));
  assert.ok(frames.some(({ joints }) => joints.left_knee_joint > 0));
  assert.ok(frames.some(({ joints }) => joints.right_knee_joint > 0));
  assert.ok(frames.some(({ joints }) => joints.left_elbow_joint > 0));
});

test('DUET locomotion uses the same articulated gait and settles at the end', () => {
  const frames = simulateDuetG1Edu23Program('duet.forward(1)');

  assert.ok(frames.every(({ joints }) => Object.keys(joints).length === 23));
  assert.ok(frames.some(({ joints }) => joints.left_elbow_joint > 0));
  assert.ok(frames.some(({ joints }) => joints.right_elbow_joint > 0));
  assert.equal(frames.at(-1).joints.left_elbow_joint, 0);
  assert.equal(frames.at(-1).joints.right_elbow_joint, 0);
  assert.equal(frames.at(-1).joints.waist_yaw_joint, 0);
});

test('DUET turning in place plays a step-in-place gait', () => {
  const frames = simulateDuetG1Edu23Program('duet.turn_left(1)');

  assert.ok(frames.at(-1).heading > 0);
  assert.ok(frames.some(({ joints }) => getMujocoJointAngle(joints, 'left_knee_joint') > 0));
  assert.ok(frames.some(({ joints }) => joints.left_elbow_joint > 0));
  assert.equal(getMujocoJointAngle(frames.at(-1).joints, 'left_knee_joint'), 0);
  assert.equal(frames.at(-1).joints.left_elbow_joint, 0);
});
