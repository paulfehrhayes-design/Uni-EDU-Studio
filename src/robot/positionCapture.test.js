import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scheduleNextPositionCaptureSample,
  selectPositionCapturePose,
  summarizePositionCaptureSensorUpdates,
} from './positionCapture.js';

const makePose = (frame_id, overrides = {}) => ({
  ready: true,
  frame_id,
  base_frame: 'pelvis',
  x: 1,
  y: 2,
  z: 0,
  yaw_rad: 0.5,
  timestamp: '2026-03-01T10:00:00Z',
  age_ms: 20,
  source: 'tf2',
  ...overrides,
});

test('capture selects odometry when available and locks the frame on later samples', () => {
  const snapshot = {
    ready: true,
    preferred_frame: 'map',
    poses: [makePose('map'), makePose('odom', { x: 3 })],
  };
  assert.equal(selectPositionCapturePose(snapshot).frame_id, 'odom');
  assert.equal(selectPositionCapturePose(snapshot, 'map').frame_id, 'map');
  assert.throws(
    () => selectPositionCapturePose({ ...snapshot, poses: [makePose('map')] }, 'odom'),
    /no frame switch was made/,
  );
});

test('capture accepts a fresh direct ROS odometry pose as well as TF', () => {
  const pose = selectPositionCapturePose({
    ready: true,
    preferred_frame: 'odom',
    poses: [makePose('odom', { source: 'odometry', base_frame: 'base' })],
  });
  assert.equal(pose.source, 'odometry');
  assert.equal(pose.base_frame, 'base');
});

test('capture rejects stale or malformed pose data instead of inventing a position', () => {
  assert.throws(
    () => selectPositionCapturePose({ ready: false, error: 'TF is unavailable.', poses: [] }),
    /TF is unavailable/,
  );
  assert.throws(
    () => selectPositionCapturePose({
      ready: true,
      poses: [makePose('odom', { age_ms: 1001 })],
    }),
    /invalid or stale/,
  );
});

test('capture sampling does not burst after slow telemetry requests', () => {
  assert.equal(scheduleNextPositionCaptureSample(110, 125, 10), 135);
  assert.equal(scheduleNextPositionCaptureSample(140, 125, 10), 140);
});

test('sensor-rate summary counts distinct source timestamps and repeated reads', () => {
  const summary = summarizePositionCaptureSensorUpdates([
    { elapsed_ms: 0, timestamp: 't0' },
    { elapsed_ms: 5, timestamp: 't0' },
    { elapsed_ms: 10, timestamp: 't10' },
    { elapsed_ms: 20, timestamp: 't20' },
  ], 'timestamp');

  assert.deepEqual(summary, {
    distinct_samples: 3,
    repeated_reads: 1,
    observed_update_rate_hz: 100,
    unique_timestamps: ['t0', 't10', 't20'],
  });
});
