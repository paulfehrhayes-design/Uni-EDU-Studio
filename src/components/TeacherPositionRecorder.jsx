import { useEffect, useRef, useState } from 'react';
import { G1_MODEL_INFO } from '../sim/g1ModelRuntime.js';
import {
  buildG1MotionRecordingExport,
  buildG1MotionRecordingsExport,
  downloadG1MotionRecording,
  downloadG1MotionRecordings,
} from '../sim/g1RecordingExport.js';
import {
  validateDuetPositionCapture,
  validateLegacyPositionCapture,
} from '../sim/g1PositionCaptureCommands.js';
import {
  scheduleNextPositionCaptureSample,
  selectPositionCapturePose,
  summarizePositionCaptureSensorUpdates,
} from '../robot/positionCapture.js';
import {
  buildG1LocomotionCalibrationSeries,
  distanceFromCalibrationAnchor,
  getG1CalibrationSectionElapsedSeconds,
  G1_CALIBRATION_STOP_RADIUS_METERS,
} from '../sim/g1LocomotionCalibration.js';

const SAMPLE_INTERVAL_MS = 1000 / 30;
const MAX_CAPTURE_SECONDS = 300;
const MAX_LOCOMOTION_SERIES_SECONDS = 1800;
const MAX_CAPTURE_SAMPLES = 54001;
const MAX_JOINT_SAMPLE_AGE_MS = 250;
const CALIBRATION_SENSOR_TIMEOUT_MS = 1500;
const CALIBRATION_STOP_TIMEOUT_MS = 5000;
const RATE_SWEEP_TARGETS_HZ = [10, 20, 30, 40, 50, 60, 80, 100, 150, 200];
const RATE_SWEEP_PHASE_SECONDS = 2;
const RATE_SWEEP_PHASE_MAX_SECONDS = 8;
const RATE_SWEEP_MAX_ATTEMPTS = 2;
const RATE_SWEEP_TIMEOUT_SECONDS = 120;

function isDuetReady(status) {
  return status?.ready === true
    && status.connected === true
    && status.controlLease === true
    && status.capabilities?.includes('arm_feedback')
    && Array.isArray(status.measuredJoints)
    && status.measuredJoints.length === 10
    && status.measuredJoints.every(Number.isFinite);
}

function isDuetIdle(status) {
  return isDuetReady(status)
    && status.programActive === false
    && status.motionActive === false;
}

function isLegacyIdle(status) {
  return status?.sdkAvailable === true && status.running === false;
}

function hasLocomotionCapability(status, controllerVersion) {
  return controllerVersion === 'duet'
    ? status?.capabilities?.includes('base_velocity') === true
    : status?.capabilities?.locomotion === true;
}

function hasCompleteG1JointSample(sample) {
  return Array.isArray(sample?.joint_names)
    && sample.joint_names.length === G1_MODEL_INFO.joints.length
    && new Set(sample.joint_names).size === G1_MODEL_INFO.joints.length
    && sample.joint_names.every((joint) => G1_MODEL_INFO.joints.includes(joint))
    && Array.isArray(sample.positions_rad)
    && sample.positions_rad.length === G1_MODEL_INFO.joints.length
    && sample.positions_rad.every(Number.isFinite)
    && Number.isFinite(sample.age_ms)
    && sample.age_ms >= 0
    && sample.age_ms <= MAX_JOINT_SAMPLE_AGE_MS;
}

async function readJointSample(connection) {
  const sample = await connection.jointState();
  if (!hasCompleteG1JointSample(sample)) {
    throw new Error('Fresh, complete 23-joint ROS telemetry is unavailable; no recording was saved.');
  }
  return {
    jointNames: sample.joint_names,
    positions: sample.positions_rad,
  };
}

function captureFilename(name) {
  const safeName = name.trim().replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  return `${safeName || 'g1-position-capture'}.json`;
}

function defaultCommand(controllerVersion) {
  return controllerVersion === 'duet'
    ? 'duet.walk(1)\nduet.turn_left(1)'
    : 'robot.walktime(1)\nrobot.turn("left", 90)';
}

function rateSweepCommand(controllerVersion) {
  return controllerVersion === 'duet'
    ? 'duet.walk(1)\nduet.backward(1)'
    : 'robot.walktime(1)\nrobot.backwardtime(1)';
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, label) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error(`${label} did not respond within ${milliseconds} ms.`)),
        milliseconds,
      );
    }),
  ]).finally(() => window.clearTimeout(timeoutId));
}

function makePoseAndJointFrame({ time, pose, positions }) {
  return { time, joints: [...positions], pose };
}

function partialRecordingName(name, recordings, capturedAt, preservedSuffix = '') {
  const timestamp = capturedAt.replace(/\D/g, '').slice(0, 14);
  let suffix = ` (partial ${timestamp})`;
  let baseNameLength = Math.max(0, 40 - suffix.length - preservedSuffix.length);
  let candidate = `${name.slice(0, baseNameLength)}${preservedSuffix}${suffix}`;
  let index = 2;
  while (recordings.some((recording) => recording.name.toLowerCase() === candidate.toLowerCase())) {
    suffix = ` (partial ${timestamp} ${index})`;
    baseNameLength = Math.max(0, 40 - suffix.length - preservedSuffix.length);
    candidate = `${name.slice(0, baseNameLength)}${preservedSuffix}${suffix}`;
    index += 1;
  }
  return candidate;
}

function uniqueRecordingName(name, recordings) {
  const existingNames = new Set(recordings.map(({ name: recordingName }) => recordingName.toLowerCase()));
  if (!existingNames.has(name.toLowerCase())) return name;
  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${name.slice(0, 40 - suffix.length)}${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
  }
}

function downloadSensorRateDiagnostic(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'g1-sensor-rate-sweep.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function summarizeRateSweepPhase(readings, targetHz) {
  const first = readings[0];
  const maxPoseDisplacementM = first
    ? Math.max(...readings.map((reading) => Math.hypot(
      reading.pose_x - first.pose_x,
      reading.pose_y - first.pose_y,
    )))
    : 0;
  const maxJointChangeRad = first
    ? Math.max(...readings.flatMap((reading) => reading.joint_positions_rad.map(
      (position, index) => Math.abs(position - first.joint_positions_rad[index]),
    )))
    : 0;
  const phaseSpanMs = readings.length > 1
    ? readings.at(-1).elapsed_ms - readings[0].elapsed_ms
    : 0;
  const pose = summarizePositionCaptureSensorUpdates(readings, 'pose_timestamp');
  const joints = summarizePositionCaptureSensorUpdates(readings, 'joint_timestamp');

  return {
    target_rate_hz: targetHz,
    requested_interval_ms: Number((1000 / targetHz).toFixed(3)),
    requested_duration_ms: RATE_SWEEP_PHASE_SECONDS * 1000,
    poll_count: readings.length,
    achieved_poll_rate_hz: phaseSpanMs > 0
      ? Number(((readings.length - 1) * 1000 / phaseSpanMs).toFixed(2))
      : 0,
    pose,
    joints,
    measurable: pose.distinct_samples >= 2 && joints.distinct_samples >= 2,
    max_pose_displacement_m: Number(maxPoseDisplacementM.toFixed(5)),
    max_joint_change_rad: Number(maxJointChangeRad.toFixed(5)),
    motion_observed: maxPoseDisplacementM > 0.001 || maxJointChangeRad > 0.001,
  };
}

export default function TeacherPositionRecorder({
  connection,
  controllerVersion,
  onBusyChange,
  onPreview,
  selectedRecordingId = null,
  blockedByOtherMotion,
}) {
  const [recordings, setRecordings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [readinessMessage, setReadinessMessage] = useState('Checking robot and full-body sensor feedback…');
  const [name, setName] = useState('');
  const [code, setCode] = useState(() => defaultCommand(controllerVersion));
  const [confirmClearArea, setConfirmClearArea] = useState(false);
  const [useLocomotionSeries, setUseLocomotionSeries] = useState(false);
  const [selectedCalibrationBatchIndex, setSelectedCalibrationBatchIndex] = useState(0);
  const [isStarting, setIsStarting] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isMeasuringRates, setIsMeasuringRates] = useState(false);
  const [selectedSectionProgress, setSelectedSectionProgress] = useState(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filePreview, setFilePreview] = useState(null);
  const [rateDiagnostic, setRateDiagnostic] = useState(null);
  const startingRef = useRef(false);
  const seriesAnchorRef = useRef(null);
  const seriesSectionsRef = useRef([]);
  const activeSeriesSectionRef = useRef(null);
  const stopAttemptedRef = useRef(false);
  const stopFailureRef = useRef(null);

  useEffect(() => {
    setCode(defaultCommand(controllerVersion));
    setConfirmClearArea(false);
    setUseLocomotionSeries(false);
  }, [controllerVersion]);

  useEffect(() => {
    onBusyChange(isStarting || isCapturing || isStopping || isMeasuringRates);
    return () => onBusyChange(false);
  }, [isStarting, isCapturing, isStopping, isMeasuringRates, onBusyChange]);

  useEffect(() => {
    let active = true;
    connection.recordings()
      .then((response) => {
        if (active) {
          setRecordings([...response.recordings].sort(
            (left, right) => left.name.localeCompare(right.name),
          ));
        }
      })
      .catch((requestError) => {
        if (active) setError(`Recorded captures could not be loaded: ${requestError.message}`);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connection]);

  useEffect(() => {
    if (isCapturing || isMeasuringRates) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const [status, poseSnapshot, jointSample] = await Promise.all([
          connection.status(),
          connection.pose(),
          connection.jointState(),
        ]);
        if (!active) return;
        const pose = selectPositionCapturePose(poseSnapshot);
        const controllerIdle = controllerVersion === 'duet'
          ? isDuetIdle(status)
          : isLegacyIdle(status);
        const jointFeedbackReady = hasCompleteG1JointSample(jointSample);
        setIsReady(controllerIdle && jointFeedbackReady && !blockedByOtherMotion);
        setReadinessMessage(blockedByOtherMotion
          ? 'Another robot operation is active; finish it before starting a capture.'
          : !controllerIdle
          ? controllerVersion === 'duet'
            ? 'Connect an idle DUET v2 controller with fresh arm feedback before starting a capture.'
            : 'Connect an idle legacy SDK robot before starting a capture.'
          : !jointFeedbackReady
            ? 'Fresh, complete 23-joint ROS telemetry is unavailable.'
            : `Ready to capture ${pose.frame_id} → ${pose.base_frame} ${pose.source} pose and all 23 measured joints.`);
      } catch (requestError) {
        if (!active) return;
        setIsReady(false);
        setReadinessMessage(`Position capture unavailable: ${requestError.message}`);
      }
    };
    refresh();
    const timer = window.setInterval(() => {
      if (!isCapturing && !isMeasuringRates) refresh();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection, controllerVersion, isCapturing, isMeasuringRates, blockedByOtherMotion]);

  const handleMeasureSensorRates = async () => {
    if (isStarting || isCapturing || isStopping || isMeasuringRates) return;
    setError('');
    setMessage('');
    setRateDiagnostic(null);
    if (!confirmClearArea) {
      setError('Confirm the robot workspace is clear and that you will supervise the physical movement.');
      return;
    }
    if (blockedByOtherMotion) {
      setError('Finish the active robot operation before starting the rate sweep.');
      return;
    }

    setIsMeasuringRates(true);
    try {
      const sweepCommand = rateSweepCommand(controllerVersion);
      const captureProgram = controllerVersion === 'duet'
        ? validateDuetPositionCapture('G1 sensor-rate sweep', sweepCommand)
        : validateLegacyPositionCapture('G1 sensor-rate sweep', sweepCommand);
      const initialStatus = await connection.status();
      const idle = controllerVersion === 'duet'
        ? isDuetIdle(initialStatus)
        : isLegacyIdle(initialStatus);
      if (!idle) {
        throw new Error('Connect the selected controller and stop all active motion before starting a rate sweep.');
      }
      if (
        !hasLocomotionCapability(initialStatus, controllerVersion)
        || !captureProgram.usesLocomotion
      ) {
        throw new Error('The selected controller must be ready for locomotion before starting a rate sweep.');
      }

      const startedAt = performance.now();
      const startedAtIso = new Date().toISOString();
      const phaseReadings = RATE_SWEEP_TARGETS_HZ.map(() => []);
      const phaseAttemptCounts = RATE_SWEEP_TARGETS_HZ.map(() => 0);
      const readings = [];
      const runResults = [];
      let frameId = null;
      let baseFrame = null;
      let sweepError = null;
      let stopError = null;
      let timeoutReached = false;

      setConfirmClearArea(false);
      setMessage(`Rate sweep started: each of the ${RATE_SWEEP_TARGETS_HZ.length} rates gets its own bounded movement cycle, with one retry if readings are insufficient.`);
      for (let phaseIndex = 0; phaseIndex < RATE_SWEEP_TARGETS_HZ.length; phaseIndex += 1) {
        const targetHz = RATE_SWEEP_TARGETS_HZ[phaseIndex];
        setMessage(`Rate sweep ${phaseIndex + 1}/${RATE_SWEEP_TARGETS_HZ.length}: testing ${targetHz} Hz.`);
        let phaseMeasurable = false;

        for (let attemptIndex = 0; attemptIndex < RATE_SWEEP_MAX_ATTEMPTS; attemptIndex += 1) {
          if (performance.now() - startedAt >= RATE_SWEEP_TIMEOUT_SECONDS * 1000) {
            timeoutReached = true;
            break;
          }
          phaseAttemptCounts[phaseIndex] += 1;
          const attemptStartedAt = performance.now();
          const attemptReadings = [];
          let runSettled = false;
          let runResult = null;
          let runError = null;
          let attemptError = null;
          let phaseTimeoutReached = false;
          let nextRequestAt = attemptStartedAt;
          const runPromise = connection.run(captureProgram.code).then(
            (result) => {
              runResult = result;
            },
            (error) => {
              runError = error;
            },
          ).finally(() => {
            runSettled = true;
          });

          while (true) {
            const now = performance.now();
            const elapsed = now - attemptStartedAt;
            if (performance.now() - startedAt >= RATE_SWEEP_TIMEOUT_SECONDS * 1000) {
              timeoutReached = true;
              break;
            }
            if (elapsed >= RATE_SWEEP_PHASE_MAX_SECONDS * 1000) {
              phaseTimeoutReached = true;
              break;
            }
            const minimumWindowElapsed = elapsed >= RATE_SWEEP_PHASE_SECONDS * 1000;
            phaseMeasurable = summarizePositionCaptureSensorUpdates(
              attemptReadings,
              'pose_timestamp',
            ).distinct_samples >= 2 && summarizePositionCaptureSensorUpdates(
              attemptReadings,
              'joint_timestamp',
            ).distinct_samples >= 2;
            if (runSettled && minimumWindowElapsed && phaseMeasurable) break;

            await wait(Math.max(0, nextRequestAt - performance.now()));
            if (
              performance.now() - startedAt >= RATE_SWEEP_TIMEOUT_SECONDS * 1000
              || performance.now() - attemptStartedAt >= RATE_SWEEP_PHASE_MAX_SECONDS * 1000
            ) {
              if (performance.now() - attemptStartedAt >= RATE_SWEEP_PHASE_MAX_SECONDS * 1000) {
                phaseTimeoutReached = true;
              }
              continue;
            }
            const requestStartedAt = performance.now();
            try {
              const [poseSnapshot, jointSample] = await Promise.all([
                connection.pose(),
                connection.jointState(),
              ]);
              const observedAt = performance.now();
              const pose = selectPositionCapturePose(poseSnapshot, frameId);
              if (frameId === null) {
                frameId = pose.frame_id;
                baseFrame = pose.base_frame;
              }
              if (pose.base_frame !== baseFrame) {
                throw new Error('The TF base frame changed during the rate sweep.');
              }
              if (!hasCompleteG1JointSample(jointSample)) {
                throw new Error('Fresh, complete 23-joint ROS telemetry is unavailable.');
              }
              if (
                typeof jointSample.received_at !== 'string'
                || !Number.isFinite(new Date(jointSample.received_at).getTime())
              ) {
                throw new Error('The ROS joint-state sample has no valid source timestamp.');
              }
              const reading = {
                phase_index: phaseIndex,
                attempt_index: attemptIndex,
                target_rate_hz: targetHz,
                elapsed_ms: Number((observedAt - startedAt).toFixed(3)),
                request_duration_ms: Number((observedAt - requestStartedAt).toFixed(3)),
                pose_timestamp: pose.timestamp,
                pose_frame_id: pose.frame_id,
                pose_age_ms: pose.age_ms,
                pose_x: pose.x,
                pose_y: pose.y,
                pose_z: pose.z,
                pose_yaw_rad: pose.yaw_rad,
                joint_timestamp: jointSample.received_at,
                joint_age_ms: jointSample.age_ms,
                joint_positions_rad: [...jointSample.positions_rad],
              };
              readings.push(reading);
              attemptReadings.push(reading);
              nextRequestAt = requestStartedAt + 1000 / targetHz;
            } catch (sampleError) {
              attemptError = sampleError;
              break;
            }
          }

          phaseReadings[phaseIndex] = attemptReadings;
          const attemptSummary = summarizePositionCaptureSensorUpdates(
            attemptReadings,
            'pose_timestamp',
          );
          phaseMeasurable = attemptSummary.distinct_samples >= 2
            && summarizePositionCaptureSensorUpdates(
              attemptReadings,
              'joint_timestamp',
            ).distinct_samples >= 2;

          if (!runSettled && (attemptError || timeoutReached || phaseTimeoutReached || runError)) {
            setIsStopping(true);
            setMessage(attemptError
              ? 'Sensor feedback failed; requesting a robot stop and preserving the partial rate report.'
              : phaseTimeoutReached
                ? 'A rate phase exceeded its 8-second safeguard; requesting a robot stop.'
                : 'Rate sweep exceeded its 120-second safeguard; requesting a robot stop.');
            try {
              await connection.stop();
            } catch (requestError) {
              stopError = requestError;
            } finally {
              setIsStopping(false);
            }
          }
          await runPromise;
          if (runError) {
            sweepError = runError.message;
            break;
          }
          runResults.push(runResult);
          if (runResult?.status !== 'completed') {
            sweepError = `Robot movement ended with status ${runResult?.status || 'unknown'}.`;
            break;
          }
          if (phaseMeasurable || timeoutReached || stopError) break;
          if (attemptError && attemptIndex === RATE_SWEEP_MAX_ATTEMPTS - 1) {
            sweepError = attemptError.message;
          }
        }

        if (sweepError || timeoutReached || stopError) break;
      }

      const elapsedMs = performance.now() - startedAt;
      const phases = RATE_SWEEP_TARGETS_HZ.map((targetHz, index) => ({
        ...summarizeRateSweepPhase(phaseReadings[index], targetHz),
        attempts: phaseAttemptCounts[index],
        movement: 'forward 1 s, then backward 1 s',
      }));
      const safetyInterventions = runResults.flatMap((result) => result?.safetyInterventions || []);
      const complete = !sweepError
        && !timeoutReached
        && !stopError
        && phaseAttemptCounts.every((attemptCount) => attemptCount > 0)
        && safetyInterventions.length === 0
        && phases.every((phase) => phase.measurable);
      const failure = sweepError
        || (safetyInterventions.length
          ? 'A safety intervention changed the commanded movement.'
          : null)
        || (stopError ? `Robot stop request failed: ${stopError.message}` : null)
        || (timeoutReached ? 'The 120-second sweep safeguard was reached.' : null)
        || (phases.some((phase) => !phase.measurable)
          ? 'One or more rates did not produce two distinct pose and joint samples after retrying.'
          : null);
      const report = {
        format: 'uni-edu-studio/g1-sensor-rate-sweep',
        version: 1,
        started_at: startedAtIso,
        controller_version: controllerVersion,
        commanded_motion: true,
        movement_program: captureProgram.code,
        movement_cycle_count: runResults.length,
        movement_cycle_duration_s: 2,
        physical_movement_verified: false,
        elapsed_ms: Number(elapsedMs.toFixed(3)),
        successful_reads: readings.length,
        joint_names: G1_MODEL_INFO.joints,
        run_status: complete ? 'completed' : runResults.at(-1)?.status || 'incomplete',
        safety_interventions: safetyInterventions,
        status: complete ? 'complete' : 'incomplete',
        failure,
        candidate_rates_hz: RATE_SWEEP_TARGETS_HZ,
        phases,
        readings,
      };
      setRateDiagnostic(report);
      if (failure) {
        setError(`Rate sweep incomplete: ${failure}`);
      } else if (!complete) {
        setError('Rate sweep returned incomplete results; inspect the exported phase data.');
      }
      setMessage(complete
        ? 'Rate sweep complete. Export the JSON report and share it to choose a default rate.'
        : 'Rate sweep ended early. Export the partial JSON report to inspect its results.');
    } catch (sweepError) {
      setError(`Sensor-rate sweep could not start: ${sweepError.message}`);
    } finally {
      setIsMeasuringRates(false);
    }
  };

  const handleRunAndCapture = async (event) => {
    event.preventDefault();
    if (startingRef.current || isCapturing || isStopping || isMeasuringRates) return;
    setError('');
    setMessage('');
    setSampleCount(0);
    setSelectedSectionProgress(null);
    seriesAnchorRef.current = null;
    seriesSectionsRef.current = [];
    activeSeriesSectionRef.current = null;
    stopAttemptedRef.current = false;
    stopFailureRef.current = null;
    if (!confirmClearArea) {
      setError('Confirm the 10 m × 10 m work area is clear, the robot starts near its center, and you will supervise the physical movement.');
      return;
    }
    if (blockedByOtherMotion) {
      setError('Finish the active robot operation before starting a position capture.');
      return;
    }

    startingRef.current = true;
    setIsStarting(true);
    let captureProgram;
    let captureBatches = null;
    let initialStatus;
    let initialPose;
    let firstJointSample;
    try {
      if (useLocomotionSeries) {
        if (controllerVersion !== 'legacy') {
          throw new Error('The selected section is available only through the validated Legacy SDK command mappings.');
        }
        const batch = buildG1LocomotionCalibrationSeries().batches[selectedCalibrationBatchIndex];
        captureBatches = [{
          ...validateLegacyPositionCapture(name, batch.code),
          label: batch.label,
          phase: batch.phase,
          code: batch.code,
          index: selectedCalibrationBatchIndex,
        }];
        captureProgram = {
          name: captureBatches[0].name,
          code: captureBatches[0].code,
          usesLocomotion: true,
        };
      } else {
        captureProgram = controllerVersion === 'duet'
          ? validateDuetPositionCapture(name, code)
          : validateLegacyPositionCapture(name, code);
      }
      initialStatus = await connection.status();
      const idle = controllerVersion === 'duet'
        ? isDuetIdle(initialStatus)
        : isLegacyIdle(initialStatus);
      if (!idle) {
        throw new Error('Connect the selected controller and stop all active motion before starting a capture.');
      }
      if (
        captureProgram.usesLocomotion
        && !hasLocomotionCapability(initialStatus, controllerVersion)
      ) {
        throw new Error('The selected controller does not report locomotion capability for this command sequence.');
      }
      const [poseSnapshot, jointSample] = await Promise.all([
        connection.pose(),
        readJointSample(connection),
      ]);
      initialPose = selectPositionCapturePose(poseSnapshot);
      firstJointSample = jointSample;
      if (useLocomotionSeries) seriesAnchorRef.current = initialPose;
    } catch (startError) {
      setError(`Position capture could not start: ${startError.message}`);
      startingRef.current = false;
      setIsStarting(false);
      return;
    }

    const startedAt = performance.now();
    const captureDurationLimitSeconds = useLocomotionSeries
      ? MAX_LOCOMOTION_SERIES_SECONDS
      : MAX_CAPTURE_SECONDS;
    const capturedAt = new Date().toISOString();
    const getRecordingCommand = () => {
      if (!useLocomotionSeries) return captureProgram.code;
      return `${captureProgram.code}\n\n# Calibration section: ${captureBatches[0].label}`;
    };
    const frames = useLocomotionSeries
      ? []
      : [makePoseAndJointFrame({
        time: 0,
        pose: initialPose,
        positions: firstJointSample.positions,
      })];
    let totalSampleCount = frames.length;
    setSampleCount(totalSampleCount);
    setConfirmClearArea(false);
    startingRef.current = false;
    setIsStarting(false);
    setIsCapturing(true);
    setSelectedSectionProgress(useLocomotionSeries
      ? { current: selectedCalibrationBatchIndex + 1, total: buildG1LocomotionCalibrationSeries().batches.length }
      : null);
    setMessage(useLocomotionSeries
      ? `Starting selected calibration section: ${captureBatches[0].label}.`
      : `Running the approved ${controllerVersion === 'duet' ? 'DUET' : 'legacy SDK'} sequence while recording pose and all 23 joints.`);

    let runSettled = false;
    let samplingError = null;
    let captureLimitReached = false;
    let stopError = null;
    let nextSampleAt = startedAt + SAMPLE_INTERVAL_MS;
    const prepareCaptureSection = async (batch) => {
      setMessage(`Preparing selected calibration section: ${batch.label}.`);
      let section = seriesSectionsRef.current[batch.index];
      const [poseSnapshot, jointSample] = await Promise.all([
        withTimeout(connection.pose(), CALIBRATION_SENSOR_TIMEOUT_MS, 'Pose telemetry'),
        withTimeout(readJointSample(connection), CALIBRATION_SENSOR_TIMEOUT_MS, 'Joint telemetry'),
      ]);
      const pose = selectPositionCapturePose(poseSnapshot, initialPose.frame_id);
      if (pose.base_frame !== initialPose.base_frame) {
        throw new Error('The TF base frame changed before a calibration section.');
      }
      if (
        jointSample.jointNames.length !== firstJointSample.jointNames.length
        || jointSample.jointNames.some((joint, jointIndex) => joint !== firstJointSample.jointNames[jointIndex])
      ) {
        throw new Error('The measured joint layout changed before a calibration section.');
      }
      if (!section) {
        section = {
          batch,
          capturedAt: new Date().toISOString(),
          frames: [],
          saved: false,
        };
        seriesSectionsRef.current[batch.index] = section;
      }
      activeSeriesSectionRef.current = section;
      section.runTimeOffset = section.frames.length
        ? section.frames.at(-1).time + 0.001
        : 0;
      section.runStartedAt = performance.now();
      nextSampleAt = section.runStartedAt + SAMPLE_INTERVAL_MS;
      section.frames.push(makePoseAndJointFrame({
        time: Number(section.runTimeOffset.toFixed(3)),
        pose,
        positions: jointSample.positions,
      }));
      totalSampleCount += 1;
      setSampleCount(totalSampleCount);
    };
    const executeCaptureProgram = async () => {
      if (!captureBatches) return connection.run(captureProgram.code);
      const batch = captureBatches[0];
      await prepareCaptureSection(batch);
      return connection.run(batch.code);
    };
    const addSample = (pose, jointSample) => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const activeSection = activeSeriesSectionRef.current;
      const sectionLimitReached = useLocomotionSeries && (
        !activeSection
        || activeSection.frames.length >= MAX_CAPTURE_SAMPLES
        || getG1CalibrationSectionElapsedSeconds(activeSection, performance.now())
          > captureDurationLimitSeconds
      );
      if (
        sectionLimitReached
        || (!useLocomotionSeries && elapsed > captureDurationLimitSeconds)
        || (!useLocomotionSeries && frames.length >= MAX_CAPTURE_SAMPLES)
      ) {
        captureLimitReached = true;
        return false;
      }
      if (useLocomotionSeries) {
        const section = activeSeriesSectionRef.current;
        const sectionTime = Math.max(
          getG1CalibrationSectionElapsedSeconds(section, performance.now()),
          section.frames.at(-1).time + 0.001,
        );
        section.frames.push(makePoseAndJointFrame({
          time: Number(sectionTime.toFixed(3)),
          pose,
          positions: jointSample.positions,
        }));
      } else {
        const time = Math.max(
          Number(elapsed.toFixed(3)),
          frames.at(-1).time + 0.001,
        );
        frames.push(makePoseAndJointFrame({
          time,
          pose,
          positions: jointSample.positions,
        }));
      }
      totalSampleCount += 1;
      setSampleCount(totalSampleCount);
      if (!useLocomotionSeries && frames.length >= MAX_CAPTURE_SAMPLES) {
        captureLimitReached = true;
        return false;
      }
      return true;
    };
    const saveActiveSeriesSection = async ({ partial = false, reason = '' } = {}) => {
      const section = activeSeriesSectionRef.current;
      if (!section || section.saved) return null;
      if (section.frames.length < 2) {
        const [poseSnapshot, jointSample] = await Promise.all([
          withTimeout(connection.pose(), CALIBRATION_SENSOR_TIMEOUT_MS, 'Pose telemetry'),
          withTimeout(readJointSample(connection), CALIBRATION_SENSOR_TIMEOUT_MS, 'Joint telemetry'),
        ]);
        const pose = selectPositionCapturePose(poseSnapshot, initialPose.frame_id);
        if (pose.base_frame !== initialPose.base_frame) {
          throw new Error('The TF base frame changed while saving a calibration section.');
        }
        const sectionTime = Math.max(
          section.runElapsedAtPause
            ?? getG1CalibrationSectionElapsedSeconds(section, performance.now()),
          section.frames.at(-1)?.time + 0.001 || 0.001,
        );
        section.frames.push(makePoseAndJointFrame({
          time: Number(sectionTime.toFixed(3)),
          pose,
          positions: jointSample.positions,
        }));
      }
      const sectionIndex = section.batch.index + 1;
      const sectionNameSuffix = ` - ${String(sectionIndex).padStart(2, '0')} ${section.batch.phase === 'isolated' ? 'Isolated' : 'Progression'}`;
      const sectionName = `${captureProgram.name.slice(0, 40 - sectionNameSuffix.length)}${sectionNameSuffix}`;
      const partialSectionSuffix = ` - ${String(sectionIndex).padStart(2, '0')}${section.batch.phase === 'isolated' ? 'I' : 'P'}`;
      const savedName = partial
        ? partialRecordingName(captureProgram.name, recordings, new Date().toISOString(), partialSectionSuffix)
        : uniqueRecordingName(sectionName, recordings);
      const command = `${section.batch.code}\n\n# Calibration section: ${section.batch.label}`;
      const saved = await connection.saveRecording({
        name: savedName,
        controller_version: controllerVersion,
        capture_type: 'position_calibration',
        command: partial ? `${command}\n\n# Partial recording: ${reason}` : command,
        joint_names: firstJointSample.jointNames,
        captured_at: section.capturedAt,
        frames: section.frames,
      });
      section.saved = true;
      setRecordings((current) => [...current, saved.recording].sort(
        (left, right) => left.name.localeCompare(right.name),
      ));
      try {
        downloadG1MotionRecording(saved.recording, captureFilename(saved.recording.name));
      } catch (exportError) {
        setError(`Section saved, but its JSON download failed: ${exportError.message}`);
      }
      return saved.recording;
    };
    const savePartialCapture = async (reason) => {
      if (useLocomotionSeries) {
        const saved = await saveActiveSeriesSection({ partial: true, reason });
        if (!saved) {
          throw new Error(`${reason} There were too few measured samples to save a partial recording.`);
        }
        const stopFailure = stopError || stopFailureRef.current;
        setError(`Calibration stopped early: ${reason}${stopFailure ? ` Stop request also failed: ${stopFailure.message}` : ''}`);
        setMessage(`Partial calibration section saved as "${saved.name}" with ${saved.frames.length} pose and joint samples.`);
        return;
      }
      if (frames.length < 2) {
        throw new Error(`${reason} There were too few measured samples to save a partial recording.`);
      }
      const partialTimestamp = new Date().toISOString();
      const partialName = partialRecordingName(captureProgram.name, recordings, partialTimestamp);
      const saved = await connection.saveRecording({
        name: partialName,
        controller_version: controllerVersion,
        capture_type: 'position_calibration',
        command: getRecordingCommand(),
        joint_names: firstJointSample.jointNames,
        captured_at: capturedAt,
        frames,
      });
      setRecordings((current) => [...current, saved.recording].sort(
        (left, right) => left.name.localeCompare(right.name),
      ));
      const stopFailure = stopError || stopFailureRef.current;
      setError(`Calibration stopped early: ${reason}${stopFailure ? ` Stop request also failed: ${stopFailure.message}` : ''}`);
      setMessage(`Partial calibration saved as "${partialName}" with ${frames.length} pose and joint samples. Review or export it in Saved robot recordings.`);
    };
    const runPromise = executeCaptureProgram().then(
      (result) => ({ result }),
      (runError) => ({ runError }),
    ).finally(() => {
      runSettled = true;
    });

    try {
      while (!runSettled) {
        if (
          useLocomotionSeries
          && !activeSeriesSectionRef.current
        ) {
          await wait(SAMPLE_INTERVAL_MS);
          continue;
        }
        const activeSection = activeSeriesSectionRef.current;
        const elapsedSeconds = useLocomotionSeries
          ? getG1CalibrationSectionElapsedSeconds(activeSection, performance.now())
          : (performance.now() - startedAt) / 1000;
        const remainingMs = (captureDurationLimitSeconds - elapsedSeconds) * 1000;
        const sampleLimitReached = useLocomotionSeries
          ? activeSection.frames.length >= MAX_CAPTURE_SAMPLES
          : frames.length >= MAX_CAPTURE_SAMPLES;
        if (remainingMs <= 0 || sampleLimitReached) {
          captureLimitReached = true;
          break;
        }
        await wait(Math.min(Math.max(0, nextSampleAt - performance.now()), remainingMs));
        if (runSettled) break;
        if (
          useLocomotionSeries
          && !activeSeriesSectionRef.current
        ) {
          continue;
        }
        nextSampleAt += SAMPLE_INTERVAL_MS;
        try {
          const poseRequest = connection.pose();
          const jointRequest = readJointSample(connection);
          const [poseSnapshot, jointSample] = useLocomotionSeries
            ? await Promise.all([
              withTimeout(poseRequest, CALIBRATION_SENSOR_TIMEOUT_MS, 'Pose telemetry'),
              withTimeout(jointRequest, CALIBRATION_SENSOR_TIMEOUT_MS, 'Joint telemetry'),
            ])
            : await Promise.all([poseRequest, jointRequest]);
          const pose = selectPositionCapturePose(poseSnapshot, initialPose.frame_id);
          if (pose.base_frame !== initialPose.base_frame) {
            throw new Error('The TF base frame changed during capture; no recording was saved.');
          }
          if (useLocomotionSeries) {
            const distance = distanceFromCalibrationAnchor(seriesAnchorRef.current, pose);
            if (distance >= G1_CALIBRATION_STOP_RADIUS_METERS) {
              throw new Error(
                `Odometry reached the ${G1_CALIBRATION_STOP_RADIUS_METERS} m local stop radius; the calibration section was halted.`,
              );
            }
          }
          if (
            jointSample.jointNames.length !== firstJointSample.jointNames.length
            || jointSample.jointNames.some((joint, index) => joint !== firstJointSample.jointNames[index])
          ) {
            throw new Error('The measured joint layout changed during capture; no recording was saved.');
          }
          if (!addSample(pose, jointSample)) break;
        } catch (sampleError) {
          samplingError = sampleError;
          break;
        }
        nextSampleAt = scheduleNextPositionCaptureSample(
          nextSampleAt,
          performance.now(),
          SAMPLE_INTERVAL_MS,
        );
      }

      if (!runSettled && (samplingError || captureLimitReached)) {
        setIsStopping(true);
        setMessage(samplingError
          ? 'Sensor feedback or the odometry boundary check failed; stopping and preserving partial calibration data.'
          : `${captureDurationLimitSeconds / 60}-minute capture safeguard reached; stopping and preserving partial calibration data.`);
        try {
          stopAttemptedRef.current = true;
          await (useLocomotionSeries
            ? withTimeout(connection.stop(), CALIBRATION_STOP_TIMEOUT_MS, 'Robot stop request')
            : connection.stop());
        } catch (requestError) {
          stopError = requestError;
        } finally {
          setIsStopping(false);
        }
      }

      const { result, runError } = await runPromise;
      if (useLocomotionSeries && runError && !stopAttemptedRef.current) {
        try {
          stopAttemptedRef.current = true;
          await withTimeout(connection.stop(), CALIBRATION_STOP_TIMEOUT_MS, 'Robot stop request');
        } catch (requestError) {
          stopError = requestError;
        }
      }
      if (
        !useLocomotionSeries
        && (performance.now() - startedAt) / 1000 > captureDurationLimitSeconds
      ) {
        captureLimitReached = true;
      }
      const partialReason = samplingError?.message
        || runError?.message
        || (result?.status === 'stopped' ? 'Stopped by the operator.' : '')
        || (captureLimitReached ? `The ${captureDurationLimitSeconds / 60}-minute capture limit was reached.` : '');
      if (useLocomotionSeries && partialReason) {
        try {
          await savePartialCapture(partialReason);
        } catch (saveError) {
          throw new Error(`${partialReason} The partial section could not be saved: ${saveError.message}`);
        }
        return;
      }
      if (runError) throw runError;
      if (samplingError) {
        throw new Error(
          stopError
            ? `${samplingError.message} The robot stop request also failed: ${stopError.message}`
            : samplingError.message,
        );
      }
      if (stopError) {
        throw new Error(`The robot stop request failed: ${stopError.message}`);
      }
      if (!['completed', 'stopped'].includes(result.status)) {
        throw new Error(`Robot command ended with status ${result.status || 'unknown'}; no recording was saved.`);
      }

      const elapsed = (performance.now() - startedAt) / 1000;
      if (!useLocomotionSeries && !captureLimitReached && elapsed <= captureDurationLimitSeconds) {
        try {
          const [poseSnapshot, finalJointSample] = await Promise.all([
            connection.pose(),
            readJointSample(connection),
          ]);
          const finalPose = selectPositionCapturePose(poseSnapshot, initialPose.frame_id);
          if (finalPose.base_frame !== initialPose.base_frame) {
            throw new Error('The TF base frame changed during capture.');
          }
          if (useLocomotionSeries) {
            const distance = distanceFromCalibrationAnchor(seriesAnchorRef.current, finalPose);
            if (distance >= G1_CALIBRATION_STOP_RADIUS_METERS) {
              throw new Error(
                `Final odometry reached the ${G1_CALIBRATION_STOP_RADIUS_METERS} m local stop radius.`,
              );
            }
          }
          if (
            finalJointSample.jointNames.length !== firstJointSample.jointNames.length
            || finalJointSample.jointNames.some(
              (joint, index) => joint !== firstJointSample.jointNames[index],
            )
          ) {
            throw new Error('The measured joint layout changed during capture.');
          }
          addSample(finalPose, finalJointSample);
        } catch (finalSampleError) {
          if (useLocomotionSeries) {
            await savePartialCapture(finalSampleError.message);
            return;
          }
          throw finalSampleError;
        }
      }
      if (useLocomotionSeries) {
        const saved = await saveActiveSeriesSection();
        setMessage(`Calibration section saved as "${saved.name}" with ${saved.frames.length} measured samples.`);
        return;
      }
      if (frames.length < 2) {
        throw new Error('The command was too short to produce at least two measured samples.');
      }

      const saved = await connection.saveRecording({
        name: captureProgram.name,
        controller_version: controllerVersion,
        capture_type: 'position_calibration',
        command: getRecordingCommand(),
        joint_names: firstJointSample.jointNames,
        captured_at: capturedAt,
        frames,
      });
      setRecordings((current) => [...current, saved.recording].sort(
        (left, right) => left.name.localeCompare(right.name),
      ));
      setName('');
      setMessage(
        `Saved ${frames.length} pose and joint samples${result.status === 'stopped' ? ' from the stopped movement' : ''}${captureLimitReached ? ` (${captureDurationLimitSeconds / 60}-minute safety limit reached)` : ''}.`,
      );
    } catch (captureError) {
      setError(`Position capture failed: ${captureError.message}`);
    } finally {
      setIsCapturing(false);
      setIsStopping(false);
    }
  };

  const handleStopRobot = async () => {
    setIsStopping(true);
    setError('');
    try {
      stopAttemptedRef.current = true;
      const result = await (useLocomotionSeries
        ? withTimeout(connection.stop(), CALIBRATION_STOP_TIMEOUT_MS, 'Robot stop request')
        : connection.stop());
      setMessage(result.physicalStopVerified === false
        ? 'Stop was sent; the controller does not independently verify physical immobility.'
        : isMeasuringRates
          ? 'Robot stop was acknowledged; the sweep will preserve the partial rate report.'
          : useLocomotionSeries
            ? 'Stop was sent to the active section; partial pose and joint data will be preserved.'
            : 'Robot stop was acknowledged by the controller. Recording continues until the command ends.');
    } catch (requestError) {
      if (useLocomotionSeries) stopFailureRef.current = requestError;
      setError(`Robot stop failed: ${requestError.message}`);
    } finally {
      setIsStopping(false);
    }
  };

  const handleDelete = async (recording) => {
    setError('');
    try {
      await connection.deleteRecording(recording.id);
      setRecordings((current) => current.filter((entry) => entry.id !== recording.id));
      setMessage(`Deleted "${recording.name}".`);
    } catch (deleteError) {
      setError(`Recording could not be deleted: ${deleteError.message}`);
    }
  };

  const handleExportRecording = (recording) => {
    setError('');
    try {
      downloadG1MotionRecording(recording, captureFilename(recording.name));
    } catch (exportError) {
      setError(`Recording export failed: ${exportError.message}`);
    }
  };

  const handleExportAll = () => {
    setError('');
    try {
      downloadG1MotionRecordings(recordings);
    } catch (exportError) {
      setError(`Recording export failed: ${exportError.message}`);
    }
  };

  const handlePreviewRecordingFile = (recording) => {
    setError('');
    try {
      setFilePreview({
        title: `${captureFilename(recording.name)}`,
        content: JSON.stringify(buildG1MotionRecordingExport(recording), null, 2),
      });
    } catch (previewError) {
      setError(`Recording file preview failed: ${previewError.message}`);
    }
  };

  const handlePreviewAllFiles = () => {
    setError('');
    try {
      setFilePreview({
        title: 'g1-recorded-motions.json',
        content: JSON.stringify(buildG1MotionRecordingsExport(recordings), null, 2),
      });
    } catch (previewError) {
      setError(`Recording file preview failed: ${previewError.message}`);
    }
  };

  const controllerLabel = controllerVersion === 'duet' ? 'DUET v2' : 'legacy SDK';
  return (
    <section className="rounded-xl border border-cyan-300 bg-cyan-50 p-4">
      <h3 className="text-sm font-semibold text-cyan-950">Record movement for calibration</h3>
      <p className="mt-1 text-xs leading-5 text-cyan-900">
        Runs a validated command sequence on the selected {controllerLabel} while recording Humble TF/odometry pose and all 23 measured G1 joint positions.
        Use short, supervised walking, turning, and arm commands to measure the actual path and joint response.
      </p>
      <p role="status" aria-live="polite" className="mt-2 text-xs font-medium text-slate-700">
        {readinessMessage}
      </p>
      {error && <p role="alert" className="mt-2 text-xs font-semibold text-red-700">{error}</p>}
      <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
        <input
          type="checkbox"
          aria-label="Confirm robot workspace is clear"
          checked={confirmClearArea}
          onChange={(event) => setConfirmClearArea(event.target.checked)}
          disabled={isStarting || isCapturing || isStopping || isMeasuringRates}
          className="mt-1 h-4 w-4 shrink-0 accent-amber-700"
        />
        <span>
          I have cleared a 10 m × 10 m work area, placed the robot near its center, will supervise the physical movement, and have the emergency stop accessible.
          Odometry will stop each section at a conservative 3 m radius from its starting pose, but odometry alone cannot guarantee a hard workspace boundary.
          The robot moves only after I explicitly select a run button.
        </span>
      </label>
      <label className={`mt-3 flex items-start gap-2 rounded-lg border p-3 text-xs leading-5 ${
        controllerVersion === 'legacy' ? 'border-cyan-200 bg-white text-slate-800' : 'border-slate-200 bg-slate-100 text-slate-500'
      }`}>
        <input
          type="checkbox"
          aria-label="Enable independent locomotion calibration sections"
          checked={useLocomotionSeries}
          onChange={(event) => setUseLocomotionSeries(event.target.checked)}
          disabled={controllerVersion !== 'legacy' || isStarting || isCapturing || isStopping || isMeasuringRates}
          className="mt-1 h-4 w-4 shrink-0 accent-cyan-800"
        />
        <span>
          <strong>Enable independent Legacy SDK locomotion calibration sections.</strong>
          {' '}The 14 sections cover 37 isolated trials and nine progression groups (110 commands total). Select and run one section at a time; it records and saves only that section. No automatic progression or continue step is involved.
          {controllerVersion !== 'legacy' && ' This uses existing step-based SDK mappings and is unavailable for DUET.'}
        </span>
      </label>
      {useLocomotionSeries && (
        <div className="mt-2 rounded-lg border border-cyan-200 bg-white p-3 text-[11px] leading-4 text-slate-600">
          <p>
            Each run has its own 3 m radial odometry cutoff from the starting pose. Localization error, drift, robot footprint, obstacles, and braking distance are not covered; supervise and keep the physical emergency stop accessible.
          </p>
          <p className="mt-1">
            Only the selected section runs and starts measuring from the robot's current pose. No return-to-start distance is required; confirm the workspace is safe before each run.
          </p>
          {selectedSectionProgress && isCapturing && (
            <p className="mt-1 font-semibold text-cyan-900">
              Section {selectedSectionProgress.current}/{selectedSectionProgress.total} in progress
            </p>
          )}
        </div>
      )}
      <div className="mt-3 rounded-lg border border-cyan-200 bg-white p-3">
        <h4 className="text-xs font-semibold text-slate-800">Temporary sensor-rate sweep</h4>
        <p className="mt-1 text-[11px] leading-4 text-slate-600">
          Tests 10–200 Hz in separate one-second forward/backward movement cycles, retrying a rate once if readings are insufficient.
          It normally takes about 20 seconds; slow sensor responses can extend it. Clear space, supervision, and an accessible emergency stop are required.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleMeasureSensorRates}
            disabled={!isReady || isLoading || isStarting || isCapturing || isStopping || isMeasuringRates || !confirmClearArea}
            className="rounded-md border border-cyan-400 px-2 py-1.5 text-[11px] font-semibold text-cyan-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isMeasuringRates ? 'Running rate sweep…' : 'Run sensor-rate sweep'}
          </button>
          {!confirmClearArea && (
            <span className="text-[11px] text-amber-900">Confirm the workspace is clear above to enable the sweep.</span>
          )}
          {!isReady && (
            <span className="text-[11px] text-slate-600">{readinessMessage}</span>
          )}
          {rateDiagnostic && (
            <>
              <button
                type="button"
                onClick={() => setFilePreview({
                  title: 'g1-sensor-rate-sweep.json',
                  content: JSON.stringify(rateDiagnostic, null, 2),
                })}
                className="rounded-md border border-cyan-300 px-2 py-1.5 text-[11px] font-semibold text-cyan-900"
              >
                Preview sweep report
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    downloadSensorRateDiagnostic(rateDiagnostic);
                  } catch (downloadError) {
                    setError(`Sensor-rate report export failed: ${downloadError.message}`);
                  }
                }}
                className="rounded-md border border-cyan-300 px-2 py-1.5 text-[11px] font-semibold text-cyan-900"
              >
                Export sweep report JSON
              </button>
            </>
          )}
        </div>
      </div>
      <form onSubmit={handleRunAndCapture} className="mt-3 space-y-3">
        <label className="block text-xs font-semibold text-slate-700">
          Capture name
          <input
            aria-label="Position capture name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            required
            disabled={isStarting || isCapturing || isMeasuringRates}
            className="mt-1 w-full rounded-md border border-cyan-200 bg-white px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-xs font-semibold text-slate-700">
          Validated {controllerLabel} command sequence
          {useLocomotionSeries ? (
            <div className="mt-1 space-y-2 rounded-md border border-cyan-200 bg-white p-3">
              <label className="block font-sans text-xs font-semibold">
                Calibration section
                <select
                  aria-label="Calibration section to run"
                  value={selectedCalibrationBatchIndex}
                  onChange={(event) => setSelectedCalibrationBatchIndex(Number(event.target.value))}
                  disabled={isStarting || isCapturing || isMeasuringRates}
                  className="mt-1 w-full rounded-md border border-cyan-200 bg-white px-2 py-2"
                >
                  {buildG1LocomotionCalibrationSeries().batches.map((batch, index) => (
                    <option key={batch.label} value={index}>
                      {String(index + 1).padStart(2, '0')} · {batch.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="font-mono text-[11px] font-normal">
                {buildG1LocomotionCalibrationSeries().batches[selectedCalibrationBatchIndex].code.split('\n').join(' → ')}
              </p>
            </div>
          ) : (
            <textarea
              aria-label="Calibration command sequence"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              rows={5}
              maxLength={10_000}
              spellCheck={false}
              disabled={isStarting || isCapturing || isMeasuringRates}
              className="mt-1 w-full resize-y rounded-md border border-cyan-200 bg-white px-3 py-2 font-mono text-xs"
            />
          )}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!isReady || isLoading || isStarting || isCapturing || isStopping || isMeasuringRates || !name.trim() || !confirmClearArea || (useLocomotionSeries && controllerVersion !== 'legacy')}
            className="rounded-lg bg-cyan-800 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? 'Checking robot and sensors…' : isCapturing ? `Running & capturing · ${sampleCount} samples` : useLocomotionSeries ? 'Run selected calibration section' : 'Run & capture position'}
          </button>
          {(isCapturing || isMeasuringRates) && (
            <button
              type="button"
              onClick={handleStopRobot}
              disabled={isStopping}
              className="rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {isStopping ? 'Stopping…' : isMeasuringRates ? 'Stop rate sweep' : useLocomotionSeries ? 'Stop section' : 'Stop robot'}
            </button>
          )}
        </div>
      </form>
      <p className="mt-2 text-[11px] leading-4 text-slate-600">
        Sequential commands and bounded loops are limited to 20 expanded commands and an estimated five minutes.
        Each calibration section runs independently with one API command and is saved as its own recording and JSON file. Select any section to run or rerun it; reruns receive unique names.
        Position captures target 30 Hz based on the completed sensor sweep. The temporary sweep tests 10, 20, 30, 40, 50, 60, 80, 100, 150, and 200 Hz with bounded forward/backward movement cycles.
        Selected sections use only existing Legacy SDK locomotion commands; fast-walk commands are forward-only in the current SDK. Legacy Stop stops locomotion but does not independently verify immobility.
        Fresh odometry/localization and all 23 ROS joint values are required. A sensor/boundary failure or STOP offers the measured partial section when at least two valid samples exist.
      </p>
      {message && <p role="status" className="mt-2 text-xs text-emerald-800">{message}</p>}
      <div className="mt-4 border-t border-cyan-200 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-slate-800">Saved robot recordings</h4>
          <button
            type="button"
            onClick={handlePreviewAllFiles}
            disabled={!recordings.length}
            className="rounded-md border border-cyan-300 px-2 py-1 text-[11px] font-semibold text-cyan-900 disabled:opacity-50"
          >
            Preview all JSON
          </button>
          <button
            type="button"
            onClick={handleExportAll}
            disabled={!recordings.length}
            className="rounded-md border border-cyan-300 px-2 py-1 text-[11px] font-semibold text-cyan-900 disabled:opacity-50"
          >
            Export all JSON
          </button>
        </div>
        {isLoading ? (
          <p className="mt-2 text-xs text-slate-500">Loading recordings…</p>
        ) : recordings.length ? (
          <ul className="mt-2 space-y-2">
            {recordings.map((recording) => (
              <li key={recording.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-100 bg-white p-2">
                <div>
                  <p className="text-xs font-semibold text-slate-800">{recording.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {recording.capture_type === 'position_calibration' ? 'Pose + ' : ''}
                    {recording.joint_names?.length || 0} joints
                    {' · '}{recording.frames.length} samples · {recording.frames.at(-1)?.time.toFixed(2) ?? '0.00'} s
                    {recording.frames[0]?.pose?.frame_id ? ` · ${recording.frames[0].pose.frame_id} frame` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onPreview(recording)}
                    disabled={isStarting || isCapturing || isStopping}
                    aria-label={`Play recording ${recording.name} in simulator`}
                    aria-pressed={recording.id === selectedRecordingId}
                    className="rounded-md border border-cyan-300 px-2 py-1 text-[11px] font-semibold text-cyan-900 disabled:opacity-50"
                  >
                    Play in simulator
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreviewRecordingFile(recording)}
                    disabled={isStarting || isCapturing || isStopping}
                    className="rounded-md border border-cyan-300 px-2 py-1 text-[11px] font-semibold text-cyan-900 disabled:opacity-50"
                  >
                    Preview JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportRecording(recording)}
                    disabled={isStarting || isCapturing || isStopping}
                    className="rounded-md border border-cyan-300 px-2 py-1 text-[11px] font-semibold text-cyan-900 disabled:opacity-50"
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(recording)}
                    disabled={isStarting || isCapturing || isStopping}
                    className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No robot recordings saved yet.</p>
        )}
      </div>
      {filePreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="recording-file-preview-title"
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-cyan-200 bg-white p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3">
              <h4 id="recording-file-preview-title" className="text-sm font-semibold text-slate-900">
                File preview: {filePreview.title}
              </h4>
              <button
                type="button"
                onClick={() => setFilePreview(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
              >
                Close preview
              </button>
            </div>
            <pre className="mt-3 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-cyan-100">
              {filePreview.content}
            </pre>
          </section>
        </div>
      )}
    </section>
  );
}
