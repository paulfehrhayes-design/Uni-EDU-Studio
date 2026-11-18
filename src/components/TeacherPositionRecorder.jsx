import { useEffect, useRef, useState } from 'react';
import { G1_MODEL_INFO } from '../sim/g1ModelRuntime.js';
import {
  downloadG1MotionRecording,
  downloadG1MotionRecordings,
} from '../sim/g1RecordingExport.js';
import {
  validateDuetPositionCapture,
  validateLegacyPositionCapture,
} from '../sim/g1PositionCaptureCommands.js';
import { selectPositionCapturePose } from '../robot/positionCapture.js';

const SAMPLE_INTERVAL_MS = 10;
const MAX_CAPTURE_SECONDS = 300;
const MAX_CAPTURE_SAMPLES = 30001;
const MAX_JOINT_SAMPLE_AGE_MS = 250;

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

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function makePoseAndJointFrame({ time, pose, positions }) {
  return { time, joints: [...positions], pose };
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
  const [sampleCount, setSampleCount] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const startingRef = useRef(false);

  useEffect(() => {
    setCode(defaultCommand(controllerVersion));
    setConfirmClearArea(false);
  }, [controllerVersion]);

  useEffect(() => {
    onBusyChange(isStarting || isCapturing || isStopping);
    return () => onBusyChange(false);
  }, [isStarting, isCapturing, isStopping, onBusyChange]);

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
      if (!isCapturing) refresh();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection, controllerVersion, isCapturing, blockedByOtherMotion]);

  const handleRunAndCapture = async (event) => {
    event.preventDefault();
    if (startingRef.current || isCapturing || isStopping) return;
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
        if (nextSampleAt < performance.now()) nextSampleAt = performance.now();
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
      <form onSubmit={handleRunAndCapture} className="mt-3 space-y-3">
        <label className="block text-xs font-semibold text-slate-700">
          Capture name
          <input
            aria-label="Position capture name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            required
            disabled={isStarting || isCapturing}
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
            disabled={isStarting || isCapturing}
            className="mt-1 w-full resize-y rounded-md border border-cyan-200 bg-white px-3 py-2 font-mono text-xs"
          />
        </label>
        <label className="flex items-start gap-2 text-xs leading-5 text-amber-950">
          <input
            type="checkbox"
            aria-label="Confirm robot workspace is clear"
            checked={confirmClearArea}
            onChange={(event) => setConfirmClearArea(event.target.checked)}
            disabled={isStarting || isCapturing || isStopping}
            className="mt-1 h-4 w-4 shrink-0 accent-amber-700"
          />
          <span>
            I have cleared the robot&apos;s travel area, will supervise this physical movement, and have the emergency stop accessible.
            The robot moves when I select Run &amp; capture.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!isReady || isLoading || isStarting || isCapturing || isStopping || !name.trim() || !confirmClearArea}
            className="rounded-lg bg-cyan-800 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isStarting ? 'Checking robot and sensors…' : isCapturing ? `Running & capturing · ${sampleCount} samples` : 'Run & capture position'}
          </button>
          {isCapturing && (
            <button
              type="button"
              onClick={handleStopRobot}
              disabled={isStopping}
              className="rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {isStopping ? 'Stopping…' : 'Stop robot'}
            </button>
          )}
        </div>
      </form>
      <p className="mt-2 text-[11px] leading-4 text-slate-600">
        Sequential commands and bounded loops are limited to 20 expanded commands and an estimated five minutes.
        Sampling requests run every 10 ms, up to 100 Hz, and auto-stop at five minutes or 30,001 samples.
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
            onClick={() => downloadG1MotionRecordings(recordings)}
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
                    onClick={() => downloadG1MotionRecording(recording, captureFilename(recording.name))}
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
    </section>
  );
}
