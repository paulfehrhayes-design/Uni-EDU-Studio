import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenG1Commands, formatG1Program, G1_COMMANDS, G1_EXECUTABLE_COMMANDS, G1_NOMINAL_STEP_METERS, getG1BlocklyCommandBlocks, parseG1Program } from './g1Commands.js';
import { compileMotionPrompt } from './textToMotion.js';
import { buildG1SimulationFrames } from './g1Edu23Env.js';

test('G1 command catalog emits matching bounded Blockly commands', () => {
  const blocks = getG1BlocklyCommandBlocks();
  assert.ok(blocks.some((block) => block.type === 'g1_command_walk'));
  assert.ok(blocks.some((block) => block.type === 'g1_command_backwardtime'));
  assert.ok(blocks.every((block) => block.codeTemplate.startsWith('robot.')));
  assert.deepEqual(
    blocks.map((block) => block.type),
    [
      ...G1_EXECUTABLE_COMMANDS.filter((command) => command.method !== 'arm_action')
        .slice(0, 12).map((command) => command.blockType),
      'g1_command_squat_to_stand',
      'g1_command_lie_to_stand',
      'g1_command_stand_to_squat',
      'g1_command_arm_action_release_arm',
      'g1_command_arm_action_two_hand_kiss',
      'g1_command_arm_action_left_kiss',
      'g1_command_arm_action_right_kiss',
      'g1_command_arm_action_hands_up',
      'g1_command_arm_action_clap',
      'g1_command_arm_action_high_five',
      'g1_command_arm_action_hug',
      'g1_command_arm_action_heart',
      'g1_command_arm_action_right_heart',
      'g1_command_arm_action_reject',
      'g1_command_arm_action_right_hand_up',
      'g1_command_arm_action_x_ray',
      'g1_command_arm_action_face_wave',
      'g1_command_arm_action_high_wave',
      'g1_command_arm_action_shake_hand',
      ...G1_EXECUTABLE_COMMANDS.filter((command) => command.method !== 'arm_action')
        .slice(12).map((command) => command.blockType),
    ],
  );
  assert.ok(blocks.every((block) => G1_EXECUTABLE_COMMANDS.some((command) => (
    command.blockType === block.type
    || (command.method === 'arm_action' && block.armPreset && command.args[0].choices.some(([, preset]) => preset === block.armPreset))
  ))));
  assert.ok(G1_EXECUTABLE_COMMANDS.some((command) => command.method === 'arm_action' && command.category === 'Gestures'));
  assert.ok(getG1BlocklyCommandBlocks(G1_COMMANDS).some((block) => block.type === 'g1_command_kickleftDegrees'));
  assert.deepEqual(
    G1_EXECUTABLE_COMMANDS.slice(0, 12).map((command) => command.method),
    ['stand', 'sit', 'walk', 'walktime', 'backward', 'backwardtime', 'sidestep', 'slowwalk', 'slowwalktime', 'fastwalk', 'fastwalktime', 'turn'],
  );
  assert.deepEqual(
    G1_EXECUTABLE_COMMANDS.filter((command) => command.category === 'Postures').map(({ method }) => method),
    ['squat_to_stand', 'lie_to_stand', 'stand_to_squat'],
  );
  assert.equal(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'squat_to_stand').sdkMethod, 'LocoClient.SetFsmId(706) / Squat2StandUp');
  assert.equal(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'lie_to_stand').sdkMethod, 'LocoClient.SetFsmId(702) / Lie2StandUp');
  assert.equal(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'stand_to_squat').sdkMethod, 'LocoClient.SetFsmId(706) / StandUp2Squat');
  assert.equal(G1_EXECUTABLE_COMMANDS[0].sdkMethod, 'LocoClient.Start() / SetFsmId(500)');
  assert.equal(G1_EXECUTABLE_COMMANDS[1].sdkMethod, 'LocoClient.Sit (SetFsmId(3))');
  assert.ok(G1_EXECUTABLE_COMMANDS.slice(2, 12).every((command) => command.sdkMethod === 'LocoClient.SetVelocity'));
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'walk').description, /34.5 cm per count/);
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'walk').description, /0\.86 s/);
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'slowwalk').description, /1\.73 s/);
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'fastwalk').description, /0\.43 s/);
  assert.ok(G1_EXECUTABLE_COMMANDS.some((command) => command.method === 'getactions' && command.sdkMethod === 'G1ArmActionClient.GetActionList'));
  assert.ok(G1_EXECUTABLE_COMMANDS.some((command) => command.method === 'say' && command.sdkMethod === 'AudioClient.TtsMaker'));
  const sayBlock = blocks.find((block) => block.type === 'g1_command_say');
  assert.deepEqual(sayBlock.stringFields, ['TEXT']);
  assert.equal(sayBlock.args0[0].type, 'field_input');
  assert.equal(sayBlock.args0[1].type, 'field_dropdown');
  assert.ok(G1_EXECUTABLE_COMMANDS.filter((command) => ['Audio', 'Diagnostics'].includes(command.category))
    .every((command) => !command.adapters.simulator));
  assert.ok(G1_COMMANDS.filter((command) => !['Audio', 'Diagnostics'].includes(command.category))
    .every((entry) => entry.adapters.simulator));
  assert.ok(G1_COMMANDS.every((entry) => entry.adapters.sdk === entry.physicalSupported));
  assert.ok(G1_COMMANDS.every((entry) => entry.adapters.webRtc === false));
  assert.equal(G1_NOMINAL_STEP_METERS, 0.345);
  const armPreset = G1_COMMANDS.find((entry) => entry.method === 'arm_action');
  assert.equal(armPreset.physicalSupported, true);
  assert.equal(armPreset.args[0].choices.length, 16);
  assert.equal(blocks.filter((block) => block.armPreset).length, 16);
  assert.ok(!blocks.some((block) => block.type === armPreset.blockType));
  assert.equal(
    blocks.find((block) => block.armPreset === 'hands up').codeTemplate,
    'robot.arm_action("hands up")\n',
  );
  assert.ok(!blocks.some((block) => block.type === G1_COMMANDS.find((entry) => entry.method === 'simulate_arm_action').blockType));
  assert.match(armPreset.description, /cannot cancel an active arm preset/);
});

test('G1 program parser normalizes commands, clamps numbers, and expands loops', () => {
  const nodes = parseG1Program('robot.walk(99)\nfor _ in range(2):\n    robot.turn("left")\n');
  assert.equal(nodes[0].code, 'robot.walk(10)');
  assert.equal(nodes[1].times, 2);
  assert.equal(nodes[1].body[0].code, 'robot.turn("left", 90)');
  assert.equal(flattenG1Commands(nodes).length, 3);
});

test('G1 program formatter preserves executable loop structure', () => {
  const nodes = parseG1Program('for _ in range(2):\n    robot.waveleft("high")\n');
  assert.equal(formatG1Program(nodes), 'for _ in range(2):\n    robot.waveleft("high")');
});

test('G1 parser reads Blockly Python formatting and semicolon-terminated commands', () => {
  const nodes = parseG1Program('for count in range(2):\n  robot.walk(3);\n');
  assert.equal(nodes[0].times, 2);
  assert.equal(nodes[0].body[0].code, 'robot.walk(3)');
});

test('G1 parser reads multiple student IDE lines and nested repeat blocks', () => {
  const nodes = parseG1Program(
    'robot.walk(2)\n'
    + 'for _ in range(3):\n'
    + '    robot.turn("left", 90)\n'
    + '    robot.backward(1)\n'
    + 'robot.stand()\n',
  );
  assert.deepEqual(nodes.map((node) => node.type), ['command', 'repeat', 'command']);
  assert.equal(nodes[0].code, 'robot.walk(2)');
  assert.equal(nodes[1].times, 3);
  assert.deepEqual(nodes[1].body.map(({ code }) => code), ['robot.turn("left", 90)', 'robot.backward(1)']);
  assert.equal(nodes[2].code, 'robot.stand()');
});

test('G1 posture commands parse and preview distinct simulator transitions', () => {
  const methods = ['squat_to_stand', 'lie_to_stand', 'stand_to_squat'];
  methods.forEach((method) => {
    assert.equal(parseG1Program(`robot.${method}()`)[0].code, `robot.${method}()`);
    const frames = buildG1SimulationFrames(`robot.${method}()`);
    assert.equal(frames.at(-1).actions.at(-1).label, {
      squat_to_stand: 'Squat to stand',
      lie_to_stand: 'Lie to stand',
      stand_to_squat: 'Stand to squat',
    }[method]);
  });

  const squat = buildG1SimulationFrames('robot.stand_to_squat()').at(-1);
  assert.equal(squat.joints.left_knee_pitch, 105);
  assert.equal(squat.torsoPitch, 16);
  const standing = buildG1SimulationFrames('robot.squat_to_stand()').at(-1);
  assert.equal(standing.torsoPitch, 0);
});

test('G1 parser safely normalizes SDK diagnostics and audio arguments', () => {
  const nodes = parseG1Program(
    'robot.say("Hello, \\"G1\\"!", 1)\n'
    + 'robot.setvolume(120)\n'
    + 'robot.led(10, 20, 300)\n'
    + 'robot.playstop("classroom-audio")\n'
    + 'robot.getactions()\n',
  );
  assert.deepEqual(nodes.map(({ method, values, code }) => ({ method, values, code })), [
    { method: 'say', values: ['Hello, "G1"!', 1], code: 'robot.say("Hello, \\"G1\\"!", 1)' },
    { method: 'setvolume', values: [70], code: 'robot.setvolume(70)' },
    { method: 'led', values: [10, 20, 255], code: 'robot.led(10, 20, 255)' },
    { method: 'playstop', values: ['classroom-audio'], code: 'robot.playstop("classroom-audio")' },
    { method: 'getactions', values: [], code: 'robot.getactions()' },
  ]);
  assert.throws(() => parseG1Program(`robot.say("${'a'.repeat(121)}", 1)`), /printable characters/);
  assert.throws(() => parseG1Program('robot.say("hello", 2)'), /speaker must be one of 0, 1/);
});

test('G1 program parser rejects unknown commands and loop counts outside safe limits', () => {
  assert.throws(() => parseG1Program('robot.moveTo(1, 2)'), /Unknown robot command/);
  assert.throws(() => parseG1Program('for _ in range(21):\n    robot.stand()'), /between 1 and 20/);
});

test('prompt output uses only shared catalog commands', () => {
  const result = compileMotionPrompt('Walk backward for 2 seconds, turn right 45 degrees, and wave high');
  assert.match(result.code, /robot\.backwardtime\(2\)/);
  assert.match(result.code, /robot\.turn\("right", 45\)/);
  assert.match(result.code, /robot\.waveleft\("high"\)/);
  assert.doesNotThrow(() => parseG1Program(result.code));
});

test('simulation expands the same bounded IDE loop syntax', () => {
  const finalFrame = buildG1SimulationFrames('for _ in range(0, 2):\n    robot.walk(1)').at(-1);
  assert.ok(Math.abs(finalFrame.x - 2 * G1_NOMINAL_STEP_METERS) < 1e-9);
});

test('legacy arm presets share the same approximate simulation and executable command', () => {
  const frames = buildG1SimulationFrames('robot.arm_action("hands up")');
  const finalFrame = frames.at(-1);

  assert.match(finalFrame.actions[0].label, /hands up/i);
  assert.match(finalFrame.actions[0].summary, /Approximate simulator pose/);
  assert.ok(finalFrame.joints.left_shoulder_pitch < 0);
  assert.ok(finalFrame.joints.right_shoulder_pitch < 0);

  const presets = G1_COMMANDS.find((entry) => entry.method === 'arm_action').args[0].choices;
  presets.forEach(([, preset]) => {
    const presetFrame = buildG1SimulationFrames(`robot.arm_action(${JSON.stringify(preset)})`).at(-1);
    assert.match(presetFrame.actions[0].label, new RegExp(preset, 'i'));
  });
});

test('sit command is available in simulator with an approximate seated pose', () => {
  const finalFrame = buildG1SimulationFrames('robot.sit()').at(-1);

  assert.equal(finalFrame.actions[0].label, 'Sit');
  assert.equal(finalFrame.torsoPitch, 12);
});
