export const G1_EDU_23_ENV = {
  robotType: 'G1 EDU 23',
  jointCount: 23,
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
  joints: [
    'left_hip_yaw', 'left_hip_roll', 'left_hip_pitch', 'left_knee_pitch', 'left_ankle_pitch', 'left_ankle_roll',
    'right_hip_yaw', 'right_hip_roll', 'right_hip_pitch', 'right_knee_pitch', 'right_ankle_pitch', 'right_ankle_roll',
    'waist_yaw', 'waist_roll', 'waist_pitch',
    'left_shoulder_pitch', 'left_shoulder_roll', 'left_shoulder_yaw', 'left_elbow_pitch', 'left_wrist_yaw', 'left_wrist_roll',
    'right_shoulder_pitch', 'right_shoulder_roll', 'right_shoulder_yaw', 'right_elbow_pitch', 'right_wrist_yaw', 'right_wrist_roll',
  ],
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

function isBlockedByObstacle(x, y, obstacles = []) {
  if (!obstacles.length) return false;
  return obstacles.some((obstacle) => {
    const dx = x - obstacle.x;
    const dy = y - obstacle.y;
    return Math.hypot(dx, dy) < obstacle.radius + 7;
  });
}

export function simulateG1Edu23Program(pythonCode, options = {}) {
  const { mode = 'kid-preview', obstacles = G1_EDU_23_ENV.defaultObstacles, challenge = null } = options;

  if (!pythonCode || !pythonCode.trim()) {
    return {
      ...createEmptyG1Edu23State(),
      blocked: false,
      collisions: 0,
      goal: challenge?.goal || null,
    };
  }

  const normalized = pythonCode.replace(/\r/g, '');
  const moveMatches = [...normalized.matchAll(/sport_client\.Move\(([^)]*)\)/g)];
  const stopMatches = [...normalized.matchAll(/sport_client\.StopMove\(\)/g)];
  const standUpMatches = [...normalized.matchAll(/sport_client\.Squat2StandUp\(\)/g)];
  const robotMatches = [...normalized.matchAll(/robot\.(\w+)\(([^)]*)\)/g)];

  if (moveMatches.length === 0 && stopMatches.length === 0 && standUpMatches.length === 0 && robotMatches.length === 0) {
    return {
      ...createEmptyG1Edu23State(),
      status: 'Idle',
      actions: [{ label: 'No G1 motion blocks', summary: 'Add a move, turn, or stand-up block to preview the robot.' }],
      blocked: false,
      collisions: 0,
      goal: challenge?.goal || null,
    };
  }

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

  moveMatches.forEach((match, index) => {
    const rawArgs = (match[1] || '').split(',').map((part) => part.trim());
    const vx = Number(rawArgs[0] ?? 0);
    const vz = Number(rawArgs[2] ?? 0);
    const sleepMatch = normalized.slice(match.index + match[0].length).match(/time\.sleep\(([^)]*)\)/);
    const seconds = Math.max(0, Number(sleepMatch?.[1] ?? 1));

    if (Math.abs(vx) > 0.001) {
      const distance = vx * seconds * 30;
      const radians = (heading * Math.PI) / 180;
      const nextX = x + Math.cos(radians) * distance;
      const nextY = y + Math.sin(radians) * distance;

      if (mode === 'advanced-physics' && isBlockedByObstacle(nextX, nextY, obstacles)) {
        collisionCount += 1;
        actions.push({
          label: 'Obstacle detected',
          summary: `Blocked before reaching ${nextX.toFixed(1)}, ${nextY.toFixed(1)}`,
        });
        timeline.push({ label: 'Block hit', summary: 'Robot avoided a barrier' });
        x = Number(nextX.toFixed(2));
        y = Number(nextY.toFixed(2));
        path.push({ x, y });
        return;
      }

      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      torsoPitch = Math.min(20, Math.max(-20, vx * 28));
      actions.push({
        label: vx > 0 ? 'Walk forward' : 'Walk backward',
        summary: `${Math.abs(vx).toFixed(2)} speed • ${seconds.toFixed(1)} s`,
      });
      timeline.push({ label: vx > 0 ? 'Walk forward' : 'Walk backward', summary: `${seconds.toFixed(1)} s` });
    }

    if (Math.abs(vz) > 0.001) {
      const turnDegrees = vz * seconds * 60;
      heading += turnDegrees;
      torsoRoll = Math.min(18, Math.max(-18, vz * 18));
      actions.push({
        label: vz > 0 ? 'Turn left' : 'Turn right',
        summary: `${Math.abs(vz).toFixed(2)} turn • ${seconds.toFixed(1)} s`,
      });
      timeline.push({ label: vz > 0 ? 'Turn left' : 'Turn right', summary: `${Math.abs(turnDegrees).toFixed(0)}°` });
    }

    if (Math.abs(vx) <= 0.001 && Math.abs(vz) <= 0.001) {
      actions.push({ label: 'Pause', summary: `${seconds.toFixed(1)} s` });
      timeline.push({ label: 'Pause', summary: `${seconds.toFixed(1)} s` });
    }

    path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });

    if (index === moveMatches.length - 1 && stopMatches.length > 0) {
      actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
      timeline.push({ label: 'Stop', summary: 'Movement stopped' });
    }
  });

  robotMatches.forEach((match) => {
    const methodName = match[1];
    const argsRaw = match[2] || '';
    const firstNumber = Number((argsRaw.match(/-?\d*\.?\d+/) || ['1'])[0]);
    const labelMap = {
      walkForward: 'Walk Forward',
      walkBackward: 'Walk Back',
      walkForwardSteps: 'Walk Forward',
      walkBackwardSteps: 'Walk Back',
      walkSidewaysLeft: 'Walk Sideways Left',
      walkSidewaysRight: 'Walk Sideways Right',
      walkSidewaysLeftSteps: 'Walk Sideways Left',
      walkSidewaysRightSteps: 'Walk Sideways Right',
      turnLeft: 'Turn Left',
      turnRight: 'Turn Right',
      raiseLeftArm: 'Raise Left Arm',
      raiseRightArm: 'Raise Right Arm',
      raiseBothArms: 'Raise Both Arms',
      lowerBothArms: 'Lower Both Arms',
      raiseLeftLeg: 'Left Leg Kick',
      raiseRightLeg: 'Right Leg Kick',
      raiseLeftKnee: 'Raise Left Knee',
      raiseRightKnee: 'Raise Right Knee',
      wait: 'Wait',
      waitSeconds: 'Wait',
      repeatLoop: 'Repeat Loop',
      stand: 'Stand',
      sit: 'Sit',
      stop: 'Stop',
      waveLeft: 'Wave Left',
      waveRight: 'Wave Right',
    };

    if (methodName === 'walkForward' || methodName === 'walkForwardSteps') {
      const nextX = x + Math.cos((heading * Math.PI) / 180) * (0.4 * firstNumber * 10);
      const nextY = y + Math.sin((heading * Math.PI) / 180) * (0.4 * firstNumber * 10);
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Forward', summary: `${firstNumber.toFixed(1)} x speed` });
      timeline.push({ label: 'Walk Forward', summary: `${firstNumber.toFixed(1)} x speed` });
    }
    if (methodName === 'walkBackward' || methodName === 'walkBackwardSteps') {
      const nextX = x - Math.cos((heading * Math.PI) / 180) * (0.4 * firstNumber * 10);
      const nextY = y - Math.sin((heading * Math.PI) / 180) * (0.4 * firstNumber * 10);
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Back', summary: `${firstNumber.toFixed(1)} x speed` });
      timeline.push({ label: 'Walk Back', summary: `${firstNumber.toFixed(1)} x speed` });
    }
    if (methodName === 'walkSidewaysLeft' || methodName === 'walkSidewaysLeftSteps') {
      const nextX = x + Math.cos((heading * Math.PI / 180 + Math.PI / 2)) * (0.3 * firstNumber * 10);
      const nextY = y + Math.sin((heading * Math.PI / 180 + Math.PI / 2)) * (0.3 * firstNumber * 10);
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Sideways Left', summary: `${firstNumber.toFixed(1)} x speed` });
      timeline.push({ label: 'Walk Sideways Left', summary: `${firstNumber.toFixed(1)} x speed` });
    }
    if (methodName === 'walkSidewaysRight' || methodName === 'walkSidewaysRightSteps') {
      const nextX = x + Math.cos((heading * Math.PI / 180 - Math.PI / 2)) * (0.3 * firstNumber * 10);
      const nextY = y + Math.sin((heading * Math.PI / 180 - Math.PI / 2)) * (0.3 * firstNumber * 10);
      x = Number(nextX.toFixed(2));
      y = Number(nextY.toFixed(2));
      actions.push({ label: 'Walk Sideways Right', summary: `${firstNumber.toFixed(1)} x speed` });
      timeline.push({ label: 'Walk Sideways Right', summary: `${firstNumber.toFixed(1)} x speed` });
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
      actions.push({ label: 'Wait', summary: `${firstNumber}s` });
      timeline.push({ label: 'Wait', summary: `${firstNumber}s` });
    }
    if (methodName === 'repeatLoop') {
      actions.push({ label: 'Repeat Loop', summary: `${firstNumber} times` });
      timeline.push({ label: 'Repeat Loop', summary: `${firstNumber} times` });
    }
    if (methodName === 'stop') {
      actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
      timeline.push({ label: 'Stop', summary: 'Movement stopped' });
    }
    if (methodName === 'sit') {
      torsoPitch = 12;
      actions.push({ label: 'Sit', summary: 'Robot lowers into a seated pose.' });
      timeline.push({ label: 'Sit', summary: 'Seated pose' });
    }
    if (labelMap[methodName]) {
      actions.push({ label: labelMap[methodName], summary: argsRaw || 'Action' });
      timeline.push({ label: labelMap[methodName], summary: argsRaw || 'Action' });
    }
    path.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
  });

  if (standUpMatches.length > 0) {
    torsoPitch = 0;
    torsoRoll = 0;
    actions.push({ label: 'Stand up', summary: 'Return to neutral standing stance.' });
    timeline.push({ label: 'Stand up', summary: 'Ready again' });
  }

  if (actions.length === 0 && stopMatches.length > 0) {
    actions.push({ label: 'Stop', summary: 'Robot stops movement.' });
    timeline.push({ label: 'Stop', summary: 'Movement stopped' });
  }

  const finalGoal = challenge?.goal || null;
  const goalReached = !!finalGoal && Math.hypot(x - finalGoal.x, y - finalGoal.y) <= (finalGoal.radius || 8);
  const blocked = mode === 'advanced-physics' && collisionCount > 0;

  const walkPhase = Math.min(path.length, 30) / 30;
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

  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    heading: Number(normalizeAngle(heading).toFixed(2)),
    torsoPitch: Number(torsoPitch.toFixed(2)),
    torsoRoll: Number(torsoRoll.toFixed(2)),
    status: goalReached ? 'Goal reached' : blocked ? 'Blocked' : 'Preview',
    path,
    actions: actions.length ? actions : [{ label: 'Idle', summary: 'Ready for a motion block.' }],
    collisions: collisionCount,
    blocked,
    goalReached,
    goal: finalGoal,
    timeline,
    joints: jointState,
    mode,
  };
}
