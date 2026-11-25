import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateDuetPositionCapture,
  validateLegacyPositionCapture,
} from './g1PositionCaptureCommands.js';

test('legacy position capture accepts a bounded sequence of locomotion and arm commands', () => {
  const capture = validateLegacyPositionCapture(
    '  Turn and move  ',
    'robot.walktime(1)\nrobot.turn("left", 90)\nrobot.arm_action("release arm")',
  );

  assert.equal(capture.name, 'Turn and move');
  assert.equal(
    capture.code,
    'robot.walktime(1)\nrobot.turn("left", 90)\nrobot.arm_action("release arm")',
  );
});

test('legacy position capture rejects unsafe or unbounded program structures', () => {
  assert.throws(
    () => validateLegacyPositionCapture('Fast', 'robot.fastwalk(2)'),
    /conservative walking and turns/,
  );
  assert.throws(
    () => validateLegacyPositionCapture(
      'Conditional',
      'if robot.front_distance_m() < 1:\n    robot.walktime(1)',
    ),
    /not conditions or concurrent blocks/,
  );
  assert.throws(
    () => validateLegacyPositionCapture(
      'Long sequence',
      Array(11).fill('robot.turn("left", 180)').join('\n'),
    ),
    /five-minute capture limit/,
  );
});

test('DUET position capture accepts bounded base and arm commands', () => {
  const capture = validateDuetPositionCapture(
    'Move and turn',
    'duet.walk(1)\nduet.turn_left(1)\nduet.gesture_clap(1)',
  );

  assert.equal(capture.name, 'Move and turn');
  assert.equal(
    capture.code,
    'duet.walk(1)\nduet.turn_left(1)\nduet.gesture_clap(1)',
  );
});

test('rate-sweep movement programs are bounded forward/backward loops on both controllers', () => {
  const legacy = validateLegacyPositionCapture(
    'G1 sensor-rate sweep',
    'for i in range(10):\n    robot.walktime(1)\n    robot.backwardtime(1)',
  );
  const duet = validateDuetPositionCapture(
    'G1 sensor-rate sweep',
    'for _ in range(10):\n    duet.walk(1)\n    duet.backward(1)',
  );

  assert.equal(legacy.usesLocomotion, true);
  assert.equal(duet.usesLocomotion, true);
});

test('DUET position capture rejects concurrent, persistent, and oversized programs', () => {
  assert.throws(
    () => validateDuetPositionCapture(
      'Concurrent',
      'with duet.concurrent():\n    duet.walk(1)\n    duet.arm_carry(1)',
    ),
    /not conditions or concurrent blocks/,
  );
  assert.throws(
    () => validateDuetPositionCapture(
      'Persistent pose',
      'duet.hold_pose_until_reset(duet.pose("both_overhead"))',
    ),
    /must include duet\.reset_arms/,
  );
  assert.throws(
    () => validateDuetPositionCapture(
      'Long sequence',
      Array(20).fill('duet.hold_pose(duet.pose("both_overhead"), 30)').join('\n'),
    ),
    /five-minute capture limit/,
  );
  assert.throws(
    () => validateDuetPositionCapture(
      'Too many commands',
      Array(21).fill('duet.walk(1)').join('\n'),
    ),
    /at most 20 expanded commands/,
  );
});
