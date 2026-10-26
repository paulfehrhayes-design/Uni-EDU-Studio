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
  armPoses: Object.freeze([pose]),
});
const armGesture = (method, label, poses) => ({
  ...command(method, `${label} (%1 s per pose)`, `Run the fixed ${label.toLowerCase()} gesture using only approved named arm poses.`, [
    numberArgument('SECONDS', 'seconds per pose', 1.5, 1, 3, 0.1),
  ]),
  armPoses: Object.freeze(poses),
});

export const DUET_ARM_MOTIONS = Object.freeze({
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
    low: ['carry', 'forward'],
    mid: ['forward', 'box_hold', 'carry'],
    high: ['forward', 'carry'],
  }),
  wave_right: Object.freeze({
    low: ['carry', 'forward'],
    mid: ['forward', 'box_hold', 'carry'],
    high: ['forward', 'carry'],
  }),
  raise_left_arm: Object.freeze({
    low: ['carry', 'box_hold'],
    mid: ['box_hold', 'forward'],
    high: ['forward', 'carry'],
  }),
  raise_right_arm: Object.freeze({
    low: ['carry', 'box_hold'],
    mid: ['box_hold', 'forward'],
    high: ['forward', 'carry'],
  }),
  raise_both_arms: Object.freeze({
    low: ['carry', 'box_hold'],
    mid: ['box_hold', 'forward'],
    high: ['forward', 'carry'],
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

export const DUET_COMMANDS = Object.freeze([
  command('move', 'Move vx %1 vy %2 yaw %3 for %4 s', 'Bounded DUET planar velocity and yaw-rate command for a short duration.', [
    numberArgument('VX', 'forward m/s', 0.15, -0.2, 0.3),
    numberArgument('VY', 'lateral m/s', 0, -0.15, 0.15),
    numberArgument('YAW_RATE', 'yaw rad/s', 0, -0.35, 0.35),
    seconds(),
  ], 'Move with custom velocity'),
  presetMove('forward', 'Move forward for %1 s', 'Move forward at a conservative fixed velocity.', 0.15, 0, 0),
  presetMove('backward', 'Move backward for %1 s', 'Move backward at a conservative fixed velocity.', -0.1, 0, 0),
  presetMove('strafe_left', 'Strafe left for %1 s', 'Move laterally left at a conservative fixed velocity.', 0, 0.1, 0),
  presetMove('strafe_right', 'Strafe right for %1 s', 'Move laterally right at a conservative fixed velocity.', 0, -0.1, 0),
  presetMove('turn_left', 'Turn left for %1 s', 'Turn left at a conservative fixed yaw rate; final angle is not guaranteed.', 0, 0, 0.25),
  presetMove('turn_right', 'Turn right for %1 s', 'Turn right at a conservative fixed yaw rate; final angle is not guaranteed.', 0, 0, -0.25),
  presetMove('arc_forward_left', 'Arc forward-left for %1 s', 'Combine conservative forward velocity and left yaw rate.', 0.12, 0, 0.2),
  presetMove('arc_forward_right', 'Arc forward-right for %1 s', 'Combine conservative forward velocity and right yaw rate.', 0.12, 0, -0.2),
  presetMove('arc_backward_left', 'Arc backward-left for %1 s', 'Combine conservative backward velocity and left yaw rate.', -0.08, 0, 0.2),
  presetMove('arc_backward_right', 'Arc backward-right for %1 s', 'Combine conservative backward velocity and right yaw rate.', -0.08, 0, -0.2),
  ...[
    armPose('arm_carry', 'Carry / neutral arms', 'carry'),
    armPose('arm_reach', 'Reach forward', 'forward'),
    armPose('arm_box_hold', 'Hold a box', 'box_hold'),
    armGesture('reach_and_return', 'Reach and return', DUET_ARM_COMMANDS.reach_and_return),
    armGesture('receive_and_hold', 'Receive and hold', DUET_ARM_COMMANDS.receive_and_hold),
    armGesture('hold_and_return', 'Hold and return', DUET_ARM_COMMANDS.hold_and_return),
    armGesture('receive_hold_return', 'Receive, hold, return', DUET_ARM_COMMANDS.receive_hold_return),
    ...Object.entries(DUET_ARM_LEVEL_MOTIONS).flatMap(([method, levels]) => (
      Object.entries(levels).map(([level, poses]) => (
        armGesture(`${method}_${level}`, `${method.replaceAll('_', ' ')} ${level}`, poses)
      ))
    )),
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
const POSE_METHODS = Object.freeze({
  carry: 'arm_carry',
  forward: 'arm_reach',
  box_hold: 'arm_box_hold',
});

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
      const gesture = body.find((node) => getDuetCommand(node.method)?.armPoses);
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

function countCommands(nodes) {
  return nodes.reduce((total, node) => (
    total + (node.type === 'repeat'
      ? node.times * countCommands(node.body)
      : node.type === 'concurrent'
        ? 1 + getDuetCommand(node.gesture.method).armPoses.length
        : getDuetCommand(node.method)?.armPoses?.length || 1)
  ), 0);
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
  return nodes;
}

export function flattenDuetCommands(nodes, result = []) {
  nodes.forEach((node) => {
    if (node.type === 'command' || node.type === 'concurrent') {
      result.push(node);
      return;
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
      : `${padding}for _ in range(${node.times}):\n${formatDuetProgram(node.body, indent + 4)}`
  )).join('\n');
}

export function getDuetBlocklyCommandBlocks() {
  return [
    ...DUET_COMMANDS.map((definition) => ({
    type: definition.type,
    category: definition.method === 'wait' || definition.method === 'stop'
      ? 'Control'
      : definition.armPoses
        ? 'Arm poses' : 'Locomotion',
    message0: definition.message,
    args0: definition.args.map((argument) => argument.kind === 'number'
      ? {
        type: 'field_number',
        name: argument.name,
        value: argument.value,
        min: argument.min,
        max: argument.max,
        precision: argument.step,
      }
      : { type: 'field_dropdown', name: argument.name, options: argument.choices }),
    previousStatement: null,
    nextStatement: null,
    colour: definition.method === 'wait' || definition.method === 'stop'
      ? 190
      : definition.armPoses ? 280 : 160,
    tooltip: definition.description,
    codeTemplate: definition.codeTemplate,
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
  return COMMAND_BY_METHOD.get(method) || null;
}

export function compileDuetMotionPrompt(prompt = '') {
  const normalized = prompt.toLowerCase().replace(/[,.!?;:]/g, ' ');
  const steps = [];
  const unknown = [];
  const durationMatch = normalized.match(/\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(s|secs?|seconds?)\b/);
  const durationValue = durationMatch ? Number(durationMatch[1]) : 1;
  const durationError = durationMatch && (durationValue < 0.1 || durationValue > 3)
    ? `Requested duration ${durationValue} seconds is outside the supported 0.1-3 second range.`
    : /\bfor\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|minutes?|mins?)\b/.test(normalized)
      ? 'Only second-based durations from 0.1 to 3 seconds are supported.'
      : /\bfor\s+[a-z]+\s*(?:s|secs?|seconds?)\b/.test(normalized)
        ? 'Specify a numeric duration in seconds.'
      : null;
  const duration = durationError ? 1 : durationValue;
  const movementMatches = [
    ...normalized.matchAll(/\b(walk|move)\s+(forward|backward)\b/g),
    ...normalized.matchAll(/\b(sidestep|step)\s+(left|right)\b/g),
    ...normalized.matchAll(/\b(turn)\s+(left|right)\b/g),
  ].sort((left, right) => left.index - right.index);

  movementMatches.forEach((match) => {
    const [, action, direction] = match;
    if (durationError) {
      unknown.push(durationError);
      return;
    }
    if (action === 'walk' || action === 'move') {
      if (/\bdegrees?\b|\bangle\b/.test(normalized)) {
        unknown.push('Angle-based movement is not supported; use forward, backward, left, or right velocity commands.');
        return;
      }
      if (/\bsteps?\b|\bmeters?\b|\bmetres?\b/.test(normalized)) {
        unknown.push('Step- or distance-based movement is not equivalent to DUET velocity-and-time commands; specify a duration in seconds.');
        return;
      }
      const vx = direction === 'backward' ? -0.1 : 0.15;
      steps.push({
        label: direction === 'backward' ? 'Move backward' : 'Move forward',
        code: `duet.move(${vx}, 0, 0, ${duration})`,
        detail: `${duration} seconds at a conservative velocity`,
      });
    } else if (action === 'sidestep' || action === 'step') {
      if (/\bdegrees?\b|\bangle\b/.test(normalized)) {
        unknown.push('Angle-based movement is not supported; use forward, backward, left, or right velocity commands.');
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

  const supportedArmGestureMatches = [
    ...normalized.matchAll(/\bwave\s+(left|right)\b/g),
    ...normalized.matchAll(/\braise\s+(?:both\s+arms?|left\s+arm|right\s+arm)\b/g),
  ].sort((left, right) => left.index - right.index);

  supportedArmGestureMatches.forEach((match) => {
    if (durationError) {
      unknown.push(durationError);
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

  if (!supportedArmGestureMatches.length && /\b(wave|raise|lift)\b/.test(normalized)) {
    unknown.push('Arm gestures are only supported as safe bounded left/right and both-arm presets that use the validated DUET arm gate.');
  }
  if (/\b(kick|knee|dance|mimic)\b/.test(normalized)) {
    unknown.push('Kicks, isolated knee raises, dance, and mimic are not available in the DUET command set.');
  }
  if (!steps.length) {
    unknown.push('Try: “move forward for 1 second, then turn left for 1 second”.');
  }
  const code = steps.map((step) => step.code).join('\n');
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
