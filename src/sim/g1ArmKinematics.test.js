import assert from 'node:assert/strict';
import test from 'node:test';
import { getDuetArmPoseNames, getDuetArmPoseTarget } from './duetArmCatalog.js';
import { getG1ArmHandPosition } from './g1ArmKinematics.js';

function getPoseHand(poseName, side) {
  const pose = getDuetArmPoseTarget(poseName);
  return getG1ArmHandPosition(side, pose.slice(side === 'left' ? 0 : 5, side === 'left' ? 5 : 10));
}

test('face wave positions the hand beside the head and waves through the shoulder and elbow chain', () => {
  const inPose = getPoseHand('right_wave_face', 'right');
  const outPose = getPoseHand('right_wave_face_out', 'right');

  assert.ok(inPose.x > 0.3);
  assert.ok(inPose.z > 0.5);
  assert.ok(Math.abs(inPose.y) < 0.15);
  assert.ok(outPose.y < inPose.y - 0.1);
  const inJoints = getDuetArmPoseTarget('right_wave_face');
  assert.ok(inJoints[8] > 0.5, 'the active elbow remains visibly flexed');
});

test('clap poses bring both hands together at chest height', () => {
  const left = getPoseHand('both_clap_closed', 'left');
  const right = getPoseHand('both_clap_closed', 'right');

  assert.ok(left.distanceTo(right) < 0.1);
  assert.ok(left.z > 0.4 && right.z > 0.4);
});

test('high-five pose places the active palm high and out to the side', () => {
  const hand = getPoseHand('right_high_five', 'right');

  assert.ok(hand.y < -0.35);
  assert.ok(hand.z > 0.4);
});

test('kiss and cross-body poses reach their intended positions rather than saturating joint limits', () => {
  const kiss = getPoseHand('left_kiss', 'left');
  const crossBody = getPoseHand('left_arm_cross_body', 'left');

  assert.ok(kiss.distanceTo({ x: 0.4, y: 0.08, z: 0.5 }) < 0.02);
  assert.ok(crossBody.distanceTo({ x: 0.4, y: 0.06, z: 0.45 }) < 0.02);
});

test('all approved arm poses produce finite hand positions with articulated elbows', () => {
  for (const poseName of getDuetArmPoseNames()) {
    const pose = getDuetArmPoseTarget(poseName);
    for (const side of ['left', 'right']) {
      const offset = side === 'left' ? 0 : 5;
      const arm = pose.slice(offset, offset + 5);
      const hand = getG1ArmHandPosition(side, arm);

      assert.ok(hand.toArray().every(Number.isFinite), `${poseName} has a finite ${side} hand position`);
      assert.ok(arm[3] >= 0.25 && arm[3] <= 1.6, `${poseName} keeps the ${side} elbow articulated`);
    }
  }
});
