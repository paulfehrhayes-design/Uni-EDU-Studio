export const G1_CALIBRATION_STOP_RADIUS_METERS = 3;
export const G1_CALIBRATION_RECENTER_TOLERANCE_METERS = 0.75;

const isolatedMovementTests = [
  {
    label: 'Timed forward 1 second',
    command: 'robot.walktime(1)',
  },
  {
    label: 'Timed forward 3 seconds',
    command: 'robot.walktime(3)',
  },
  {
    label: 'Timed forward 5 seconds',
    command: 'robot.walktime(5)',
  },
  {
    label: 'Timed backward 1 second',
    command: 'robot.backwardtime(1)',
  },
  {
    label: 'Timed backward 3 seconds',
    command: 'robot.backwardtime(3)',
  },
  {
    label: 'Timed backward 5 seconds',
    command: 'robot.backwardtime(5)',
  },
  {
    label: 'Forward 1 step',
    command: 'robot.walk(1)',
  },
  {
    label: 'Forward 3 steps',
    command: 'robot.walk(3)',
  },
  {
    label: 'Forward 5 steps',
    command: 'robot.walk(5)',
  },
  {
    label: 'Backward 1 step',
    command: 'robot.backward(1)',
  },
  {
    label: 'Backward 3 steps',
    command: 'robot.backward(3)',
  },
  {
    label: 'Backward 5 steps',
    command: 'robot.backward(5)',
  },
  {
    label: 'Slow forward 1 step',
    command: 'robot.slowwalk(1)',
  },
  {
    label: 'Slow forward 3 steps',
    command: 'robot.slowwalk(3)',
  },
  {
    label: 'Slow forward 5 steps',
    command: 'robot.slowwalk(5)',
  },
  {
    label: 'Slow forward 1 second',
    command: 'robot.slowwalktime(1)',
  },
  {
    label: 'Slow forward 3 seconds',
    command: 'robot.slowwalktime(3)',
  },
  {
    label: 'Slow forward 5 seconds',
    command: 'robot.slowwalktime(5)',
  },
  {
    label: 'Fast forward 1 step',
    command: 'robot.fastwalk(1)',
  },
  {
    label: 'Fast forward 3 steps',
    command: 'robot.fastwalk(3)',
  },
  {
    label: 'Fast forward 5 steps',
    command: 'robot.fastwalk(5)',
  },
  {
    label: 'Fast forward 1 second',
    command: 'robot.fastwalktime(1)',
  },
  {
    label: 'Fast forward 3 seconds',
    command: 'robot.fastwalktime(3)',
  },
  {
    label: 'Fast forward 5 seconds',
    command: 'robot.fastwalktime(5)',
  },
  {
    label: 'Left sidestep 1 step',
    command: 'robot.sidestep("left", 1)',
  },
  {
    label: 'Left sidestep 3 steps',
    command: 'robot.sidestep("left", 3)',
  },
  {
    label: 'Left sidestep 5 steps',
    command: 'robot.sidestep("left", 5)',
  },
  {
    label: 'Right sidestep 1 step',
    command: 'robot.sidestep("right", 1)',
  },
  {
    label: 'Right sidestep 3 steps',
    command: 'robot.sidestep("right", 3)',
  },
  {
    label: 'Right sidestep 5 steps',
    command: 'robot.sidestep("right", 5)',
  },
  {
    label: 'Turn left 15 degrees',
    command: 'robot.turn("left", 15)',
  },
  {
    label: 'Turn left 45 degrees',
    command: 'robot.turn("left", 45)',
  },
  {
    label: 'Turn left 90 degrees',
    command: 'robot.turn("left", 90)',
  },
  {
    label: 'Turn right 15 degrees',
    command: 'robot.turn("right", 15)',
  },
  {
    label: 'Turn right 45 degrees',
    command: 'robot.turn("right", 45)',
  },
  {
    label: 'Turn right 90 degrees',
    command: 'robot.turn("right", 90)',
  },
  {
    label: 'Turn around 180 degrees',
    command: 'robot.turn_around_180()',
  },
];

const progressionBatches = [
  {
    label: 'Timed forward/backward progression',
    commands: [
      'robot.walktime(1)',
      'robot.walktime(3)',
      'robot.walktime(5)',
      'robot.backwardtime(1)',
      'robot.backwardtime(3)',
      'robot.backwardtime(5)',
      'robot.walktime(1)',
      'robot.backwardtime(1)',
      'robot.walktime(3)',
      'robot.backwardtime(3)',
      'robot.walktime(5)',
      'robot.backwardtime(5)',
    ],
  },
  {
    label: 'Step-based forward/backward progression',
    commands: [
      'robot.walk(1)',
      'robot.walk(3)',
      'robot.walk(5)',
      'robot.backward(1)',
      'robot.backward(3)',
      'robot.backward(5)',
      'robot.walk(1)',
      'robot.backward(1)',
      'robot.walk(3)',
      'robot.backward(3)',
      'robot.walk(5)',
      'robot.backward(5)',
    ],
  },
  {
    label: 'Slow-walk progression',
    commands: [
      'robot.slowwalk(1)',
      'robot.slowwalk(3)',
      'robot.slowwalk(5)',
      'robot.slowwalktime(1)',
      'robot.slowwalktime(3)',
      'robot.slowwalktime(5)',
      'robot.slowwalk(1)',
      'robot.slowwalktime(1)',
      'robot.slowwalk(3)',
      'robot.slowwalktime(3)',
      'robot.slowwalk(5)',
      'robot.slowwalktime(5)',
    ],
  },
  {
    label: 'Fast-walk progression',
    commands: [
      'robot.fastwalk(1)',
      'robot.fastwalk(3)',
      'robot.fastwalk(5)',
      'robot.fastwalktime(1)',
      'robot.fastwalktime(3)',
      'robot.fastwalktime(5)',
      'robot.fastwalk(1)',
      'robot.fastwalktime(1)',
      'robot.fastwalk(3)',
      'robot.fastwalktime(3)',
      'robot.fastwalk(5)',
      'robot.fastwalktime(5)',
    ],
  },
  {
    label: 'Sidestep-only alternating direction progression',
    commands: [
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
    ],
  },
  {
    label: 'Turn-only alternating direction progression',
    commands: [
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
    ],
  },
  {
    label: 'Sidestep with forward/backward transitions',
    commands: [
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
    ],
  },
  {
    label: 'Turns with forward/backward and sideways transitions',
    commands: [
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
    ],
  },
  {
    label: 'Mixed command transitions',
    commands: [
      'robot.walktime(1)',
      'robot.turn("left", 15)',
      'robot.backwardtime(1)',
      'robot.turn("right", 15)',
      'robot.walk(1)',
      'robot.sidestep("left", 1)',
      'robot.backward(1)',
      'robot.sidestep("right", 1)',
      'robot.slowwalk(1)',
      'robot.fastwalk(1)',
      'robot.slowwalktime(1)',
      'robot.fastwalktime(1)',
      'robot.turn_around_180()',
    ],
  },
];

export function buildG1LocomotionCalibrationSeries() {
  const isolatedBatches = [];
  for (let index = 0; index < isolatedMovementTests.length; index += 9) {
    const tests = isolatedMovementTests.slice(index, index + 9);
    isolatedBatches.push({
      label: `Isolated movement trials ${index + 1}-${index + tests.length}`,
      phase: 'isolated',
      cases: tests.map(({ label, command }) => ({ label, command })),
      code: tests.flatMap(({ command }) => [command, 'robot.wait(2)']).join('\n'),
    });
  }
  const batches = [
    ...isolatedBatches,
    ...progressionBatches.map((batch) => ({
      ...batch,
      phase: 'progression',
      cases: batch.commands.map((command) => ({ label: command, command })),
      code: batch.commands.join('\n'),
    })),
  ];
  return {
    batches,
    code: batches.map((batch) => batch.code).join('\n\n'),
  };
}

export async function executeG1LocomotionCalibrationSeries({
  batches,
  runBatch,
  waitForContinue,
  shouldStop = () => false,
  onBatchStart = () => {},
}) {
  if (!Array.isArray(batches) || typeof runBatch !== 'function' || typeof waitForContinue !== 'function') {
    throw new TypeError('Calibration series execution requires bounded batches and explicit run/continue handlers.');
  }
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    while (true) {
      if (shouldStop()) return { status: 'stopped' };
      await onBatchStart(batch, index, batches.length);
      const result = await runBatch(batch);
      if (result?.status !== 'completed') return result;
      if (shouldStop()) return { status: 'stopped' };
      const action = await waitForContinue({
        completed: index + 1,
        total: batches.length,
        completedBatch: batch,
        nextBatch: batches[index + 1] ?? null,
      });
      if (action === 'repeat') continue;
      if (action !== 'continue') return { status: 'stopped' };
      break;
    }
  }
  return { status: 'completed' };
}

export function distanceFromCalibrationAnchor(anchor, pose) {
  if (
    !anchor
    || !pose
    || anchor.frame_id !== pose.frame_id
    || anchor.base_frame !== pose.base_frame
    || !Number.isFinite(anchor.x)
    || !Number.isFinite(anchor.y)
    || !Number.isFinite(pose.x)
    || !Number.isFinite(pose.y)
  ) {
    throw new Error('The local pose frame changed or is invalid; stop the calibration series.');
  }
  return Math.hypot(pose.x - anchor.x, pose.y - anchor.y);
}

export function getG1CalibrationSectionElapsedSeconds(section, now) {
  return section.runTimeOffset + Math.max(0, now - section.runStartedAt) / 1000;
}
