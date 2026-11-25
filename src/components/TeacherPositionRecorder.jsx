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

const SAMPLE_INTERVAL_MS = 10;
const MAX_CAPTURE_SECONDS = 300;
const MAX_CAPTURE_SAMPLES = 30001;
const MAX_JOINT_SAMPLE_AGE_MS = 250;
const RATE_SWEEP_TARGETS_HZ = [10, 20, 30, 40, 50, 60, 80, 100, 150, 200];
const RATE_SWEEP_PHASE_SECONDS = 2;
const RATE_SWEEP_TIMEOUT_SECONDS = 30;

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
    ? 'for _ in range(10):\n    duet.walk(1)\n    duet.backward(1)'
    : 'for i in range(10):\n    robot.walktime(1)\n    robot.backwardtime(1)';
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function makePoseAndJointFrame({ time, pose, positions }) {
  return { time, joints: [...positions], pose };
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
  blockedByOtherMotion,
}) {
  const [recordings, setRecordings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [readinessMessage, setReadinessMessage] = useState('Checking robot and full-body sensor feedback…');
  const [name, setName] = useState('');
  const [code, setCode] = useState(() => defaultCommand(controllerVersion));
  const [confirmClearArea, setConfirmClearArea] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isMeasuringRates, setIsMeasuringRates] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filePreview, setFilePreview] = useState(null);
  const [rateDiagnostic, setRateDiagnostic] = useState(null);
  const startingRef = useRef(false);

  useEffect(() => {
    setCode(defaultCommand(controllerVersion));
    setConfirmClearArea(false);
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
      const phaseDurationMs = RATE_SWEEP_PHASE_SECONDS * 1000;
      const phaseReadings = RATE_SWEEP_TARGETS_HZ.map(() => []);
      const readings = [];
      let frameId = null;
      let baseFrame = null;
      let runSettled = false;
      let runResult = null;
      let runError = null;
      let samplingError = null;
      let stopError = null;
      let timeoutReached = false;
      let nextRequestAt = startedAt;
      let activePhaseIndex = -1;

      setConfirmClearArea(false);
      setMessage('Rate sweep started: 10 bounded one-second forward/backward cycles, testing each target rate.');
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

      while (!runSettled) {
        const elapsed = performance.now() - startedAt;
        if (elapsed >= RATE_SWEEP_TIMEOUT_SECONDS * 1000) {
          timeoutReached = true;
          break;
        }
        await wait(Math.min(
          Math.max(0, nextRequestAt - performance.now()),
          RATE_SWEEP_TIMEOUT_SECONDS * 1000 - elapsed,
        ));
        if (runSettled) break;

        const requestStartedAt = performance.now();
        const requestElapsed = requestStartedAt - startedAt;
        if (requestElapsed >= RATE_SWEEP_TIMEOUT_SECONDS * 1000) {
          timeoutReached = true;
          break;
        }
        const phaseIndex = Math.min(
          Math.floor(requestElapsed / phaseDurationMs),
          RATE_SWEEP_TARGETS_HZ.length - 1,
        );
        const targetHz = RATE_SWEEP_TARGETS_HZ[phaseIndex];
        if (phaseIndex !== activePhaseIndex) {
          activePhaseIndex = phaseIndex;
          setMessage(`Rate sweep ${phaseIndex + 1}/${RATE_SWEEP_TARGETS_HZ.length}: testing ${targetHz} Hz.`);
        }

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
          phaseReadings[phaseIndex].push(reading);
          nextRequestAt = requestStartedAt + 1000 / targetHz;
        } catch (sampleError) {
          samplingError = sampleError;
          break;
        }
      }

      if (!runSettled && (samplingError || timeoutReached)) {
        setIsStopping(true);
        setMessage(samplingError
          ? 'Sensor feedback failed; requesting a robot stop and preserving the partial rate report.'
          : 'Rate sweep exceeded its 30-second safeguard; requesting a robot stop.');
        try {
          await connection.stop();
        } catch (requestError) {
          stopError = requestError;
        } finally {
          setIsStopping(false);
        }
      }
      await runPromise;

      const elapsedMs = performance.now() - startedAt;
      const phases = RATE_SWEEP_TARGETS_HZ.map((targetHz, index) => ({
        ...summarizeRateSweepPhase(phaseReadings[index], targetHz),
        movement: 'forward 1 s, then backward 1 s',
      }));
      const safetyInterventions = runResult?.safetyInterventions || [];
      const complete = runResult?.status === 'completed'
        && safetyInterventions.length === 0
        && phases.every((phase) => phase.measurable);
      const failure = samplingError?.message
        || runError?.message
        || (safetyInterventions.length
          ? 'A safety intervention changed the commanded movement.'
          : null)
        || (stopError ? `Robot stop request failed: ${stopError.message}` : null)
        || (timeoutReached ? 'The 30-second sweep safeguard was reached.' : null);
      const report = {
        format: 'uni-edu-studio/g1-sensor-rate-sweep',
        version: 1,
        started_at: startedAtIso,
        controller_version: controllerVersion,
        commanded_motion: true,
        movement_program: captureProgram.code,
        movement_cycle_count: 10,
        movement_cycle_duration_s: 2,
        physical_movement_verified: false,
        elapsed_ms: Number(elapsedMs.toFixed(3)),
        successful_reads: readings.length,
        joint_names: G1_MODEL_INFO.joints,
        run_status: runResult?.status || (runError ? 'failed' : 'unknown'),
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
    if (!confirmClearArea) {
      setError('Confirm the robot workspace is clear and that you will supervise the physical movement.');
      return;
    }
    if (blockedByOtherMotion) {
      setError('Finish the active robot operation before starting a position capture.');
      return;
    }

    startingRef.current = true;
    setIsStarting(true);
    let captureProgram;
    let initialStatus;
    let initialPose;
    let firstJointSample;
    try {
      captureProgram = controllerVersion === 'duet'
        ? validateDuetPositionCapture(name, code)
        : validateLegacyPositionCapture(name, code);
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
    } catch (startError) {
      setError(`Position capture could not start: ${startError.message}`);
      startingRef.current = false;
      setIsStarting(false);
      return;
    }

    const startedAt = performance.now();
    const capturedAt = new Date().toISOString();
    const frames = [makePoseAndJointFrame({
      time: 0,
      pose: initialPose,
      positions: firstJointSample.positions,
    })];
    setSampleCount(1);
    setConfirmClearArea(false);
    startingRef.current = false;
    setIsStarting(false);
    setIsCapturing(true);
    setMessage(`Running the approved ${controllerVersion === 'duet' ? 'DUET' : 'legacy SDK'} sequence while recording pose and all 23 joints.`);

    let runSettled = false;
    let samplingError = null;
    let captureLimitReached = false;
    let stopError = null;
    const addSample = (pose, jointSample) => {
      const elapsed = (performance.now() - startedAt) / 1000;
      if (elapsed > MAX_CAPTURE_SECONDS || frames.length >= MAX_CAPTURE_SAMPLES) {
        captureLimitReached = true;
        return false;
      }
      const time = Math.max(
        Number(elapsed.toFixed(3)),
        frames.at(-1).time + 0.001,
      );
      frames.push(makePoseAndJointFrame({
        time,
        pose,
        positions: jointSample.positions,
      }));
      setSampleCount(frames.length);
      if (frames.length >= MAX_CAPTURE_SAMPLES) {
        captureLimitReached = true;
        return false;
      }
      return true;
    };
    const runPromise = connection.run(captureProgram.code).then(
      (result) => ({ result }),
      (runError) => ({ runError }),
    ).finally(() => {
      runSettled = true;
    });

    try {
      let nextSampleAt = startedAt + SAMPLE_INTERVAL_MS;
      while (!runSettled) {
        const remainingMs = MAX_CAPTURE_SECONDS * 1000 - (performance.now() - startedAt);
        if (remainingMs <= 0 || frames.length >= MAX_CAPTURE_SAMPLES) {
          captureLimitReached = true;
          break;
        }
        await wait(Math.min(Math.max(0, nextSampleAt - performance.now()), remainingMs));
        if (runSettled) break;
        nextSampleAt += SAMPLE_INTERVAL_MS;
        try {
          const [poseSnapshot, jointSample] = await Promise.all([
            connection.pose(),
            readJointSample(connection),
          ]);
          const pose = selectPositionCapturePose(poseSnapshot, initialPose.frame_id);
          if (pose.base_frame !== initialPose.base_frame) {
            throw new Error('The TF base frame changed during capture; no recording was saved.');
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
          ? 'Sensor feedback failed; requesting a robot stop. No capture will be saved.'
          : 'Five-minute capture safeguard reached; requesting a robot stop.');
        try {
          await connection.stop();
        } catch (requestError) {
          stopError = requestError;
        } finally {
          setIsStopping(false);
        }
      }

      const { result, runError } = await runPromise;
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
      if (!captureLimitReached && elapsed <= MAX_CAPTURE_SECONDS) {
        const [poseSnapshot, finalJointSample] = await Promise.all([
          connection.pose(),
          readJointSample(connection),
        ]);
        const finalPose = selectPositionCapturePose(poseSnapshot, initialPose.frame_id);
        if (finalPose.base_frame !== initialPose.base_frame) {
          throw new Error('The TF base frame changed during capture; no recording was saved.');
        }
        if (
          finalJointSample.jointNames.length !== firstJointSample.jointNames.length
          || finalJointSample.jointNames.some(
            (joint, index) => joint !== firstJointSample.jointNames[index],
          )
        ) {
          throw new Error('The measured joint layout changed during capture; no recording was saved.');
        }
        addSample(finalPose, finalJointSample);
      }
      if (frames.length < 2) {
        throw new Error('The command was too short to produce at least two measured samples.');
      }

      const saved = await connection.saveRecording({
        name: captureProgram.name,
        controller_version: controllerVersion,
        capture_type: 'position_calibration',
        command: captureProgram.code,
        joint_names: firstJointSample.jointNames,
        captured_at: capturedAt,
        frames,
      });
      setRecordings((current) => [...current, saved.recording].sort(
        (left, right) => left.name.localeCompare(right.name),
      ));
      setName('');
      setMessage(
        `Saved ${frames.length} pose and joint samples${result.status === 'stopped' ? ' from the stopped movement' : ''}${captureLimitReached ? ' (five-minute safety limit reached)' : ''}.`,
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
      const result = await connection.stop();
      setMessage(result.physicalStopVerified === false
        ? 'Stop was sent; the controller does not independently verify physical immobility.'
        : isMeasuringRates
          ? 'Robot stop was acknowledged; the sweep will preserve the partial rate report.'
          : 'Robot stop was acknowledged by the controller. Recording continues until the command ends.');
    } catch (requestError) {
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
      <div className="mt-3 rounded-lg border border-cyan-200 bg-white p-3">
        <h4 className="text-xs font-semibold text-slate-800">Temporary sensor-rate sweep</h4>
        <p className="mt-1 text-[11px] leading-4 text-slate-600">
          Runs ten one-second forward/backward cycles, testing 10–200 Hz while the robot moves.
          The full sweep takes about 20 seconds and requires clear space, supervision, and an accessible emergency stop.
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
        </label>
        <label className="flex items-start gap-2 text-xs leading-5 text-amber-950">
          <input
            type="checkbox"
            aria-label="Confirm robot workspace is clear"
            checked={confirmClearArea}
            onChange={(event) => setConfirmClearArea(event.target.checked)}
            disabled={isStarting || isCapturing || isStopping || isMeasuringRates}
            className="mt-1 h-4 w-4 shrink-0 accent-amber-700"
          />
          <span>
            I have cleared the robot&apos;s travel area, will supervise this physical movement, and have the emergency stop accessible.
            The robot moves when I select Run &amp; capture or Run sensor-rate sweep. The sweep walks forward for one second and backward for one second at each of ten test rates.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!isReady || isLoading || isStarting || isCapturing || isStopping || isMeasuringRates || !name.trim() || !confirmClearArea}
            className="rounded-lg bg-cyan-800 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? 'Checking robot and sensors…' : isCapturing ? `Running & capturing · ${sampleCount} samples` : 'Run & capture position'}
          </button>
          {(isCapturing || isMeasuringRates) && (
            <button
              type="button"
              onClick={handleStopRobot}
              disabled={isStopping}
              className="rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {isStopping ? 'Stopping…' : isMeasuringRates ? 'Stop rate sweep' : 'Stop robot'}
            </button>
          )}
        </div>
      </form>
      <p className="mt-2 text-[11px] leading-4 text-slate-600">
        Sequential commands and bounded loops are limited to 20 expanded commands and an estimated five minutes.
        Captures target 100 Hz. The temporary sweep tests 10, 20, 30, 40, 50, 60, 80, 100, 150, and 200 Hz, and stops after one 20-second movement sequence.
        Legacy Stop robot stops locomotion but cannot cancel an accepted arm preset. A stop acknowledgement does not verify physical immobility.
        Fresh odometry/localization and all 23 ROS joint values are required; missing or stale feedback discards the capture.
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
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
                    className="rounded-md border border-cyan-300 px-2 py-1 text-[11px] font-semibold text-cyan-900 disabled:opacity-50"
                  >
                    Preview
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
