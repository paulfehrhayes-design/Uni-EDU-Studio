import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseG1Urdf, G1_MODEL_INFO } from './g1ModelRuntime.js';
import { buildPlannerMotionCommands, clampScenePoint, derivePlannerWaypointsFromCode, normalizePlannerMotionSegment } from './g1Edu23Env.js';

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

test('planner commands preserve waypoint order and heading direction', () => {
  const commands = buildPlannerMotionCommands([
    { id: 'start', x: 0, y: 0 },
    { id: 'diag', x: 10, y: 10 },
    { id: 'turn', x: 10, y: 0 },
  ]);

  assert.ok(commands.includes('robot.turnLeft(45);'));
  assert.ok(commands.includes('robot.turnRight(135);'));
  assert.ok(commands.indexOf('robot.turnLeft(45);') < commands.indexOf('robot.turnRight(135);'));
  assert.ok(commands.includes('robot.walkForward(4);'));
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
