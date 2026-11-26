import {
  flattenG1Commands,
  formatG1Program,
  parseG1Program,
} from './g1Commands.js';
import {
  flattenDuetCommands,
  formatDuetProgram,
  getDuetCommand,
  parseDuetProgram,
} from './duetCommands.js';

const MAX_CAPTURE_COMMANDS = 20;
const MAX_CAPTURE_COMMAND_SECONDS = 300;
const MAX_COMMAND_CODE_LENGTH = 10_000;
const MAX_CAPTURE_NAME_LENGTH = 40;

const LEGACY_CAPTURE_COMMANDS = new Set([
  'stand',
  'walk',
  'walktime',
  'backward',
  'backwardtime',
  'fastwalk',
  'fastwalktime',
  'sidestep',
  'slowwalk',
  'slowwalktime',
  'turn',
  'turn_around_180',
  'arm_action',
  'hold_arm',
  'wait',
]);

const LEGACY_PHYSICAL_COMMANDS = new Set([
  'walk',
  'walktime',
  'backward',
  'backwardtime',
  'fastwalk',
  'fastwalktime',
  'sidestep',
  'slowwalk',
  'slowwalktime',
  'turn',
  'turn_around_180',
  'arm_action',
  'hold_arm',
]);

const LEGACY_LOCOMOTION_COMMANDS = new Set([
  'stand',
  'walk',
  'walktime',
  'backward',
  'backwardtime',
  'fastwalk',
  'fastwalktime',
  'sidestep',
  'slowwalk',
  'slowwalktime',
  'turn',
  'turn_around_180',
]);

function validateCaptureInput(name, code, controllerName) {
  if (typeof name !== 'string') {
    throw new Error('Enter a name for the position capture.');
  }
  const normalizedName = name.trim();
  if (
    !normalizedName
    || normalizedName.length > MAX_CAPTURE_NAME_LENGTH
    || [...normalizedName].some((character) => (
      character.codePointAt(0) < 32 || character.codePointAt(0) === 127
    ))
  ) {
    throw new Error(`Position capture names must contain 1 to ${MAX_CAPTURE_NAME_LENGTH} printable characters.`);
  }
  if (typeof code !== 'string' || code.length > MAX_COMMAND_CODE_LENGTH) {
    throw new Error(`${controllerName} command code must be text no longer than ${MAX_COMMAND_CODE_LENGTH} characters.`);
  }
  return normalizedName;
}

function validateSequentialCommands(nodes, controllerName) {
  const hasUnsupportedNode = (items) => items.some((node) => (
    node.type === 'repeat'
      ? hasUnsupportedNode(node.body)
      : node.type !== 'command'
  ));
  if (hasUnsupportedNode(nodes)) {
    throw new Error(`${controllerName} position capture supports sequential commands and bounded loops, not conditions or concurrent blocks.`);
  }
}

function validateCommandCount(commands, controllerName) {
  if (commands.length > MAX_CAPTURE_COMMANDS) {
    throw new Error(`${controllerName} position captures may contain at most ${MAX_CAPTURE_COMMANDS} expanded commands.`);
  }
  if (!commands.length) {
    throw new Error('Add one or more approved robot commands before recording.');
  }
}

function validateCommandDuration(seconds) {
  if (seconds > MAX_CAPTURE_COMMAND_SECONDS) {
    throw new Error('The estimated command sequence exceeds the five-minute capture limit.');
  }
}

function estimateLegacyCommandSeconds(command) {
  const { method, values } = command;
  if (['walktime', 'backwardtime', 'slowwalktime', 'fastwalktime', 'wait'].includes(method)) {
    return values[0];
  }
  if (method === 'hold_arm') return values[1];
  if (['walk', 'backward', 'slowwalk'].includes(method)) return values[0] * 2.5;
  if (method === 'fastwalk') return values[0] * 0.345 / 0.8;
  if (method === 'sidestep') return values[1] * 2.5;
  if (method === 'turn') return values[1] / 6;
  if (method === 'turn_around_180' || method === 'arm_action') return 30;
  return method === 'stand' ? 10 : 0;
}

export function validateLegacyPositionCapture(name, code) {
  const normalizedName = validateCaptureInput(name, code, 'Legacy');
  const nodes = parseG1Program(code);
  validateSequentialCommands(nodes, 'Legacy');
  const commands = flattenG1Commands(nodes);
  validateCommandCount(commands, 'Legacy');

  if (commands.some(({ method }) => !LEGACY_CAPTURE_COMMANDS.has(method))) {
    throw new Error('Legacy position captures allow standing, conservative walking and turns, approved arm actions, and waits only.');
  }
  if (!commands.some(({ method }) => LEGACY_PHYSICAL_COMMANDS.has(method))) {
    throw new Error('Add at least one approved arm or locomotion command before recording.');
  }
  validateCommandDuration(commands.reduce(
    (total, command) => total + estimateLegacyCommandSeconds(command),
    0,
  ));

  return {
    name: normalizedName,
    code: formatG1Program(nodes),
    usesLocomotion: commands.some(({ method }) => LEGACY_LOCOMOTION_COMMANDS.has(method)),
  };
}

function isDuetArmCommand(method) {
  const definition = getDuetCommand(method);
  return Boolean(definition?.armPoses || definition?.poseInput);
}

function isAllowedDuetCommand(method) {
  const definition = getDuetCommand(method);
  return Boolean(
    method === 'move'
    || definition?.motion
    || isDuetArmCommand(method)
    || ['wait', 'reset_arms', 'stop'].includes(method),
  );
}

function estimateDuetCommandSeconds(command) {
  const definition = getDuetCommand(command.method);
  if (command.method === 'move') return command.values[3];
  if (command.method === 'turn_around_180') return command.values[0];
  if (command.method === 'hold_pose_until_reset') return 30;
  if (command.method === 'hold_pose') return command.values[0];
  if (definition?.motion) return command.values[0];
  if (definition?.armPoses) return command.values[0] * definition.armPoses.length;
  if (command.method === 'wait') return command.values[0];
  return command.method === 'reset_arms' ? 3 : 0;
}

function validateDuetArmResets(commands) {
  let poseHeldUntilReset = false;
  commands.forEach(({ method }) => {
    if (poseHeldUntilReset && isDuetArmCommand(method) && method !== 'reset_arms') {
      throw new Error('Reset arms with duet.reset_arms() before starting another arm motion.');
    }
    if (method === 'reset_arms') poseHeldUntilReset = false;
    else if (method === 'hold_pose_until_reset') poseHeldUntilReset = true;
  });
  if (poseHeldUntilReset) {
    throw new Error('Position captures must include duet.reset_arms() after every hold-until-reset pose.');
  }
}

export function validateDuetPositionCapture(name, code) {
  const normalizedName = validateCaptureInput(name, code, 'DUET');
  const nodes = parseDuetProgram(code);
  validateSequentialCommands(nodes, 'DUET');
  const commands = flattenDuetCommands(nodes);
  validateCommandCount(commands, 'DUET');

  if (commands.some(({ method }) => !isAllowedDuetCommand(method))) {
    throw new Error('DUET position captures allow bounded walking, turning, approved arm motions, waits, resets, and a final stop only.');
  }
  if (!commands.some(({ method }) => (
    method === 'move' || getDuetCommand(method)?.motion || isDuetArmCommand(method)
  ))) {
    throw new Error('Add at least one approved arm or locomotion command before recording.');
  }
  validateDuetArmResets(commands);
  validateCommandDuration(commands.reduce(
    (total, command) => total + estimateDuetCommandSeconds(command),
    0,
  ));

  return {
    name: normalizedName,
    code: formatDuetProgram(nodes),
    usesLocomotion: commands.some(({ method }) => (
      method === 'move' || Boolean(getDuetCommand(method)?.motion)
    )),
  };
}
