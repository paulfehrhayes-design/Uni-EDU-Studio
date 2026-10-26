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
    'arm_carry',
    'arm_reach',
    'arm_box_hold',
    'reach_and_return',
    'receive_and_hold',
    'hold_and_return',
    'receive_hold_return',
    'wave_left_low',
    'wave_left_mid',
    'wave_left_high',
    'wave_right_low',
    'wave_right_mid',
    'wave_right_high',
    'raise_left_arm_low',
    'raise_left_arm_mid',
    'raise_left_arm_high',
    'raise_right_arm_low',
    'raise_right_arm_mid',
    'raise_right_arm_high',
    'raise_both_arms_low',
    'raise_both_arms_mid',
    'raise_both_arms_high',
    'wait',
    'stop',
  ]);
  assert.ok(getDuetBlocklyCommandBlocks().every(({ type }) => (
    type.startsWith('duet_command_') || type === 'duet_concurrent_action'
  )));
  assert.equal(getDuetBlocklyCommandBlocks().filter(({ category }) => category === 'Locomotion').length, 11);
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_concurrent_action').category, 'Concurrent actions');
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_command_arm_carry').category, 'Arm poses');
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_command_wave_left_mid').category, 'Arm poses');
  assert.ok(DUET_COMMANDS.filter(({ armPoses }) => armPoses).every(({ args }) => (
    args.every((argument) => argument.kind !== 'choice')
  )));
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

test('DUET concurrent container pairs any supported locomotion command with a separate arm gesture block', () => {
  const code = 'with duet.concurrent():\n'
    + '    duet.arc_forward_left(1.5)\n'
    + '    duet.wave_left_mid(1.5)';
  const [node] = parseDuetProgram(code);
  assert.equal(node.type, 'concurrent');
  assert.equal(node.movement.method, 'arc_forward_left');
  assert.equal(node.gesture.method, 'wave_left_mid');
  assert.equal(formatDuetProgram([node]), code);
  for (const invalid of [
    'with duet.concurrent():\n    duet.wave_left_mid(1.5)\n    duet.arm_reach(1.5)',
    'with duet.concurrent():\n    duet.forward(1)\n    duet.turn_left(1)',
    'with duet.concurrent():\n    duet.forward(1)',
    'with duet.concurrent():\n    duet.forward(1)\n    duet.arm_reach(1.5)\n    duet.arm_carry(1.5)',
  ]) {
    assert.throws(() => parseDuetProgram(invalid), /Concurrent action/);
  }
});

test('bounded loops repeat concurrent pairs while ordinary commands remain sequential', () => {
  const code = 'duet.wait(0.5)\n'
    + 'for _ in range(2):\n'
    + '    with duet.concurrent():\n'
    + '        duet.forward(1)\n'
    + '        duet.arm_reach(1.5)\n'
    + 'duet.wait(0.5)';
  const nodes = parseDuetProgram(code);
  assert.equal(nodes[0].method, 'wait');
  assert.equal(nodes[1].type, 'repeat');
  assert.equal(nodes[1].times, 2);
  assert.deepEqual(flattenDuetCommands(nodes).map(({ method }) => method), [
    'wait',
    undefined,
    undefined,
    'wait',
  ]);
  assert.equal(formatDuetProgram(nodes), code);
});

test('DUET programs have no aggregate duration cap beyond the expanded-command limit', () => {
  const concurrentRepeat = 'for _ in range(10):\n'
    + '    for _ in range(10):\n'
    + '        duet.wait(3)';
  const nodes = parseDuetProgram(concurrentRepeat);
  assert.equal(flattenDuetCommands(nodes).length, 100);
  assert.equal(flattenDuetCommands(nodes).reduce((total, node) => total + node.values[0], 0), 300);
});

test('DUET arm poses use separate commands with bounded durations', () => {
  const arm = parseDuetProgram('duet.arm_reach(1.5)')[0];
  assert.deepEqual(arm.values, [1.5]);
  assert.equal(arm.code, 'duet.arm_reach(1.5)');
  assert.equal(parseDuetProgram('duet.arm_carry(1.5)')[0].method, 'arm_carry');
  assert.equal(parseDuetProgram('duet.arm_box_hold(1.5)')[0].method, 'arm_box_hold');
  assert.throws(() => parseDuetProgram('duet.arm_reach(0.5)'), /between 1 and 3/);
  assert.throws(() => parseDuetProgram('duet.arm_reach(3.1)'), /between 1 and 3/);
});

test('DUET arm motion macros and safe mirrored presets expand only into bounded existing named-pose commands', () => {
  const nodes = parseDuetProgram('duet.receive_hold_return(1.5)');
  assert.equal(nodes[0].method, 'receive_hold_return');
  assert.deepEqual(nodes[0].values, [1.5]);
  assert.equal(nodes[0].code, 'duet.receive_hold_return(1.5)');

  const leftWave = parseDuetProgram('duet.wave_left_mid(1.5)');
  assert.equal(leftWave[0].method, 'wave_left_mid');
  assert.deepEqual(leftWave[0].values, [1.5]);
  assert.equal(leftWave[0].code, 'duet.wave_left_mid(1.5)');

  assert.throws(() => parseDuetProgram('duet.wave_left_urgent(1.5)'), /Unknown DUET command/);
  assert.throws(() => parseDuetProgram('duet.receive_hold_return(0.5)'), /between 1 and 3/);
  assert.throws(
    () => parseDuetProgram(
      'for _ in range(20):\n'
      + '    for _ in range(20):\n'
      + '        duet.receive_hold_return(1.5)',
    ),
    /at most 400 expanded commands/,
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
  assert.throws(() => parseDuetProgram('duet.raw_joint(1)'), /Unknown DUET command/);
  assert.throws(() => parseDuetProgram('duet.wait(3.1)'), /between 0.1 and 3/);
});

test('DUET parser bounds loop depth and expanded command count', () => {
  assert.equal(flattenDuetCommands(parseDuetProgram('for _ in range(20):\n    duet.wait(0.1)')).length, 20);
  const fourHundredRepeats = 'for _ in range(20):\n'
    + '    for _ in range(20):\n'
    + '        duet.wait(3)';
  assert.equal(flattenDuetCommands(parseDuetProgram(fourHundredRepeats)).length, 400);
  assert.equal(
    flattenDuetCommands(parseDuetProgram(fourHundredRepeats))
      .reduce((total, node) => total + node.values[0], 0),
    1200,
  );
  assert.throws(() => parseDuetProgram('for _ in range(21):\n    duet.stop()'), /between 1 and 20/);
  assert.throws(() => parseDuetProgram(`${fourHundredRepeats}\nduet.wait(0.1)`), /at most 400 expanded commands/);
  assert.throws(() => parseDuetProgram(
    'for _ in range(20):\n'
      + '    for _ in range(20):\n'
      + '        for _ in range(2):\n'
      + '            duet.wait(0.1)',
  ), /at most 400 expanded commands/);
});

test('DUET prompt compiler preserves supported duration and accepts safe bounded arm gestures', () => {
  const supported = compileDuetMotionPrompt('walk forward for 2 seconds');
  assert.equal(supported.code, 'duet.move(0.15, 0, 0, 2)');
  assert.deepEqual(supported.unknown, []);

  const waveResult = compileDuetMotionPrompt('wave left for 1 second');
  assert.equal(waveResult.code, 'duet.wave_left("mid", 1)');
  assert.deepEqual(waveResult.unknown, []);

  const raiseResult = compileDuetMotionPrompt('raise both arms high for 2 seconds');
  assert.equal(raiseResult.code, 'duet.raise_both_arms("high", 2)');
  assert.deepEqual(raiseResult.unknown, []);

  for (const prompt of [
    'walk forward 3 steps',
    'turn left 90 degrees',
    'walk forward for 10 seconds',
    'wave left for 2 minutes',
    'raise both arms to 45 degrees',
  ]) {
    const result = compileDuetMotionPrompt(prompt);
    if (prompt === 'wave left for 2 minutes' || prompt === 'raise both arms to 45 degrees') {
      assert.ok(result.code === '' || result.unknown.length > 0, prompt);
      continue;
    }
    assert.equal(result.code, '', prompt);
    assert.ok(result.unknown.length > 0, prompt);
  }
});
