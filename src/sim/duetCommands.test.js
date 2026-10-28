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
import { getDuetArmCatalog, getDuetArmPoseNames, getDuetArmPoseTarget } from './duetArmCatalog.js';

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
    'hold_pose',
    'hold_pose_until_reset',
    'reset_arms',
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
    'gesture_kiss_both',
    'gesture_kiss_left',
    'gesture_kiss_right',
    'gesture_hands_up',
    'gesture_clap',
    'gesture_high_five_left',
    'gesture_high_five_right',
    'gesture_hug',
    'gesture_heart_both',
    'gesture_heart_left',
    'gesture_heart_right',
    'gesture_reject_left',
    'gesture_reject_right',
    'gesture_hand_up_left',
    'gesture_hand_up_right',
    'gesture_xray',
    'gesture_face_wave_left',
    'gesture_face_wave_right',
    'gesture_high_wave_left',
    'gesture_high_wave_right',
    'gesture_shake_hand_left',
    'gesture_shake_hand_right',
    'wait',
    'stop',
  ]);
  assert.ok(getDuetBlocklyCommandBlocks().every(({ type }) => (
    type.startsWith('duet_command_')
    || type.startsWith('duet_pose_target_')
    || type === 'duet_concurrent_action'
  )));
  assert.equal(getDuetBlocklyCommandBlocks().filter(({ category }) => category === 'Locomotion').length, 11);
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_concurrent_action').category, 'Concurrent actions');
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_command_arm_carry').category, 'Arm poses');
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_command_wave_left_mid').category, 'Arm gestures');
  assert.equal(getDuetBlocklyCommandBlocks().find(({ type }) => type === 'duet_command_gesture_kiss_both').category, 'Arm gestures');
  assert.ok(getDuetBlocklyCommandBlocks().some(({ type, output }) => (
    type === 'duet_pose_target_both_overhead' && output === 'String'
  )));
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

test('DUET arm pose targets are bounded and legacy gestures include their available side mirrors', () => {
  const catalog = getDuetArmCatalog();
  const poseNames = getDuetArmPoseNames();
  assert.equal(poseNames.length, new Set(poseNames).size);
  assert.deepEqual(Object.keys(catalog.gestures), [
    'legacy_kiss_both',
    'legacy_kiss_left',
    'legacy_kiss_right',
    'legacy_hands_up',
    'legacy_clap',
    'legacy_high_five_left',
    'legacy_high_five_right',
    'legacy_hug',
    'legacy_heart_both',
    'legacy_heart_left',
    'legacy_heart_right',
    'legacy_reject_left',
    'legacy_reject_right',
    'legacy_hand_up_left',
    'legacy_hand_up_right',
    'legacy_xray',
    'legacy_face_wave_left',
    'legacy_face_wave_right',
    'legacy_high_wave_left',
    'legacy_high_wave_right',
    'legacy_shake_hand_left',
    'legacy_shake_hand_right',
  ]);
  const left = getDuetArmPoseTarget('left_high_five');
  const right = getDuetArmPoseTarget('right_high_five');
  assert.deepEqual(right.slice(5), [
    left[0],
    -left[1],
    -left[2],
    left[3],
    -left[4],
  ]);
});

test('DUET named-pose holds round-trip, enforce bounds, and require reset before another arm motion', () => {
  const timedCode = 'duet.hold_pose(duet.pose("left_raise_mid"), 12)';
  const [timed] = parseDuetProgram(timedCode);
  assert.equal(timed.poseName, 'left_raise_mid');
  assert.deepEqual(timed.values, [12]);
  assert.equal(formatDuetProgram([timed]), timedCode);
  assert.equal(
    parseDuetProgram('duet.hold_pose_until_reset(duet.pose("both_overhead"))')[0].poseName,
    'both_overhead',
  );
  assert.throws(() => parseDuetProgram('duet.hold_pose(duet.pose("carry"), 31)'), /between 1 and 30/);
  assert.throws(() => parseDuetProgram('duet.hold_pose(duet.pose("unknown"), 2)'), /named DUET pose target/);
  assert.throws(
    () => parseDuetProgram('duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\nduet.gesture_clap(1)'),
    /Reset arms/,
  );
  assert.throws(
    () => parseDuetProgram('duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\nwith duet.concurrent():\n    duet.forward(1)\n    duet.arm_carry(1)'),
    /Reset arms/,
  );
  const resetProgram = 'duet.hold_pose_until_reset(duet.pose("left_raise_mid"))\n'
    + 'duet.wait(1)\n'
    + 'duet.reset_arms()\n'
    + 'duet.gesture_clap(1)';
  assert.equal(formatDuetProgram(parseDuetProgram(resetProgram)), resetProgram);
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
  assert.throws(() => parseDuetProgram('duet.stop()\nduet.wait(1)'), /must be the final command/);
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
