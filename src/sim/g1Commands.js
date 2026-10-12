const numberArgument = (name, label, value, min, max, step = 1) => ({
  name,
  label,
  kind: 'number',
  value,
  min,
  max,
  step,
});

const integerArgument = (name, label, value, min, max) => ({
  name,
  label,
  kind: 'integer',
  value,
  min,
  max,
  step: 1,
});

const choiceArgument = (name, label, choices, value) => ({
  name,
  label,
  kind: 'choice',
  choices,
  value,
});

const integerChoiceArgument = (name, label, choices, value) => ({
  name,
  label,
  kind: 'integerChoice',
  choices,
  value,
});

const textArgument = (name, label, value) => ({
  name,
  label,
  kind: 'text',
  value,
});

const SDK_COMMAND_METHODS = {
  stand: 'LocoClient.Start() / SetFsmId(500)',
  sit: 'LocoClient.Sit (SetFsmId(3))',
  walk: 'LocoClient.SetVelocity',
  walktime: 'LocoClient.SetVelocity',
  backward: 'LocoClient.SetVelocity',
  backwardtime: 'LocoClient.SetVelocity',
  sidestep: 'LocoClient.SetVelocity',
  slowwalk: 'LocoClient.SetVelocity',
  slowwalktime: 'LocoClient.SetVelocity',
  fastwalk: 'LocoClient.SetVelocity',
  fastwalktime: 'LocoClient.SetVelocity',
  turn: 'LocoClient.SetVelocity',
  squat_to_stand: 'LocoClient.SetFsmId(706) / Squat2StandUp',
  lie_to_stand: 'LocoClient.SetFsmId(702) / Lie2StandUp',
  stand_to_squat: 'LocoClient.SetFsmId(706) / StandUp2Squat',
  getfsm: 'LocoClient.GetFsmId',
  getactions: 'G1ArmActionClient.GetActionList',
  arm_action: 'G1ArmActionClient.ExecuteAction',
  say: 'AudioClient.TtsMaker',
  getvolume: 'AudioClient.GetVolume',
  setvolume: 'AudioClient.SetVolume',
  led: 'AudioClient.LedControl',
  playstop: 'AudioClient.PlayStop',
};

const command = (method, label, category, description, args = []) => ({
  method,
  label,
  category,
  description,
  sdkMethod: SDK_COMMAND_METHODS[method] || null,
  adapters: {
    simulator: !['Diagnostics', 'Audio'].includes(category),
    sdk: Boolean(SDK_COMMAND_METHODS[method]),
    webRtc: false,
  },
  physicalSupported: Boolean(SDK_COMMAND_METHODS[method]),
  args,
  blockType: `g1_command_${method}`,
  blockMessage: `${label}${args.map((_, index) => ` %${index + 1}`).join('')}`,
  stringFields: args.filter((argument) => argument.kind === 'text').map((argument) => argument.name),
  codeTemplate: `robot.${method}(${args.map((argument) => {
    if (argument.kind === 'choice') return `"{{${argument.name}}}"`;
    return `{{${argument.name}}}`;
  }).join(', ')})\n`,
});

const steps = (value = 2) => numberArgument('STEPS', 'steps', value, 1, 10);
const seconds = (value = 1) => numberArgument('SECONDS', 'seconds', value, 0.1, 10, 0.001);
const degrees = (value = 90) => numberArgument('DEGREES', 'degrees', value, 0, 120);
const direction = (value = 'left') => choiceArgument('DIRECTION', 'direction', [['Left', 'left'], ['Right', 'right']], value);
const level = (value = 'mid') => choiceArgument('LEVEL', 'level', [['High', 'high'], ['Mid', 'mid'], ['Low', 'low']], value);
const ARM_PRESETS = [
  ['Release Arm (99)', 'release arm'],
  ['Two-hand Kiss (11)', 'two-hand kiss'],
  ['Left Kiss (12)', 'left kiss'],
  ['Right Kiss (13)', 'right kiss'],
  ['Hands Up (15)', 'hands up'],
  ['Clap (17)', 'clap'],
  ['High Five (18)', 'high five'],
  ['Hug (19)', 'hug'],
  ['Heart (20)', 'heart'],
  ['Right Heart (21)', 'right heart'],
  ['Reject (22)', 'reject'],
  ['Right Hand Up (23)', 'right hand up'],
  ['X-ray (24)', 'x-ray'],
  ['Face Wave (25)', 'face wave'],
  ['High Wave (26)', 'high wave'],
  ['Shake Hand (27)', 'shake hand'],
];

const commandGroups = [
  [
    command('stand', 'Stand / ready', 'Basics', 'Select the normal G1 locomotion-ready FSM (ID 500). This does not run the separate Squat2StandUp transition.'),
    command('sit', 'Sit down', 'Basics', 'Request the G1 seated posture (LocoClient FSM 3). The simulator shows an approximate seated pose; transition completion is not monitored.'),
  ],
  [
    command('walk', 'Walk forward', 'Walking', 'Estimate 34.5 cm per count from observed 33–36 cm steps; requests about 0.86 s of 0.4 m/s velocity per count, then stops. Real distance varies.', [steps()]),
    command('walktime', 'Walk forward for', 'Walking', 'Request forward velocity for this many seconds, then stop. Actual distance varies with the robot and surface.', [seconds()]),
    command('backward', 'Walk backward', 'Walking', 'Estimate 34.5 cm per count from observed 33–36 cm steps; requests about 0.86 s of 0.4 m/s backward velocity per count, then stops. Real distance varies.', [steps()]),
    command('backwardtime', 'Walk backward for', 'Walking', 'Request backward velocity for this many seconds, then stop. Actual distance varies with the robot and surface.', [seconds()]),
    command('sidestep', 'Sidestep', 'Walking', 'Request sideways motion for about 2 seconds at 0.2 m/s, then stop. This is timed velocity, not a measured footstep.', [direction()]),
    command('slowwalk', 'Slow walk', 'Walking', 'Estimate 34.5 cm per count from observed 33–36 cm steps; requests about 1.73 s of 0.2 m/s velocity per count, then stops. Real distance varies.', [steps()]),
    command('slowwalktime', 'Slow walk for', 'Walking', 'Request forward velocity at 0.2 m/s for this many seconds, then stop. Actual distance varies with the robot and surface.', [seconds()]),
    command('fastwalk', 'Fast walk', 'Walking', 'Estimate 34.5 cm per count from observed 33–36 cm steps; requests about 0.43 s of 0.8 m/s velocity per count, then stops. Real distance varies.', [steps()]),
    command('fastwalktime', 'Fast walk for', 'Walking', 'Request forward velocity at 0.8 m/s for this many seconds, then stop. Actual distance varies with the robot and surface.', [seconds()]),
    command('turn', 'Turn', 'Walking', 'Request a timed turn at about 0.6 radians/second for the selected angle, then stop. The angle is a target estimate, not feedback-controlled positioning.', [direction(), numberArgument('ANGLE', 'degrees', 90, 5, 180)]),
  ],
  [
    command('squat_to_stand', 'Squat to stand', 'Postures', 'Request the SDK squat-to-stand transition (FSM 706). The SDK only confirms the request, not completion.'),
    command('lie_to_stand', 'Lie to stand', 'Postures', 'Request the SDK lie-to-stand transition (FSM 702). The SDK only confirms the request, not completion.'),
    command('stand_to_squat', 'Stand to squat', 'Postures', 'Request the SDK stand-to-squat transition (FSM 706). The SDK only confirms the request, not completion.'),
  ],
  [
    command(
      'arm_action',
      'Run arm preset',
      'Gestures',
      'Request a named built-in G1 arm action. The SDK reports whether the request was accepted, not when the motion finishes. Teacher Stop stops locomotion but cannot cancel an active arm preset; use only with the robot area clear and direct supervision.',
      [choiceArgument('ACTION', 'arm preset', ARM_PRESETS, 'hands up')],
    ),
    command(
      'simulate_arm_action',
      'Preview arm preset',
      'Gestures',
      'Preview an approximate arm pose for a legacy G1 preset. Simulator-only; the motion does not match the SDK trajectory.',
      [choiceArgument('ACTION', 'arm preset', ARM_PRESETS, 'hands up')],
    ),
    command('waveleft', 'Wave left hand', 'Gestures', 'Wave the left hand at a preset height.', [level()]),
    command('waveleftDegrees', 'Wave left hand by', 'Gestures', 'Set the left arm gesture angle in degrees.', [degrees()]),
    command('waveright', 'Wave right hand', 'Gestures', 'Wave the right hand at a preset height.', [level()]),
    command('waverightDegrees', 'Wave right hand by', 'Gestures', 'Set the right arm gesture angle in degrees.', [degrees()]),
    command('raisebotharms', 'Raise both arms', 'Gestures', 'Raise both arms to a preset height.', [level()]),
    command('raisebotharmsDegrees', 'Raise both arms by', 'Gestures', 'Set both arm gesture angles in degrees.', [degrees()]),
    command('raiseleftarm', 'Raise left arm', 'Gestures', 'Raise the left arm to a preset height.', [level()]),
    command('raiseleftarmDegrees', 'Raise left arm by', 'Gestures', 'Set the left arm angle in degrees.', [degrees()]),
    command('raiserightarm', 'Raise right arm', 'Gestures', 'Raise the right arm to a preset height.', [level()]),
    command('raiserightarmDegrees', 'Raise right arm by', 'Gestures', 'Set the right arm angle in degrees.', [degrees()]),
    command('kickleft', 'Kick with left leg', 'Gestures', 'Perform a left-leg kick at a preset level.', [level()]),
    command('kickleftDegrees', 'Kick with left leg by', 'Gestures', 'Set the left-leg kick angle in degrees.', [degrees()]),
    command('kickright', 'Kick with right leg', 'Gestures', 'Perform a right-leg kick at a preset level.', [level()]),
    command('kickrightDegrees', 'Kick with right leg by', 'Gestures', 'Set the right-leg kick angle in degrees.', [degrees()]),
    command('kneeleft', 'Raise left knee', 'Gestures', 'Raise the left knee.'),
    command('kneeright', 'Raise right knee', 'Gestures', 'Raise the right knee.'),
  ],
  [
    command('getfsm', 'Read current motion state', 'Diagnostics', 'Read the current locomotion FSM ID without changing robot state.'),
    command('getactions', 'List available arm actions', 'Diagnostics', 'Read the preset arm actions reported by the robot; does not execute an action.'),
  ],
  [
    command('say', 'Speak %1 with voice %2', 'Audio', 'Speak a short text phrase.', [textArgument('TEXT', 'text', 'Hello'), integerChoiceArgument('SPEAKER', 'speaker', [['Chinese', '0'], ['English', '1']], '1')]),
    command('getvolume', 'Read speaker volume', 'Audio', 'Read the current speaker volume.'),
    command('setvolume', 'Set speaker volume to %1', 'Audio', 'Set speaker volume from 0 to 70.', [integerArgument('VOLUME', 'volume', 50, 0, 70)]),
    command('led', 'Set head LED R %1 G %2 B %3', 'Audio', 'Set the head LED RGB color.', [
      integerArgument('RED', 'red', 0, 0, 255),
      integerArgument('GREEN', 'green', 160, 0, 255),
      integerArgument('BLUE', 'blue', 255, 0, 255),
    ]),
    command('playstop', 'Stop audio app %1', 'Audio', 'Stop playback for the named audio app.', [textArgument('APP', 'app name', 'example')]),
  ],
];

export const G1_NOMINAL_STEP_METERS = 0.345;
export const G1_COMMANDS = Object.freeze(commandGroups.flat());
export const G1_EXECUTABLE_COMMANDS = Object.freeze(
  G1_COMMANDS.filter((entry) => entry.adapters.sdk),
);

const COMMAND_BY_METHOD = new Map(G1_COMMANDS.map((entry) => [entry.method, entry]));

function armPresetBlockType(preset) {
  const suffix = preset.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();
  return `g1_command_arm_action_${suffix}`;
}

function splitArguments(rawArgs) {
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const character of rawArgs) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote) {
      current += character;
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
    } else if (character === ',' && !quote) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function decodeArgument(raw, definition) {
  if (definition.kind === 'number' || definition.kind === 'integer') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${definition.label} must be a number.`);
    if (definition.kind === 'integer' && !Number.isInteger(value)) throw new Error(`${definition.label} must be an integer.`);
    const bounded = Math.min(definition.max, Math.max(definition.min, value));
    return Number(bounded.toFixed(3));
  }
  if (definition.kind === 'text') {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      if (!raw.startsWith("'") || !raw.endsWith("'") || raw.slice(1, -1).includes("'")) {
        throw new Error(`${definition.label} must be a quoted string.`);
      }
      value = raw.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\'/g, "'");
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 120
      || [...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
      throw new Error(`${definition.label} must contain 1 to 120 printable characters.`);
    }
    return value;
  }
  if (definition.kind === 'integerChoice') {
    const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2');
    if (!definition.choices.some(([, value]) => value === unquoted)) {
      throw new Error(`${definition.label} must be one of ${definition.choices.map(([, value]) => value).join(', ')}.`);
    }
    return Number(unquoted);
  }
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
  if (!definition.choices.some(([, value]) => value === unquoted)) {
    throw new Error(`${definition.label} must be one of ${definition.choices.map(([, value]) => value).join(', ')}.`);
  }
  return unquoted;
}

function formatArgument(value, definition) {
  return definition.kind === 'choice' ? `"${value}"` : definition.kind === 'text' ? JSON.stringify(value) : String(value);
}

function normalizeCommand(method, rawArgs) {
  const definition = COMMAND_BY_METHOD.get(method);
  if (!definition) throw new Error(`Unknown robot command: ${method}`);
  const args = splitArguments(rawArgs);
  if (method === 'turn' && args.length === 1) args.push('90');
  if (args.length !== definition.args.length) {
    throw new Error(`robot.${method} expects ${definition.args.length} argument${definition.args.length === 1 ? '' : 's'}.`);
  }
  const values = args.map((argument, index) => decodeArgument(argument, definition.args[index]));
  const code = `robot.${method}(${values.map((value, index) => formatArgument(value, definition.args[index])).join(', ')})`;
  return { method, values, code };
}

function parseLines(lines, startIndex, indentLevel, depth) {
  if (depth > 5) throw new Error('Loops may be nested at most five levels.');
  const nodes = [];
  let index = startIndex;
  while (index < lines.length) {
    const { indent, text, lineNumber } = lines[index];
    if (!text || text.startsWith('#')) {
      index += 1;
      continue;
    }
    if (indent < indentLevel) break;
    if (indent > indentLevel) throw new Error(`Unexpected indentation on line ${lineNumber}.`);

    const loop = text.match(/^for\s+\w+\s+in\s+range\(\s*(?:0\s*,\s*)?(\d+)\s*\)\s*:\s*$/);
    if (loop) {
      const times = Number(loop[1]);
      if (times < 1 || times > 20) throw new Error(`Loop count on line ${lineNumber} must be between 1 and 20.`);
      index += 1;
      while (index < lines.length && (!lines[index].text || lines[index].text.startsWith('#'))) index += 1;
      if (index >= lines.length || lines[index].indent <= indentLevel) throw new Error(`Loop on line ${lineNumber} has no body.`);
      const [body, nextIndex] = parseLines(lines, index, lines[index].indent, depth + 1);
      nodes.push({ type: 'repeat', times, body });
      index = nextIndex;
      continue;
    }

    const call = text.match(/^robot\.([A-Za-z]\w*)\((.*)\);?$/);
    if (!call) throw new Error(`Unsupported statement on line ${lineNumber}. Use a robot command or a for/range loop.`);
    nodes.push({ type: 'command', ...normalizeCommand(call[1], call[2]) });
    index += 1;
  }
  return [nodes, index];
}

export function parseG1Program(code = '') {
  const lines = code.replace(/\r/g, '').split('\n').map((raw, index) => {
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    return { indent, text: raw.trim(), lineNumber: index + 1 };
  });
  const [nodes, endIndex] = parseLines(lines, 0, 0, 0);
  if (endIndex < lines.length && lines.slice(endIndex).some(({ text }) => text && !text.startsWith('#'))) {
    throw new Error(`Invalid indentation on line ${lines[endIndex].lineNumber}.`);
  }
  return nodes;
}

export function flattenG1Commands(nodes, result = []) {
  nodes.forEach((node) => {
    if (node.type === 'command') {
      result.push(node);
      return;
    }
    for (let count = 0; count < node.times; count += 1) flattenG1Commands(node.body, result);
  });
  return result;
}

export function formatG1Program(nodes, indent = 0) {
  const padding = ' '.repeat(indent);
  return nodes.map((node) => {
    if (node.type === 'command') return `${padding}${node.code}`;
    return `${padding}for _ in range(${node.times}):\n${formatG1Program(node.body, indent + 4)}`;
  }).join('\n');
}

export function getG1BlocklyCommandBlocks(commands = G1_EXECUTABLE_COMMANDS) {
  return commands.flatMap((definition) => {
    const variants = definition.method === 'arm_action'
      ? definition.args[0].choices.map(([presetLabel, preset]) => ({
        ...definition,
        type: armPresetBlockType(preset),
        message: `Arm preset: ${presetLabel.replace(/ \(\d+\)$/, '')}`,
        args: [],
        codeTemplate: `robot.arm_action(${JSON.stringify(preset)})\n`,
        armPreset: preset,
      }))
      : [{
        ...definition,
        type: definition.blockType,
        message: definition.args.length
          ? `${definition.label} ${definition.args.map((_, index) => `%${index + 1}`).join(' ')}`
          : definition.label,
      }];

    return variants.map((variant) => ({
      type: variant.type,
      category: definition.category,
      armPreset: variant.armPreset,
      message0: variant.message,
      args0: variant.args.map((argument) => ['number', 'integer'].includes(argument.kind)
        ? { type: 'field_number', name: argument.name, value: argument.value, min: argument.min, max: argument.max, precision: argument.step }
        : argument.kind === 'text'
          ? { type: 'field_input', name: argument.name, text: argument.value }
          : { type: 'field_dropdown', name: argument.name, options: argument.choices }),
      previousStatement: null,
      nextStatement: null,
      colour: definition.category === 'Gestures' ? 280 : definition.category === 'Audio' ? 210 : definition.category === 'Diagnostics' ? 230 : 160,
      tooltip: !definition.physicalSupported
        ? `${definition.description} Physical robot execution is not configured for this action yet.`
        : !definition.adapters.simulator
          ? `${definition.description} Executes on G1 hardware; not simulated.`
          : definition.description,
      codeTemplate: variant.codeTemplate,
      stringFields: variant.stringFields,
    }));
  });
}
