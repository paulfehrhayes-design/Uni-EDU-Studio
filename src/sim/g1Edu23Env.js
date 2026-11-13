import { G1_MODEL_INFO } from './g1ModelRuntime.js';
import { G1_NOMINAL_STEP_METERS, parseG1Program } from './g1Commands.js';
import { getDuetArmCatalog, getDuetArmPoseTarget } from './duetArmCatalog.js';
import { getG1GaitEnvelope, getG1GaitJointTargets } from './g1Gait.js';

const ARM_CATALOG = getDuetArmCatalog();
const ARM_JOINTS = ARM_CATALOG.jointOrder;
const ANIMATED_ARM_JOINTS = ARM_JOINTS;
const RADIANS_TO_DEGREES = 180 / Math.PI;

const LEGACY_ARM_GESTURES = {
  'two-hand kiss': ['legacy_kiss_both'],
  'left kiss': ['legacy_kiss_left'],
  'right kiss': ['legacy_kiss_right'],
  'hands up': ['legacy_hands_up'],
  clap: ['legacy_clap'],
  'high five': ['legacy_high_five_right'],
  hug: ['legacy_hug'],
  heart: ['legacy_heart_both'],
  'right heart': ['legacy_heart_right'],
  reject: ['legacy_reject_right'],
  'right hand up': ['legacy_hand_up_right'],
  'x-ray': ['legacy_xray'],
  'face wave': ['legacy_face_wave_right'],
  'high wave': ['legacy_high_wave_right'],
  'shake hand': ['legacy_shake_hand_right'],
};

function getArmTargetsFromPose(poseName) {
  const target = getDuetArmPoseTarget(poseName);
  return Object.fromEntries(ARM_JOINTS.map((joint, index) => [
    joint,
    target[index] * RADIANS_TO_DEGREES,
  ]));
}

export function getLegacyArmPoseTargets(action) {
  if (action === 'release arm') {
    return [Object.fromEntries(ARM_JOINTS.map((joint) => [joint, 0]))];
  }

  const gestureNames = LEGACY_ARM_GESTURES[action];
  if (!gestureNames) throw new Error(`Unknown simulated arm preset: ${action}`);

  const poseNames = gestureNames.flatMap((gestureName) => {
    const gesture = ARM_CATALOG.gestures[gestureName];
    if (!gesture) throw new Error(`Unknown simulated arm gesture: ${gestureName}`);
    return gesture.poses;
  });
  if (poseNames.at(-1) === 'carry') poseNames.pop();
  return poseNames.map(getArmTargetsFromPose);
}

export const G1_EDU_23_ENV = {
  robotType: G1_MODEL_INFO.robotType,
  source: G1_MODEL_INFO.source,
  sourceFile: G1_MODEL_INFO.sourceFile,
  jointCount: G1_MODEL_INFO.jointCount,
  scene: {
    width: 220,
    height: 220,
    scale: 1.5,
    originX: 110,
    originY: 110,
  },
  initialPose: {
    x: 0,
    y: 0,
    heading: 0,
    torsoPitch: 0,
    torsoRoll: 0,
  },
  joints: G1_MODEL_INFO.joints,
  motionTemplates: {
    walkForward: { label: 'Walk forward', speed: 0.4, description: 'Forward locomotion' },
    walkBackward: { label: 'Walk backward', speed: -0.4, description: 'Backward locomotion' },
    turnLeft: { label: 'Turn left', turnRate: 0.6, description: 'Left rotation' },
    turnRight: { label: 'Turn right', turnRate: -0.6, description: 'Right rotation' },
    stop: { label: 'Stop', description: 'Stop all movement' },
    standUp: { label: 'Stand up', description: 'Return to neutral standing pose' },
  },
  defaultObstacles: [
    { id: 'block-1', type: 'box', label: 'Box', color: '#60a5fa', x: 26, y: 18, radius: 12 },
    { id: 'block-2', type: 'sphere', label: 'Sphere', color: '#cbd5e1', x: -18, y: -10, radius: 14 },
    { id: 'block-3', type: 'terrain', label: 'Terrain', color: '#86efac', x: 8, y: -26, radius: 10 },
  ],
  challengeLayouts: {
    'simple-path': {
      label: 'Simple path',
      goal: { x: 30, y: 28, radius: 10 },
      obstacles: [
        { id: 'wall-1', type: 'wall', label: 'Wall', color: '#f59e0b', x: 12, y: -12, radius: 9 },
      ],
    },
    'avoid-blocks': {
      label: 'Avoid blocks',
      goal: { x: 38, y: -24, radius: 10 },
      obstacles: [
        { id: 'block-a', x: 20, y: 0, radius: 12 },
        { id: 'block-b', x: -8, y: -18, radius: 11 },
        { id: 'block-c', x: 10, y: 22, radius: 9 },
      ],
    },
    'loop-mission': {
      label: 'Loop mission',
      goal: { x: -28, y: 20, radius: 12 },
      obstacles: [
        { id: 'loop-1', x: -12, y: 4, radius: 10 },
        { id: 'loop-2', x: 18, y: -8, radius: 10 },
      ],
    },
  },
};

export const SIMULATOR_MODES = {
  'kid-preview': {
    label: 'Kid preview',
    description: 'Simple motion preview for student coding',
  },
  'advanced-physics': {
    label: 'Advanced physics',
    description: 'Obstacle-aware preview with motion templates',
  },
};

export const G1_MOTION_TEMPLATES = [
  {
    id: 'slow-forward-1s',
    label: 'Slow forward 1s',
    code: `robot.slowwalktime(1)\n`,
  },
  {
    id: 'forward-2s',
    label: 'Forward 2s',
    code: `robot.walktime(2)\n`,
  },
  {
    id: 'backward-1s',
    label: 'Backward 1s',
    code: `robot.backwardtime(1)\n`,
  },
  {
    id: 'sidestep-left',
    label: 'Sidestep left',
    code: `robot.sidestep("left", 1)\n`,
  },
  {
    id: 'sidestep-right',
    label: 'Sidestep right',
    code: `robot.sidestep("right", 1)\n`,
  },
  {
    id: 'turn-left-90',
    label: 'Turn left 90 deg',
    code: `robot.turn("left", 90)\n`,
  },
  {
    id: 'turn-around',
    label: 'Turn around',
    code: `robot.turn("left", 180)\n`,
  },
  {
    id: 'square-path',
    label: 'Square path',
    code: `for _ in range(4):\n    robot.walk(2)\n    robot.turn("left", 90)\n`,
  },
  {
    id: 'stand-up',
    label: 'Stand up',
    code: `robot.stand()\n`,
  },
];

export const createEmptyG1Edu23State = () => ({
  x: 0,
  y: 0,
  heading: 0,
  torsoPitch: 0,
  torsoRoll: 0,
  status: 'Ready',
  path: [{ x: 0, y: 0 }],
  actions: [{ label: 'Idle', summary: 'No movement commands yet.' }],
  collisions: 0,
  blocked: false,
  goalReached: false,
  goal: null,
  timeline: [],
  joints: Object.fromEntries(
    G1_EDU_23_ENV.joints.map((joint) => [joint, 0]),
  ),
});

function normalizeAngle(angle) {
  return (((angle % 360) + 360) % 360);
}

function normalizeTurnDelta(angle) {
  const normalized = normalizeAngle(angle);
  return normalized > 180 ? normalized - 360 : normalized;
}

export function normalizePlannerMotionSegment(from = { x: 0, y: 0 }, to = { x: 0, y: 0 }, currentHeading = 0) {
  const dx = Number(to.x ?? 0) - Number(from.x ?? 0);
  const dy = Number(to.y ?? 0) - Number(from.y ?? 0);
  const distanceMeters = Math.hypot(dx, dy);
  const targetHeading = (Math.atan2(dy, dx) * 180) / Math.PI;
  const relativeHeading = normalizeTurnDelta(targetHeading - currentHeading);
  const shouldWalkBackward = Math.abs(relativeHeading) > 150;
  const turnDelta = shouldWalkBackward
    ? (relativeHeading > 0 ? relativeHeading - 180 : relativeHeading + 180)
    : relativeHeading;
  const stepCount = Number.isFinite(distanceMeters) && distanceMeters > 0.05
    ? Math.max(1, Math.round(distanceMeters / 4))
    : 0;

  return {
    dx,
    dy,
    distanceMeters,
    targetHeading: Number(normalizeAngle(targetHeading || 0).toFixed(2)),
    relativeHeading: Number(relativeHeading.toFixed(2)),
    turnDelta: Number(turnDelta.toFixed(2)),
    stepCount,
    shouldWalkBackward,
    direction: distanceMeters > 0.05 ? (shouldWalkBackward ? 'backward' : 'forward') : 'stop',
  };
}

export function clampScenePoint(x, y, gridSize = 20) {
  const halfSize = Number(gridSize) > 0 ? Number(gridSize) / 2 : 10;
  const safeX = Number.isFinite(Number(x)) ? Number(x) : 0;
  const safeY = Number.isFinite(Number(y)) ? Number(y) : 0;

  return {
    x: Math.max(-halfSize, Math.min(halfSize, safeX)),
    y: Math.max(-halfSize, Math.min(halfSize, safeY)),
  };
}

export function derivePlannerWaypointsFromCode(code = '') {
  if (!code || !code.trim()) return [];

  const commandMatches = [...code.matchAll(/robot\.(moveTo|walkForward|walkBackward|walkSidewaysLeft|walkSidewaysRight|turnLeft|turnRight|turn)\(([^)]*)\)/g)];
  if (!commandMatches.length) return [];

  let x = 0;
  let y = 0;
  let heading = 0;
  const points = [{ id: 'planner-0', x, y }];

  commandMatches.forEach((match) => {
    const [, methodName, argsRaw = ''] = match;
    const numeric = Number((argsRaw.match(/-?\d*\.?\d+/) || ['0'])[0]);
    const amount = Number.isFinite(numeric) ? numeric : 0;

        if (methodName === 'moveTo') {
          const [targetX, targetY] = argsRaw.split(',').map(Number);
          if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
            x = targetX;
            y = targetY;
          }
        } else if (methodName === 'walkForward' || methodName === 'walkBackward') {
      const stepDistance = methodName === 'walkBackward' ? -amount : amount;
      x += Math.cos((heading * Math.PI) / 180) * stepDistance;
      y += Math.sin((heading * Math.PI) / 180) * stepDistance;
    }

    if (methodName === 'walkSidewaysLeft' || methodName === 'walkSidewaysRight') {
      const direction = methodName === 'walkSidewaysLeft' ? 1 : -1;
      const sidewaysHeading = heading + (direction > 0 ? 90 : -90);
      x += Math.cos((sidewaysHeading * Math.PI) / 180) * amount;
      y += Math.sin((sidewaysHeading * Math.PI) / 180) * amount;
    }

    if (methodName === 'turnLeft' || methodName === 'turnRight') {
      heading += methodName === 'turnLeft' ? amount : -amount;
    }

    if (methodName === 'turn') {
      const turnArgs = argsRaw.match(/"([^"]+)"\s*,\s*(\d+(?:\.\d+)?)/) || argsRaw.match(/'([^']+)'\s*,\s*(\d+(?:\.\d+)?)/);
      if (turnArgs) {
        const direction = (turnArgs[1] || 'left').toLowerCase();
        const turnAmount = Number(turnArgs[2] || 0);
        heading += direction === 'right' ? -turnAmount : turnAmount;
      }
    }

    points.push({ id: `planner-${points.length}`, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
  });

  return points;
}

export function buildPlannerMotionCommands(waypoints = []) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return ['robot.stand()'];
  }

  const commands = ['robot.stand()'];
  let previous = G1_EDU_23_ENV.initialPose;
  let heading = previous.heading;

  waypoints.forEach((waypoint) => {
    const x = Number(waypoint.x);
    const y = Number(waypoint.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const deltaX = x - previous.x;
    const deltaY = y - previous.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance <= 0.01) return;

    const targetHeading = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
    const turnDelta = normalizeTurnDelta(targetHeading - heading);
    if (Math.abs(turnDelta) >= 5) {
      commands.push(`robot.turn("${turnDelta > 0 ? 'left' : 'right'}", ${Math.abs(turnDelta).toFixed(2)})`);
    }
    let remainingSeconds = distance / 0.4;
    while (remainingSeconds > 0.001) {
      const segmentSeconds = Math.min(10, remainingSeconds);
      commands.push(`robot.walktime(${segmentSeconds.toFixed(3)})`);
      remainingSeconds -= segmentSeconds;
    }
    heading = targetHeading;
    previous = { x, y };
  });

  commands.push('robot.stand()');
  return commands;
}

function isBlockedByObstacle(x, y, obstacles = []) {
  if (!obstacles.length) return false;
  return obstacles.some((obstacle) => {
    const dx = x - obstacle.x;
    const dy = y - obstacle.y;
    return Math.hypot(dx, dy) < obstacle.radius + 7;
  });
}

export function buildLegacyG1SimulationFrames(pythonCode, options = {}) {
  const { mode = 'kid-preview', obstacles = G1_EDU_23_ENV.defaultObstacles, challenge = null } = options;

  if (!pythonCode || !pythonCode.trim()) {
    return [{
      ...createEmptyG1Edu23State(),
      blocked: false,
      collisions: 0,
      goal: challenge?.goal || null,
    }];
  }

  const normalized = pythonCode.replace(/\r/g, '');
  let programNodes;
  let commandMatches = [];
  try {
    programNodes = parseG1Program(normalized);
  } catch (error) {
    if (/^\s*(?:if|elif|else)\b/m.test(normalized)) {
      return [{
        ...createEmptyG1Edu23State(),
        status: 'Invalid distance condition',
        actions: [{ label: 'Condition not simulated', summary: error.message }],
        blocked: false,
        collisions: 0,
        goal: challenge?.goal || null,
      }];
    }
    commandMatches = [
      ...normalized.matchAll(/robot\.(\w+)\(([^)]*)\)/g),
      ...normalized.matchAll(/sport_client\.Move\(([^)]*)\)/g),
      ...normalized.matchAll(/sport_client\.StopMove\(\)/g),
      ...normalized.matchAll(/sport_client\.Squat2StandUp\(\)/g),
    ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  const countProgramCommands = (nodes) => nodes.reduce((total, node) => {
    if (node.type === 'command') return total + 1;
    if (node.type === 'boolean_assignment') return total;
    if (node.type === 'repeat') return total + node.times * countProgramCommands(node.body);
    return total + Math.max(countProgramCommands(node.then), countProgramCommands(node.else));
  }, 0);
  if (programNodes ? countProgramCommands(programNodes) === 0 : !commandMatches.length) {
    return [{
      ...createEmptyG1Edu23State(),
      status: 'Idle',
      actions: [{ label: 'No G1 motion blocks', summary: 'Add a move, turn, or stand-up block to preview the robot.' }],
      blocked: false,
      collisions: 0,
      goal: challenge?.goal || null,
    }];
  }

  const frames = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  let torsoPitch = 0;
  let torsoRoll = 0;
  const path = [{ x, y }];
  const actions = [];
  const timeline = [];
  const jointState = Object.fromEntries(G1_EDU_23_ENV.joints.map((joint) => [joint, 0]));
  let collisionCount = 0;
  let gaitPhase = 0;
  let gaitWeight = 0;
  let elapsedSeconds = 0;
  const poseTargets = {};

  const addFrame = (isInitial = false) => {
    const finalGoal = challenge?.goal || null;
    const goalReached = !!finalGoal && Math.hypot(x - finalGoal.x, y - finalGoal.y) <= (finalGoal.radius || 8);
    const blocked = mode === 'advanced-physics' && collisionCount > 0;
    Object.assign(
      jointState,
      getG1GaitJointTargets(gaitPhase * Math.PI * 2, isInitial ? 0 : gaitWeight, torsoPitch, torsoRoll),
    );
    Object.entries(poseTargets).forEach(([name, value]) => {
      const jointName = name.replace(/_knee_pitch(?:_joint)?$/, '_knee_joint');
      jointState[jointName.endsWith('_joint') ? jointName : `${jointName}_joint`] = value;
    });

    frames.push({
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      heading: Number(normalizeAngle(heading).toFixed(2)),
      torsoPitch: Number(torsoPitch.toFixed(2)),
      torsoRoll: Number(torsoRoll.toFixed(2)),
      status: goalReached ? 'Goal reached' : blocked ? 'Blocked' : 'Preview',
      path: [...path],
      actions: actions.length ? [...actions] : [{ label: 'Idle', summary: 'Ready for a motion block.' }],
      collisions: collisionCount,
      blocked,
      goalReached,
      goal: finalGoal,
      timeline: [...timeline],
      joints: { ...jointState },
      mode,
      time: elapsedSeconds,
    });
  };

  const clearLegPoseTargets = () => {
    [
      'left_hip_pitch', 'right_hip_pitch', 'left_hip_roll', 'right_hip_roll',
      'left_hip_yaw', 'right_hip_yaw', 'left_knee_pitch', 'right_knee_pitch',
      'left_ankle_pitch', 'right_ankle_pitch', 'left_ankle_roll', 'right_ankle_roll',
    ].forEach((joint) => { delete poseTargets[joint]; });
  };

  addFrame(true);

  const walkThrough = (distance, direction, label, summary, durationSeconds) => {
    const normalizedDirection = direction === 0 ? 0 : (direction > 0 ? 1 : -1);
    const radians = (heading * Math.PI) / 180;
    const travelDistance = Math.abs(distance);
    const frameCount = Math.max(10, Math.ceil(travelDistance * 16));
    const segmentDuration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : frameCount / 30;
    const stepScale = travelDistance / frameCount;
    const stepX = Math.cos(radians) * stepScale * normalizedDirection;
    const stepY = Math.sin(radians) * stepScale * normalizedDirection;
    clearLegPoseTargets();
    actions.push({ label, summary });
    timeline.push({ label, summary });

    for (let index = 0; index < frameCount; index += 1) {
      elapsedSeconds += segmentDuration / frameCount;
      x += stepX;
      y += stepY;
      gaitPhase += stepScale / (2 * G1_NOMINAL_STEP_METERS);
      gaitWeight = getG1GaitEnvelope((index + 1) / frameCount);
      torsoPitch = Math.sin(gaitPhase * Math.PI) * (normalizedDirection >= 0 ? 8 : -8);
      path.push({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
      addFrame();
    }

    torsoPitch = 0;
    gaitWeight = 0;
    addFrame();
  };

  const animateAction = (frameCount, update, label, summary, durationSeconds = frameCount / 30) => {
    actions.push({ label, summary });
    timeline.push({ label, summary });
    for (let index = 1; index <= frameCount; index += 1) {
      elapsedSeconds += durationSeconds / frameCount;
      update(index / frameCount);
      addFrame();
    }
  };

  const animateTurn = (deltaDegrees, frameCount, label, summary, durationSeconds) => {
    clearLegPoseTargets();
    const startingHeading = heading;
    const startingGaitPhase = gaitPhase;
    animateAction(frameCount, (progress) => {
      heading = startingHeading + deltaDegrees * progress;
      torsoRoll = Math.sin(progress * Math.PI) * Math.sign(deltaDegrees) * 8;
      gaitPhase = startingGaitPhase + (Math.abs(deltaDegrees) / 90) * progress;
      gaitWeight = getG1GaitEnvelope(progress);
    }, label, summary, durationSeconds);
    torsoRoll = 0;
    gaitWeight = 0;
    addFrame();
  };

  const animateArmTargets = (targets, label, summary, durationSeconds = 0.8, frameCount = 24) => {
    const starts = Object.fromEntries(ANIMATED_ARM_JOINTS.map((joint) => [
      joint,
      poseTargets[joint] ?? jointState[joint] ?? 0,
    ]));
    animateAction(frameCount, (progress) => {
      ANIMATED_ARM_JOINTS.forEach((joint) => {
        const end = targets[joint] ?? 0;
        poseTargets[joint] = starts[joint] + (end - starts[joint]) * progress;
      });
    }, label, summary, durationSeconds);
  };

  const executeCommand = (match) => {
    const rawCommand = match[0];
    if (rawCommand.startsWith('sport_client.Move')) {
      const rawArgs = (match[1] || '').split(',').map((part) => part.trim());
      const vx = Number(rawArgs[0] ?? 0);
      const vz = Number(rawArgs[2] ?? 0);
      const distance = Math.hypot(vx, vz) * 2;
      const radians = (heading * Math.PI) / 180;
      const nextX = x + Math.cos(radians) * (vx * 2);
      const nextY = y + Math.sin(radians) * (vx * 2);

      if (mode === 'advanced-physics' && isBlockedByObstacle(nextX, nextY, obstacles)) {
        collisionCount += 1;
        actions.push({ label: 'Obstacle detected', summary: `Blocked before reaching ${nextX.toFixed(1)}, ${nextY.toFixed(1)}` });
        timeline.push({ label: 'Block hit', summary: 'Robot avoided a barrier' });
        x = Number(nextX.toFixed(2));
        y = Number(nextY.toFixed(2));
        path.push({ x, y });
        addFrame();
        return;
      }

      if (Math.abs(vx) > 0.001) {
        walkThrough(vx * 2, vx > 0 ? 1 : -1, vx > 0 ? 'Walk forward' : 'Walk backward', `${Math.abs(vx).toFixed(2)} m`);
      }

      if (Math.abs(vz) > 0.001) {
        const turnDegrees = Math.sign(vz) * distance * 0.7;
        animateTurn(turnDegrees, 12, vz > 0 ? 'Turn left' : 'Turn right', `${Math.abs(turnDegrees).toFixed(0)}°`);
      }

      if (Math.abs(vx) <= 0.001) {
        path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
        addFrame();
      }
      return;
    }

    if (rawCommand === 'sport_client.StopMove()') {
      actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
      timeline.push({ label: 'Stop', summary: 'Movement stopped' });
      path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
      animateAction(6, () => {
        torsoPitch *= 0.8;
        torsoRoll *= 0.8;
      }, 'Stop', 'Movement stopped');
      return;
    }

    if (rawCommand === 'sport_client.Squat2StandUp()') {
      torsoPitch = 0;
      torsoRoll = 0;
      actions.push({ label: 'Stand up', summary: 'Return to neutral standing stance.' });
      timeline.push({ label: 'Stand up', summary: 'Ready again' });
      path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
      animateAction(12, (progress) => {
        torsoPitch = 12 * (1 - progress);
      }, 'Stand up', 'Return to neutral standing stance.');
      return;
    }
    const methodName = match[1];
    const argsRaw = match[2] || '';
    const firstNumber = Number((argsRaw.match(/-?\d*\.?\d+/) || ['0'])[0]);

    if (methodName === 'moveTo') {
      const [targetX, targetY] = argsRaw.split(',').map(Number);
      if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;

      const deltaX = targetX - x;
      const deltaY = targetY - y;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance > 0.01) {
        const startHeading = heading;
        const targetHeading = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
        const turnDelta = normalizeTurnDelta(targetHeading - startHeading);
        if (Math.abs(turnDelta) > 0.05) {
          animateTurn(
            turnDelta,
            14,
            turnDelta > 0 ? 'Turn Left' : 'Turn Right',
            `${Math.abs(turnDelta).toFixed(1)}°`,
          );
        }

        walkThrough(distance, 1, 'Follow waypoint path', `${distance.toFixed(2)} m`);
      }

      x = Number(targetX.toFixed(2));
      y = Number(targetY.toFixed(2));
      if (path.length) path[path.length - 1] = { x, y };
      else path.push({ x, y });
      addFrame();
      return;
    }

    if (methodName === 'walkForward' || methodName === 'walkForwardSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = G1_NOMINAL_STEP_METERS * stepCount;
      walkThrough(stride, 1, 'Walk Forward', `${stepCount.toFixed(1)} steps`);
    }

    if (methodName === 'walkBackward' || methodName === 'walkBackwardSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = G1_NOMINAL_STEP_METERS * stepCount;
      walkThrough(-stride, -1, 'Walk Back', `${stepCount.toFixed(1)} steps`);
    }

    if (methodName === 'walkSidewaysLeft' || methodName === 'walkSidewaysLeftSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = 0.3 * stepCount;
      const previousHeading = heading;
      heading += 90;
      walkThrough(stride, 1, 'Walk Sideways Left', `${stepCount.toFixed(1)} steps`);
      heading = previousHeading;
      addFrame();
    }

    if (methodName === 'walkSidewaysRight' || methodName === 'walkSidewaysRightSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = 0.3 * stepCount;
      const previousHeading = heading;
      heading -= 90;
      walkThrough(stride, 1, 'Walk Sideways Right', `${stepCount.toFixed(1)} steps`);
      heading = previousHeading;
      addFrame();
    }

    if (['squat_to_stand', 'lie_to_stand', 'stand_to_squat'].includes(methodName)) {
      const isSquatting = methodName === 'stand_to_squat';
      const isLying = methodName === 'lie_to_stand';
      const startPose = isSquatting
        ? { torso: 0, hip: 0, knee: 8, ankle: 0 }
        : isLying
        ? { torso: 70, hip: -20, knee: 8, ankle: -5 }
          : { torso: 16, hip: 45, knee: 105, ankle: -50 };
      const label = methodName === 'squat_to_stand'
        ? 'Squat to stand'
        : methodName === 'lie_to_stand' ? 'Lie to stand' : 'Stand to squat';
      const target = isSquatting
        ? { torso: 16, hip: 45, knee: 105, ankle: -50 }
        : { torso: 0, hip: 0, knee: 8, ankle: 0 };

      poseTargets.left_hip_pitch = startPose.hip;
      poseTargets.right_hip_pitch = startPose.hip;
      poseTargets.left_knee_pitch = startPose.knee;
      poseTargets.right_knee_pitch = startPose.knee;
      poseTargets.left_ankle_pitch = startPose.ankle;
      poseTargets.right_ankle_pitch = startPose.ankle;
      torsoPitch = startPose.torso;
      animateAction(20, (progress) => {
        torsoPitch = startPose.torso + (target.torso - startPose.torso) * progress;
        poseTargets.left_hip_pitch = startPose.hip + (target.hip - startPose.hip) * progress;
        poseTargets.right_hip_pitch = poseTargets.left_hip_pitch;
        poseTargets.left_knee_pitch = startPose.knee + (target.knee - startPose.knee) * progress;
        poseTargets.right_knee_pitch = poseTargets.left_knee_pitch;
        poseTargets.left_ankle_pitch = startPose.ankle + (target.ankle - startPose.ankle) * progress;
        poseTargets.right_ankle_pitch = poseTargets.left_ankle_pitch;
      }, label, 'Approximate posture transition', 1);

      if (!isSquatting) {
        torsoPitch = 0;
        ['left_hip_pitch', 'right_hip_pitch', 'left_knee_pitch', 'right_knee_pitch', 'left_ankle_pitch', 'right_ankle_pitch']
          .forEach((joint) => delete poseTargets[joint]);
      }
    }

    if (methodName === 'walk' || methodName === 'backward' || methodName === 'walktime' || methodName === 'backwardtime' ||
      methodName === 'slowwalk' || methodName === 'slowwalktime' || methodName === 'fastwalk' || methodName === 'fastwalktime') {
      const isTime = methodName.endsWith('time');
      const isBackward = methodName === 'backward' || methodName === 'backwardtime';
      const speed = methodName.startsWith('slow') ? 0.2 : methodName.startsWith('fast') ? 0.8 : 0.4;
      const duration = isTime ? firstNumber : firstNumber * G1_NOMINAL_STEP_METERS / speed;
      const distance = duration * speed;
      const summary = isTime ? `${duration.toFixed(2)} seconds` : `${firstNumber.toFixed(1)} steps`;
      walkThrough(
        distance,
        isBackward ? -1 : 1,
        isBackward ? 'Walk backward' : methodName.startsWith('slow') ? 'Slow walk' : methodName.startsWith('fast') ? 'Fast walk' : 'Walk forward',
        summary,
        duration,
      );
    }

    if (methodName === 'sidestep') {
      const side = /["']right["']/i.test(argsRaw) ? -90 : 90;
      const stepCountMatch = argsRaw.match(/,\s*(\d+)/);
      const stepCount = stepCountMatch ? Number(stepCountMatch[1]) : 1;
      const previousHeading = heading;
      heading += side;
      walkThrough(0.4 * stepCount, 1, 'Sidestep', `${side > 0 ? 'Left' : 'Right'} • ${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`, 2 * stepCount);
      heading = previousHeading;
    }

    if (methodName === 'turn' || methodName === 'turn_around_180') {
      const directionMatch = argsRaw.match(/["'](left|right)["']/i);
      const amountMatch = argsRaw.match(/,\s*(-?\d*\.?\d+)/);
      const amount = methodName === 'turn_around_180'
        ? 180
        : amountMatch ? Number(amountMatch[1]) : 90;
      const delta = methodName === 'turn_around_180' || directionMatch?.[1].toLowerCase() !== 'right'
        ? amount
        : -amount;
      animateTurn(
        delta,
        Math.max(10, Math.ceil(Math.abs(amount) / 6)),
        delta > 0 ? 'Turn Left' : 'Turn Right',
        `${Math.abs(amount)}°`,
        Math.abs((amount * Math.PI / 180) / 0.6),
      );
    }

    if (methodName === 'turnLeft') {
      const amount = firstNumber || 90;
      animateTurn(amount, 14, 'Turn Left', `${amount}°`);
    }

    if (methodName === 'turnRight') {
      const amount = firstNumber || 90;
      animateTurn(-amount, 14, 'Turn Right', `${amount}°`);
    }

    if (methodName === 'wait' || methodName === 'waitSeconds') {
      const duration = firstNumber || 0.5;
      animateAction(
        Math.max(1, Math.ceil(duration * 30)),
        () => {},
        'Wait',
        `${duration}s`,
        duration,
      );
    }

    if (methodName === 'stand') {
      const startingPitch = torsoPitch;
      animateAction(12, (progress) => {
        torsoPitch = startingPitch * (1 - progress);
        torsoRoll *= 1 - progress;
      }, 'Stand', 'Robot stands upright.');
      torsoPitch = 0;
      torsoRoll = 0;
      Object.keys(poseTargets).forEach((joint) => { poseTargets[joint] = 0; });
    }

    if (methodName === 'simulate_arm_action' || methodName === 'arm_action' || methodName === 'hold_arm') {
      const actionArgument = methodName === 'hold_arm' ? argsRaw.split(',')[0].trim() : argsRaw;
      const action = actionArgument.replace(/^["']|["']$/g, '').toLowerCase();
      const armPoses = getLegacyArmPoseTargets(action);
      const sequence = methodName === 'hold_arm' ? armPoses.slice(0, 1) : armPoses;
      sequence.forEach((targets) => {
        animateArmTargets(
          targets,
          `Arm preset preview: ${action}`,
          'Approximate catalog pose with simulator-only wrist angles; the SDK trajectory is not exposed.',
        );
      });
      if (methodName === 'hold_arm') {
        const holdSeconds = Number(argsRaw.split(',')[1]);
        animateAction(
          Math.max(1, Math.ceil(holdSeconds * 30)),
          () => {},
          'Hold arm pose',
          `${action} • timed preview only; robot SDK does not actively hold joint targets.`,
          holdSeconds,
        );
      }
      return;
    }

    if (methodName === 'stop') {
      actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
      timeline.push({ label: 'Stop', summary: 'Movement stopped' });
    }

    if (methodName === 'raiseLeftKnee' || methodName === 'raiseRightKnee') {
      const side = methodName === 'raiseLeftKnee' ? 'left' : 'right';
      animateAction(14, (progress) => {
        poseTargets[`${side}_hip_pitch`] = -25 * progress;
        poseTargets[`${side}_knee_pitch`] = 8 + 65 * progress;
        poseTargets[`${side}_ankle_pitch`] = -20 * progress;
      }, methodName === 'raiseLeftKnee' ? 'Raise left knee' : 'Raise right knee', 'leg pose');
    }

    if (methodName.startsWith('knee')) {
      const side = methodName === 'kneeleft' ? 'left' : 'right';
      animateAction(14, (progress) => {
        poseTargets[`${side}_hip_pitch`] = -25 * progress;
        poseTargets[`${side}_knee_pitch`] = 8 + 65 * progress;
        poseTargets[`${side}_ankle_pitch`] = -20 * progress;
      }, `Raise ${side} knee`, 'leg pose');
    }

    const normalizedMethod = methodName.toLowerCase();
    if (normalizedMethod.startsWith('wave') || normalizedMethod.startsWith('raise') || normalizedMethod.startsWith('kick')) {
      const side = normalizedMethod.includes('right') ? 'right' : 'left';
      const rawLevel = argsRaw.match(/["'](high|mid|low)["']/i)?.[1]?.toLowerCase();
      const requestedDegrees = Number((argsRaw.match(/-?\d*\.?\d+/) || [90])[0]);
      const amount = rawLevel ? ({ low: 30, mid: 60, high: 90 })[rawLevel] : requestedDegrees;
      const level = rawLevel || (amount <= 40 ? 'low' : amount <= 75 ? 'mid' : 'high');
      const isBoth = normalizedMethod.startsWith('raisebotharms');
      const isKick = normalizedMethod.startsWith('kick');
      if (isKick) {
        animateAction(16, (progress) => {
          const sides = isBoth ? ['left', 'right'] : [side];
          sides.forEach((armSide) => {
            poseTargets[`${armSide}_hip_pitch`] = amount * 0.45 * progress;
            poseTargets[`${armSide}_knee_pitch`] = 10 + amount * progress;
            poseTargets[`${armSide}_ankle_pitch`] = -amount * 0.35 * progress;
          });
        }, normalizedMethod.replace(/degrees$/, ''), `${amount}°`);
      }

      if (!isKick) {
        const isWave = normalizedMethod.startsWith('wave');
        const poseName = isBoth ? `both_raise_${level}` : `${side}_${isWave ? 'wave' : 'raise'}_${level}`;
        const target = getArmTargetsFromPose(poseName);
        const scale = rawLevel ? 1 : amount / 90;
        const activeSides = isBoth ? ['left', 'right'] : [side];
        const scaledTarget = Object.fromEntries(Object.entries(target).map(([joint, value]) => [
          joint,
          activeSides.some((activeSide) => joint.startsWith(`${activeSide}_`)) ? value * scale : value,
        ]));

        if (isWave) {
          const outTarget = getArmTargetsFromPose(`${poseName}_out`);
          const scaledOutTarget = Object.fromEntries(Object.entries(outTarget).map(([joint, value]) => [
            joint,
            activeSides.some((activeSide) => joint.startsWith(`${activeSide}_`)) ? value * scale : value,
          ]));
          animateArmTargets(scaledTarget, normalizedMethod, `${amount}°`, 0.6, 18);
          for (let cycle = 0; cycle < 3; cycle += 1) {
            animateArmTargets(scaledOutTarget, normalizedMethod, `${amount}°`, 0.25, 8);
            animateArmTargets(scaledTarget, normalizedMethod, `${amount}°`, 0.25, 8);
          }
        } else {
          animateArmTargets(scaledTarget, normalizedMethod.replace(/degrees$/, ''), `${amount}°`);
        }
      }
    }

    if (methodName === 'raiseLeftLeg' || methodName === 'raiseRightLeg' || methodName === 'kick') {
      const side = methodName === 'raiseRightLeg' ? 'right' : 'left';
      animateAction(18, (progress) => {
        const kick = Math.sin(progress * Math.PI) * 55;
        poseTargets[`${side}_hip_pitch`] = kick * 0.45;
        poseTargets[`${side}_knee_pitch`] = 10 + kick;
        poseTargets[`${side}_ankle_pitch`] = -kick * 0.35;
      }, side === 'left' ? 'Kick left' : 'Kick right', 'leg gesture');
    }

    path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
    addFrame();
  };

  const closestObstacleDistance = (sector) => {
    const radians = (heading * Math.PI) / 180;
    const maxRangeMeters = 40;
    const direction = sector === 'rear' ? -1 : 1;
    let closestDistance = maxRangeMeters;
    obstacles.forEach((obstacle) => {
      const dx = Number(obstacle.x) - x;
      const dy = Number(obstacle.y) - y;
      const forward = direction * (dx * Math.cos(radians) + dy * Math.sin(radians));
      const lateral = direction * (-dx * Math.sin(radians) + dy * Math.cos(radians));
      if (forward <= 0 || Math.abs(Math.atan2(lateral, forward)) > Math.PI / 6) return;
      const radius = Number.isFinite(Number(obstacle.radius)) ? Math.max(0, Number(obstacle.radius)) : 0;
      closestDistance = Math.min(closestDistance, Math.max(0, Math.hypot(forward, lateral) - radius));
    });
    return closestDistance;
  };
  const booleanVariables = new Map();

  const executeNodes = (nodes) => {
    nodes.forEach((node) => {
      if (node.type === 'command') {
        const openingParenthesis = node.code.indexOf('(');
        executeCommand([node.code, node.method, node.code.slice(openingParenthesis + 1, -1)]);
        return;
      }
      if (node.type === 'boolean_assignment') {
        booleanVariables.set(node.name, node.value);
        actions.push({ label: 'Set Boolean variable', summary: `${node.name} = ${node.value}` });
        timeline.push({ label: 'Set Boolean variable', summary: `${node.name} = ${node.value}` });
        addFrame();
        return;
      }
      if (node.type === 'repeat') {
        for (let iteration = 0; iteration < node.times; iteration += 1) executeNodes(node.body);
        return;
      }
      let selectedThen;
      let summary;
      if (typeof node.value === 'boolean') {
        selectedThen = node.value;
        summary = `${node.code} → ${selectedThen ? 'then' : 'else'}`;
      } else if (node.variable) {
        if (!booleanVariables.has(node.variable)) {
          throw new Error(`Boolean variable '${node.variable}' was not assigned before simulation.`);
        }
        selectedThen = booleanVariables.get(node.variable);
        summary = `${node.variable} is ${selectedThen} → ${selectedThen ? 'then' : 'else'}`;
      } else {
        const sector = node.sensor === 'rear_distance_m' ? 'rear' : 'forward';
        const distance = closestObstacleDistance(sector);
        const operators = {
          '<': (left, right) => left < right,
          '<=': (left, right) => left <= right,
          '>': (left, right) => left > right,
          '>=': (left, right) => left >= right,
          '==': (left, right) => left === right,
          '!=': (left, right) => left !== right,
        };
        selectedThen = operators[node.operator](distance, node.threshold);
        const side = sector === 'rear' ? 'rear' : 'forward';
        summary = `Nearest ${side} obstacle: ${distance.toFixed(2)} m ${node.operator} ${node.threshold} m → ${selectedThen ? 'then' : 'else'}`;
      }
      const label = node.variable || typeof node.value === 'boolean'
        ? 'Boolean condition'
        : 'Distance condition';
      actions.push({ label, summary });
      timeline.push({ label, summary });
      addFrame();
      executeNodes(selectedThen ? node.then : node.else);
    });
  };

  if (programNodes) executeNodes(programNodes);
  else commandMatches.forEach(executeCommand);

  if (!frames.length) {
    addFrame();
  }

  return frames;
}

export function simulateG1Edu23Program(pythonCode, options = {}) {
  const { mode = 'kid-preview', obstacles = G1_EDU_23_ENV.defaultObstacles, challenge = null } = options;
  const frames = buildG1SimulationFrames(pythonCode, { mode, obstacles, challenge });
  return frames[frames.length - 1] || {
    ...createEmptyG1Edu23State(),
    blocked: false,
    collisions: 0,
    goal: challenge?.goal || null,
  };
}

export function buildG1SimulationFrames(pythonCode, options = {}) {
  return buildLegacyG1SimulationFrames(pythonCode, options);
}
