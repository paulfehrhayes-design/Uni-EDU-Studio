import assert from 'node:assert/strict';
import test from 'node:test';
import { interpolateSimulationFrame } from './g1MotionInterpolation.js';

test('playback interpolates authored joint samples continuously and wraps heading by the shortest arc', () => {
  const frame = interpolateSimulationFrame({
    time: 1,
    x: 2,
    y: 4,
    heading: 350,
    joints: { left_elbow_joint: 20, right_knee_joint: 0 },
  }, {
    time: 2,
    x: 6,
    y: 8,
    heading: 10,
    joints: { left_elbow_joint: 60, right_knee_joint: 32 },
  }, 0.25);

  assert.equal(frame.time, 1.25);
  assert.equal(frame.x, 3);
  assert.equal(frame.y, 5);
  assert.equal(frame.heading, 355);
  assert.equal(frame.joints.left_elbow_joint, 30);
  assert.equal(frame.joints.right_knee_joint, 8);
});
