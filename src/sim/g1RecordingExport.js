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
  const captureType = recording?.capture_type ?? 'motion';
  const duetJointNames = getDuetArmCatalog().jointOrder;
  if (!['legacy', 'duet'].includes(controllerVersion)) {
    throw new Error('Recorded motion controller version is unsupported.');
  }
  if (!['motion', 'position_calibration'].includes(captureType)) {
    throw new Error('Recorded motion capture type is unsupported.');
  }
  if (!Array.isArray(jointNames)) {
    throw new Error('Recorded motion joint names do not match the supported G1 model.');
  }
  const hasLegacyLayout = jointNames.length === 23
    && new Set(jointNames).size === knownJoints.size
    && jointNames.every((name) => knownJoints.has(name));
  const hasDuetLayout = jointNames.length === duetJointNames.length
    && jointNames.every((name, index) => name === duetJointNames[index]);
  const isValidJointLayout = captureType === 'position_calibration'
    ? hasLegacyLayout || (controllerVersion === 'duet' && hasDuetLayout)
    : controllerVersion === 'legacy' ? hasLegacyLayout : hasDuetLayout;
  if (
    new Set(jointNames).size !== jointNames.length
    || !isValidJointLayout
  ) {
    throw new Error('Recorded motion joint names do not match the supported G1 model.');
  }
  const frames = recording?.frames;
  const maximumSamples = captureType === 'position_calibration' ? 54001 : 601;
  const maximumDuration = captureType === 'position_calibration' ? 1800 : 30;
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > maximumSamples) {
    throw new Error(`Recorded motion must contain 2 to ${maximumSamples} samples.`);
  }
  let previousTime = -1;
  frames.forEach((frame, index) => {
    if (
      !Number.isFinite(frame?.time)
      || frame.time < 0
      || frame.time > maximumDuration
      || frame.time <= previousTime
      || !Array.isArray(frame.joints)
      || frame.joints.length !== jointNames.length
      || frame.joints.some((position) => !Number.isFinite(position))
      || (captureType === 'position_calibration' && !isValidBasePose(frame.pose))
      || (frame.pose !== undefined && frame.pose !== null && !isValidBasePose(frame.pose))
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

function exportLowStateSample(sample, frameIndex) {
  if (sample === undefined || sample === null) return null;
  const validVector = (values) => Array.isArray(values)
    && values.length === 3
    && values.every(Number.isFinite);
  if (
    typeof sample.timestamp !== 'string'
    || !Number.isFinite(new Date(sample.timestamp).getTime())
    || !Number.isFinite(sample.age_ms)
    || sample.age_ms < 0
    || sample.age_ms > 250
    || !Number.isInteger(sample.motor_count)
    || !Array.isArray(sample.motor_state)
    || sample.motor_state.length !== sample.motor_count
    || sample.motor_state.some((motor, index) => (
      motor?.index !== index
      || !Number.isFinite(motor.q)
      || !Number.isFinite(motor.dq)
      || !Number.isFinite(motor.tau_est)
    ))
    || !validVector(sample.imu_state?.rpy)
    || !validVector(sample.imu_state?.gyroscope)
    || !validVector(sample.imu_state?.accelerometer)
  ) {
    throw new Error(`Recorded Unitree LowState sample ${frameIndex + 1} is invalid.`);
  }
  return {
    timestamp: normalizeCaptureTime(sample.timestamp),
    age_ms: sample.age_ms,
    motor_count: sample.motor_count,
    motor_state: sample.motor_state.map((motor) => ({
      index: motor.index,
      q_rad: motor.q,
      dq_rad_s: motor.dq,
      tau_est_nm: motor.tau_est,
    })),
    imu_state: {
      rpy_rad: [...sample.imu_state.rpy],
      gyroscope_rad_s: [...sample.imu_state.gyroscope],
      accelerometer_m_s2: [...sample.imu_state.accelerometer],
    },
  };
}

function isValidBasePose(pose) {
  return typeof pose?.frame_id === 'string'
    && pose.frame_id.length > 0
    && typeof pose?.base_frame === 'string'
    && pose.base_frame.length > 0
    && ['x', 'y', 'z', 'yaw_rad', 'age_ms'].every((key) => Number.isFinite(pose[key]))
    && pose.age_ms >= 0
    && pose.age_ms <= 1000
    && typeof pose.timestamp === 'string'
    && Number.isFinite(new Date(pose.timestamp).getTime())
    && ['tf2', 'odometry'].includes(pose.source);
}

export function buildG1MotionRecordingExport(recording) {
  const jointNames = validateRecording(recording);
  const controllerVersion = recording.controller_version ?? 'duet';
  const captureType = recording.capture_type ?? 'motion';
  return {
    format: G1_RECORDING_FORMAT,
    version: G1_RECORDING_SCHEMA_VERSION,
    robot_model: 'unitree_g1_23dof',
    model_dof: 23,
    recorded_dof: jointNames.length,
    controller: controllerVersion === 'legacy' ? 'legacy_sdk' : 'duet_v2',
    controller_version: controllerVersion,
    capture_type: captureType,
    measurement_source: controllerVersion === 'legacy'
      || (captureType === 'position_calibration' && jointNames.length === 23)
      ? 'ros:/joint_states'
      : 'duet_status:measuredJoints',
    name: recording.name,
    command: recording.command || '',
    joint_names: [...jointNames],
    units: captureType === 'position_calibration'
      ? {
        time: 'seconds',
        joint_position: 'radians',
        base_position: 'meters',
        base_yaw: 'radians',
        ...(recording.low_state_metadata ? {
          low_state_motor_position: 'radians',
          low_state_motor_velocity: 'radians_per_second',
          low_state_estimated_motor_torque: 'newton_meters',
          imu_rpy: 'radians',
          imu_gyroscope: 'radians_per_second',
          imu_accelerometer: 'meters_per_second_squared',
        } : {}),
      }
      : { time: 'seconds', joint_position: 'radians' },
    ...(recording.low_state_metadata
      ? { low_state_capture: recording.low_state_metadata }
      : {}),
    captured_at: normalizeCaptureTime(recording.captured_at || recording.created_at),
    frames: recording.frames.map((frame, index) => ({
      time_s: frame.time,
      positions_rad: [...frame.joints],
      ...(frame.low_state ? { low_state: exportLowStateSample(frame.low_state, index) } : {}),
      ...(frame.pose ? {
        base_pose: {
          frame_id: frame.pose.frame_id,
          base_frame: frame.pose.base_frame,
          x_m: frame.pose.x,
          y_m: frame.pose.y,
          z_m: frame.pose.z,
          yaw_rad: frame.pose.yaw_rad,
          timestamp: normalizeCaptureTime(frame.pose.timestamp),
          age_ms: frame.pose.age_ms,
          source: frame.pose.source,
        },
      } : {}),
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
  link.style.position = 'fixed';
  link.style.left = '-10000px';
  link.style.top = '0';
  document.body.append(link);
  try {
    link.click();
  } finally {
    window.setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  }
}
