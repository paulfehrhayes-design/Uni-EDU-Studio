export function getG1GaitJointTargets(phaseRadians, weight = 1, torsoPitch = 0, torsoRoll = 0) {
  const phase = Number.isFinite(phaseRadians) ? phaseRadians : 0;
  const gaitWeight = Math.max(0, Math.min(1, Number(weight) || 0));
  const swing = Math.sin(phase) * gaitWeight;
  const leftKnee = Math.max(0, swing) * 32;
  const rightKnee = Math.max(0, -swing) * 32;
  const leftHip = swing * 20 + torsoPitch * 0.4;
  const rightHip = -swing * 20 + torsoPitch * 0.4;
  const leftRoll = Math.cos(phase) * gaitWeight * 4 + torsoRoll * 0.2;
  const rightRoll = -leftRoll;

  return {
    left_hip_pitch_joint: Number(leftHip.toFixed(2)),
    right_hip_pitch_joint: Number(rightHip.toFixed(2)),
    left_hip_roll_joint: Number(leftRoll.toFixed(2)),
    right_hip_roll_joint: Number(rightRoll.toFixed(2)),
    left_hip_yaw_joint: 0,
    right_hip_yaw_joint: 0,
    left_knee_joint: Number(leftKnee.toFixed(2)),
    right_knee_joint: Number(rightKnee.toFixed(2)),
    left_ankle_pitch_joint: Number((-leftHip * 0.25 - leftKnee * 0.3).toFixed(2)),
    right_ankle_pitch_joint: Number((-rightHip * 0.25 - rightKnee * 0.3).toFixed(2)),
    left_ankle_roll_joint: Number((-leftRoll * 0.5).toFixed(2)),
    right_ankle_roll_joint: Number((-rightRoll * 0.5).toFixed(2)),
    waist_yaw_joint: 0,
    left_shoulder_pitch_joint: Number((-swing * 24).toFixed(2)),
    right_shoulder_pitch_joint: Number((swing * 24).toFixed(2)),
    left_shoulder_roll_joint: Number((gaitWeight * 6).toFixed(2)),
    right_shoulder_roll_joint: Number((-gaitWeight * 6).toFixed(2)),
    left_shoulder_yaw_joint: Number((Math.cos(phase) * gaitWeight * 4).toFixed(2)),
    right_shoulder_yaw_joint: Number((-Math.cos(phase) * gaitWeight * 4).toFixed(2)),
    left_elbow_joint: Number((gaitWeight * (34 + Math.cos(phase) * 8)).toFixed(2)),
    right_elbow_joint: Number((gaitWeight * (34 - Math.cos(phase) * 8)).toFixed(2)),
    left_wrist_roll_joint: Number((swing * 6).toFixed(2)),
    right_wrist_roll_joint: Number((-swing * 6).toFixed(2)),
  };
}

export function getG1GaitEnvelope(progress) {
  const amount = Math.max(0, Math.min(1, Number(progress) || 0));
  const fade = Math.min(1, amount * 5, (1 - amount) * 5);
  return fade * fade * (3 - 2 * fade);
}
