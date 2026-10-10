import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenG1Commands, formatG1Program, G1_COMMANDS, getG1BlocklyCommandBlocks, parseG1Program } from './g1Commands.js';
import { compileMotionPrompt } from './textToMotion.js';
import { buildG1SimulationFrames } from './g1Edu23Env.js';

test('G1 command catalog emits matching bounded Blockly commands', () => {
  const blocks = getG1BlocklyCommandBlocks();
  assert.ok(blocks.some((block) => block.type === 'g1_command_walk'));
  assert.ok(blocks.some((block) => block.type === 'g1_command_backwardtime'));
  assert.ok(blocks.some((block) => block.type === 'g1_command_kickleftDegrees'));
  assert.ok(blocks.every((block) => block.codeTemplate.startsWith('robot.')));
  assert.ok(G1_COMMANDS.every((entry) => entry.adapters.simulator));
  assert.ok(G1_COMMANDS.every((entry) => entry.adapters.sdk === entry.physicalSupported));
  assert.ok(G1_COMMANDS.every((entry) => entry.adapters.webRtc === false));
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
  assert.equal(finalFrame.x, 0.8);
});
