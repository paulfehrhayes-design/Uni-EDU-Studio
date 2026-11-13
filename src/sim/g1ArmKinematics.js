import * as THREE from 'three';
import { G1_MODEL_INFO } from './g1ModelRuntime.js';

const ARM_JOINTS = ['shoulder_pitch_joint', 'shoulder_roll_joint', 'shoulder_yaw_joint', 'elbow_joint'];
const HAND_LINKS = {
  left: 'left_wrist_roll_rubber_hand',
  right: 'right_wrist_roll_rubber_hand',
};
const JOINTS_BY_CHILD = new Map(G1_MODEL_INFO.jointDetails.map((joint) => [joint.child, joint]));
const ARM_CHAINS = Object.fromEntries(Object.entries(HAND_LINKS).map(([side, handLink]) => {
  const chain = [];
  let link = handLink;
  while (link !== 'pelvis') {
    const joint = JOINTS_BY_CHILD.get(link);
    if (!joint) throw new Error(`G1 arm model has no parent joint for ${link}.`);
    chain.push(joint);
    link = joint.parent;
  }
  return [side, chain.reverse()];
}));

function getOriginTransform(joint) {
  const [x, y, z] = joint.origin.split(/\s+/).map(Number);
  const [roll, pitch, yaw] = joint.originRpy.split(/\s+/).map(Number);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, pitch, yaw, 'XYZ'));
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    rotation,
    new THREE.Vector3(1, 1, 1),
  );
}

function getArmJointName(side, suffix) {
  return `${side}_${suffix}`;
}

function getHandPosition(side, angles) {
  const transform = new THREE.Matrix4();
  for (const joint of ARM_CHAINS[side]) {
    transform.multiply(getOriginTransform(joint));
    if (joint.type !== 'revolute') continue;
    const [x, y, z] = joint.axis.split(/\s+/).map(Number);
    const angle = angles[getArmJointName(side, joint.name.slice(side.length + 1))] || 0;
    transform.multiply(new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), angle),
    ));
  }
  return new THREE.Vector3(0.2, 0, 0).applyMatrix4(transform);
}

function clamp(value, [minimum, maximum]) {
  return Math.max(minimum, Math.min(maximum, value));
}

function solveLinearSystem(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return [0, 0, 0];
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index < 4; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index < 4; index += 1) rows[row][index] -= factor * rows[column][index];
    }
  }
  return rows.map((row) => row[3]);
}

export function getG1ArmHandPosition(side, target) {
  const angles = {};
  ARM_JOINTS.forEach((suffix, index) => {
    angles[getArmJointName(side, suffix)] = target[index] || 0;
  });
  angles[getArmJointName(side, 'wrist_roll_joint')] = target[4] || 0;
  return getHandPosition(side, angles);
}

function solveArmTargetFromSeed(side, handTarget, seed, jointWorkspace) {
  const names = ARM_JOINTS.map((suffix) => getArmJointName(side, suffix));
  const angles = Object.fromEntries(names.map((name, index) => [name, seed[index] || 0]));
  const preferred = Object.fromEntries(names.map((name, index) => [name, seed[index] || 0]));
  const target = new THREE.Vector3(...handTarget);
  const step = 1e-4;
  const damping = 0.04;

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const position = getHandPosition(side, angles);
    const error = target.clone().sub(position);
    if (error.length() < 0.002) break;

    const jacobian = [[], [], []];
    names.forEach((name, index) => {
      angles[name] += step;
      const moved = getHandPosition(side, angles);
      angles[name] -= step;
      const derivative = moved.sub(position).multiplyScalar(1 / step);
      jacobian[0][index] = derivative.x;
      jacobian[1][index] = derivative.y;
      jacobian[2][index] = derivative.z;
    });

    const normal = Array.from({ length: 3 }, (_, row) => (
      Array.from({ length: 3 }, (_, column) => (
        jacobian[row].reduce((sum, value, index) => sum + value * jacobian[column][index], 0)
        + (row === column ? damping * damping : 0)
      ))
    ));
    const correction = solveLinearSystem(normal, error.toArray());
    const preferenceDelta = names.map((name) => preferred[name] - angles[name]);
    const taskPreference = jacobian.map((row) => row.reduce(
      (sum, value, index) => sum + value * preferenceDelta[index],
      0,
    ));
    const taskCorrection = solveLinearSystem(normal, taskPreference);
    names.forEach((name, index) => {
      const delta = jacobian.reduce((sum, row, axis) => sum + row[index] * correction[axis], 0);
      const projectedPreference = preferenceDelta[index] - jacobian.reduce(
        (sum, row, axis) => sum + row[index] * taskCorrection[axis],
        0,
      );
      angles[name] = clamp(
        angles[name] + clamp(delta + projectedPreference * 0.2, [-0.15, 0.15]),
        jointWorkspace[index],
      );
    });
  }

  return [
    ...names.map((name) => angles[name]),
    seed[4] || 0,
  ];
}

export function solveG1ArmHandTarget(side, handTarget, seed, jointWorkspace) {
  const candidates = [
    seed,
    [-1.3, 0.3, 0, 0.55, seed[4] || 0],
    [-1.3, 0.8, -0.4, 0.6, seed[4] || 0],
    [-1.3, 0.5, 0.5, 0.6, seed[4] || 0],
    [-1, -0.15, 0.5, 0.6, seed[4] || 0],
    [-1.2, 0.96, -0.55, 0.25, seed[4] || 0],
  ];
  let best;
  let bestError = Infinity;

  for (const candidate of candidates) {
    const solution = solveArmTargetFromSeed(side, handTarget, candidate, jointWorkspace);
    const position = getG1ArmHandPosition(side, solution);
    const error = position.distanceTo(new THREE.Vector3(...handTarget));
    if (error < bestError) {
      best = solution;
      bestError = error;
    }
    if (error < 0.003) break;
  }

  if (bestError > 0.04) {
    throw new Error(`G1 ${side} arm cannot reach hand target ${handTarget.join(', ')} within 4 cm (error: ${bestError.toFixed(3)} m).`);
  }
  return best;
}
