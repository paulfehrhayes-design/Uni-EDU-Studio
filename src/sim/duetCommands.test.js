import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DUET_COMMANDS,
  compileDuetMotionPrompt,
  flattenDuetCommands,
  formatDuetProgram,
  getDuetBlocklyCommandBlocks,
  parseDuetProgram,
} from './duetCommands.js';

test('DUET command catalog contains no legacy robot commands', () => {
  assert.deepEqual(DUET_COMMANDS.map(({ method }) => method), [
    'move',
    'forward',
    'backward',
    'strafe_left',
    'strafe_right',
    'turn_left',
    'turn_right',
    'arc_forward_left',
    'arc_forward_right',
    'arc_backward_left',
    'arc_backward_right',
    'arm_pose',
    'arm_motion',
    'wait',
    'stop',
  ]);
  assert.ok(getDuetBlocklyCommandBlocks().every(({ type }) => type.startsWith('duet_command_')));
  assert.equal(getDuetBlocklyCommandBlocks().filter(({ category }) => category === 'Locomotion').length, 11);
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_command_arm_pose').category, 'Arm poses');
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_command_arm_motion').category, 'Arm poses');
});

test('DUET preset commands have one bounded duration and parse as DUET-only syntax', () => {
  const nodes = parseDuetProgram(
    'duet.forward(1)\n'
    + 'duet.backward(0.5)\n'
    + 'duet.strafe_left(1)\n'
    + 'duet.strafe_right(1)\n'
    + 'duet.turn_left(1)\n'
    + 'duet.turn_right(1)\n'
    + 'duet.arc_forward_left(1)\n'
    + 'duet.arc_forward_right(1)\n'
    + 'duet.arc_backward_left(1)\n'
    + 'duet.arc_backward_right(1)',
  );
  assert.equal(flattenDuetCommands(nodes).length, 10);
  assert.throws(() => parseDuetProgram('duet.forward(3.1)'), /between 0.1 and 3/);
});

test('DUET arm commands are restricted to named poses and bounded lease durations', () => {
  const arm = parseDuetProgram('duet.arm_pose("forward", 1.5)')[0];
  assert.deepEqual(arm.values, ['forward', 1.5]);
  assert.equal(arm.code, 'duet.arm_pose("forward", 1.5)');
  assert.throws(() => parseDuetProgram('duet.arm_pose("wave", 1)'), /must be one of carry, forward, box_hold/);
  assert.throws(() => parseDuetProgram('duet.arm_pose("forward", 0.5)'), /between 1 and 3/);
  assert.throws(() => parseDuetProgram('duet.arm_pose("forward", 3.1)'), /between 1 and 3/);
});

test('DUET arm motion macros expand only into bounded existing named-pose commands', () => {
  const nodes = parseDuetProgram('duet.arm_motion("receive_hold_return", 1.5)');
  assert.equal(nodes[0].method, 'arm_motion');
  assert.deepEqual(nodes[0].values, ['receive_hold_return', 1.5]);
  assert.equal(nodes[0].code, 'duet.arm_motion("receive_hold_return", 1.5)');
  assert.throws(() => parseDuetProgram('duet.arm_motion("wave", 1.5)'), /must be one of/);
  assert.throws(() => parseDuetProgram('duet.arm_motion("reach_and_return", 0.5)'), /between 1 and 3/);
  assert.throws(
    () => parseDuetProgram(
      'for _ in range(10):\n'
      + '    for _ in range(10):\n'
      + '        duet.arm_motion("receive_hold_return", 1.5)',
    ),
    /at most 100 expanded commands/,
  );
});

test('DUET parser normalizes commands and bounded loops', () => {
  const code = 'for _ in range(2):\n    duet.move(0.2, 0, 0, 1)\nduet.stop()';
  const nodes = parseDuetProgram(code);
  assert.equal(formatDuetProgram(nodes), code);
  assert.equal(flattenDuetCommands(nodes).length, 3);
});

test('DUET parser rejects legacy commands and unsupported syntax', () => {
  assert.throws(() => parseDuetProgram('robot.walk(1)'), /Unsupported statement/);
  assert.throws(() => parseDuetProgram('duet.raw_joint(1)'), /Unknown DUET command/);
  assert.throws(() => parseDuetProgram('if True:\n    duet.stop()'), /Unsupported statement/);
});

test('DUET parser rejects unsafe values instead of silently clamping them', () => {
  assert.throws(() => parseDuetProgram('duet.move(0.31, 0, 0, 1)'), /between -0.2 and 0.3/);
  assert.throws(() => parseDuetProgram('duet.move(0, 0.16, 0, 1)'), /between -0.15 and 0.15/);
  assert.throws(() => parseDuetProgram('duet.wave("left", "mid", 1)'), /Unknown DUET command/);
  assert.throws(() => parseDuetProgram('duet.raise_arm("both", "mid", 1)'), /Unknown DUET command/);
  assert.throws(() => parseDuetProgram('duet.wait(3.1)'), /between 0.1 and 3/);
});

test('DUET parser bounds loop depth and expanded command count', () => {
  assert.throws(() => parseDuetProgram('for _ in range(11):\n    duet.stop()'), /between 1 and 10/);
  assert.throws(() => parseDuetProgram('for _ in range(10):\n    for _ in range(10):\n        for _ in range(2):\n            duet.stop()'), /at most 100 expanded commands/);
});

test('DUET prompt compiler preserves supported duration and rejects approximated units', () => {
  const supported = compileDuetMotionPrompt('walk forward for 2 seconds');
  assert.equal(supported.code, 'duet.move(0.15, 0, 0, 2)');
  assert.deepEqual(supported.unknown, []);

  for (const prompt of [
    'walk forward 3 steps',
    'turn left 90 degrees',
    'walk forward for 10 seconds',
    'wave left for 2 minutes',
    'raise both arms to 45 degrees',
  ]) {
    const result = compileDuetMotionPrompt(prompt);
    assert.equal(result.code, '', prompt);
    assert.ok(result.unknown.length > 0, prompt);
  }
  assert.match(compileDuetMotionPrompt('wave left').unknown.join(' '), /hardware-validated arm-target gateway/);
});
