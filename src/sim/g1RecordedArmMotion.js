import { G1_MODEL_INFO } from './g1ModelRuntime.js';
import { getDuetArmCatalog } from './duetArmCatalog.js';

const RADIANS_TO_DEGREES = 180 / Math.PI;
const MAX_RECORDING_SECONDS = 30;

export function buildG1RecordedMotionFrames(recording) {
  const frames = recording?.frames;
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > 601) {
    throw new Error('Recorded motion must contain 2 to 601 measured samples.');
  }

  const jointNames = recording.joint_names || getDuetArmCatalog().jointOrder;
  const knownJoints = new Set(G1_MODEL_INFO.joints);
  const duetJointNames = getDuetArmCatalog().jointOrder;
  if (!Array.isArray(jointNames)) {
    throw new Error('Recorded motion joint names do not match the supported G1 model.');
  }
  const controllerVersion = recording.controller_version
    ?? (jointNames.length === 23 ? 'legacy' : 'duet');
  if (!['legacy', 'duet'].includes(controllerVersion)) {
    throw new Error('Recorded motion controller version is unsupported.');
  }
  const isLegacy = controllerVersion === 'legacy';
  const hasLegacyLayout = jointNames.length === 23
    && new Set(jointNames).size === knownJoints.size
    && jointNames.every((name) => knownJoints.has(name));
  const hasDuetLayout = jointNames.length === duetJointNames.length
    && jointNames.every((name, index) => name === duetJointNames[index]);
  if (
    new Set(jointNames).size !== jointNames.length
    || (isLegacy ? !hasLegacyLayout : !hasDuetLayout)
  ) {
    throw new Error('Recorded motion joint names do not match the supported G1 model.');
  }
  let previousTime = -1;
  return frames.map((frame, frameIndex) => {
    if (
      !Number.isFinite(frame?.time)
      || frame.time < 0
      || frame.time > MAX_RECORDING_SECONDS
      || frame.time <= previousTime
      || !Array.isArray(frame.joints)
      || frame.joints.length !== jointNames.length
      || frame.joints.some((angle) => !Number.isFinite(angle))
    ) {
      throw new Error(`Recorded motion sample ${frameIndex + 1} is invalid.`);
    }
    if (frameIndex === 0 && frame.time !== 0) {
      throw new Error('Recorded motion must start at time zero.');
    }
    previousTime = frame.time;

    const joints = Object.fromEntries(G1_MODEL_INFO.joints.map((name) => [name, 0]));
    jointNames.forEach((name, jointIndex) => {
      joints[name] = frame.joints[jointIndex] * RADIANS_TO_DEGREES;
    });
    return {
      time: frame.time,
      x: 0,
      y: 0,
      heading: 0,
      joints,
      path: [{ x: 0, y: 0 }],
      actions: [{ label: recording.name || 'Recorded motion', summary: 'Measured robot joint trajectory' }],
    };
  });
}

export const buildG1RecordedArmMotionFrames = buildG1RecordedMotionFrames;
