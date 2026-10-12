import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenG1Commands, G1_COMMANDS, parseG1Program } from './g1Commands.js';
import { parseG1Urdf, G1_MODEL_INFO } from './g1ModelRuntime.js';
import { buildG1SimulationFrames, buildPlannerMotionCommands, clampScenePoint, derivePlannerWaypointsFromCode, G1_MOTION_TEMPLATES, normalizePlannerMotionSegment } from './g1Edu23Env.js';

test('motion templates use only commands supported by the physical SDK adapter', () => {
  const commandsByMethod = new Map(G1_COMMANDS.map((command) => [command.method, command]));

  for (const template of G1_MOTION_TEMPLATES) {
    const commands = flattenG1Commands(parseG1Program(template.code));
    assert.ok(commands.length > 0, `${template.id} should contain a robot command`);
    for (const command of commands) {
      assert.equal(
        commandsByMethod.get(command.method)?.adapters.sdk,
        true,
        `${template.id} uses unsupported command ${command.method}`,
      );
    }
  }
});

test('G1 URDF defines the active robot structure used by the runtime', () => {
  const urdfText = readFileSync(new URL('../../g1_23dof.urdf.txt', import.meta.url), 'utf8');
  const modelData = parseG1Urdf(urdfText);

  assert.equal(modelData.jointCount, 23);
  assert.equal(modelData.allJoints.length, 32);
  assert.equal(modelData.links.length, 33);
  assert.deepEqual(modelData.joints.slice(0, 6), [
    'left_hip_pitch_joint',
    'left_hip_roll_joint',
    'left_hip_yaw_joint',
    'left_knee_joint',
    'left_ankle_pitch_joint',
    'left_ankle_roll_joint',
  ]);
  assert.deepEqual(G1_MODEL_INFO.joints.slice(0, 6), modelData.joints.slice(0, 6));
  assert.ok(modelData.joints.includes('waist_yaw_joint'));
  assert.ok(modelData.joints.includes('left_hip_pitch_joint'));
  assert.ok(modelData.joints.includes('right_wrist_roll_joint'));
  assert.ok(modelData.links.includes('pelvis'));
  assert.ok(modelData.links.includes('torso_link'));
  assert.ok(modelData.fixedJoints.includes('pelvis_contour_joint'));
  assert.ok(modelData.fixedJoints.includes('waist_yaw_fixed_joint'));
  assert.ok(modelData.allJoints.includes('head_joint'));
  assert.ok(!modelData.allJoints.includes('floating_base_joint'));
});

test('planner compiles waypoints into physical walk and turn primitives, not simulator-only coordinates', () => {
  const commands = buildPlannerMotionCommands([
    { id: 'start', x: 0, y: 0 },
    { id: 'diag', x: 10, y: 10 },
    { id: 'turn', x: 10, y: 0 },
  ]);

  assert.ok(commands.some((command) => command.startsWith('robot.walktime(')));
  assert.ok(commands.some((command) => command.startsWith('robot.turn(')));
  assert.ok(commands.every((command) => !command.includes('moveTo')));
});

test('planner simulation reaches fractional waypoint coordinates exactly', () => {
  const waypoints = [
    { id: 'first', x: 2.5, y: 1.25 },
    { id: 'target', x: 4.75, y: 3.5 },
  ];
  const code = buildPlannerMotionCommands(waypoints).join('\n');
  const finalFrame = buildG1SimulationFrames(code).at(-1);

  assert.deepEqual({ x: finalFrame.x, y: finalFrame.y }, { x: 4.75, y: 3.5 });
  assert.ok(finalFrame.path.some((point) => point.x === 2.5 && point.y === 1.25));
  assert.ok(finalFrame.path.some((point) => point.x === 4.75 && point.y === 3.5));
});

test('simulation movement distance and timing match SDK velocity command estimates', () => {
  const scenarios = [
    { code: 'robot.walk(2)', distance: 0.69, seconds: 1.725 },
    { code: 'robot.slowwalk(2)', distance: 0.69, seconds: 3.45 },
    { code: 'robot.fastwalk(2)', distance: 0.69, seconds: 0.8625 },
    { code: 'robot.walktime(2)', distance: 0.8, seconds: 2 },
    { code: 'robot.slowwalktime(2)', distance: 0.4, seconds: 2 },
    { code: 'robot.fastwalktime(2)', distance: 1.6, seconds: 2 },
  ];

  scenarios.forEach(({ code, distance, seconds }) => {
    const finalFrame = buildG1SimulationFrames(code).at(-1);
    assert.ok(Math.abs(finalFrame.x - distance) < 1e-9, `${code} distance should match the SDK estimate`);
    assert.ok(Math.abs(finalFrame.time - seconds) < 1e-9, `${code} duration should match the SDK estimate`);
  });
});

test('turn and sidestep simulation timing match SDK velocity command estimates', () => {
  const turnFrame = buildG1SimulationFrames('robot.turn("left", 90)').at(-1);
  assert.ok(Math.abs(turnFrame.heading - 90) < 1e-9);
  assert.ok(Math.abs(turnFrame.time - (Math.PI / 2) / 0.6) < 1e-9);

  const sidestepFrame = buildG1SimulationFrames('robot.sidestep("left")').at(-1);
  assert.ok(Math.abs(sidestepFrame.y - 0.4) < 1e-9);
  assert.ok(Math.abs(sidestepFrame.time - 2) < 1e-9);
});

test('planner motion normalization keeps forward segments forward and stable', () => {
  const segment = normalizePlannerMotionSegment({ x: 0, y: 0 }, { x: 4, y: 0 });

  assert.equal(segment.direction, 'forward');
  assert.equal(segment.distanceMeters, 4);
  assert.equal(segment.stepCount, 1);
  assert.equal(segment.targetHeading, 0);
});

test('planner reverse segments use a short turn plus backward steps', () => {
  const segment = normalizePlannerMotionSegment({ x: 0, y: 0 }, { x: -4, y: 0 }, 0);

  assert.equal(segment.direction, 'backward');
  assert.equal(segment.shouldWalkBackward, true);
  assert.equal(segment.turnDelta, 0);
  assert.equal(segment.relativeHeading, 180);
});

test('scene positions stay inside the active grid bounds while dragging', () => {
  const clamped = clampScenePoint(42, -18, 20);

  assert.deepEqual(clamped, { x: 10, y: -10 });
  assert.deepEqual(clampScenePoint(3, 4, 20), { x: 3, y: 4 });
});

test('empty and non-motion code do not create planner waypoints', () => {
  assert.deepEqual(derivePlannerWaypointsFromCode(''), []);
  assert.deepEqual(derivePlannerWaypointsFromCode('robot.stand();'), []);
});

test('planner waypoints derived from motion code preserve coordinates', () => {
  const waypoints = derivePlannerWaypointsFromCode('robot.turnLeft(90);\nrobot.walkForward(2);');

  assert.deepEqual(waypoints[0], { id: 'planner-0', x: 0, y: 0 });
  assert.deepEqual(waypoints.at(-1), { id: 'planner-2', x: 0, y: 2 });
});

test('planner waypoints derived from moveTo commands stay absolute', () => {
  const waypoints = derivePlannerWaypointsFromCode('robot.moveTo(2.5, 1.25);\nrobot.moveTo(4.75, 3.5);');

  assert.deepEqual(waypoints.map(({ x, y }) => ({ x, y })), [
    { x: 0, y: 0 },
    { x: 2.5, y: 1.25 },
    { x: 4.75, y: 3.5 },
  ]);
});
