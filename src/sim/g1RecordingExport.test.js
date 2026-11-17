import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildG1MotionRecordingExport,
  buildG1MotionRecordingsExport,
} from './g1RecordingExport.js';
import { getDuetArmCatalog } from './duetArmCatalog.js';
import { G1_MODEL_INFO } from './g1ModelRuntime.js';

const makeRecording = (overrides = {}) => ({
  name: 'Measured wave',
  controller_version: 'duet',
  command: 'duet.wave_right("mid", 1.5)',
  joint_names: getDuetArmCatalog().jointOrder,
  captured_at: '2026-03-01T10:00:00Z',
  frames: [
    { time: 0, joints: Array(10).fill(0) },
    { time: 0.1, joints: Array(10).fill(0.1) },
  ],
  ...overrides,
});

test('portable DUET export records controller, joint order, units, command, and samples', () => {
  const exported = buildG1MotionRecordingExport(makeRecording());

  assert.equal(exported.format, 'uni-edu-studio/g1-motion-recording');
  assert.equal(exported.version, 1);
  assert.equal(exported.robot_model, 'unitree_g1_23dof');
  assert.equal(exported.controller, 'duet_v2');
  assert.equal(exported.measurement_source, 'duet_status:measuredJoints');
  assert.deepEqual(exported.units, { time: 'seconds', joint_position: 'radians' });
  assert.deepEqual(exported.joint_names, getDuetArmCatalog().jointOrder);
  assert.deepEqual(exported.frames[1], { time_s: 0.1, positions_rad: Array(10).fill(0.1) });
});

test('portable legacy export preserves all 23 named joint positions', () => {
  const names = [...G1_MODEL_INFO.joints];
  const exported = buildG1MotionRecordingExport(makeRecording({
    controller_version: 'legacy',
    joint_names: names,
    frames: [
      { time: 0, joints: Array(23).fill(0) },
      { time: 0.1, joints: Array.from({ length: 23 }, (_, index) => index / 100) },
    ],
  }));
  assert.equal(exported.controller, 'legacy_sdk');
  assert.equal(exported.measurement_source, 'ros:/joint_states');
  assert.equal(exported.recorded_dof, 23);
  assert.deepEqual(exported.joint_names, names);
  assert.equal(exported.frames[1].positions_rad[22], 0.22);
});

test('position calibration export preserves timestamped TF pose with joint samples', () => {
  const pose = {
    frame_id: 'odom',
    base_frame: 'pelvis',
    x: 1.2,
    y: -0.4,
    z: 0.03,
    yaw_rad: 1.5,
    timestamp: '2026-03-01T10:00:00Z',
    age_ms: 20,
    source: 'tf2',
  };
  const exported = buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    command: '90 degree left turn',
    frames: [
      { time: 0, joints: Array(10).fill(0), pose },
      { time: 0.1, joints: Array(10).fill(0.1), pose: { ...pose, x: 1.3, timestamp: '2026-03-01T10:00:00.1Z' } },
    ],
  }));

  assert.equal(exported.capture_type, 'position_calibration');
  assert.equal(exported.units.base_position, 'meters');
  assert.deepEqual(exported.frames[1].base_pose, {
    frame_id: 'odom',
    base_frame: 'pelvis',
    x_m: 1.3,
    y_m: -0.4,
    z_m: 0.03,
    yaw_rad: 1.5,
    timestamp: '2026-03-01T10:00:00.100Z',
    age_ms: 20,
    source: 'tf2',
  });
  assert.throws(() => buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    frames: [
      { time: 0, joints: Array(10).fill(0) },
      { time: 0.1, joints: Array(10).fill(0.1) },
    ],
  })), /sample 1 is invalid/);
});

test('DUET position calibration exports all 23 ROS-measured joints', () => {
  const names = [...G1_MODEL_INFO.joints];
  const pose = {
    frame_id: 'odom',
    base_frame: 'pelvis',
    x: 0,
    y: 0,
    z: 0,
    yaw_rad: 0,
    timestamp: '2026-03-01T10:00:00Z',
    age_ms: 10,
    source: 'tf2',
  };
  const exported = buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    joint_names: names,
    frames: [
      { time: 0, joints: Array(23).fill(0), pose },
      { time: 0.1, joints: Array.from({ length: 23 }, (_, index) => index / 100), pose },
    ],
  }));

  assert.equal(exported.controller, 'duet_v2');
  assert.equal(exported.measurement_source, 'ros:/joint_states');
  assert.equal(exported.recorded_dof, 23);
  assert.deepEqual(exported.joint_names, names);
  assert.equal(exported.frames[1].positions_rad[22], 0.22);
});

test('position calibration exports support the 100 Hz five-minute sample limit', () => {
  const pose = {
    frame_id: 'odom',
    base_frame: 'pelvis',
    x: 0,
    y: 0,
    z: 0,
    yaw_rad: 0,
    timestamp: '2026-03-01T10:00:00Z',
    age_ms: 10,
    source: 'tf2',
  };
  const frames = Array.from({ length: 30001 }, (_, index) => ({
    time: index / 100,
    joints: Array(10).fill(0),
    pose,
  }));
  assert.equal(buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    frames,
  })).frames.length, 30001);
  assert.throws(() => buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    frames: [...frames, { time: 300.01, joints: Array(10).fill(0), pose }],
  })), /2 to 30001 samples/);
});

test('collection export validates and bundles each recording', () => {
  const exported = buildG1MotionRecordingsExport([makeRecording()]);
  assert.equal(exported.format, 'uni-edu-studio/g1-motion-recordings');
  assert.equal(exported.recordings.length, 1);
  assert.throws(() => buildG1MotionRecordingsExport([makeRecording({
    frames: [{ time: 0, joints: [] }, { time: 0.1, joints: [] }],
  })]), /sample 1 is invalid/);
});
