import { G1_MODEL_INFO } from './g1ModelRuntime.js';
import { getDuetArmCatalog } from './duetArmCatalog.js';

const RADIANS_TO_DEGREES = 180 / Math.PI;

export function buildG1RecordedMotionFrames(recording) {
  const frames = recording?.frames;
  const captureType = recording?.capture_type ?? 'motion';
  const isPositionCapture = captureType === 'position_calibration';
  const maximumSeconds = isPositionCapture ? 1800 : 30;
  const maximumSamples = isPositionCapture ? 54001 : 601;
  if (!['motion', 'position_calibration'].includes(captureType)) {
    throw new Error('Recorded motion capture type is unsupported.');
  }
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > maximumSamples) {
    throw new Error(`Recorded motion must contain 2 to ${maximumSamples} measured samples.`);
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
  const isPositionCalibration = captureType === 'position_calibration';
  const hasLegacyLayout = jointNames.length === 23
    && new Set(jointNames).size === knownJoints.size
    && jointNames.every((name) => knownJoints.has(name));
  const hasDuetLayout = jointNames.length === duetJointNames.length
    && jointNames.every((name, index) => name === duetJointNames[index]);
  const hasValidLayout = isPositionCalibration
    ? hasLegacyLayout || (controllerVersion === 'duet' && hasDuetLayout)
    : isLegacy ? hasLegacyLayout : hasDuetLayout;
  if (
    new Set(jointNames).size !== jointNames.length
    || !hasValidLayout
  ) {
    throw new Error('Recorded motion joint names do not match the supported G1 model.');
  }
  let positionFrames = frames.map(() => ({ x: 0, y: 0 }));
  let previewPath = [{ x: 0, y: 0 }];
  let positionHeadings = frames.map(() => 0);
  if (isPositionCalibration) {
    const poses = frames.map((frame, frameIndex) => {
      const pose = frame?.pose;
      if (
        typeof pose?.frame_id !== 'string'
        || !pose.frame_id
        || typeof pose?.base_frame !== 'string'
        || !pose.base_frame
        || !['x', 'y', 'yaw_rad'].every((key) => Number.isFinite(pose[key]))
      ) {
        throw new Error(`Recorded position sample ${frameIndex + 1} has an invalid base pose.`);
      }
      if (
        frameIndex > 0
        && (pose.frame_id !== frames[0].pose.frame_id
          || pose.base_frame !== frames[0].pose.base_frame)
      ) {
        throw new Error('Recorded position samples must use one consistent TF frame pair.');
      }
      return pose;
    });
    const origin = poses[0];
    let unwrappedYaw = origin.yaw_rad;
    positionFrames = poses.map((pose, index) => {
      if (index > 0) {
        let yawDelta = pose.yaw_rad - poses[index - 1].yaw_rad;
        yawDelta = ((yawDelta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        unwrappedYaw += yawDelta;
      }
      positionHeadings[index] = (unwrappedYaw - origin.yaw_rad) * RADIANS_TO_DEGREES;
      const deltaX = pose.x - origin.x;
      const deltaY = pose.y - origin.y;
      const cosine = Math.cos(origin.yaw_rad);
      const sine = Math.sin(origin.yaw_rad);
      return {
        x: cosine * deltaX + sine * deltaY,
        y: -sine * deltaX + cosine * deltaY,
      };
    });
    const pathStride = Math.max(1, Math.ceil(positionFrames.length / 500));
    previewPath = positionFrames.filter((_, index) => (
      index % pathStride === 0 || index === positionFrames.length - 1
    ));
  }
  let previousTime = -1;
  return frames.map((frame, frameIndex) => {
    if (
      !Number.isFinite(frame?.time)
      || frame.time < 0
      || frame.time > maximumSeconds
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
    const position = positionFrames[frameIndex];
    return {
      time: frame.time,
      x: position.x,
      y: position.y,
      heading: positionHeadings[frameIndex],
      joints,
      path: previewPath,
      actions: [{ label: recording.name || 'Recorded motion', summary: 'Measured robot joint trajectory' }],
    };
  });
}

export const buildG1RecordedArmMotionFrames = buildG1RecordedMotionFrames;
