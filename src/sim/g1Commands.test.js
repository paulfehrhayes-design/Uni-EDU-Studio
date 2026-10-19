import test from 'node:test';
import assert from 'node:assert/strict';
import * as Blockly from 'blockly';
import { pythonGenerator } from 'blockly/python';
import { flattenG1Commands, formatG1Program, G1_COMMANDS, G1_EXECUTABLE_COMMANDS, G1_NOMINAL_STEP_METERS, getG1BlocklyCommandBlocks, getG1BlocklyConditionBlocks, parseG1Program } from './g1Commands.js';
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
      'g1_command_hold_arm',
      'g1_command_getfsm',
      'g1_command_getactions',
      'g1_command_say',
      'g1_command_getvolume',
      'g1_command_setvolume',
      'g1_command_led',
      'g1_command_playstop',
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
    ['stand', 'wait', 'walk', 'walktime', 'backward', 'backwardtime', 'sidestep', 'slowwalk', 'slowwalktime', 'fastwalk', 'fastwalktime', 'turn'],
  );
  assert.deepEqual(
    G1_EXECUTABLE_COMMANDS.filter((command) => command.category === 'Postures').map(({ method }) => method),
    ['squat_to_stand', 'lie_to_stand', 'stand_to_squat'],
  );
  assert.equal(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'squat_to_stand').sdkMethod, 'LocoClient.SetFsmId(706) / Squat2StandUp');
  assert.equal(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'lie_to_stand').sdkMethod, 'LocoClient.SetFsmId(702) / Lie2StandUp');
  assert.equal(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'stand_to_squat').sdkMethod, 'LocoClient.SetFsmId(706) / StandUp2Squat');
  assert.equal(G1_EXECUTABLE_COMMANDS[0].sdkMethod, 'LocoClient.Start() / SetFsmId(500)');
  assert.equal(G1_EXECUTABLE_COMMANDS[1].sdkMethod, null);
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'wait').description, /Pause/);
  assert.ok(G1_EXECUTABLE_COMMANDS.filter((command) => ['walk', 'walktime', 'backward', 'backwardtime', 'sidestep', 'slowwalk', 'slowwalktime', 'fastwalk', 'fastwalktime', 'turn'].includes(command.method))
    .every((command) => command.sdkMethod === 'LocoClient.SetVelocity'));
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'walk').description, /Walk forward/);
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'walk').description, /may vary/);
  assert.ok(G1_EXECUTABLE_COMMANDS.some((command) => command.method === 'getactions' && command.sdkMethod === 'G1ArmActionClient.GetActionList'));
  assert.ok(G1_EXECUTABLE_COMMANDS.some((command) => command.method === 'say' && command.sdkMethod === 'AudioClient.TtsMaker'));
  const audioMethods = ['say', 'getvolume', 'setvolume', 'led', 'playstop'];
  assert.deepEqual(
    G1_EXECUTABLE_COMMANDS.filter((command) => command.category === 'Audio').map(({ method }) => method),
    audioMethods,
  );
  assert.ok(audioMethods.every((method) => blocks.some((block) => block.type === `g1_command_${method}`)));
  const sayBlock = blocks.find((block) => block.type === 'g1_command_say');
  assert.deepEqual(sayBlock.stringFields, ['TEXT']);
  assert.equal(sayBlock.args0[0].type, 'field_input');
  assert.equal(sayBlock.args0[1].type, 'field_dropdown');
  assert.equal(sayBlock.message0, 'Speak %1 with voice %2');
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
  assert.match(armPreset.description, /Stop cannot cancel an arm preset/);
  assert.match(G1_EXECUTABLE_COMMANDS.find((command) => command.method === 'playstop').description, /placeholder app name, not a sound/);
  assert.equal(
    blocks.find((block) => block.type === 'g1_command_arm_action_hands_up').tooltip.startsWith('Raise both hands.'),
    true,
  );
  assert.equal(
    getG1BlocklyCommandBlocks(G1_COMMANDS).find((block) => block.type === 'g1_command_waveleft').tooltip.endsWith('This action is only available in the simulator.'),
    true,
  );
});

test('all executable Blockly command blocks instantiate successfully', () => {
  const blocks = getG1BlocklyCommandBlocks(G1_EXECUTABLE_COMMANDS);
  const definitions = blocks.map((block) => {
    const definition = { ...block };
    delete definition.codeTemplate;
    delete definition.stringFields;
    delete definition.category;
    delete definition.armPreset;
    return definition;
  });
  Blockly.common.defineBlocksWithJsonArray(definitions);
  const workspace = new Blockly.Workspace();

  try {
    blocks.forEach(({ type }) => workspace.newBlock(type));
  } finally {
    workspace.dispose();
  }
});

test('G1 program parser normalizes commands, clamps numbers, and expands loops', () => {
  const nodes = parseG1Program('robot.walk(99)\nfor _ in range(2):\n    robot.turn("left")\n');
  assert.equal(nodes[0].code, 'robot.walk(10)');
  assert.equal(nodes[1].times, 2);
  assert.equal(nodes[1].body[0].code, 'robot.turn("left", 90)');
  assert.equal(flattenG1Commands(nodes).length, 3);
});

test('wait command is bounded, included in the IDE catalog, and previews its full duration', () => {
  const waitCommand = G1_COMMANDS.find((command) => command.method === 'wait');
  const [waitBlock] = getG1BlocklyCommandBlocks([waitCommand]);
  assert.equal(waitBlock.message0, 'Wait for %1 seconds');
  assert.deepEqual(
    [waitBlock.args0[0].value, waitBlock.args0[0].min, waitBlock.args0[0].max, waitBlock.args0[0].precision],
    [1, 0.1, 10, 0.001],
  );
  assert.equal(parseG1Program('robot.wait(0.1)')[0].values[0], 0.1);
  assert.equal(parseG1Program('robot.wait(2)')[0].code, 'robot.wait(2)');
  assert.equal(parseG1Program('robot.wait(2);')[0].code, 'robot.wait(2)');
  assert.equal(parseG1Program('robot.wait(99)')[0].code, 'robot.wait(10)');
  const frames = buildG1SimulationFrames('robot.wait(2)');
  assert.ok(Math.abs(frames.at(-1).time - 2) < 1e-9);
  assert.equal(frames.at(-1).actions.length, 1);
  assert.equal(frames.at(-1).actions[0].label, 'Wait');
});

test('G1 program formatter preserves executable loop structure', () => {
  const nodes = parseG1Program('for _ in range(2):\n    robot.waveleft("high")\n');
  assert.equal(formatG1Program(nodes), 'for _ in range(2):\n    robot.waveleft("high")');
});

test('distance conditions preserve if/then and if/then/else branches in IDE code', () => {
  const code = [
    'if robot.front_distance_m() < 1.25:',
    '    robot.walk(2)',
    'else:',
    '    robot.turn("left", 90)',
  ].join('\n');
  const nodes = parseG1Program(code);

  assert.equal(nodes[0].type, 'condition');
  assert.equal(nodes[0].sensor, 'front_distance_m');
  assert.equal(nodes[0].operator, '<');
  assert.equal(nodes[0].threshold, 1.25);
  assert.equal(nodes[0].then[0].method, 'walk');
  assert.equal(nodes[0].else[0].method, 'turn');
  assert.equal(formatG1Program(nodes), code);
  assert.throws(() => flattenG1Commands(nodes), /cannot be flattened without sensor data/);
});

test('distance conditions support nested branches and bounds without flattening their logic', () => {
  const nodes = parseG1Program(
    'for _ in range(2):\n'
    + '    if robot.front_distance_m() <= 0.5:\n'
    + '        robot.walktime(0.2)\n'
    + '    else:\n'
    + '        robot.turn("right", 45)',
  );
  assert.equal(nodes[0].type, 'repeat');
  assert.equal(nodes[0].times, 2);
  assert.equal(nodes[0].body[0].type, 'condition');
  assert.equal(formatG1Program(nodes).includes('else:'), true);
  assert.throws(
    () => parseG1Program('if robot.front_distance_m() < 0.01:\n    robot.walk(1)'),
    /between 0.1 and 40 meters/,
  );
  assert.doesNotThrow(() => parseG1Program(
    'if robot.front_distance_m() < 40:\n    robot.walk(1)',
  ));
  assert.throws(
    () => parseG1Program('if robot.front_distance_m() < 1:\n    robot.walk(1)\nelse:\n    '),
    /no body/,
  );
});

test('rear distance conditions round-trip through the same structured parser', () => {
  const code = 'if robot.rear_distance_m() < 0.8:\n'
    + '    robot.backward(1)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)';
  const [node] = parseG1Program(code);
  assert.equal(node.sensor, 'rear_distance_m');
  assert.equal(node.then[0].method, 'backward');
  assert.equal(formatG1Program([node]), code);
  assert.ok(getG1BlocklyConditionBlocks().some((block) => block.type === 'g1_rear_distance_m'));
});

test('distance condition Blockly value block is a numeric expression', () => {
  const [distanceBlock] = getG1BlocklyConditionBlocks();
  const definition = { ...distanceBlock };
  delete definition.codeTemplate;
  Blockly.common.defineBlocksWithJsonArray([definition]);
  const workspace = new Blockly.Workspace();
  try {
    const condition = workspace.newBlock('controls_if');
    const comparison = workspace.newBlock('logic_compare');
    const sensor = workspace.newBlock('g1_front_distance_m');
    const threshold = workspace.newBlock('math_number');
    comparison.setFieldValue('LT', 'OP');
    threshold.setFieldValue('1', 'NUM');
    condition.getInput('IF0').connection.connect(comparison.outputConnection);
    comparison.getInput('A').connection.connect(sensor.outputConnection);
    comparison.getInput('B').connection.connect(threshold.outputConnection);
    assert.ok(condition.getInput('DO0'));
    assert.equal(sensor.outputConnection.getCheck().includes('Number'), true);

    pythonGenerator.forBlock.g1_front_distance_m = () => ['robot.front_distance_m()', pythonGenerator.ORDER_ATOMIC];
    const generated = pythonGenerator.workspaceToCode(workspace);
    assert.match(generated, /robot\.front_distance_m\(\)\s*<\s*1/);
  } finally {
    workspace.dispose();
  }
});

test('simulator selects the near-obstacle branch from the forward sector', () => {
  const frames = buildG1SimulationFrames(
    'if robot.front_distance_m() < 1:\n'
    + '    robot.walk(1)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)',
    { obstacles: [{ id: 'near', x: 0.8, y: 0, radius: 0.1 }] },
  );
  const finalFrame = frames.at(-1);
  assert.ok(finalFrame.x > 0.3);
  assert.equal(finalFrame.heading, 0);
  assert.match(finalFrame.timeline[0].summary, /0\.70 m < 1 m → then/);
});

test('simulator selects else for out-of-sector or missing obstacles', () => {
  const program = 'if robot.front_distance_m() < 1:\n'
    + '    robot.walk(1)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)';
  const sideObstacle = buildG1SimulationFrames(program, {
    obstacles: [{ id: 'side', x: 1, y: 2, radius: 0 }],
  });
  const noObstacle = buildG1SimulationFrames(program, { obstacles: [] });
  assert.equal(sideObstacle.at(-1).heading, 90);
  assert.equal(noObstacle.at(-1).heading, 90);
  assert.match(noObstacle[1].timeline[0].summary, /40\.00 m < 1 m → else/);
});

test('simulator evaluates rear obstacle distance behind the robot', () => {
  const frames = buildG1SimulationFrames(
    'if robot.rear_distance_m() < 1:\n'
    + '    robot.walk(1)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)',
    { obstacles: [{ id: 'rear', x: -0.8, y: 0, radius: 0.1 }] },
  );
  assert.ok(frames.at(-1).x > 0.3);
  assert.equal(frames.at(-1).heading, 0);
  assert.match(frames[1].timeline[0].summary, /Nearest rear obstacle: 0\.70 m < 1 m → then/);
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
  assert.equal(parseG1Program('robot.stand()\n'.repeat(200)).length, 200);
  assert.throws(
    () => parseG1Program('robot.stand()\n'.repeat(201)),
    /at most 200 expanded commands/,
  );
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

test('legacy arm presets preserve their selected pose in simulation and executable code', () => {
  const frames = buildG1SimulationFrames('robot.arm_action("hands up")');
  const finalFrame = frames.at(-1);

  assert.equal(finalFrame.actions.at(-1).label, 'Arm preset preview: hands up');
  assert.equal(Number(finalFrame.joints.left_shoulder_pitch), -75);
  assert.equal(Number(finalFrame.joints.right_shoulder_pitch), -75);

  const presets = G1_COMMANDS.find((entry) => entry.method === 'arm_action').args[0].choices;
  presets.forEach(([, preset]) => {
    const presetProgram = parseG1Program(`robot.arm_action(${JSON.stringify(preset)})`);
    assert.deepEqual(presetProgram.map(({ values }) => values[0]), [preset]);
  });
});

test('arm preset parsing preserves only explicitly requested releases', () => {
  const nodes = parseG1Program(
    'robot.arm_action("hands up")\n'
    + 'robot.arm_action("release arm")\n'
    + 'robot.arm_action("right heart")',
  );
  assert.deepEqual(nodes.map(({ values }) => values[0]), [
    'hands up',
    'release arm',
    'right heart',
  ]);
  assert.equal(
    formatG1Program(nodes),
    'robot.arm_action("hands up")\n'
      + 'robot.arm_action("release arm")\n'
      + 'robot.arm_action("right heart")',
  );
});

test('timed arm pose block uses supported static presets and previews the requested hold time', () => {
  const program = parseG1Program('robot.hold_arm("hands up", 3)');
  assert.deepEqual(program[0].values, ['hands up', 3]);
  assert.equal(program[0].code, 'robot.hold_arm("hands up", 3)');

  const frames = buildG1SimulationFrames(program[0].code);
  assert.ok(Math.abs(frames.at(-1).time - 3.8) < 1e-9);
  assert.equal(Number(frames.at(-1).joints.left_shoulder_pitch), -75);
  assert.equal(Number(frames.at(-1).joints.right_shoulder_pitch), -75);
  assert.equal(frames.at(-1).actions.at(-1).label, 'Hold arm pose');

  for (const code of [
    'robot.hold_arm("release arm", 3)',
    'robot.hold_arm("clap", 3)',
    'robot.hold_arm("hands up")',
  ]) {
    assert.throws(() => parseG1Program(code));
  }
});
