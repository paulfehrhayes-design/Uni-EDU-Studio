import {
  getDuetArmCatalog,
  getDuetArmGesture,
  getDuetArmPoseNames,
  getDuetArmPoseTarget,
} from './duetArmCatalog.js';

const numberArgument = (name, label, value, min, max, step = 0.01) => ({
  name,
  label,
  kind: 'number',
  value,
  min,
  max,
  step,
});

const seconds = () => numberArgument('SECONDS', 'seconds', 1, 0.1, 3, 0.1);
const command = (method, message, description, args = [], label = message.replace(/%\d+/g, '1')) => ({
  method,
  label,
  message,
  description,
  args,
  type: `duet_command_${method}`,
  codeTemplate: `duet.${method}(${args.map((argument) => (
    argument.kind === 'choice' ? `"{{${argument.name}}}"` : `{{${argument.name}}}`
  )).join(', ')})\n`,
});
const presetMove = (method, message, description, vx, vy, yawRate) => ({
  ...command(method, message, description, [seconds()]),
  motion: Object.freeze({ vx, vy, yawRate }),
});
const armPose = (method, label, pose) => ({
  ...command(method, `${label} for %1 s`, `Apply the fixed ${label.toLowerCase()} arm pose for a bounded lease.`, [
    numberArgument('SECONDS', 'seconds', 1.5, 1, 3, 0.1),
  ]),
  category: 'Arm poses',
  armPoses: Object.freeze([pose]),
  armTargets: Object.freeze([getDuetArmPoseTarget(pose)]),
});
const armGesture = (method, label, poses) => ({
  ...command(
    method,
    `${label} (%1 s per pose)`,
    `Run the fixed ${label.toLowerCase()} arm trajectory, then hold its final pose for 20 seconds before returning to carry. Other actions may continue during the hold, but another gesture must wait until the arms return.`,
    [numberArgument('SECONDS', 'seconds per pose', 1.5, 1, 3, 0.1)],
  ),
  category: 'Arm gestures',
  armPoses: Object.freeze(poses),
  armTargets: Object.freeze(poses.map(getDuetArmPoseTarget)),
});

const DUET_ARM_MOTIONS = Object.freeze({
  reach_and_return: Object.freeze(['forward', 'carry']),
  receive_and_hold: Object.freeze(['forward', 'box_hold']),
  hold_and_return: Object.freeze(['box_hold', 'carry']),
  receive_hold_return: Object.freeze(['forward', 'box_hold', 'carry']),
  wave_left: Object.freeze(['forward', 'box_hold', 'carry']),
  wave_right: Object.freeze(['forward', 'box_hold', 'carry']),
  raise_left_arm: Object.freeze(['carry', 'forward']),
  raise_right_arm: Object.freeze(['carry', 'forward']),
  raise_both_arms: Object.freeze(['forward', 'carry']),
});

const DUET_ARM_LEVEL_MOTIONS = Object.freeze({
  wave_left: Object.freeze({
    low: ['left_wave_low', 'left_wave_low_out', 'left_wave_low', 'left_wave_low_out', 'carry'],
    mid: ['left_wave_mid', 'left_wave_mid_out', 'left_wave_mid', 'left_wave_mid_out', 'carry'],
    high: ['left_wave_high', 'left_wave_high_out', 'left_wave_high', 'left_wave_high_out', 'carry'],
  }),
  wave_right: Object.freeze({
    low: ['right_wave_low', 'right_wave_low_out', 'right_wave_low', 'right_wave_low_out', 'carry'],
    mid: ['right_wave_mid', 'right_wave_mid_out', 'right_wave_mid', 'right_wave_mid_out', 'carry'],
    high: ['right_wave_high', 'right_wave_high_out', 'right_wave_high', 'right_wave_high_out', 'carry'],
  }),
  raise_left_arm: Object.freeze({
    low: ['left_raise_low', 'carry'],
    mid: ['left_raise_mid', 'carry'],
    high: ['left_raise_high', 'carry'],
  }),
  raise_right_arm: Object.freeze({
    low: ['right_raise_low', 'carry'],
    mid: ['right_raise_mid', 'carry'],
    high: ['right_raise_high', 'carry'],
  }),
  raise_both_arms: Object.freeze({
    low: ['both_raise_low', 'carry'],
    mid: ['both_raise_mid', 'carry'],
    high: ['both_raise_high', 'carry'],
  }),
});

export const DUET_ARM_COMMANDS = Object.freeze({
  arm_carry: Object.freeze(['carry']),
  arm_reach: Object.freeze(['forward']),
  arm_box_hold: Object.freeze(['box_hold']),
  reach_and_return: DUET_ARM_MOTIONS.reach_and_return,
  receive_and_hold: DUET_ARM_MOTIONS.receive_and_hold,
  hold_and_return: DUET_ARM_MOTIONS.hold_and_return,
  receive_hold_return: DUET_ARM_MOTIONS.receive_hold_return,
  ...Object.fromEntries(Object.entries(DUET_ARM_LEVEL_MOTIONS).flatMap(([method, levels]) => (
    Object.entries(levels).map(([level, poses]) => [`${method}_${level}`, Object.freeze(poses)])
  ))),
});

const catalogGestureCommands = Object.keys(getDuetArmGestureCatalog()).map((method) => {
  const gesture = getDuetArmGesture(method);
  return armGesture(
    `gesture_${method.replace(/^legacy_/, '')}`,
    gesture.label,
    gesture.poses.map(({ name }) => name),
  );
});

const holdPoseCommand = (method, label, description, args) => ({
  ...command(method, label, description, args),
  poseInput: true,
});
const MIN_DISTANCE_METERS = 0.1;
const MAX_DISTANCE_METERS = 40;
const DUET_DISTANCE_SENSORS = Object.freeze([
  {
    type: 'duet_front_distance_m',
    sensor: 'front_distance_m',
    message0: 'Front obstacle distance (m)',
    tooltip: 'Read fresh, calibrated MID-360 forward footprint clearance.',
  },
  {
    type: 'duet_rear_distance_m',
    sensor: 'rear_distance_m',
    message0: 'Rear obstacle distance (m)',
    tooltip: 'Read fresh, calibrated MID-360 rear footprint clearance.',
  },
]);

const DUET_ARM_POSE_BLOCKS = Object.freeze(getDuetArmPoseNames().map((poseName) => Object.freeze({
  type: `duet_pose_target_${poseName}`,
  label: poseName.replaceAll('_', ' '),
  message: poseName.replaceAll('_', ' '),
  description: `Use the bounded ${poseName.replaceAll('_', ' ')} arm target.`,
  codeTemplate: `duet.pose(${JSON.stringify(poseName)})`,
  output: 'String',
  category: 'Arm pose targets',
})));

export const DUET_COMMANDS = Object.freeze([
  command('move', 'Move vx %1 vy %2 yaw %3 for %4 s', 'Bounded DUET planar velocity and yaw-rate command for a short duration.', [
    numberArgument('VX', 'forward m/s', 0.15, -0.2, 0.3),
    numberArgument('VY', 'lateral m/s', 0, -0.15, 0.15),
    numberArgument('YAW_RATE', 'yaw rad/s', 0, -0.35, 0.35),
    seconds(),
  ], 'Move with custom velocity'),
  presetMove('walk', 'Walk forward for %1 s', 'Walk forward at a conservative fixed velocity for the selected time. DUET uses timed velocity, not Legacy step counts.', 0.15, 0, 0),
  presetMove('backward', 'Move backward for %1 s', 'Move backward at a conservative fixed velocity.', -0.1, 0, 0),
  presetMove('strafe_left', 'Strafe left for %1 s', 'Move laterally left at a conservative fixed velocity.', 0, 0.1, 0),
  presetMove('strafe_right', 'Strafe right for %1 s', 'Move laterally right at a conservative fixed velocity.', 0, -0.1, 0),
  presetMove('turn_left', 'Turn left for %1 s', 'Turn left at a conservative fixed yaw rate; final angle is not guaranteed.', 0, 0, 0.25),
  presetMove('turn_right', 'Turn right for %1 s', 'Turn right at a conservative fixed yaw rate; final angle is not guaranteed.', 0, 0, -0.25),
  {
    ...command(
      'turn_around_180',
      'Turn around about 180° in place',
      'Turn in place by about 180° using bounded left-yaw segments. The final angle is approximate; keep the area clear and supervise.',
    ),
    motion: Object.freeze({ vx: 0, vy: 0, yawRate: 0.25 }),
  },
  presetMove('arc_forward_left', 'Arc forward-left for %1 s', 'Combine conservative forward velocity and left yaw rate.', 0.12, 0, 0.2),
  presetMove('arc_forward_right', 'Arc forward-right for %1 s', 'Combine conservative forward velocity and right yaw rate.', 0.12, 0, -0.2),
  presetMove('arc_backward_left', 'Arc backward-left for %1 s', 'Combine conservative backward velocity and left yaw rate.', -0.08, 0, 0.2),
  presetMove('arc_backward_right', 'Arc backward-right for %1 s', 'Combine conservative backward velocity and right yaw rate.', -0.08, 0, -0.2),
  ...[
    armPose('arm_carry', 'Carry / neutral arms', 'carry'),
    armPose('arm_reach', 'Reach forward', 'forward'),
    armPose('arm_box_hold', 'Hold a box', 'box_hold'),
    holdPoseCommand(
      'hold_pose',
      'Hold pose %1 for %2 s',
      'Move to the supplied arm pose, hold it for 1–30 seconds, then return to carry.',
      [
        { name: 'POSE', label: 'pose', kind: 'input' },
        numberArgument('SECONDS', 'seconds', 3, 1, 30, 1),
      ],
    ),
    holdPoseCommand(
      'hold_pose_until_reset',
      'Hold pose %1 until reset',
      'Maintain the supplied arm pose until duet.reset_arms(); no other arm motion may start first.',
      [{ name: 'POSE', label: 'pose', kind: 'input' }],
    ),
    command('reset_arms', 'Reset arms to carry', 'Return both arms to the approved default/carry target.', []),
    command('saved_motion', 'Run saved motion %1', 'Run one teacher-approved saved DUET motion.', [
      {
        name: 'MOTION_ID',
        label: 'saved motion',
        kind: 'choice',
        value: '',
        choices: [['No saved motions available', '']],
      },
    ], 'Run saved motion'),
    command('shared_motion', 'Run shared motion %1', 'Run a teacher-managed shared DUET starter motion.', [
      {
        name: 'MOTION_ID',
        label: 'shared motion',
        kind: 'choice',
        value: '',
        choices: [['No shared motions available', '']],
      },
    ], 'Run shared motion'),
    armGesture('reach_and_return', 'Reach and return', DUET_ARM_COMMANDS.reach_and_return),
    armGesture('receive_and_hold', 'Receive and hold', DUET_ARM_COMMANDS.receive_and_hold),
    armGesture('hold_and_return', 'Hold and return', DUET_ARM_COMMANDS.hold_and_return),
    armGesture('receive_hold_return', 'Receive, hold, return', DUET_ARM_COMMANDS.receive_hold_return),
    ...Object.entries(DUET_ARM_LEVEL_MOTIONS).flatMap(([method, levels]) => (
      Object.entries(levels).map(([level, poses]) => (
        armGesture(`${method}_${level}`, `${method.replaceAll('_', ' ')} ${level}`, poses)
      ))
    )),
    ...catalogGestureCommands,
  ],
  command('wait', 'Wait %1 s', 'Pause the program.', [seconds()]),
  command('stop', 'Stop DUET motion', 'Request a DUET controller stop; execution stops at this command.', []),
].map((definition) => Object.freeze({
  ...definition,
  args: Object.freeze(definition.args.map((argument) => Object.freeze({
    ...argument,
    choices: argument.choices ? Object.freeze(argument.choices.map((choice) => Object.freeze(choice))) : undefined,
  }))),
})));

const COMMAND_BY_METHOD = new Map(DUET_COMMANDS.map((definition) => [definition.method, definition]));
const DUET_COMMAND_ALIASES = Object.freeze({
  // `forward` was the original DUET spelling. Keep saved programs valid while
  // generating the Legacy-aligned `walk` spelling for new/normalized code.
  forward: 'walk',
});
const POSE_METHODS = Object.freeze({
  carry: 'arm_carry',
  forward: 'arm_reach',
  box_hold: 'arm_box_hold',
});

function getDuetArmGestureCatalog() {
  return getDuetArmCatalog().gestures;
}

function splitArguments(rawArgs, lineNumber) {
  if (!rawArgs.trim()) return [];
  const args = [];
  let current = '';
  let quote = null;
  for (const character of rawArgs) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
    } else if (character === ',' && !quote) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (quote) throw new Error(`Unclosed string on line ${lineNumber}.`);
  args.push(current.trim());
  return args;
}

function parseValue(raw, argument, lineNumber) {
  if (argument.kind === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${argument.label} on line ${lineNumber} must be a finite number.`);
    if (value < argument.min || value > argument.max) {
      throw new Error(`${argument.label} on line ${lineNumber} must be between ${argument.min} and ${argument.max}.`);
    }
    return Number(value.toFixed(3));
  }
  const value = raw.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
  if (!argument.choices.some(([, choice]) => choice === value)) {
    throw new Error(`${argument.label} on line ${lineNumber} must be one of ${argument.choices.map(([, choice]) => choice).join(', ')}.`);
  }
  return value;
}

function formatValue(value, argument) {
  return argument.kind === 'choice' ? JSON.stringify(value) : String(value);
}

function normalizeCommand(method, rawArgs, lineNumber) {
  const canonicalMethod = DUET_COMMAND_ALIASES[method];
  if (canonicalMethod) return normalizeCommand(canonicalMethod, rawArgs, lineNumber);
  if (method === 'turn_around_180') {
    if (splitArguments(rawArgs, lineNumber).length) {
      throw new Error(`duet.turn_around_180 takes no arguments on line ${lineNumber}.`);
    }
    return {
      type: 'command',
      method,
      values: [Number((Math.PI / 0.25).toFixed(3))],
      code: 'duet.turn_around_180()',
    };
  }
  if (method === 'saved_motion' || method === 'shared_motion') {
    const args = splitArguments(rawArgs, lineNumber);
    if (args.length !== 1) {
      throw new Error(`duet.${method} expects one motion ID on line ${lineNumber}.`);
    }
    const motionId = args[0].replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(motionId)) {
      throw new Error(`DUET motion ID on line ${lineNumber} is invalid.`);
    }
    return {
      type: 'command',
      method,
      values: [motionId],
      code: `duet.${method}(${JSON.stringify(motionId)})`,
    };
  }
  if (method === 'hold_pose' || method === 'hold_pose_until_reset') {
    const args = splitArguments(rawArgs, lineNumber);
    const expectedCount = method === 'hold_pose' ? 2 : 1;
    if (args.length !== expectedCount) {
      throw new Error(`duet.${method} expects ${expectedCount} argument${expectedCount === 1 ? '' : 's'} on line ${lineNumber}.`);
    }
    const poseMatch = args[0].match(/^duet\.pose\((['"])([A-Za-z_]\w*)\1\)$/);
    const poseName = poseMatch?.[2];
    if (!poseName || !getDuetArmPoseNames().includes(poseName)) {
      throw new Error(`duet.${method} on line ${lineNumber} requires a named DUET pose target block.`);
    }
    const duration = method === 'hold_pose'
      ? parseValue(args[1], numberArgument('SECONDS', 'seconds', 3, 1, 30, 1), lineNumber)
      : null;
    const values = duration === null ? [] : [duration];
    const poseCode = `duet.pose(${JSON.stringify(poseName)})`;
    return {
      type: 'command',
      method,
      poseName,
      values,
      code: method === 'hold_pose'
        ? `duet.hold_pose(${poseCode}, ${duration})`
        : `duet.hold_pose_until_reset(${poseCode})`,
    };
  }
  if (method === 'move_and_arm') {
    const args = splitArguments(rawArgs, lineNumber);
    if (args.length !== 6) throw new Error(`duet.move_and_arm expects 6 arguments on line ${lineNumber}.`);
    const numericArguments = [
      numberArgument('VX', 'forward m/s', 0.15, -0.2, 0.3),
      numberArgument('VY', 'lateral m/s', 0, -0.15, 0.15),
      numberArgument('YAW_RATE', 'yaw rad/s', 0, -0.35, 0.35),
      numberArgument('SECONDS', 'move seconds', 1, 0.1, 2.5, 0.1),
    ];
    const movementValues = args.slice(0, 4).map((raw, index) => (
      parseValue(raw, numericArguments[index], lineNumber)
    ));
    const pose = args[4].replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
    const armMethod = POSE_METHODS[pose];
    const gesture = armMethod && normalizeCommand(armMethod, args[5], lineNumber);
    if (!gesture || gesture.type !== 'command') {
      throw new Error(`duet.move_and_arm on line ${lineNumber} requires a named arm pose.`);
    }
    if (gesture.values[0] < movementValues[3] + 0.25) {
      throw new Error(`arm seconds on line ${lineNumber} must be at least 0.25 seconds longer than move seconds.`);
    }
    return {
      type: 'concurrent',
      movement: {
        type: 'command',
        method: 'move',
        values: movementValues,
        code: `duet.move(${movementValues.join(', ')})`,
      },
      gesture,
    };
  }
  if (method === 'arm_pose') {
    const [rawPose, rawDuration] = splitArguments(rawArgs, lineNumber);
    const pose = rawPose?.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
    const poseMethod = POSE_METHODS[pose];
    if (!poseMethod || rawDuration === undefined) {
      throw new Error(`duet.arm_pose on line ${lineNumber} requires a named pose and duration.`);
    }
    return normalizeCommand(poseMethod, rawDuration, lineNumber);
  }
  if (method === 'arm_motion') {
    const [rawMotion, rawDuration] = splitArguments(rawArgs, lineNumber);
    const motion = rawMotion?.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
    const motionMethod = DUET_ARM_COMMANDS[motion]
      ? motion
      : DUET_ARM_COMMANDS[`${motion}_mid`] ? `${motion}_mid` : null;
    if (!motionMethod || rawDuration === undefined) {
      throw new Error(`duet.arm_motion on line ${lineNumber} requires a supported fixed gesture and duration.`);
    }
    return normalizeCommand(motionMethod, rawDuration, lineNumber);
  }
  if (['wave_left', 'wave_right', 'raise_left_arm', 'raise_right_arm', 'raise_both_arms'].includes(method)) {
    const [rawLevel, rawDuration] = splitArguments(rawArgs, lineNumber);
    const level = rawLevel?.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
    const variant = `${method}_${level}`;
    if (!DUET_ARM_COMMANDS[variant] || rawDuration === undefined) {
      throw new Error(`duet.${method} on line ${lineNumber} requires a supported fixed level and duration.`);
    }
    return normalizeCommand(variant, rawDuration, lineNumber);
  }
  const definition = COMMAND_BY_METHOD.get(method);
  if (!definition) throw new Error(`Unknown DUET command 'duet.${method}' on line ${lineNumber}.`);
  const args = splitArguments(rawArgs, lineNumber);
  if (args.length !== definition.args.length) {
    throw new Error(`duet.${method} expects ${definition.args.length} argument${definition.args.length === 1 ? '' : 's'} on line ${lineNumber}.`);
  }
  const values = args.map((raw, index) => parseValue(raw, definition.args[index], lineNumber));
  if (definition.motion) {
    return {
      type: 'command',
      method,
      values,
      code: `duet.${method}(${values[0]})`,
    };
  }
  return {
    type: 'command',
    method,
    values,
    code: `duet.${method}(${values.map((value, index) => formatValue(value, definition.args[index])).join(', ')})`,
  };
}

function parseLines(lines, start, indent, depth) {
  if (depth > 5) throw new Error('DUET programs may be nested at most five levels.');
  const nodes = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.text || line.text.startsWith('#')) {
      index += 1;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`Unexpected indentation on line ${line.lineNumber}.`);

    const distanceCondition = line.text.match(
      /^if\s+duet\.(front|rear)_distance_m\(\)\s*(<=|>=|==|!=|<|>)\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*:\s*$/,
    );
    if (distanceCondition) {
      const [, sector, operator, rawThreshold] = distanceCondition;
      const threshold = Number(rawThreshold);
      if (!Number.isFinite(threshold) || threshold < MIN_DISTANCE_METERS || threshold > MAX_DISTANCE_METERS) {
        throw new Error(
          `Distance threshold on line ${line.lineNumber} must be between ${MIN_DISTANCE_METERS} and ${MAX_DISTANCE_METERS} meters.`,
        );
      }
      let bodyStart = lineIndexAfter(lines, index + 1);
      if (bodyStart >= lines.length || lines[bodyStart].indent <= indent) {
        throw new Error(`Distance condition on line ${line.lineNumber} has no body.`);
      }
      const [then, next] = parseLines(lines, bodyStart, lines[bodyStart].indent, depth + 1);
      if (!then.length) throw new Error(`Distance condition on line ${line.lineNumber} has no body.`);
      index = lineIndexAfter(lines, next);
      let otherwise = [];
      if (index < lines.length && lines[index].indent === indent && lines[index].text === 'else:') {
        bodyStart = lineIndexAfter(lines, index + 1);
        if (bodyStart >= lines.length || lines[bodyStart].indent <= indent) {
          throw new Error(`Else branch on line ${lines[index].lineNumber} has no body.`);
        }
        [otherwise, index] = parseLines(lines, bodyStart, lines[bodyStart].indent, depth + 1);
        if (!otherwise.length) throw new Error(`Else branch on line ${line.lineNumber} has no body.`);
      }
      const sensor = `${sector}_distance_m`;
      nodes.push({
        type: 'condition',
        sensor,
        operator,
        threshold,
        code: `duet.${sensor}() ${operator} ${threshold}`,
        then,
        else: otherwise,
      });
      continue;
    }
    const booleanCondition = line.text.match(/^if\s+(True|False)\s*:\s*$/);
    if (booleanCondition) {
      let bodyStart = lineIndexAfter(lines, index + 1);
      if (bodyStart >= lines.length || lines[bodyStart].indent <= indent) {
        throw new Error(`Boolean condition on line ${line.lineNumber} has no body.`);
      }
      const [then, next] = parseLines(lines, bodyStart, lines[bodyStart].indent, depth + 1);
      if (!then.length) throw new Error(`Boolean condition on line ${line.lineNumber} has no body.`);
      index = lineIndexAfter(lines, next);
      let otherwise = [];
      if (index < lines.length && lines[index].indent === indent && lines[index].text === 'else:') {
        bodyStart = lineIndexAfter(lines, index + 1);
        if (bodyStart >= lines.length || lines[bodyStart].indent <= indent) {
          throw new Error(`Else branch on line ${lines[index].lineNumber} has no body.`);
        }
        [otherwise, index] = parseLines(lines, bodyStart, lines[bodyStart].indent, depth + 1);
        if (!otherwise.length) throw new Error(`Else branch on line ${line.lineNumber} has no body.`);
      }
      nodes.push({
        type: 'condition',
        value: booleanCondition[1] === 'True',
        code: booleanCondition[1],
        then,
        else: otherwise,
      });
      continue;
    }
    if (/^if\b/.test(line.text)) {
      throw new Error(
        `Unsupported condition on line ${line.lineNumber}. Use True, False, or compare duet.front_distance_m() or duet.rear_distance_m() with a numeric threshold.`,
      );
    }

    if (line.text === 'with duet.concurrent():') {
      let bodyStart = index + 1;
      while (bodyStart < lines.length && (!lines[bodyStart].text || lines[bodyStart].text.startsWith('#'))) bodyStart += 1;
      if (bodyStart >= lines.length || lines[bodyStart].indent <= indent) {
        throw new Error(`Concurrent action on line ${line.lineNumber} needs one locomotion and one arm command.`);
      }
      const [body, next] = parseLines(lines, bodyStart, lines[bodyStart].indent, depth + 1);
      if (body.length !== 2 || body.some((node) => node.type !== 'command')) {
        throw new Error(`Concurrent action on line ${line.lineNumber} must contain exactly two simple commands.`);
      }
      const movement = body.find((node) => node.method === 'move' || getDuetCommand(node.method)?.motion);
      const gesture = body.find((node) => {
        const definition = getDuetCommand(node.method);
        return definition?.armPoses || definition?.poseInput;
      });
      if (!movement || !gesture || movement === gesture) {
        throw new Error(`Concurrent action on line ${line.lineNumber} needs one locomotion command and one arm gesture.`);
      }
      nodes.push({ type: 'concurrent', movement, gesture });
      index = next;
      continue;
    }

    const loop = line.text.match(/^for\s+_\s+in\s+range\(\s*(\d+)\s*\)\s*:\s*$/);
    if (loop) {
      const times = Number(loop[1]);
      if (times < 1 || times > 20) throw new Error(`Loop count on line ${line.lineNumber} must be between 1 and 20.`);
      let bodyStart = index + 1;
      while (bodyStart < lines.length && (!lines[bodyStart].text || lines[bodyStart].text.startsWith('#'))) bodyStart += 1;
      if (bodyStart >= lines.length || lines[bodyStart].indent <= indent) {
        throw new Error(`Loop on line ${line.lineNumber} has no body.`);
      }
      const [body, next] = parseLines(lines, bodyStart, lines[bodyStart].indent, depth + 1);
      if (!body.length) throw new Error(`Loop on line ${line.lineNumber} has no commands.`);
      nodes.push({ type: 'repeat', times, body });
      index = next;
      continue;
    }

    const call = line.text.match(/^duet\.([A-Za-z_]\w*)\((.*)\);?$/);
    if (!call) {
      throw new Error(`Unsupported statement on line ${line.lineNumber}. Use DUET commands or bounded for/range loops only.`);
    }
    const normalized = normalizeCommand(call[1], call[2], line.lineNumber);
    nodes.push(...(Array.isArray(normalized) ? normalized : [normalized]));
    index += 1;
  }
  return [nodes, index];
}

function lineIndexAfter(lines, index) {
  while (index < lines.length && (!lines[index].text || lines[index].text.startsWith('#'))) index += 1;
  return index;
}

function countCommands(nodes) {
  return nodes.reduce((total, node) => (
    total + (node.type === 'repeat'
      ? node.times * countCommands(node.body)
      : node.type === 'concurrent'
        ? 1 + (getDuetCommand(node.gesture.method)?.armPoses?.length || 1)
        : node.type === 'condition'
          ? 1 + Math.max(countCommands(node.then), countCommands(node.else))
        : node.method === 'turn_around_180'
          ? 5
          : getDuetCommand(node.method)?.armPoses?.length || 1)
  ), 0);
}

function validateStopPlacement(nodes, finalInParent = true) {
  nodes.forEach((node, index) => {
    const isFinal = finalInParent && index === nodes.length - 1;
    if (node.type === 'command' && node.method === 'stop' && !isFinal) {
      throw new Error('duet.stop() must be the final command on every execution path.');
    }
    if (node.type === 'condition') {
      validateStopPlacement(node.then, isFinal);
      validateStopPlacement(node.else, isFinal);
    } else if (node.type === 'repeat') {
      validateStopPlacement(node.body, isFinal && node.times === 1);
    }
  });
}

function validateArmResetFlow(nodes, possibleHeldStates = new Set([false])) {
  let states = possibleHeldStates;
  nodes.forEach((node) => {
    if (node.type === 'condition') {
      const thenStates = validateArmResetFlow(node.then, new Set(states));
      const elseStates = validateArmResetFlow(node.else, new Set(states));
      states = new Set([...thenStates, ...elseStates]);
      return;
    }
    if (node.type === 'repeat') {
      for (let iteration = 0; iteration < node.times; iteration += 1) {
        states = validateArmResetFlow(node.body, states);
      }
      return;
    }
    const commands = node.type === 'concurrent' ? [node.gesture] : [node];
    const startsArmMotion = commands.some(({ method }) => {
      const definition = getDuetCommand(method);
      return definition?.armPoses || definition?.poseInput;
    });
    if (states.has(true) && startsArmMotion) {
      throw new Error('Reset arms with duet.reset_arms() before starting another arm motion.');
    }
    if (node.type === 'command' && node.method === 'reset_arms') states = new Set([false]);
    else if (commands.some(({ method }) => method === 'hold_pose_until_reset')) states = new Set([true]);
  });
  return states;
}

function duetCommandDuration(node) {
  if (node.type === 'concurrent') {
    const movementDefinition = getDuetCommand(node.movement.method)?.motion;
    const movementDuration = movementDefinition
      ? node.movement.values[0]
      : node.movement.values[3];
    const gestureDefinition = getDuetCommand(node.gesture.method);
    const gestureDuration = gestureDefinition?.poseInput
      ? node.gesture.method === 'hold_pose'
        ? 1 + node.gesture.values[0]
        : movementDuration
      : (gestureDefinition?.armPoses?.length || 1) * node.gesture.values[0];
    return Math.max(movementDuration, gestureDuration);
  }
  if (node.type !== 'command') return 0;
  const definition = getDuetCommand(node.method);
  if (definition?.motion) return node.values[0];
  if (node.method === 'move') return node.values[3];
  if (node.method === 'wait') return node.values[0];
  if (definition?.armPoses) return definition.armPoses.length * node.values[0];
  if (definition?.poseInput) return node.method === 'hold_pose' ? 1 + node.values[0] : 0;
  return 0;
}

function validateAutomaticGestureFlow(nodes, initialStates = [{ remaining: 0, gesture: null }]) {
  let states = initialStates;
  for (const node of nodes) {
    if (node.type === 'repeat') {
      for (let iteration = 0; iteration < node.times; iteration += 1) {
        states = validateAutomaticGestureFlow(node.body, states);
      }
      continue;
    }
    if (node.type === 'condition') {
      const branches = [node.then, node.else].map((branch) => (
        validateAutomaticGestureFlow(branch, states.map((state) => ({ ...state })))
      ));
      states = [...new Map(branches.flat().map((state) => [
        `${state.remaining.toFixed(3)}|${state.gesture ?? ''}`,
        state,
      ])).values()];
      continue;
    }

    const commands = node.type === 'concurrent' ? [node.gesture] : [node];
    const startsArmMotion = commands.some(({ method }) => {
      const definition = getDuetCommand(method);
      return definition?.armPoses || definition?.poseInput;
    });
    const reset = node.type === 'command' && node.method === 'reset_arms';
    const heldGesture = node.type === 'command'
      && getDuetCommand(node.method)?.category === 'Arm gestures'
      && getDuetCommand(node.method).armPoses.at(-1) !== 'carry';
    const nextStates = [];
    for (const state of states) {
      if (state.remaining > 0 && startsArmMotion && !reset) {
        throw new Error(
          `The ${state.gesture} gesture is still active for about ${state.remaining.toFixed(1)} seconds. Run other actions or wait for it to return before the next arm gesture (${commands[0].method}).`,
        );
      }
      if (reset) {
        nextStates.push({ remaining: 0, gesture: null });
      } else if (heldGesture) {
        nextStates.push({ remaining: 20, gesture: node.method });
      } else {
        const duration = duetCommandDuration(node);
        nextStates.push({
          remaining: Math.max(0, state.remaining - duration),
          gesture: state.remaining > duration ? state.gesture : null,
        });
      }
    }
    states = [...new Map(nextStates.map((state) => [
      `${state.remaining.toFixed(3)}|${state.gesture ?? ''}`,
      state,
    ])).values()];
  }
  return states;
}

export function parseDuetProgram(code = '') {
  const lines = code.replace(/\r/g, '').split('\n').map((raw, index) => ({
    indent: raw.match(/^\s*/)[0].replace(/\t/g, '  ').length,
    text: raw.trim(),
    lineNumber: index + 1,
  }));
  const [nodes, endIndex] = parseLines(lines, 0, 0, 0);
  if (endIndex < lines.length && lines.slice(endIndex).some(({ text }) => text && !text.startsWith('#'))) {
    throw new Error(`Invalid indentation on line ${lines[endIndex].lineNumber}.`);
  }
  if (countCommands(nodes) > 400) {
    throw new Error('DUET programs may contain at most 400 expanded commands.');
  }
  validateStopPlacement(nodes);
  validateArmResetFlow(nodes);
  validateAutomaticGestureFlow(nodes);
  return nodes;
}

export function flattenDuetCommands(nodes, result = []) {
  nodes.forEach((node) => {
    if (node.type === 'command' || node.type === 'concurrent') {
      result.push(node);
      return;
    }
    if (node.type === 'condition') {
      throw new Error('Programs with distance conditions cannot be flattened without sensor data.');
    }
    for (let count = 0; count < node.times; count += 1) flattenDuetCommands(node.body, result);
  });
  return result;
}

export function formatDuetProgram(nodes, indent = 0) {
  const padding = ' '.repeat(indent);
  return nodes.map((node) => (
    node.type === 'concurrent'
      ? `${padding}with duet.concurrent():\n${padding}    ${node.movement.code}\n${padding}    ${node.gesture.code}`
      : node.type === 'command'
      ? `${padding}${node.code}`
      : node.type === 'condition'
        ? `${padding}if ${node.code}:\n${formatDuetProgram(node.then, indent + 4)}${node.else.length
          ? `\n${padding}else:\n${formatDuetProgram(node.else, indent + 4)}`
          : ''}`
        : `${padding}for _ in range(${node.times}):\n${formatDuetProgram(node.body, indent + 4)}`
  )).join('\n');
}

export function getDuetBlocklyCommandBlocks(savedMotions = [], sharedMotions = []) {
  return [
    ...DUET_COMMANDS.map((definition) => ({
    type: definition.type,
    category: definition.category || (definition.method === 'shared_motion'
      ? 'Shared motions'
      : definition.method === 'saved_motion'
        ? 'Saved motions'
      : definition.method === 'wait' || definition.method === 'stop' || definition.method === 'reset_arms'
      ? 'Control'
      : definition.armPoses
        ? 'Arm gestures'
        : definition.poseInput ? 'Arm poses' : 'Locomotion'),
    message0: definition.message,
    args0: definition.method === 'saved_motion' || definition.method === 'shared_motion'
      ? [{
        type: 'field_dropdown',
        name: 'MOTION_ID',
        options: definition.method === 'saved_motion'
          ? savedMotions.length
            ? savedMotions.map(({ id, name }) => [name, id])
            : [['No saved motions available', '']]
          : sharedMotions.length
            ? sharedMotions.map(({ id, name }) => [name, id])
            : [['No shared motions available', '']],
      }]
      : definition.args.map((argument) => argument.kind === 'number'
      ? {
        type: 'field_number',
        name: argument.name,
        value: argument.value,
        min: argument.min,
        max: argument.max,
        precision: argument.step,
      }
      : argument.kind === 'input'
        ? { type: 'input_value', name: argument.name, check: 'String' }
        : { type: 'field_dropdown', name: argument.name, options: argument.choices }),
    previousStatement: null,
    nextStatement: null,
    colour: definition.method === 'wait' || definition.method === 'stop' || definition.method === 'reset_arms'
      ? 190
      : definition.armPoses ? 280 : 160,
    tooltip: definition.description,
    codeTemplate: definition.codeTemplate,
    })),
    ...DUET_ARM_POSE_BLOCKS.map(({ category, label, ...block }) => ({
      ...block,
      category,
      message0: label,
      args0: [],
      output: 'String',
      colour: 280,
    })),
    ...DUET_DISTANCE_SENSORS.map(({ type, sensor, message0, tooltip }) => ({
      type,
      category: 'Sensors',
      message0,
      output: 'Number',
      colour: 200,
      tooltip,
      codeTemplate: `duet.${sensor}()`,
    })),
    {
      type: 'duet_concurrent_action',
      category: 'Concurrent actions',
      message0: 'At the same time, locomotion %1',
      args0: [{ type: 'input_statement', name: 'LOCOMOTION' }],
      message1: 'and arm gesture %1',
      args1: [{ type: 'input_statement', name: 'GESTURE' }],
      previousStatement: null,
      nextStatement: null,
      colour: 210,
      tooltip: 'Run one supported locomotion command concurrently with one separate arm command. Other program actions remain sequential.',
    },
  ];
}

export function getDuetCommand(method) {
  return COMMAND_BY_METHOD.get(DUET_COMMAND_ALIASES[method] || method) || null;
}

export function getDuetCommandExamples(savedMotions = [], sharedMotions = []) {
  const commandExamples = DUET_COMMANDS.flatMap((definition) => {
    if (definition.method === 'saved_motion' || definition.method === 'shared_motion') return [];
    const category = definition.category || (
      definition.method === 'wait' || definition.method === 'stop' || definition.method === 'reset_arms'
        ? 'Control'
        : definition.armPoses
          ? 'Arm gestures'
          : definition.poseInput
            ? 'Arm poses'
            : 'Locomotion'
    );
    if (definition.poseInput) {
      return getDuetArmPoseNames().map((poseName) => {
        const poseCode = `duet.pose(${JSON.stringify(poseName)})`;
        const code = definition.method === 'hold_pose'
          ? `duet.hold_pose(${poseCode}, ${definition.args[1].value})`
          : `duet.hold_pose_until_reset(${poseCode})`;
        return {
          key: `${definition.method}_${poseName}`,
          category,
          label: `${definition.method === 'hold_pose' ? 'Hold' : 'Hold until reset'}: ${poseName.replaceAll('_', ' ')}`,
          code,
        };
      });
    }
    return [{
      key: definition.method,
      category,
      label: definition.label,
      code: `duet.${definition.method}(${definition.args.map((argument) => (
        argument.kind === 'choice' ? JSON.stringify(argument.value) : String(argument.value)
      )).join(', ')})`,
    }];
  });
  return [
    ...commandExamples,
    ...savedMotions.map(({ id, name }) => ({
      key: `saved_motion_${id}`,
      category: 'Saved motions',
      label: `Saved motion: ${name}`,
      code: `duet.saved_motion(${JSON.stringify(id)})`,
    })),
    ...sharedMotions.map(({ id, name }) => ({
      key: `shared_motion_${id}`,
      category: 'Shared motions',
      label: `Shared motion: ${name}`,
      code: `duet.shared_motion(${JSON.stringify(id)})`,
    })),
    {
      key: 'front_distance_condition',
      category: 'Conditions',
      label: 'Front distance condition example',
      code: 'if duet.front_distance_m() < 1:\n    duet.stop()\nelse:\n    duet.walk(1)',
    },
    {
      key: 'rear_distance_condition',
      category: 'Conditions',
      label: 'Rear distance condition example',
      code: 'if duet.rear_distance_m() < 1:\n    duet.stop()\nelse:\n    duet.backward(1)',
    },
  ];
}

export function compileDuetMotionPrompt(prompt = '') {
  const normalized = prompt.toLowerCase().replace(/[,.!?;:]/g, ' ');
  const steps = [];
  const unknown = [];
  const timedPoseMatch = normalized.match(
    /\b(?:hold|keep|maintain)\s+(?:the\s+)?(.+?)\s+for\s+(\d+(?:\.\d+)?)\s*(s|secs?|seconds?)\b/,
  );
  const untilResetPoseMatch = normalized.match(
    /\b(?:hold|keep|maintain)\s+(?:the\s+)?(.+?)\s+until\s+reset\b/,
  );
  const heldPoseMatch = timedPoseMatch || untilResetPoseMatch;
  const posePromptAliases = getDuetArmPoseNames().flatMap((poseName) => {
    const words = poseName.replaceAll('_', ' ');
    const aliases = [words];
    if (poseName.startsWith('left_') || poseName.startsWith('right_')) {
      const side = poseName.startsWith('left_') ? 'left' : 'right';
      const pose = poseName.slice(side.length + 1).replaceAll('_', ' ');
      aliases.push(`${side} arm ${pose}`);
      if (pose.startsWith('raise ')) aliases.push(`${side} arm raised ${pose.slice(6)}`);
    } else if (poseName.startsWith('both_')) {
      const pose = poseName.slice(5).replaceAll('_', ' ');
      aliases.push(`both arms ${pose}`);
      if (poseName === 'both_hands_up') aliases.push('both arms up');
      if (poseName === 'both_overhead') aliases.push('both arms above head', 'arms overhead');
      if (poseName === 'both_sideways') aliases.push('both arms out sideways', 'arms out sideways');
      if (poseName === 'both_hold_object') aliases.push('both arms carrying something');
    }
    return aliases.map((phrase) => ({ poseName, phrase }));
  }).sort((left, right) => right.phrase.length - left.phrase.length);

  if (heldPoseMatch) {
    const requestedPose = heldPoseMatch[1].trim();
    const matchedPose = posePromptAliases.find(({ phrase }) => phrase === requestedPose);
    if (!matchedPose) {
      unknown.push(`Unknown DUET arm pose "${requestedPose}"; choose a named pose from the V2 arm-pose library.`);
    } else if (untilResetPoseMatch) {
      steps.push({
        label: `Hold ${matchedPose.poseName.replaceAll('_', ' ') } until reset`,
        code: `duet.hold_pose_until_reset(duet.pose(${JSON.stringify(matchedPose.poseName)}))`,
        detail: 'The pose remains requested until duet.reset_arms() or program completion.',
      });
    } else {
      const holdDuration = Number(timedPoseMatch[2]);
      if (holdDuration < 1 || holdDuration > 30) {
        unknown.push('Timed arm poses must be held for 1 to 30 seconds.');
      } else {
        steps.push({
          label: `Hold ${matchedPose.poseName.replaceAll('_', ' ')} for ${holdDuration} seconds`,
          code: `duet.hold_pose(duet.pose(${JSON.stringify(matchedPose.poseName)}), ${holdDuration})`,
          detail: 'The named pose holds for the requested interval, then returns to carry.',
        });
      }
    }
  }
  const durationMatches = [...normalized.matchAll(/\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(s|secs?|seconds?)\b/g)];
  const durationMatch = durationMatches[0];
  if (durationMatches.length > 1) {
    unknown.push('DUET prompt generation supports one shared duration per series; split requests with different durations into separate prompts.');
  }
  const durationValue = durationMatch ? Number(durationMatch[1]) : 1;
  const durationError = durationMatch && (durationValue < 0.1 || durationValue > 3)
    ? `Requested duration ${durationValue} seconds is outside the supported 0.1-3 second range.`
    : /\bfor\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|minutes?|mins?)\b/.test(normalized)
      ? 'Only second-based durations from 0.1 to 3 seconds are supported.'
      : /\bfor\s+[a-z]+\s*(?:s|secs?|seconds?)\b/.test(normalized)
        ? 'Specify a numeric duration in seconds.'
      : null;
  const duration = durationError ? 1 : durationValue;
  const concurrentMatch = normalized.match(
    /\b(?:walk|move)\s+(forward|backward)\b.*?\bwhile\b.*?\bwave\s+(left|right)\b/,
  );
  let concurrentHandled = false;
  let concurrentRejected = false;
  if (concurrentMatch) {
    if (durationError) {
      unknown.push(durationError);
      concurrentRejected = true;
    } else if (duration > 2.5) {
      unknown.push('Concurrent DUET locomotion is limited to 2.5 seconds so the arm can finish its bounded transition.');
      concurrentRejected = true;
    } else {
      const [, direction, side] = concurrentMatch;
      const armDuration = Math.max(1, Number((duration + 0.5).toFixed(1)));
      const level = /\b(high|up)\b/.test(normalized) ? 'high' : /\b(low|down)\b/.test(normalized) ? 'low' : 'mid';
      const movementMethod = direction === 'backward' ? 'backward' : 'walk';
      steps.push({
        label: `Move ${direction} while waving ${side}`,
        code: `with duet.concurrent():\n    duet.${movementMethod}(${duration})\n    duet.wave_${side}("${level}", ${armDuration})`,
        detail: 'One bounded DUET locomotion action paired with a longer catalog arm gesture.',
      });
      concurrentHandled = true;
    }
  }
  const arcMatches = [
    ...normalized.matchAll(/\barc\s+(forward|backward)[ -](left|right)\b/g),
    ...normalized.matchAll(/\b(forward|backward)[ -](left|right)\s+arc\b/g),
  ].sort((left, right) => left.index - right.index);
  arcMatches.forEach((match) => {
    if (concurrentHandled || concurrentRejected) return;
    if (durationError) {
      unknown.push(durationError);
      return;
    }
    const direction = match[1] || match[2];
    const side = match[2] || match[3];
    const method = `arc_${direction}_${side}`;
    steps.push({
      label: `${direction} ${side} arc`,
      code: `duet.${method}(${duration})`,
      detail: `${duration} seconds using the approved DUET arc preset`,
    });
  });
  const movementMatches = [
    ...normalized.matchAll(/\b(walk|move)\s+(forward|backward)\b/g),
    ...normalized.matchAll(/\b(strafe|sidestep|step)\s+(left|right)\b/g),
    ...normalized.matchAll(/\b(turn)\s+(left|right)\b/g),
  ].sort((left, right) => left.index - right.index);

  movementMatches.forEach((match) => {
    const [, action, direction] = match;
    if (concurrentHandled || concurrentRejected || arcMatches.some(({ index }) => (
      index <= match.index && match.index < index + match[0].length
    ))) return;
    if (durationError) {
      unknown.push(durationError);
      return;
    }
    if (action === 'walk' || action === 'move') {
      if (/\bdegrees?\b|\bangle\b/.test(normalized)) {
        unknown.push('Angle-based movement is not supported; use walk, backward, left, or right velocity commands.');
        return;
      }
      if (/\bsteps?\b|\bmeters?\b|\bmetres?\b/.test(normalized)) {
        unknown.push('Step- or distance-based movement is not equivalent to DUET velocity-and-time commands; specify a duration in seconds.');
        return;
      }
      steps.push({
        label: direction === 'backward' ? 'Walk backward' : 'Walk forward',
        code: `duet.${direction === 'backward' ? 'backward' : 'walk'}(${duration})`,
        detail: `${duration} seconds at a conservative velocity`,
      });
    } else if (action === 'strafe' || action === 'sidestep' || action === 'step') {
      if (/\bdegrees?\b|\bangle\b/.test(normalized)) {
        unknown.push('Angle-based movement is not supported; use walk, backward, left, or right velocity commands.');
        return;
      }
      const vy = direction === 'left' ? 0.1 : -0.1;
      steps.push({
        label: `Move ${direction}`,
        code: `duet.move(0, ${vy}, 0, ${duration})`,
        detail: `${duration} seconds at a conservative lateral velocity`,
      });
    } else if (action === 'turn') {
      if (/\bdegrees?\b|\bangle\b/.test(normalized)) {
        unknown.push('Angle-based turns are not equivalent to DUET yaw-rate commands; specify a duration in seconds instead.');
        return;
      }
      const yaw = direction === 'left' ? 0.25 : -0.25;
      steps.push({
        label: `Turn ${direction}`,
        code: `duet.move(0, 0, ${yaw}, ${duration})`,
        detail: `${duration} seconds at a conservative yaw rate`,
      });
    }
  });

  const angleArmGesture = /\b(wave|raise)\b/.test(normalized) && /\bdegrees?\b|\bangle\b/.test(normalized);
  if (angleArmGesture) {
    unknown.push('Angle-based arm gestures are not supported; choose a safe bounded high/mid/low arm preset instead.');
    return {
      code: '',
      steps: [],
      unknown: [...new Set(unknown)],
      summary: 'Angle-based arm gestures are not supported in DUET; use a bounded high/mid/low arm preset instead.',
    };
  }

  const supportedArmGestureMatches = concurrentHandled || concurrentRejected ? [] : [
    ...normalized.matchAll(/\bwave\s+(left|right)\b/g),
    ...normalized.matchAll(/\braise\s+(?:both\s+arms?|left\s+arm|right\s+arm)\b/g),
  ].sort((left, right) => left.index - right.index);
  const armDurationError = duration < 1 || duration > 3
    ? 'DUET arm gestures and pose macros must last between 1 and 3 seconds.'
    : null;

  supportedArmGestureMatches.forEach((match) => {
    if (durationError || armDurationError) {
      unknown.push(durationError || armDurationError);
      return;
    }
    const phrase = match[0].toLowerCase();
    const level = /\b(high|up)\b/.test(normalized) ? 'high' : /\b(low|down)\b/.test(normalized) ? 'low' : 'mid';
    if (phrase.startsWith('wave')) {
      const target = phrase.includes('left') ? 'left' : 'right';
      const method = target === 'left' ? 'wave_left' : 'wave_right';
      steps.push({
        label: `Wave ${target} arm`,
        code: `duet.${method}("${level}", ${duration})`,
        detail: `${duration} seconds at a safe bounded arm-wave level`,
      });

    } else if (phrase.includes('both')) {
      steps.push({
        label: 'Raise both arms',
        code: `duet.raise_both_arms("${level}", ${duration})`,
        detail: `${duration} seconds at a safe bounded arm-raise level`,
      });
    } else {
      const target = phrase.includes('left') ? 'left' : 'right';
      const method = target === 'left' ? 'raise_left_arm' : 'raise_right_arm';
      steps.push({
        label: `Raise ${target} arm`,
        code: `duet.${method}("${level}", ${duration})`,
        detail: `${duration} seconds at a safe bounded arm-raise level`,
      });
    }
  });

  const fixedGestureAliases = [
    { pattern: /\b(?:carry|neutral arms?)\b/, method: 'arm_carry', label: 'Carry arms' },
    { pattern: /\breach forward\b/, method: 'arm_reach', label: 'Reach forward' },
    { pattern: /\bclap\b/, method: 'gesture_clap', label: 'Clap' },
    { pattern: /\b(?:hug|give a hug)\b/, method: 'gesture_hug', label: 'Hug' },
    { pattern: /\b(?:kiss|blow a kiss)\b/, method: 'gesture_kiss_both', label: 'Two-hand kiss' },
    { pattern: /\b(?:heart|make a heart)\b/, method: 'gesture_heart_both', label: 'Heart' },
    { pattern: /\b(?:hands up|raise both hands)\b/, method: 'gesture_hands_up', label: 'Hands up' },
    { pattern: /\bx[\s-]?ray\b/, method: 'gesture_xray', label: 'X-ray pose' },
    { pattern: /\breach and return\b/, method: 'reach_and_return', label: 'Reach and return' },
    { pattern: /\breceive and hold\b/, method: 'receive_and_hold', label: 'Receive and hold' },
    { pattern: /\bhold and return\b/, method: 'hold_and_return', label: 'Hold and return' },
    { pattern: /\breceive hold and return\b/, method: 'receive_hold_return', label: 'Receive, hold, and return' },
  ];
  fixedGestureAliases.forEach(({ pattern, method, label }) => {
    if (
      concurrentHandled
      || concurrentRejected
      || !pattern.test(normalized)
      || supportedArmGestureMatches.some(({ 0: phrase }) => pattern.test(phrase))
    ) return;
    if (durationError || armDurationError) {
      unknown.push(durationError || armDurationError);
      return;
    }
    steps.push({
      label,
      code: `duet.${method}(${duration})`,
      detail: `Run the approved ${label.toLowerCase()} arm macro`,
    });
  });
  if (
    !concurrentHandled
    && !concurrentRejected
    && /\bhigh five\b/.test(normalized)
    && !supportedArmGestureMatches.length
  ) {
    if (durationError || armDurationError) {
      unknown.push(durationError || armDurationError);
    } else {
      const side = /\bright\b/.test(normalized) ? 'right' : 'left';
      const method = `gesture_high_five_${side}`;
      steps.push({
        label: `${side === 'left' ? 'Left' : 'Right'} high five`,
        code: `duet.${method}(${duration})`,
        detail: `Run the approved ${side} high-five arm macro`,
      });
    }
  }

  if (!heldPoseMatch && !supportedArmGestureMatches.length && /\b(wave|raise|lift)\b/.test(normalized)) {
    unknown.push('Arm gestures are only supported as safe bounded left/right and both-arm presets that use the validated DUET arm gate.');
  }
  if (/\b(kick|knee|dance|mimic)\b/.test(normalized)) {
    unknown.push('Kicks, isolated knee raises, dance, and mimic are not available in the DUET command set.');
  }
  if (!steps.length) {
    unknown.push('Try: “walk forward for 1 second, then turn left for 1 second”.');
  }
  let code = steps.map((step) => step.code).join('\n');
  const repeatMatch = normalized.match(/\brepeat\b.*?\b(\d+)\s+times?\b/);
  if (repeatMatch) {
    const repetitions = Number(repeatMatch[1]);
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
      unknown.push('DUET prompt repetitions must be between 1 and 20.');
      code = '';
    } else if (code) {
      code = `for _ in range(${repetitions}):\n${code.split('\n').map((line) => `    ${line}`).join('\n')}`;
    }
  }
  if (unknown.length) code = '';
  if (code) parseDuetProgram(code);
  return {
    code,
    steps,
    unknown: [...new Set(unknown)],
    summary: steps.length
      ? `Generated ${steps.length} bounded DUET action${steps.length === 1 ? '' : 's'}.`
      : 'No supported DUET movement was detected.',
  };
}
