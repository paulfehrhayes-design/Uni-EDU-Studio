const numberArgument = (name, label, value, min, max, step = 1) => ({
  name,
  label,
  kind: 'number',
  value,
  min,
  max,
  step,
});

const choiceArgument = (name, label, choices, value) => ({
  name,
  label,
  kind: 'choice',
  choices,
  value,
});

const command = (method, label, category, description, args = []) => ({
  method,
  label,
  category,
  description,
  physicalSupported: ['stand', 'walk', 'walktime', 'backward', 'backwardtime', 'sidestep', 'slowwalk', 'slowwalktime', 'fastwalk', 'fastwalktime', 'turn'].includes(method),
  args,
  blockType: `g1_command_${method}`,
  blockMessage: `${label}${args.map((_, index) => ` %${index + 1}`).join('')}`,
  codeTemplate: `robot.${method}(${args.map((argument) => argument.kind === 'choice' ? `"{{${argument.name}}}"` : `{{${argument.name}}}`).join(', ')})\n`,
});

const steps = (value = 2) => numberArgument('STEPS', 'steps', value, 1, 10);
const seconds = (value = 1) => numberArgument('SECONDS', 'seconds', value, 0.1, 10, 0.001);
const degrees = (value = 90) => numberArgument('DEGREES', 'degrees', value, 0, 120);
const direction = (value = 'left') => choiceArgument('DIRECTION', 'direction', [['Left', 'left'], ['Right', 'right']], value);
const level = (value = 'mid') => choiceArgument('LEVEL', 'level', [['High', 'high'], ['Mid', 'mid'], ['Low', 'low']], value);

const commandGroups = [
  [
    command('stand', 'Stand upright', 'Basics', 'Move to the default upright stance.'),
  ],
  [
    command('walk', 'Walk forward', 'Walking', 'Walk forward for a number of steps.', [steps()]),
    command('walktime', 'Walk forward for', 'Walking', 'Walk forward for a duration in seconds.', [seconds()]),
    command('backward', 'Walk backward', 'Walking', 'Walk backward for a number of steps.', [steps()]),
    command('backwardtime', 'Walk backward for', 'Walking', 'Walk backward for a duration in seconds.', [seconds()]),
    command('sidestep', 'Sidestep', 'Walking', 'Take steps to the selected side.', [direction()]),
    command('slowwalk', 'Slow walk', 'Walking', 'Walk at half speed for a number of steps.', [steps()]),
    command('slowwalktime', 'Slow walk for', 'Walking', 'Walk at half speed for a duration in seconds.', [seconds()]),
    command('fastwalk', 'Fast walk', 'Walking', 'Walk at twice speed for a number of steps.', [steps()]),
    command('fastwalktime', 'Fast walk for', 'Walking', 'Walk at twice speed for a duration in seconds.', [seconds()]),
    command('turn', 'Turn', 'Walking', 'Turn left or right by an angle in degrees; omit the angle for 90 degrees.', [direction(), numberArgument('ANGLE', 'degrees', 90, 5, 180)]),
  ],
  [
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
];

export const G1_COMMANDS = Object.freeze(commandGroups.flat());

const COMMAND_BY_METHOD = new Map(G1_COMMANDS.map((entry) => [entry.method, entry]));

function splitArguments(rawArgs) {
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
  if (current.trim()) args.push(current.trim());
  return args;
}

function decodeArgument(raw, definition) {
  if (definition.kind === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${definition.label} must be a number.`);
    const bounded = Math.min(definition.max, Math.max(definition.min, value));
    return Number(bounded.toFixed(3));
  }
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
  if (!definition.choices.some(([, value]) => value === unquoted)) {
    throw new Error(`${definition.label} must be one of ${definition.choices.map(([, value]) => value).join(', ')}.`);
  }
  return unquoted;
}

function formatArgument(value, definition) {
  return definition.kind === 'choice' ? `"${value}"` : String(value);
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

export function getG1BlocklyCommandBlocks() {
  return G1_COMMANDS.map((definition) => ({
    type: definition.blockType,
    message0: definition.args.length
      ? `${definition.label} ${definition.args.map((argument, index) => `%${index + 1}`).join(' ')}`
      : definition.label,
    args0: definition.args.map((argument) => argument.kind === 'number'
      ? { type: 'field_number', name: argument.name, value: argument.value, min: argument.min, max: argument.max, precision: argument.step }
      : { type: 'field_dropdown', name: argument.name, options: argument.choices }),
    previousStatement: null,
    nextStatement: null,
    colour: definition.category === 'Gestures' ? 280 : 160,
    tooltip: definition.physicalSupported
      ? definition.description
      : `${definition.description} Physical robot execution is not configured for this action yet.`,
    codeTemplate: definition.codeTemplate,
  }));
}
