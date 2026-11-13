import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import {
  clampMujocoJointAngle, composeMujocoJointQuaternion, convertMujocoAxisToView,
  getMujocoJointAngle, G1_MESH_ARM_JOINT_NAMES,
} from './g1MeshRigAxes.js';
import { buildLegacyG1SimulationFrames, getLegacyArmPoseTargets } from './g1Edu23Env.js';
import { simulateDuetG1Edu23Program } from './duetG1Edu23Env.js';

test('legacy catalog arm frames use only the 23-DOF arm chain', () => {
  const rig = readFileSync(new URL('../../public/g1/g1.xml', import.meta.url), 'utf8');
  const jointClassAxes = new Map([...rig.matchAll(/<default class="([^"]+)">\s*<joint axis="([^"]+)"/g)]
    .map(([, className, axis]) => [className, axis]));
  const legacyFrame = buildLegacyG1SimulationFrames('robot.simulate_arm_action("high wave")')
    .find(({ joints }) => Math.abs(joints.right_wrist_roll_joint) > 20);
  const duetFrame = simulateDuetG1Edu23Program('duet.wave_left_high(1)')
    .find(({ joints }) => Math.abs(joints.left_wrist_roll_joint) > 20);

  assert.ok(legacyFrame, 'legacy catalog trajectory should animate the supported wrist-roll target');
  assert.ok(duetFrame, 'DUET catalog trajectory should animate the supported wrist-roll target');
  for (const side of ['left', 'right']) {
    for (const joint of ['shoulder_pitch', 'shoulder_roll', 'shoulder_yaw', 'elbow', 'wrist_roll']) {
      const jointName = `${side}_${joint}_joint`;
      const jointDefinition = rig.match(new RegExp(`<joint name="${jointName}"([^>]*)>`));
      const jointClass = jointDefinition?.[1].match(/class="([^"]+)"/)?.[1];
      assert.ok(jointClass, `${jointName} exists in the mesh model`);
      assert.ok(G1_MESH_ARM_JOINT_NAMES.includes(jointName));
      assert.ok(
        convertMujocoAxisToView(jointClassAxes.get(jointClass)),
        `${jointName} resolves its inherited MuJoCo axis for mesh rotation`,
      );
      assert.ok(Object.hasOwn(legacyFrame.joints, jointName), `${jointName} is present in legacy frames`);
      assert.ok(Object.hasOwn(duetFrame.joints, jointName), `${jointName} is present in DUET frames`);
    }
  }

  for (const extraJoint of [
    'left_wrist_pitch_joint',
    'left_wrist_yaw_joint',
    'right_wrist_pitch_joint',
    'right_wrist_yaw_joint',
    'waist_pitch_joint',
    'waist_roll_joint',
  ]) {
    assert.equal(Object.hasOwn(legacyFrame.joints, extraJoint), false, `${extraJoint} is outside the 23-DOF model`);
    assert.equal(Object.hasOwn(duetFrame.joints, extraJoint), false, `${extraJoint} is outside the 23-DOF model`);
  }
  assert.ok(getMujocoJointAngle(legacyFrame.joints, 'right_elbow_joint') > 45);
  assert.ok(Math.abs(getMujocoJointAngle(legacyFrame.joints, 'right_wrist_roll_joint')) > 20);
});

test('legacy gesture elbow and wrist-roll targets stay inside the 23-DOF workspace', () => {
  const rig = readFileSync(new URL('../../public/g1/g1.xml', import.meta.url), 'utf8');
  assert.match(rig, /<default class="elbow">\s*<joint[^>]*range="-1\.0472 2\.0944"/);
  assert.match(rig, /<default class="wrist_roll">\s*<joint axis="1 0 0" range="-1\.97222 1\.97222"/);

  const leftKiss = getLegacyArmPoseTargets('left kiss')[0];
  const rightKiss = getLegacyArmPoseTargets('right kiss')[0];
  const lowerWristLimit = -1.97222 * (180 / Math.PI);
  const upperWristLimit = 1.97222 * (180 / Math.PI);
  const lowerElbowLimit = -1.0472 * (180 / Math.PI);
  const upperElbowLimit = 2.0944 * (180 / Math.PI);

  assert.ok(leftKiss.left_elbow_joint > 0, 'catalog elbow target remains present');
  assert.ok(rightKiss.right_elbow_joint > 0, 'mirrored catalog elbow target remains present');
  const bothKiss = getLegacyArmPoseTargets('two-hand kiss')[0];
  assert.equal(Object.keys(leftKiss).length, 10);
  assert.equal(Object.keys(rightKiss).length, 10);
  assert.equal(Object.keys(bothKiss).length, 10);

  for (const pose of [leftKiss, rightKiss]) {
    for (const joint of ['left_wrist_roll_joint', 'right_wrist_roll_joint']) {
      assert.ok(pose[joint] >= lowerWristLimit && pose[joint] <= upperWristLimit, `${joint} respects the bundled model range`);
    }
    for (const joint of ['left_elbow_joint', 'right_elbow_joint']) {
      assert.ok(pose[joint] >= lowerElbowLimit && pose[joint] <= upperElbowLimit, `${joint} respects the bundled model range`);
    }
  }

  const highWave = buildLegacyG1SimulationFrames('robot.simulate_arm_action("high wave")')
    .find(({ joints }) => Math.abs(joints.right_wrist_roll_joint) > 20);
  assert.ok(highWave, 'the gesture animation reaches its wrist-roll target');
  assert.ok(highWave.joints.right_elbow_joint > 45);
});

test('G1 wrist-roll MuJoCo axis maps to the mesh rig longitudinal view axis', () => {
  const rig = readFileSync(new URL('../../public/g1/g1.xml', import.meta.url), 'utf8');
  assert.match(rig, /<default class="wrist_roll">\s*<joint axis="1 0 0"/);
  assert.match(rig, /<joint name="left_wrist_roll_joint" class="wrist_roll"/);

  assert.deepEqual(convertMujocoAxisToView('0 1 0'), { axis: 'x', sign: 1 });
  assert.deepEqual(convertMujocoAxisToView('0 0 1'), { axis: 'y', sign: 1 });
  assert.deepEqual(convertMujocoAxisToView('1 0 0'), { axis: 'z', sign: 1 });
  assert.deepEqual(convertMujocoAxisToView('-1 0 0'), { axis: 'z', sign: -1 });
  assert.equal(convertMujocoAxisToView('0 0 0'), null);
});

test('simulated G1 arm joints stay within ranges inherited from their MuJoCo joint classes', () => {
  const rig = readFileSync(new URL('../../public/g1/g1.xml', import.meta.url), 'utf8');
  assert.match(rig, /<default class="elbow">\s*<joint[^>]*range="-1\.0472 2\.0944"/);
  assert.match(rig, /<joint name="left_elbow_joint" class="elbow"/);
  assert.match(rig, /<joint name="right_elbow_joint" class="elbow"/);

  const elbowRange = '-1.0472 2.0944';
  const lowerElbowLimit = -1.0472 * (180 / Math.PI);
  const upperElbowLimit = 2.0944 * (180 / Math.PI);
  assert.ok(Math.abs(clampMujocoJointAngle(-75, elbowRange) - lowerElbowLimit) < 1e-9);
  assert.ok(Math.abs(clampMujocoJointAngle(-90, elbowRange) - lowerElbowLimit) < 1e-9);
  assert.ok(Math.abs(clampMujocoJointAngle(130, elbowRange) - upperElbowLimit) < 1e-9);
  assert.equal(clampMujocoJointAngle(-45, elbowRange), -45);
});

test('mesh joint rotation preserves the model body transform before applying the joint angle', () => {
  const bodyRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 6);
  const elbowAxis = convertMujocoAxisToView('0 1 0');
  const composed = composeMujocoJointQuaternion(bodyRotation, elbowAxis, Math.PI / 4);
  const expected = bodyRotation.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4),
  );

  assert.ok(composed.angleTo(expected) < 1e-10);
  assert.ok(composeMujocoJointQuaternion(bodyRotation, elbowAxis, 0).angleTo(bodyRotation) < 1e-10);
});

test('mesh knee joints resolve legacy and DUET state names', () => {
  assert.equal(getMujocoJointAngle({ left_knee_pitch: 32 }, 'left_knee_joint'), 32);
  assert.equal(getMujocoJointAngle({
    right_knee_joint: 0,
    right_knee_pitch_joint: 47,
  }, 'right_knee_joint'), 47);
  assert.equal(getMujocoJointAngle({ right_knee_joint: 12 }, 'right_knee_joint'), 12);

  const walkingFrame = simulateDuetG1Edu23Program('duet.forward(1)')
    .find(({ joints }) => joints.left_knee_joint > 0);
  assert.ok(walkingFrame);
  assert.equal(
    getMujocoJointAngle(walkingFrame.joints, 'left_knee_joint'),
    walkingFrame.joints.left_knee_joint,
  );
});
