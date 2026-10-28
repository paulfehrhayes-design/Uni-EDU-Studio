import {
  flattenDuetCommands,
  formatDuetProgram,
  getDuetCommand,
  parseDuetProgram,
} from './duetCommands.js';

export const MAX_SAVED_DUET_ARM_MOTIONS = 50;
const MAX_SAVED_MOTION_NAME_LENGTH = 40;
const MAX_SAVED_MOTION_CODE_LENGTH = 10_000;

export function getDuetArmMotionsStorageKey(username) {
  const owner = typeof username === 'string' && username.trim()
    ? username.trim().toLowerCase()
    : 'guest';
  return `uni-edu-duet-arm-motions:${encodeURIComponent(owner)}`;
}

export function validateDuetArmMotion(name, code) {
  if (typeof name !== 'string') {
    throw new Error('Enter a name for the saved arm sequence.');
  }
  const normalizedName = name.trim();
  if (
    !normalizedName
    || normalizedName.length > MAX_SAVED_MOTION_NAME_LENGTH
    || [...normalizedName].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)
  ) {
    throw new Error(`Arm sequence names must contain 1 to ${MAX_SAVED_MOTION_NAME_LENGTH} printable characters.`);
  }
  if (typeof code !== 'string' || code.length > MAX_SAVED_MOTION_CODE_LENGTH) {
    throw new Error(`Arm sequence code must be text no longer than ${MAX_SAVED_MOTION_CODE_LENGTH} characters.`);
  }

  const nodes = parseDuetProgram(code);
  const commands = flattenDuetCommands(nodes);
  if (!commands.length) {
    throw new Error('Add one or more approved arm commands before saving a sequence.');
  }
  const unsupported = commands.find((node) => {
    if (node.type !== 'command') return true;
    if (node.method === 'reset_arms') return false;
    const definition = getDuetCommand(node.method);
    return !definition?.armPoses && !definition?.poseInput;
  });
  if (unsupported) {
    throw new Error('Saved arm sequences may contain only approved arm poses, gestures, holds, and resets.');
  }
  let poseHeldUntilReset = false;
  commands.forEach(({ method }) => {
    if (method === 'reset_arms') poseHeldUntilReset = false;
    else if (method === 'hold_pose_until_reset') poseHeldUntilReset = true;
  });
  if (poseHeldUntilReset) {
    throw new Error('A reusable sequence must include duet.reset_arms() after every hold-until-reset pose.');
  }

  return {
    name: normalizedName,
    code: formatDuetProgram(nodes),
  };
}

export function parseSavedDuetArmMotions(serialized) {
  if (serialized === null || serialized === '') return [];

  let saved;
  try {
    saved = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Saved arm sequence data is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(saved) || saved.length > MAX_SAVED_DUET_ARM_MOTIONS) {
    throw new Error(`Saved arm sequence data must be a list of at most ${MAX_SAVED_DUET_ARM_MOTIONS} items.`);
  }

  const motions = saved.map((motion, index) => {
    if (!motion || typeof motion !== 'object' || Array.isArray(motion)) {
      throw new Error(`Saved arm sequence ${index + 1} is invalid.`);
    }
    return validateDuetArmMotion(motion.name, motion.code);
  });
  const names = new Set();
  motions.forEach(({ name }) => {
    const normalizedName = name.toLocaleLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`Saved arm sequence name "${name}" appears more than once.`);
    }
    names.add(normalizedName);
  });
  return motions;
}
