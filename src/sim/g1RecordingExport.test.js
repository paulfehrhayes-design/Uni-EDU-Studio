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

test('legacy position export preserves timestamped LowState motor and IMU measurements', () => {
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
  const lowState = {
    timestamp: '2026-03-01T10:00:00.010Z',
    age_ms: 20,
    motor_count: 27,
    motor_state: Array.from({ length: 27 }, (_, index) => ({
      index,
      q: index / 10,
      dq: index / 100,
      tau_est: index / 1000,
    })),
    imu_state: {
      rpy: [0.1, 0.2, 0.3],
      gyroscope: [0.4, 0.5, 0.6],
      accelerometer: [0.7, 0.8, 0.9],
    },
  };
  const exported = buildG1MotionRecordingExport(makeRecording({
    controller_version: 'legacy',
    capture_type: 'position_calibration',
    joint_names: [...G1_MODEL_INFO.joints],
    low_state_metadata: {
      source: 'unitree_sdk2py:rt/lowstate',
      status: 'recorded',
      sample_count: 1,
      failed_polls: 0,
      reason: null,
      motor_joint_mapping: G1_MODEL_INFO.joints.map((joint_name, index) => ({
        joint_name,
        motor_index: index < 13 ? index : index < 18 ? index + 2 : index + 4,
      })),
    },
    frames: [
      { time: 0, joints: Array(23).fill(0), pose, low_state: lowState },
      { time: 0.1, joints: Array(23).fill(0.1), pose },
    ],
  }));

  assert.equal(exported.units.low_state_motor_position, 'radians');
  assert.equal(exported.low_state_capture.sample_count, 1);
  assert.deepEqual(exported.frames[0].low_state.motor_state[26], {
    index: 26,
    q_rad: 2.6,
    dq_rad_s: 0.26,
    tau_est_nm: 0.026,
  });
  assert.deepEqual(exported.frames[0].low_state.imu_state, {
    rpy_rad: [0.1, 0.2, 0.3],
    gyroscope_rad_s: [0.4, 0.5, 0.6],
    accelerometer_m_s2: [0.7, 0.8, 0.9],
  });
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

test('position calibration export accepts direct odometry pose samples', () => {
  const pose = {
    frame_id: 'odom',
    base_frame: 'pelvis',
    x: 0.4,
    y: -0.2,
    z: 0,
    yaw_rad: 0.25,
    timestamp: '2026-03-01T10:00:00Z',
    age_ms: 15,
    source: 'odometry',
  };
  const exported = buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    joint_names: [...G1_MODEL_INFO.joints],
    frames: [
      { time: 0, joints: Array(23).fill(0), pose },
      { time: 0.1, joints: Array(23).fill(0.1), pose: { ...pose, x: 0.5 } },
    ],
  }));

  assert.equal(exported.frames[0].base_pose.source, 'odometry');
  assert.equal(exported.frames[1].base_pose.x_m, 0.5);
});

test('position calibration exports support the 30 Hz thirty-minute sample limit', () => {
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
  const frames = Array.from({ length: 54001 }, (_, index) => ({
    time: index / 30,
    joints: Array(10).fill(0),
    pose,
  }));
  assert.equal(buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    frames,
  })).frames.length, 54001);
  assert.throws(() => buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    frames: [...frames, { time: 1800.1, joints: Array(10).fill(0), pose }],
  })), /2 to 54001 samples/);
  assert.throws(() => buildG1MotionRecordingExport(makeRecording({
    capture_type: 'position_calibration',
    frames: [
      { time: 0, joints: Array(10).fill(0), pose },
      { time: 1800.001, joints: Array(10).fill(0), pose },
    ],
  })), /sample 2 is invalid/);
});

test('collection export validates and bundles each recording', () => {
  const exported = buildG1MotionRecordingsExport([makeRecording()]);
  assert.equal(exported.format, 'uni-edu-studio/g1-motion-recordings');
  assert.equal(exported.recordings.length, 1);
  assert.throws(() => buildG1MotionRecordingsExport([makeRecording({
    frames: [{ time: 0, joints: [] }, { time: 0.1, joints: [] }],
  })]), /sample 1 is invalid/);
});
