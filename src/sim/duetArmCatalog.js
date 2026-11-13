import catalog from './duetArmCatalog.json' with { type: 'json' };
import { solveG1ArmHandTarget } from './g1ArmKinematics.js';

const ARM_JOINT_WORKSPACE = [
  [-2.0, 1.0],
  [-0.25, 1.6],
  [-1.0, 1.0],
  [0.25, 1.6],
  [-1.5, 1.5],
  [-2.0, 1.0],
  [-1.6, 0.25],
  [-1.0, 1.0],
  [0.25, 1.6],
  [-1.5, 1.5],
];
const HAND_TARGETS = {
  carry: [0.03, 0.23, -0.13],
  forward: [0.38, 0.24, -0.05],
  box_hold: [0.27, 0.2, 0.02],
  raise_low: [0.3, 0.43, 0.2],
  raise_mid: [0.3, 0.4, 0.38],
  raise_high: [0.3, 0.3, 0.62],
  both_raise_low: [0.3, 0.43, 0.2],
  both_raise_mid: [0.3, 0.4, 0.38],
  both_raise_high: [0.3, 0.3, 0.62],
  both_overhead: [0.35, 0.2, 0.65],
  both_sideways: [0.3, 0.55, 0.3],
  both_forward_low: [0.38, 0.24, -0.02],
  both_forward_mid: [0.38, 0.28, 0.2],
  both_open_bent: [0.35, 0.5, 0.38],
  both_lowered_open: [0.25, 0.46, 0.05],
  both_chest_hold: [0.4, 0.15, 0.44],
  both_hold_object: [0.4, 0.16, 0.25],
  kiss: [0.4, 0.08, 0.5],
  both_hands_up: [0.35, 0.22, 0.62],
  both_kiss: [0.4, 0.08, 0.5],
  both_clap_open: [0.4, 0.18, 0.45],
  both_clap_closed: [0.4, 0.04, 0.45],
  high_five: [0.35, 0.43, 0.46],
  both_hug: [0.4, 0.16, 0.45],
  both_heart: [0.4, 0.07, 0.48],
  heart: [0.4, 0.07, 0.48],
  reject: [0.3, 0.5, 0.38],
  hand_up: [0.35, 0.28, 0.62],
  both_xray: [0.38, 0.3, 0.36],
  arm_forward: [0.38, 0.24, 0.02],
  arm_out: [0.3, 0.55, 0.3],
  arm_cross_body: [0.4, 0.06, 0.45],
  wave_low: [0.3, 0.45, 0.2],
  wave_low_out: [0.3, 0.56, 0.2],
  wave_mid: [0.3, 0.4, 0.38],
  wave_mid_out: [0.3, 0.51, 0.38],
  wave_face: [0.38, 0.1, 0.55],
  wave_face_out: [0.38, 0.22, 0.55],
  wave_high: [0.35, 0.28, 0.62],
  wave_high_out: [0.33, 0.39, 0.57],
  shake_hand: [0.4, 0.34, 0.25],
};

function mirrorSingleArm(target) {
  return [target[0], -target[1], -target[2], target[3], -target[4]];
}

function validateTarget(target, poseName) {
  if (!Array.isArray(target) || target.length !== catalog.jointOrder.length) {
    throw new Error(`DUET arm pose ${poseName} must define all ten arm joints.`);
  }
  target.forEach((value, index) => {
    const [minimum, maximum] = ARM_JOINT_WORKSPACE[index];
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`DUET arm pose ${poseName} exceeds the approved workspace at ${catalog.jointOrder[index]}.`);
    }
  });
  return Object.freeze([...target]);
}

const resolvedPoses = new Map();

export function getDuetArmPoseNames() {
  return [...new Set(Object.keys(catalog.poses).flatMap((poseName) => (
    poseName.startsWith('left_')
      ? [poseName, poseName.replace(/^left_/, 'right_')]
      : [poseName]
  )))];
}

export function getDuetArmPoseTarget(poseName) {
  if (resolvedPoses.has(poseName)) return resolvedPoses.get(poseName);

  if (poseName.startsWith('right_')) {
    const leftTarget = getDuetArmPoseTarget(poseName.replace(/^right_/, 'left_'));
    const mirror = (arm) => [arm[0], -arm[1], -arm[2], arm[3], -arm[4]];
    const mirroredTarget = Object.freeze([
      ...mirror(leftTarget.slice(5, 10)),
      ...mirror(leftTarget.slice(0, 5)),
    ]);
    resolvedPoses.set(poseName, mirroredTarget);
    return mirroredTarget;
  }

  const definition = catalog.poses[poseName];
  if (!definition) throw new Error(`Unknown DUET arm pose ${poseName}.`);

  let left;
  let right;
  if (definition.left && definition.right) {
    left = definition.left;
    right = definition.right;
  } else {
    const side = definition.side || (poseName.startsWith('right_') ? 'right' : 'left');
    const armTarget = definition.target;
    const defaultArm = catalog.defaultArm;
    left = side === 'left' ? armTarget : defaultArm;
    right = side === 'right' ? armTarget : mirrorSingleArm(defaultArm);
  }

  const target = [...validateTarget([...left, ...right], poseName)];
  const normalizedPoseName = poseName.replace(/^(left|right)_/, '');
  const handGoal = HAND_TARGETS[poseName] || HAND_TARGETS[normalizedPoseName];
  if (handGoal) {
    const activeSides = definition.left && definition.right
      ? ['left', 'right']
      : [poseName.startsWith('right_') ? 'right' : (definition.side || 'left')];
    activeSides.forEach((side) => {
      const offset = side === 'left' ? 0 : 5;
      const sideGoal = [handGoal[0], side === 'left' ? handGoal[1] : -handGoal[1], handGoal[2]];
      target.splice(offset, 5, ...solveG1ArmHandTarget(
        side,
        sideGoal,
        target.slice(offset, offset + 5),
        ARM_JOINT_WORKSPACE.slice(offset, offset + 4),
      ));
    });
  }
  const resolvedTarget = Object.freeze(target);
  resolvedPoses.set(poseName, resolvedTarget);
  return resolvedTarget;
}

export function getDuetArmGesture(method) {
  const gesture = catalog.gestures[method];
  if (!gesture) return null;
  return Object.freeze({
    label: gesture.label,
    poses: Object.freeze(gesture.poses.map((poseName) => ({
      name: poseName,
      target: getDuetArmPoseTarget(poseName),
    }))),
  });
}

export function getDuetArmCatalog() {
  return catalog;
}

Object.keys(catalog.poses).forEach((poseName) => {
  getDuetArmPoseTarget(poseName);
  if (poseName.startsWith('left_')) getDuetArmPoseTarget(poseName.replace(/^left_/, 'right_'));
});
