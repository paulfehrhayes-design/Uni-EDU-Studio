import * as THREE from 'three';

// The G1 project model has five actuated arm joints per side.
export const G1_MESH_ARM_JOINT_NAMES = Object.freeze([
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'left_wrist_roll_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
  'right_wrist_roll_joint',
]);

const VIEW_AXES = ['x', 'y', 'z'];
const VIEW_AXIS_VECTORS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// The mesh rig maps MuJoCo coordinates (x, y, z) to view coordinates (y, z, x).
export function convertMujocoAxisToView(axis) {
  const source = Array.isArray(axis) ? axis : String(axis || '').trim().split(/\s+/).map(Number);
  if (source.length !== 3 || source.some((value) => !Number.isFinite(value))) return null;

  const [x, y, z] = source;
  const converted = [y, z, x];
  const nonZeroAxes = converted
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => Math.abs(value) > 1e-8);
  if (nonZeroAxes.length !== 1) return null;

  const [{ value, index }] = nonZeroAxes;
  return { axis: VIEW_AXES[index], sign: Math.sign(value) };
}

export function composeMujocoJointQuaternion(baseQuaternion, jointAxis, angleRadians) {
  const result = baseQuaternion.clone();
  const axis = jointAxis && VIEW_AXIS_VECTORS[jointAxis.axis];
  if (!axis || !Number.isFinite(angleRadians)) return result;

  // The XML body's quaternion defines its zero-pose frame; the joint rotates within it.
  const jointRotation = new THREE.Quaternion().setFromAxisAngle(
    axis,
    angleRadians * (jointAxis.sign || 1),
  );
  return result.multiply(jointRotation);
}

export function clampMujocoJointAngle(angleDegrees, range) {
  const angle = Number(angleDegrees);
  if (!Number.isFinite(angle)) return 0;

  const bounds = Array.isArray(range) ? range : String(range || '').trim().split(/\s+/).map(Number);
  if (bounds.length !== 2 || bounds.some((value) => !Number.isFinite(value))) return angle;

  const radiansToDegrees = 180 / Math.PI;
  const [lower, upper] = bounds.map((value) => value * radiansToDegrees);
  return Math.min(upper, Math.max(lower, angle));
}

export function getMujocoJointAngle(joints, jointName) {
  const normalizedName = jointName.replace(/_joint$/, '');
  const stateNames = [normalizedName];
  if (normalizedName.endsWith('_knee')) {
    stateNames.push(`${normalizedName}_pitch`, `${normalizedName}_pitch_joint`);
  }
  stateNames.push(jointName);

  for (const stateName of stateNames) {
    if (joints?.[stateName] !== undefined && joints[stateName] !== null) {
      return joints[stateName];
    }
  }
  return 0;
}
