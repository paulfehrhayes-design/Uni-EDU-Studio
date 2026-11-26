import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenG1Commands, parseG1Program } from './g1Commands.js';
import { validateLegacyPositionCapture } from './g1PositionCaptureCommands.js';
import { buildG1MotionRecordingExport } from './g1RecordingExport.js';
import { G1_MODEL_INFO } from './g1ModelRuntime.js';
import {
  buildG1LocomotionCalibrationSeries,
  distanceFromCalibrationAnchor,
  executeG1LocomotionCalibrationSeries,
  getG1CalibrationSectionElapsedSeconds,
  G1_CALIBRATION_RECENTER_TOLERANCE_METERS,
  G1_CALIBRATION_STOP_RADIUS_METERS,
} from './g1LocomotionCalibration.js';
import { buildG1RecordedMotionFrames } from './g1RecordedArmMotion.js';

test('locomotion calibration is finite, locomotion-only, and divided into bounded SDK batches', () => {
  const series = buildG1LocomotionCalibrationSeries();
  const methods = [];
  const isolatedBatches = series.batches.filter(({ phase }) => phase === 'isolated');
  const progressionBatches = series.batches.filter(({ phase }) => phase === 'progression');

  assert.equal(series.batches.length, 14);
  assert.equal(isolatedBatches.length, 5);
  assert.equal(progressionBatches.length, 9);
  for (const [index, batch] of series.batches.entries()) {
    const validated = validateLegacyPositionCapture(`Calibration ${index}`, batch.code);
    const commands = flattenG1Commands(parseG1Program(validated.code));
    assert.ok(commands.length > 0 && commands.length <= 20);
    assert.equal(validated.usesLocomotion, true);
    methods.push(...commands.map(({ method }) => method));
  }

  const isolatedMovementCommands = isolatedBatches.flatMap((batch) => {
    const commands = flattenG1Commands(parseG1Program(batch.code));
    assert.equal(commands.length, batch.cases.length * 2);
    for (let index = 0; index < commands.length; index += 2) {
      assert.notEqual(commands[index].method, 'wait');
      assert.equal(commands[index + 1].method, 'wait');
      assert.deepEqual(commands[index + 1].values, [2]);
    }
    return commands.filter(({ method }) => method !== 'wait');
  });
  const isolatedCaseCommands = isolatedBatches.flatMap((batch) => (
    batch.cases.map(({ command }) => command)
  ));
  const progressionCommands = progressionBatches.flatMap((batch) => {
    const commands = flattenG1Commands(parseG1Program(batch.code));
    assert.equal(commands.some(({ method }) => method === 'wait'), false);
    return commands;
  });
  assert.equal(isolatedMovementCommands.length, 37);
  assert.equal(new Set(isolatedCaseCommands).size, 37);
  assert.equal(progressionCommands.length, 110);
  assert.equal(methods.length, 184);
  assert.deepEqual(new Set(methods), new Set([
    'walktime', 'backwardtime', 'walk', 'backward', 'slowwalk', 'slowwalktime',
    'fastwalk', 'fastwalktime', 'sidestep', 'turn', 'turn_around_180', 'wait',
  ]));
  assert.ok(isolatedMovementCommands.some(({ method }) => method === 'fastwalk'));
  assert.ok(isolatedMovementCommands.some(({ method }) => method === 'fastwalktime'));
  assert.equal(
    isolatedMovementCommands.filter(({ method }) => method === 'fastwalk').length,
    3,
  );
  assert.equal(
    isolatedMovementCommands.filter(({ method }) => method === 'fastwalktime').length,
    3,
  );
  assert.ok(progressionCommands.some(({ method }) => method === 'fastwalk'));
  assert.ok(progressionCommands.some(({ method }) => method === 'fastwalktime'));
  assert.deepEqual(progressionBatches.slice(0, 4).map(({ cases }) => cases.length), [12, 12, 12, 12]);
  assert.ok(progressionBatches[4].cases.every(({ command }) => command.startsWith('robot.sidestep(')));
  assert.deepEqual(progressionBatches[4].cases.map(({ command }) => command), [
    'robot.sidestep("left", 1)',
    'robot.sidestep("left", 3)',
    'robot.sidestep("right", 1)',
    'robot.sidestep("right", 3)',
    'robot.sidestep("left", 5)',
    'robot.sidestep("right", 5)',
    'robot.sidestep("left", 1)',
    'robot.sidestep("right", 1)',
    'robot.sidestep("left", 3)',
    'robot.sidestep("right", 3)',
    'robot.sidestep("left", 5)',
    'robot.sidestep("right", 5)',
  ]);
  assert.ok(progressionBatches[5].cases.every(({ command }) => (
    command.startsWith('robot.turn(')
  )));
  assert.deepEqual(progressionBatches[5].cases.map(({ command }) => command), [
    'robot.turn("left", 15)',
    'robot.turn("left", 45)',
    'robot.turn("right", 15)',
    'robot.turn("right", 45)',
    'robot.turn("left", 90)',
    'robot.turn("right", 90)',
    'robot.turn("left", 15)',
    'robot.turn("right", 15)',
    'robot.turn("left", 45)',
    'robot.turn("right", 45)',
    'robot.turn("left", 90)',
    'robot.turn("right", 90)',
  ]);
  assert.deepEqual(progressionBatches[6].cases.map(({ command }) => command), [
    'robot.sidestep("left", 1)',
    'robot.walktime(1)',
    'robot.sidestep("right", 1)',
    'robot.backwardtime(1)',
    'robot.sidestep("left", 3)',
    'robot.walk(3)',
    'robot.sidestep("right", 3)',
    'robot.backward(3)',
    'robot.sidestep("left", 5)',
    'robot.walk(5)',
    'robot.sidestep("right", 5)',
    'robot.backward(5)',
  ]);
  assert.deepEqual(progressionBatches[7].cases.map(({ command }) => command), [
    'robot.turn("left", 15)',
    'robot.walktime(1)',
    'robot.turn("right", 15)',
    'robot.sidestep("left", 1)',
    'robot.turn("left", 45)',
    'robot.backwardtime(1)',
    'robot.turn("right", 45)',
    'robot.sidestep("right", 1)',
    'robot.turn("left", 90)',
    'robot.walk(1)',
    'robot.turn("right", 90)',
    'robot.backward(1)',
    'robot.turn_around_180()',
  ]);
});

test('local odometry boundary checks require the same frame and enforce conservative limits', () => {
  const anchor = { frame_id: 'odom', base_frame: 'pelvis', x: 1, y: -2 };
  assert.ok(Math.abs(
    distanceFromCalibrationAnchor(anchor, { ...anchor, x: 3, y: 1 }) - Math.sqrt(13),
  ) < 1e-12);
  assert.equal(G1_CALIBRATION_STOP_RADIUS_METERS, 3);
  assert.equal(G1_CALIBRATION_RECENTER_TOLERANCE_METERS, 0.75);
  assert.throws(
    () => distanceFromCalibrationAnchor(anchor, { ...anchor, frame_id: 'map' }),
    /frame changed/,
  );
});

test('section capture time excludes pauses and starts independently for each section', () => {
  const firstSection = { runTimeOffset: 4, runStartedAt: 1000 };
  const secondSection = { runTimeOffset: 0, runStartedAt: 3_601_000 };

  assert.equal(getG1CalibrationSectionElapsedSeconds(firstSection, 6000), 9);
  assert.equal(getG1CalibrationSectionElapsedSeconds(secondSection, 3_606_000), 5);
});

test('series runner requires each explicit continue and stops without issuing later batches', async () => {
  const { batches } = buildG1LocomotionCalibrationSeries();
  const executions = [];
  let checkpointCount = 0;
  const result = await executeG1LocomotionCalibrationSeries({
    batches,
    runBatch: async (batch) => {
      executions.push(batch.label);
      return { status: 'completed' };
    },
    waitForContinue: async ({ completed, nextBatch }) => {
      checkpointCount += 1;
      assert.equal(completed, checkpointCount);
      assert.equal(nextBatch.label, batches[checkpointCount].label);
      return checkpointCount < 2 ? 'continue' : 'stop';
    },
  });

  assert.deepEqual(result, { status: 'stopped' });
  assert.deepEqual(executions, batches.slice(0, 2).map(({ label }) => label));
  assert.equal(checkpointCount, 2);
});

test('series runner repeats only the selected batch and can finish at the final checkpoint', async () => {
  const { batches } = buildG1LocomotionCalibrationSeries();
  const selectedBatches = batches.slice(0, 2);
  const executions = [];
  let repeatedFirstBatch = false;
  const result = await executeG1LocomotionCalibrationSeries({
    batches: selectedBatches,
    runBatch: async (batch) => {
      executions.push(batch.label);
      return { status: 'completed' };
    },
    waitForContinue: async ({ completed, nextBatch }) => {
      if (completed === 1 && !repeatedFirstBatch) {
        repeatedFirstBatch = true;
        assert.equal(nextBatch.label, selectedBatches[1].label);
        return 'repeat';
      }
      if (completed === 2) {
        assert.equal(nextBatch, null);
      }
      return 'continue';
    },
  });

  assert.deepEqual(result, { status: 'completed' });
  assert.deepEqual(executions, [
    selectedBatches[0].label,
    selectedBatches[0].label,
    selectedBatches[1].label,
  ]);
});

test('series runner waits for section recording setup before starting each batch', async () => {
  const { batches } = buildG1LocomotionCalibrationSeries();
  const events = [];
  let activeIndex = -1;
  const result = await executeG1LocomotionCalibrationSeries({
    batches: batches.slice(0, 2),
    onBatchStart: async (batch, index) => {
      activeIndex = index;
      events.push(`setup:${index}`);
      await Promise.resolve();
      events.push(`ready:${index}`);
    },
    runBatch: async () => {
      events.push(`run:${activeIndex}`);
      return { status: 'completed' };
    },
    waitForContinue: async () => 'continue',
  });

  assert.deepEqual(result, { status: 'completed' });
  assert.deepEqual(events, [
    'setup:0', 'ready:0', 'run:0',
    'setup:1', 'ready:1', 'run:1',
  ]);
});

test('series runner halts on a failed batch and does not retry it automatically', async () => {
  const { batches } = buildG1LocomotionCalibrationSeries();
  const executions = [];
  const result = await executeG1LocomotionCalibrationSeries({
    batches,
    runBatch: async (batch) => {
      executions.push(batch.label);
      return { status: 'stopped' };
    },
    waitForContinue: async () => assert.fail('No checkpoint follows a failed batch.'),
  });

  assert.deepEqual(result, { status: 'stopped' });
  assert.deepEqual(executions, [batches[0].label]);
});

test('series pose and full 23-joint samples pass the existing calibration JSON export schema', () => {
  const { code } = buildG1LocomotionCalibrationSeries();
  const pose = {
    frame_id: 'odom',
    base_frame: 'pelvis',
    x: 0,
    y: 0,
    z: 0,
    yaw_rad: 0,
    timestamp: '2026-03-01T10:00:00Z',
    age_ms: 20,
    source: 'odometry',
  };
  const exported = buildG1MotionRecordingExport({
    name: 'Locomotion calibration',
    controller_version: 'legacy',
    capture_type: 'position_calibration',
    command: code,
    joint_names: [...G1_MODEL_INFO.joints],
    captured_at: '2026-03-01T10:00:00Z',
    frames: [
      { time: 0, joints: Array(23).fill(0), pose },
      { time: 0.1, joints: Array(23).fill(0.1), pose: { ...pose, x: 0.02 } },
    ],
  });

  assert.equal(exported.capture_type, 'position_calibration');
  assert.equal(exported.recorded_dof, 23);
  assert.equal(exported.command, code);
  assert.equal(exported.frames[1].positions_rad.length, 23);
  assert.equal(exported.frames[1].base_pose.x_m, 0.02);
});

test('each saved calibration section can be played as an independent measured motion', () => {
  const pose = {
    frame_id: 'odom',
    base_frame: 'pelvis',
    x: 0,
    y: 0,
    z: 0,
    yaw_rad: 0,
    timestamp: '2026-03-01T10:00:00Z',
    age_ms: 20,
    source: 'odometry',
  };
  const recording = (name, x) => ({
    name,
    controller_version: 'legacy',
    capture_type: 'position_calibration',
    joint_names: [...G1_MODEL_INFO.joints],
    frames: [
      { time: 0, joints: Array(23).fill(0), pose },
      { time: 0.1, joints: Array(23).fill(0.1), pose: { ...pose, x } },
    ],
  });
  const firstSection = buildG1RecordedMotionFrames(recording('Section 1', 0.1));
  const secondSection = buildG1RecordedMotionFrames(recording('Section 2', -0.2));

  assert.equal(firstSection.length, 2);
  assert.equal(secondSection.length, 2);
  assert.equal(firstSection[0].time, 0);
  assert.equal(secondSection[0].time, 0);
  assert.equal(firstSection.at(-1).x, 0.1);
  assert.equal(secondSection.at(-1).x, -0.2);
});
