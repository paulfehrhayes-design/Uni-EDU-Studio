import { getDuetArmCatalog } from './duetArmCatalog.js';
import { G1_MODEL_INFO } from './g1ModelRuntime.js';

export const G1_RECORDING_FORMAT = 'uni-edu-studio/g1-motion-recording';
export const G1_RECORDING_COLLECTION_FORMAT = 'uni-edu-studio/g1-motion-recordings';
export const G1_RECORDING_SCHEMA_VERSION = 1;

function getRecordingJointNames(recording) {
  if (Array.isArray(recording?.joint_names)) return recording.joint_names;
  return getDuetArmCatalog().jointOrder;
}

function validateRecording(recording) {
  const jointNames = getRecordingJointNames(recording);
  const knownJoints = new Set(G1_MODEL_INFO.joints);
  const controllerVersion = recording?.controller_version ?? 'duet';
  const duetJointNames = getDuetArmCatalog().jointOrder;
  if (!['legacy', 'duet'].includes(controllerVersion)) {
    throw new Error('Recorded motion controller version is unsupported.');
  }
  if (!Array.isArray(jointNames)) {
    throw new Error('Recorded motion joint names do not match the supported G1 model.');
  }
  const hasLegacyLayout = jointNames.length === 23
    && new Set(jointNames).size === knownJoints.size
    && jointNames.every((name) => knownJoints.has(name));
  const hasDuetLayout = jointNames.length === duetJointNames.length
    && jointNames.every((name, index) => name === duetJointNames[index]);
  if (
    new Set(jointNames).size !== jointNames.length
    || !(controllerVersion === 'legacy' ? hasLegacyLayout : hasDuetLayout)
  ) {
    throw new Error('Recorded motion joint names do not match the supported G1 model.');
  }
  const frames = recording?.frames;
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > 601) {
    throw new Error('Recorded motion must contain 2 to 601 samples.');
  }
  let previousTime = -1;
  frames.forEach((frame, index) => {
    if (
      !Number.isFinite(frame?.time)
      || frame.time < 0
      || frame.time > 30
      || frame.time <= previousTime
      || !Array.isArray(frame.joints)
      || frame.joints.length !== jointNames.length
      || frame.joints.some((position) => !Number.isFinite(position))
    ) {
      throw new Error(`Recorded motion sample ${index + 1} is invalid.`);
    }
    if (index === 0 && frame.time !== 0) {
      throw new Error('Recorded motion must start at time zero.');
    }
    previousTime = frame.time;
  });
  return jointNames;
}

export function buildG1MotionRecordingExport(recording) {
  const jointNames = validateRecording(recording);
  const controllerVersion = recording.controller_version ?? 'duet';
  return {
    format: G1_RECORDING_FORMAT,
    version: G1_RECORDING_SCHEMA_VERSION,
    robot_model: 'unitree_g1_23dof',
    model_dof: 23,
    recorded_dof: jointNames.length,
    controller: controllerVersion === 'legacy' ? 'legacy_sdk' : 'duet_v2',
    controller_version: controllerVersion,
    measurement_source: controllerVersion === 'legacy'
      ? 'ros:/joint_states'
      : 'duet_status:measuredJoints',
    name: recording.name,
    command: recording.command || '',
    joint_names: [...jointNames],
    units: { time: 'seconds', joint_position: 'radians' },
    captured_at: normalizeCaptureTime(recording.captured_at || recording.created_at),
    frames: recording.frames.map((frame) => ({
      time_s: frame.time,
      positions_rad: [...frame.joints],
    })),
  };
}

function normalizeCaptureTime(value) {
  if (!value) return null;
  if (typeof value !== 'string') {
    throw new Error('Recorded motion capture timestamp is invalid.');
  }
  const isoValue = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = new Date(isoValue);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Recorded motion capture timestamp is invalid.');
  }
  return timestamp.toISOString();
}

export function buildG1MotionRecordingsExport(recordings) {
  if (!Array.isArray(recordings)) {
    throw new Error('Recorded motions must be provided as a list.');
  }
  return {
    format: G1_RECORDING_COLLECTION_FORMAT,
    version: G1_RECORDING_SCHEMA_VERSION,
    robot_model: 'unitree_g1_23dof',
    recordings: recordings.map(buildG1MotionRecordingExport),
  };
}

export function downloadG1MotionRecording(recording, filename) {
  const content = JSON.stringify(buildG1MotionRecordingExport(recording), null, 2);
  downloadJson(content, filename);
}

export function downloadG1MotionRecordings(recordings) {
  const content = JSON.stringify(buildG1MotionRecordingsExport(recordings), null, 2);
  downloadJson(content, 'g1-recorded-motions.json');
}

function downloadJson(content, filename) {
  const blob = new Blob([content], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
