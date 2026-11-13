import {
  flattenG1Commands,
  formatG1Program,
  parseG1Program,
} from './g1Commands.js';

const ARM_COMMANDS = new Set(['arm_action', 'hold_arm']);
const ALLOWED_COMMANDS = new Set([...ARM_COMMANDS, 'wait']);

export function validateLegacyArmMotion(name, code) {
  if (typeof name !== 'string') {
    throw new Error('Enter a name for the recorded motion.');
  }
  const normalizedName = name.trim();
  if (
    !normalizedName
    || normalizedName.length > 40
    || [...normalizedName].some((character) => (
      character.codePointAt(0) < 32 || character.codePointAt(0) === 127
    ))
  ) {
    throw new Error('Recording names must contain 1 to 40 printable characters.');
  }
  if (typeof code !== 'string' || code.length > 10_000) {
    throw new Error('Legacy arm command code must be text no longer than 10,000 characters.');
  }

  const nodes = parseG1Program(code);
  const containsUnsupportedStructure = (items) => items.some((node) => (
    node.type === 'condition'
    || node.type === 'boolean_assignment'
    || (node.type === 'repeat' && containsUnsupportedStructure(node.body))
  ));
  if (containsUnsupportedStructure(nodes)) {
    throw new Error('Legacy motion capture does not support conditions or Boolean assignments.');
  }

  const commands = flattenG1Commands(nodes);
  if (commands.some(({ method }) => !ALLOWED_COMMANDS.has(method))) {
    throw new Error('Legacy recordings may contain only arm actions, static arm holds, and waits.');
  }
  if (!commands.length || !commands.some(({ method }) => ARM_COMMANDS.has(method))) {
    throw new Error('Add one or more approved physical arm commands before recording.');
  }

  return {
    name: normalizedName,
    code: formatG1Program(nodes),
  };
}
