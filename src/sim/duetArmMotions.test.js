import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDuetArmMotionsStorageKey,
  parseSavedDuetArmMotions,
  validateDuetArmMotion,
} from './duetArmMotions.js';

test('saved arm sequences normalize approved pose commands and bounded loops', () => {
  const saved = validateDuetArmMotion(
    '  Overhead hold  ',
    'for _ in range(2):\n'
      + '    duet.hold_pose(duet.pose("both_overhead"), 5)\n'
      + 'duet.reset_arms()',
  );

  assert.deepEqual(saved, {
    name: 'Overhead hold',
    code: 'for _ in range(2):\n'
      + '    duet.hold_pose(duet.pose("both_overhead"), 5)\n'
      + 'duet.reset_arms()',
  });
});

test('saved arm sequences reject locomotion, concurrent blocks, and empty programs', () => {
  for (const code of [
    'duet.forward(1)',
    'with duet.concurrent():\n    duet.forward(1)\n    duet.gesture_clap(1)',
    '',
  ]) {
    assert.throws(() => validateDuetArmMotion('Invalid sequence', code));
  }
});

test('saved arm sequences must reset persistent poses to remain reusable', () => {
  assert.throws(
    () => validateDuetArmMotion(
      'Persistent pose',
      'duet.hold_pose_until_reset(duet.pose("both_overhead"))',
    ),
    /must include duet\.reset_arms\(\)/,
  );
  assert.doesNotThrow(() => validateDuetArmMotion(
    'Resettable pose',
    'duet.hold_pose_until_reset(duet.pose("both_overhead"))\n'
      + 'duet.reset_arms()',
  ));
});

test('saved arm sequence names and code are bounded and non-empty', () => {
  assert.throws(() => validateDuetArmMotion('', 'duet.gesture_clap(1)'), /names must contain/);
  assert.throws(() => validateDuetArmMotion('x'.repeat(41), 'duet.gesture_clap(1)'), /names must contain/);
  assert.throws(() => validateDuetArmMotion('Clap', 'x'.repeat(10_001)), /no longer than/);
  assert.throws(() => validateDuetArmMotion('Clap', 'duet.raw_joint(1)'), /Unknown DUET command/);
});

test('saved arm sequences parse persisted data and reject corrupt or duplicate entries', () => {
  assert.deepEqual(parseSavedDuetArmMotions(null), []);
  assert.deepEqual(
    parseSavedDuetArmMotions(JSON.stringify([{ name: 'Clap', code: 'duet.gesture_clap(1)' }])),
    [{ name: 'Clap', code: 'duet.gesture_clap(1)' }],
  );
  assert.throws(() => parseSavedDuetArmMotions('{'), /invalid JSON/);
  assert.throws(() => parseSavedDuetArmMotions(JSON.stringify([
    { name: 'Clap', code: 'duet.gesture_clap(1)' },
    { name: ' clap ', code: 'duet.gesture_hug(1)' },
  ])), /appears more than once/);
});

test('saved arm sequence storage is isolated by normalized user name', () => {
  assert.equal(getDuetArmMotionsStorageKey('Student A'), getDuetArmMotionsStorageKey(' student a '));
  assert.notEqual(getDuetArmMotionsStorageKey('student-a'), getDuetArmMotionsStorageKey('student-b'));
  assert.equal(getDuetArmMotionsStorageKey(''), 'uni-edu-duet-arm-motions:guest');
});
