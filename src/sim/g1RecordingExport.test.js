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

test('collection export validates and bundles each recording', () => {
  const exported = buildG1MotionRecordingsExport([makeRecording()]);
  assert.equal(exported.format, 'uni-edu-studio/g1-motion-recordings');
  assert.equal(exported.recordings.length, 1);
  assert.throws(() => buildG1MotionRecordingsExport([makeRecording({
    frames: [{ time: 0, joints: [] }, { time: 0.1, joints: [] }],
  })]), /sample 1 is invalid/);
});
