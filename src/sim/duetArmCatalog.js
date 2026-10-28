import catalog from './duetArmCatalog.json' with { type: 'json' };

const ARM_JOINT_WORKSPACE = [
  [-2.0, 1.0],
  [-0.25, 1.6],
  [-1.0, 1.0],
  [-0.5, 1.6],
  [-1.5, 1.5],
  [-2.0, 1.0],
  [-1.6, 0.25],
  [-1.0, 1.0],
  [-0.5, 1.6],
  [-1.5, 1.5],
];

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

  const definition = catalog.poses[poseName] || (
    poseName.startsWith('right_')
      ? catalog.poses[poseName.replace(/^right_/, 'left_')]
      : null
  );
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
    if (poseName.startsWith('right_') && definition.side === 'left') {
      right = mirrorSingleArm(armTarget);
      left = defaultArm;
    }
  }

  const target = validateTarget([...left, ...right], poseName);
  resolvedPoses.set(poseName, target);
  return target;
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
