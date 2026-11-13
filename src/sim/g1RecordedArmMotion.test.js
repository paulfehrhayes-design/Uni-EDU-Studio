import assert from 'node:assert/strict';
import test from 'node:test';
import { buildG1RecordedMotionFrames } from './g1RecordedArmMotion.js';
import { getDuetArmCatalog } from './duetArmCatalog.js';
import { G1_MODEL_INFO } from './g1ModelRuntime.js';

test('recorded arm samples become 23-DOF simulator frames with measured arm angles', () => {
  const recording = {
    name: 'Measured wave',
    frames: [
      { time: 0, joints: Array(10).fill(0) },
      { time: 0.1, joints: [0.1, -0.2, 0.3, 0.4, -0.5, 0.6, -0.7, 0.8, 0.9, -1] },
    ],
  };
  const frames = buildG1RecordedMotionFrames(recording);
  const armJointNames = getDuetArmCatalog().jointOrder;

  assert.equal(frames.length, 2);
  assert.equal(Object.keys(frames[1].joints).length, 23);
  assert.ok(Math.abs(frames[1].joints[armJointNames[0]] - 0.1 * 180 / Math.PI) < 1e-12);
  assert.ok(Math.abs(frames[1].joints[armJointNames[9]] + 180 / Math.PI) < 1e-12);
  assert.ok(G1_MODEL_INFO.joints.every((name) => name in frames[1].joints));
  assert.equal(frames[1].time, 0.1);
});

test('recorded arm samples reject missing, unordered, and non-finite joint data', () => {
  assert.throws(() => buildG1RecordedMotionFrames({ frames: [] }), /2 to 601/);
  assert.throws(() => buildG1RecordedMotionFrames({
    frames: [
      { time: 0.1, joints: Array(10).fill(0) },
      { time: 0.2, joints: Array(10).fill(0) },
    ],
  }), /time zero/);
  assert.throws(() => buildG1RecordedMotionFrames({
    frames: [
      { time: 0, joints: Array(10).fill(0) },
      { time: 0.1, joints: [NaN, ...Array(9).fill(0)] },
    ],
  }), /sample 2 is invalid/);
});

test('recorded legacy samples map all 23 named joint positions into simulator frames', () => {
  const jointNames = [...G1_MODEL_INFO.joints].reverse();
  const frames = buildG1RecordedMotionFrames({
    name: 'Measured full-body motion',
    joint_names: jointNames,
    frames: [
      { time: 0, joints: Array(23).fill(0) },
      { time: 0.1, joints: Array.from({ length: 23 }, (_, index) => index / 100) },
    ],
  });
  assert.equal(Object.keys(frames[1].joints).length, 23);
  jointNames.forEach((jointName, index) => {
    assert.ok(Math.abs(frames[1].joints[jointName] - (index / 100) * 180 / Math.PI) < 1e-12);
  });
});

test('recorded motion rejects unknown or duplicate joint names', () => {
  const base = [
    { time: 0, joints: Array(10).fill(0) },
    { time: 0.1, joints: Array(10).fill(0) },
  ];
  assert.throws(() => buildG1RecordedMotionFrames({
    joint_names: [...getDuetArmCatalog().jointOrder.slice(1), 'unknown_joint'],
    frames: base,
  }), /do not match/);
  assert.throws(() => buildG1RecordedMotionFrames({
    joint_names: Array(10).fill(getDuetArmCatalog().jointOrder[0]),
    frames: base,
  }), /do not match/);
});
