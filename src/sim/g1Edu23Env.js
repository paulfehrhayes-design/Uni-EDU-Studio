import { G1_MODEL_INFO } from './g1ModelRuntime.js';

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
    { id: 'block-1', x: 26, y: 18, radius: 12 },
    { id: 'block-2', x: -18, y: -10, radius: 14 },
    { id: 'block-3', x: 8, y: -26, radius: 10 },
  ],
  challengeLayouts: {
    'simple-path': {
      label: 'Simple path',
      goal: { x: 30, y: 28, radius: 10 },
      obstacles: [
        { id: 'wall-1', x: 12, y: -12, radius: 9 },
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
    id: 'forward-2s',
    label: 'Forward 2s',
    code: `sport_client.Move(0.4, 0.0, 0.0, False)\ntime.sleep(2)\nsport_client.StopMove()\n`,
  },
  {
    id: 'turn-left-1s',
    label: 'Turn left 1s',
    code: `sport_client.Move(0.0, 0.0, 0.6, False)\ntime.sleep(1)\nsport_client.StopMove()\n`,
  },
  {
    id: 'square-path',
    label: 'Square path',
    code: `sport_client.Move(0.4, 0.0, 0.0, False)\ntime.sleep(2)\nsport_client.StopMove()\n\nsport_client.Move(0.0, 0.0, 0.6, False)\ntime.sleep(1)\nsport_client.StopMove()\n\nsport_client.Move(0.4, 0.0, 0.0, False)\ntime.sleep(2)\nsport_client.StopMove()\n\nsport_client.Move(0.0, 0.0, 0.6, False)\ntime.sleep(1)\nsport_client.StopMove()\n`,
  },
  {
    id: 'stand-up',
    label: 'Stand up',
    code: `sport_client.Squat2StandUp()\n`,
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
  joints: Object.fromEntries(G1_EDU_23_ENV.joints.map((joint, index) => [joint, Number((index % 7) * 0.05).toFixed(3)])),
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
    return ['robot.stand();', 'robot.wait(0.5);', 'robot.stand();', 'console.log("Program complete!");'];
  }

  const commands = ['robot.stand();', 'robot.wait(0.5);'];
  let previous = G1_EDU_23_ENV.initialPose;

  waypoints.forEach((waypoint) => {
    const x = Number(waypoint.x);
    const y = Number(waypoint.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x - previous.x, y - previous.y) <= 0.01) return;
    commands.push(`robot.moveTo(${x.toFixed(2)}, ${y.toFixed(2)});`);
    previous = { x, y };
  });

  if (commands.length === 2) {
    commands.push('robot.moveTo(0, 0);');
  }

  commands.push('robot.stand();');
  commands.push('console.log("Program complete!");');
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
  const commandMatches = [
    ...normalized.matchAll(/robot\.(\w+)\(([^)]*)\)/g),
    ...normalized.matchAll(/sport_client\.Move\(([^)]*)\)/g),
    ...normalized.matchAll(/sport_client\.StopMove\(\)/g),
    ...normalized.matchAll(/sport_client\.Squat2StandUp\(\)/g),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  if (!commandMatches.length) {
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
  const poseTargets = {};

  const addFrame = (isInitial = false) => {
    const finalGoal = challenge?.goal || null;
    const goalReached = !!finalGoal && Math.hypot(x - finalGoal.x, y - finalGoal.y) <= (finalGoal.radius || 8);
    const blocked = mode === 'advanced-physics' && collisionCount > 0;
    const walkPhase = isInitial ? 0 : gaitPhase;
    const leftSwing = Math.sin(walkPhase * Math.PI * 2) * 26;
    const rightSwing = Math.sin(walkPhase * Math.PI * 2 + Math.PI) * 26;

    jointState.left_hip_pitch = Number((leftSwing * 0.8 + torsoPitch * 0.4).toFixed(2));
    jointState.right_hip_pitch = Number((rightSwing * 0.8 + torsoPitch * 0.4).toFixed(2));
    jointState.left_knee_pitch = Number((Math.abs(leftSwing) * 0.9 + 8).toFixed(2));
    jointState.right_knee_pitch = Number((Math.abs(rightSwing) * 0.9 + 8).toFixed(2));
    jointState.left_ankle_pitch = Number((-Math.abs(leftSwing) * 0.4).toFixed(2));
    jointState.right_ankle_pitch = Number((-Math.abs(rightSwing) * 0.4).toFixed(2));
    jointState.left_shoulder_pitch = Number((Math.sin(walkPhase * Math.PI) * 18 + torsoPitch * 0.3).toFixed(2));
    jointState.right_shoulder_pitch = Number((Math.sin(walkPhase * Math.PI + Math.PI) * 18 + torsoPitch * 0.3).toFixed(2));
    jointState.left_shoulder_yaw = Number((Math.sin(walkPhase * Math.PI / 2) * 12 + torsoRoll * 0.6).toFixed(2));
    jointState.right_shoulder_yaw = Number((Math.sin(walkPhase * Math.PI / 2 + Math.PI) * 12 + torsoRoll * 0.6).toFixed(2));
    jointState.waist_yaw = Number((heading * 0.28).toFixed(2));
    jointState.waist_pitch = Number((torsoPitch * 0.6).toFixed(2));
    jointState.waist_roll = Number((torsoRoll * 0.8).toFixed(2));
    Object.assign(jointState, poseTargets);

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
    });
  };

  addFrame(true);

  const walkThrough = (distance, direction, label, summary) => {
    const normalizedDirection = direction === 0 ? 0 : (direction > 0 ? 1 : -1);
    const radians = (heading * Math.PI) / 180;
    const travelDistance = Math.abs(distance);
    const frameCount = Math.max(10, Math.ceil(travelDistance * 16));
    const stepScale = travelDistance / frameCount;
    const stepX = Math.cos(radians) * stepScale * normalizedDirection;
    const stepY = Math.sin(radians) * stepScale * normalizedDirection;
    actions.push({ label, summary });
    timeline.push({ label, summary });

    for (let index = 0; index < frameCount; index += 1) {
      x = Number((x + stepX).toFixed(3));
      y = Number((y + stepY).toFixed(3));
      gaitPhase += 0.18;
      torsoPitch = Math.sin(gaitPhase * Math.PI) * (normalizedDirection >= 0 ? 8 : -8);
      path.push({ x, y });
      addFrame();
    }

    torsoPitch = 0;
  };

  const animateAction = (frameCount, update, label, summary) => {
    actions.push({ label, summary });
    timeline.push({ label, summary });
    for (let index = 1; index <= frameCount; index += 1) {
      update(index / frameCount);
      addFrame();
    }
  };

  commandMatches.forEach((match) => {
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
        const turnDegrees = distance * 0.7;
        const startingHeading = heading;
        animateAction(12, (progress) => {
          heading = startingHeading + turnDegrees * progress;
          torsoRoll = Math.sin(progress * Math.PI) * Math.min(18, Math.max(-18, vz * 18));
          poseTargets.left_hip_roll = Math.sin(progress * Math.PI * 2) * 5;
          poseTargets.right_hip_roll = -poseTargets.left_hip_roll;
        }, vz > 0 ? 'Turn left' : 'Turn right', `${Math.abs(turnDegrees).toFixed(0)}°`);
        torsoRoll = 0;
        delete poseTargets.left_hip_roll;
        delete poseTargets.right_hip_roll;
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
          animateAction(14, (progress) => {
            heading = startHeading + turnDelta * progress;
            torsoRoll = Math.sin(progress * Math.PI) * 8;
          }, turnDelta > 0 ? 'Turn Left' : 'Turn Right', `${Math.abs(turnDelta).toFixed(1)}°`);
          heading = startHeading + turnDelta;
          torsoRoll = 0;
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
      const stride = 0.4 * stepCount;
      walkThrough(stride, 1, 'Walk Forward', `${stepCount.toFixed(1)} steps`);
    }

    if (methodName === 'walkBackward' || methodName === 'walkBackwardSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = 0.4 * stepCount;
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

    if (methodName === 'turnLeft') {
      const amount = firstNumber || 90;
      const startingHeading = heading;
      animateAction(14, (progress) => {
        heading = startingHeading + amount * progress;
        torsoRoll = Math.sin(progress * Math.PI) * 8;
        poseTargets.left_hip_roll = Math.sin(progress * Math.PI * 2) * 5;
        poseTargets.right_hip_roll = -poseTargets.left_hip_roll;
      }, 'Turn Left', `${amount}°`);
      torsoRoll = 0;
      delete poseTargets.left_hip_roll;
      delete poseTargets.right_hip_roll;
    }

    if (methodName === 'turnRight') {
      const amount = firstNumber || 90;
      const startingHeading = heading;
      animateAction(14, (progress) => {
        heading = startingHeading - amount * progress;
        torsoRoll = -Math.sin(progress * Math.PI) * 8;
        poseTargets.left_hip_roll = -Math.sin(progress * Math.PI * 2) * 5;
        poseTargets.right_hip_roll = -poseTargets.left_hip_roll;
      }, 'Turn Right', `${amount}°`);
      torsoRoll = 0;
      delete poseTargets.left_hip_roll;
      delete poseTargets.right_hip_roll;
    }

    if (methodName === 'wait' || methodName === 'waitSeconds') {
      actions.push({ label: 'Wait', summary: `${firstNumber || 0.5}s` });
      timeline.push({ label: 'Wait', summary: `${firstNumber || 0.5}s` });
      animateAction(8, () => {}, 'Wait', `${firstNumber || 0.5}s`);
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

    if (methodName === 'sit') {
      const startingPitch = torsoPitch;
      animateAction(14, (progress) => {
        torsoPitch = startingPitch + (12 - startingPitch) * progress;
      }, 'Sit', 'Robot lowers into a seated pose.');
      torsoPitch = 12;
    }

    if (methodName === 'stop') {
      actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
      timeline.push({ label: 'Stop', summary: 'Movement stopped' });
    }

    if (methodName === 'raiseBothArms' || methodName === 'lowerBothArms') {
      const target = methodName === 'raiseBothArms' ? -75 : 0;
      animateAction(14, (progress) => {
        poseTargets.left_shoulder_pitch = target * progress;
        poseTargets.right_shoulder_pitch = target * progress;
        poseTargets.left_elbow = target * progress * 0.4;
        poseTargets.right_elbow = target * progress * 0.4;
      }, methodName === 'raiseBothArms' ? 'Raise Both Arms' : 'Lower Both Arms', 'Arm pose adjusted.');
    }

    if (methodName === 'waveLeft' || methodName === 'waveRight') {
      const side = methodName === 'waveLeft' ? 'left' : 'right';
      animateAction(18, (progress) => {
        const wave = Math.sin(progress * Math.PI * 4) * 35;
        poseTargets[`${side}_shoulder_pitch`] = -55;
        poseTargets[`${side}_shoulder_roll`] = side === 'left' ? -30 : 30;
        poseTargets[`${side}_elbow`] = -75;
        poseTargets[`${side}_wrist_roll`] = wave;
      }, methodName === 'waveLeft' ? 'Wave left' : 'Wave right', 'Arm gesture');
    }

    if (methodName === 'raiseLeftArm' || methodName === 'raiseRightArm') {
      const side = methodName === 'raiseLeftArm' ? 'left' : 'right';
      const degrees = Math.min(180, Math.max(10, firstNumber || 90));
      animateAction(16, (progress) => {
        poseTargets[`${side}_shoulder_pitch`] = -degrees * progress;
        poseTargets[`${side}_shoulder_roll`] = (side === 'left' ? -1 : 1) * degrees * 0.35 * progress;
        poseTargets[`${side}_elbow`] = -degrees * 0.45 * progress;
      }, methodName === 'raiseLeftArm' ? 'Raise left arm' : 'Raise right arm', `${degrees} degrees`);
    }

    if (methodName === 'raiseLeftKnee' || methodName === 'raiseRightKnee') {
      const side = methodName === 'raiseLeftKnee' ? 'left' : 'right';
      animateAction(14, (progress) => {
        poseTargets[`${side}_hip_pitch`] = -25 * progress;
        poseTargets[`${side}_knee_pitch`] = 8 + 65 * progress;
        poseTargets[`${side}_ankle_pitch`] = -20 * progress;
      }, methodName === 'raiseLeftKnee' ? 'Raise left knee' : 'Raise right knee', 'leg pose');
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
  });

  if (!frames.length) {
    addFrame();
  }

  return frames;
}

function buildUnusedDuplicateG1SimulationFrames(pythonCode, options = {}) {
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
  const commandMatches = [
    ...normalized.matchAll(/robot\.(\w+)\(([^)]*)\)/g),
    ...normalized.matchAll(/sport_client\.Move\(([^)]*)\)/g),
    ...normalized.matchAll(/sport_client\.StopMove\(\)/g),
    ...normalized.matchAll(/sport_client\.Squat2StandUp\(\)/g),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  if (!commandMatches.length) {
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

  const addFrame = (isInitial = false) => {
    const finalGoal = challenge?.goal || null;
    const goalReached = !!finalGoal && Math.hypot(x - finalGoal.x, y - finalGoal.y) <= (finalGoal.radius || 8);
    const blocked = mode === 'advanced-physics' && collisionCount > 0;
    const walkPhase = isInitial ? 0 : Math.min(path.length, 30) / 30;
    const leftSwing = Math.sin(walkPhase * Math.PI * 2) * 26;
    const rightSwing = Math.sin(walkPhase * Math.PI * 2 + Math.PI) * 26;

    jointState.left_hip_pitch = Number((leftSwing * 0.8 + torsoPitch * 0.4).toFixed(2));
    jointState.right_hip_pitch = Number((rightSwing * 0.8 + torsoPitch * 0.4).toFixed(2));
    jointState.left_knee_pitch = Number((Math.abs(leftSwing) * 0.9 + 8).toFixed(2));
    jointState.right_knee_pitch = Number((Math.abs(rightSwing) * 0.9 + 8).toFixed(2));
    jointState.left_ankle_pitch = Number((-Math.abs(leftSwing) * 0.4).toFixed(2));
    jointState.right_ankle_pitch = Number((-Math.abs(rightSwing) * 0.4).toFixed(2));
    jointState.left_shoulder_pitch = Number((Math.sin(walkPhase * Math.PI) * 18 + torsoPitch * 0.3).toFixed(2));
    jointState.right_shoulder_pitch = Number((Math.sin(walkPhase * Math.PI + Math.PI) * 18 + torsoPitch * 0.3).toFixed(2));
    jointState.left_shoulder_yaw = Number((Math.sin(walkPhase * Math.PI / 2) * 12 + torsoRoll * 0.6).toFixed(2));
    jointState.right_shoulder_yaw = Number((Math.sin(walkPhase * Math.PI / 2 + Math.PI) * 12 + torsoRoll * 0.6).toFixed(2));
    jointState.waist_yaw = Number((heading * 0.28).toFixed(2));
    jointState.waist_pitch = Number((torsoPitch * 0.6).toFixed(2));
    jointState.waist_roll = Number((torsoRoll * 0.8).toFixed(2));

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
    });
  };

  addFrame(true);

  commandMatches.forEach((match) => {
    const rawCommand = match[0];
    if (rawCommand.startsWith('sport_client.Move')) {
      const rawArgs = (match[1] || '').split(',').map((part) => part.trim());
      const vx = Number(rawArgs[0] ?? 0);
      const vz = Number(rawArgs[2] ?? 0);
      const distance = Math.hypot(vx, vz) * 2;
      const radians = (heading * Math.PI) / 180;
      const nextX = x + Math.cos(radians) * (vx * 12);
      const nextY = y + Math.sin(radians) * (vx * 12);

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
        x = Number(nextX.toFixed(2));
        y = Number(nextY.toFixed(2));
        torsoPitch = Math.min(20, Math.max(-20, vx * 28));
        actions.push({ label: vx > 0 ? 'Walk forward' : 'Walk backward', summary: `${Math.abs(vx).toFixed(2)} speed` });
        timeline.push({ label: vx > 0 ? 'Walk forward' : 'Walk backward', summary: `${Math.abs(vx).toFixed(2)} speed` });
      }

      if (Math.abs(vz) > 0.001) {
        const turnDegrees = distance * 0.7;
        heading += turnDegrees;
        torsoRoll = Math.min(18, Math.max(-18, vz * 18));
        actions.push({ label: vz > 0 ? 'Turn left' : 'Turn right', summary: `${Math.abs(vz).toFixed(2)} turn` });
        timeline.push({ label: vz > 0 ? 'Turn left' : 'Turn right', summary: `${Math.abs(turnDegrees).toFixed(0)}°` });
      }

      path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
      addFrame();
      return;
    }

    if (rawCommand === 'sport_client.StopMove()') {
      actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
      timeline.push({ label: 'Stop', summary: 'Movement stopped' });
      path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
      addFrame();
      return;
    }

    if (rawCommand === 'sport_client.Squat2StandUp()') {
      torsoPitch = 0;
      torsoRoll = 0;
      actions.push({ label: 'Stand up', summary: 'Return to neutral standing stance.' });
      timeline.push({ label: 'Stand up', summary: 'Ready again' });
      path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
      addFrame();
      return;
    }

    const methodName = match[1];
    const argsRaw = match[2] || '';
    const firstNumber = Number((argsRaw.match(/-?\d*\.?\d+/) || ['0'])[0]);

    if (methodName === 'walkForward' || methodName === 'walkForwardSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = 0.4 * stepCount;
      const nextX = x + Math.cos((heading * Math.PI) / 180) * stride;
      const nextY = y + Math.sin((heading * Math.PI) / 180) * stride;
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Forward', summary: `${stepCount.toFixed(1)} steps` });
      timeline.push({ label: 'Walk Forward', summary: `${stepCount.toFixed(1)} steps` });
    }

    if (methodName === 'walkBackward' || methodName === 'walkBackwardSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = 0.4 * stepCount;
      const nextX = x - Math.cos((heading * Math.PI) / 180) * stride;
      const nextY = y - Math.sin((heading * Math.PI) / 180) * stride;
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Back', summary: `${stepCount.toFixed(1)} steps` });
      timeline.push({ label: 'Walk Back', summary: `${stepCount.toFixed(1)} steps` });
    }

    if (methodName === 'walkSidewaysLeft' || methodName === 'walkSidewaysLeftSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = 0.3 * stepCount;
      const nextX = x + Math.cos((heading * Math.PI / 180 + Math.PI / 2)) * stride;
      const nextY = y + Math.sin((heading * Math.PI / 180 + Math.PI / 2)) * stride;
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Sideways Left', summary: `${stepCount.toFixed(1)} steps` });
      timeline.push({ label: 'Walk Sideways Left', summary: `${stepCount.toFixed(1)} steps` });
    }

    if (methodName === 'walkSidewaysRight' || methodName === 'walkSidewaysRightSteps') {
      const stepCount = Math.max(1, firstNumber || 1);
      const stride = 0.3 * stepCount;
      const nextX = x + Math.cos((heading * Math.PI / 180 - Math.PI / 2)) * stride;
      const nextY = y + Math.sin((heading * Math.PI / 180 - Math.PI / 2)) * stride;
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Sideways Right', summary: `${stepCount.toFixed(1)} steps` });
      timeline.push({ label: 'Walk Sideways Right', summary: `${stepCount.toFixed(1)} steps` });
    }

    if (methodName === 'turnLeft') {
      heading += firstNumber || 90;
      actions.push({ label: 'Turn Left', summary: `${firstNumber || 90}°` });
      timeline.push({ label: 'Turn Left', summary: `${firstNumber || 90}°` });
    }

    if (methodName === 'turnRight') {
      heading -= firstNumber || 90;
      actions.push({ label: 'Turn Right', summary: `${firstNumber || 90}°` });
      timeline.push({ label: 'Turn Right', summary: `${firstNumber || 90}°` });
    }

    if (methodName === 'wait' || methodName === 'waitSeconds') {
      actions.push({ label: 'Wait', summary: `${firstNumber || 0.5}s` });
      timeline.push({ label: 'Wait', summary: `${firstNumber || 0.5}s` });
    }

    if (methodName === 'stand') {
      torsoPitch = 0;
      torsoRoll = 0;
      actions.push({ label: 'Stand', summary: 'Robot stands upright.' });
      timeline.push({ label: 'Stand', summary: 'Ready again' });
    }

    if (methodName === 'sit') {
      torsoPitch = 12;
      actions.push({ label: 'Sit', summary: 'Robot lowers into a seated pose.' });
      timeline.push({ label: 'Sit', summary: 'Seated pose' });
    }

    if (methodName === 'stop') {
      actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
      timeline.push({ label: 'Stop', summary: 'Movement stopped' });
    }

    if (methodName === 'raiseBothArms' || methodName === 'lowerBothArms') {
      actions.push({ label: methodName === 'raiseBothArms' ? 'Raise Both Arms' : 'Lower Both Arms', summary: 'Arm pose adjusted.' });
      timeline.push({ label: methodName === 'raiseBothArms' ? 'Raise Both Arms' : 'Lower Both Arms', summary: 'Arm pose adjusted.' });
    }

    path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
    addFrame();
  });

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
