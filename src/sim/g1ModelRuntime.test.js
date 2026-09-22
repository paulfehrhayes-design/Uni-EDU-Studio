import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseG1Urdf, G1_MODEL_INFO } from './g1ModelRuntime.js';

test('G1 URDF defines the 23 actuated joints used by the runtime', () => {
  const urdfText = readFileSync(new URL('../../g1_23dof.urdf.txt', import.meta.url), 'utf8');
  const modelData = parseG1Urdf(urdfText);

  assert.equal(modelData.jointCount, 23);
  assert.deepEqual(modelData.joints, G1_MODEL_INFO.joints);
  assert.ok(modelData.joints.includes('waist_yaw_joint'));
  assert.ok(modelData.joints.includes('left_hip_pitch_joint'));
  assert.ok(modelData.joints.includes('right_wrist_roll_joint'));
});
