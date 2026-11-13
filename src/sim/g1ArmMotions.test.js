import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLegacyArmMotion } from './g1ArmMotions.js';

test('legacy recording accepts approved arm actions and bounded waits', () => {
  const motion = validateLegacyArmMotion(
    '  Face wave  ',
    'robot.arm_action("face wave")\nrobot.wait(1)',
  );
  assert.equal(motion.name, 'Face wave');
  assert.match(motion.code, /robot\.arm_action\("face wave"\)/);
});

test('legacy recording rejects non-arm commands, empty programs, and conditional motion', () => {
  assert.throws(() => validateLegacyArmMotion('Walk', 'robot.walk(1)'), /only arm actions/);
  assert.throws(() => validateLegacyArmMotion('Empty', '# nothing'), /one or more/);
  assert.throws(() => validateLegacyArmMotion(
    'Conditional',
    'if robot.front_distance_m() < 1:\n    robot.arm_action("face wave")',
  ), /conditions or Boolean assignments/);
});
