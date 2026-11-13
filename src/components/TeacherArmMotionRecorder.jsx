import { useEffect, useState } from 'react';
import { validateLegacyArmMotion } from '../sim/g1ArmMotions.js';
import { validateDuetArmMotion } from '../sim/duetArmMotions.js';
import { G1_MODEL_INFO } from '../sim/g1ModelRuntime.js';
import { getDuetArmCatalog } from '../sim/duetArmCatalog.js';
import {
  downloadG1MotionRecording,
  downloadG1MotionRecordings,
} from '../sim/g1RecordingExport.js';

const SAMPLE_INTERVAL_MS = 50;
const MAX_CAPTURE_SECONDS = 30;
const LEGACY_MAX_SAMPLE_AGE_MS = 250;

function hasDuetArmFeedback(status) {
  return status?.ready === true
    && status.capabilities?.includes('arm_feedback')
    && Array.isArray(status.measuredJoints)
    && status.measuredJoints.length === 10
    && status.measuredJoints.every(Number.isFinite);
}

function isDuetIdle(status) {
  return hasDuetArmFeedback(status)
    && status.programActive === false
    && status.motionActive === false;
}

function isLegacyIdle(status) {
  return status?.sdkAvailable === true && status.running === false;
}

function hasCompleteLegacySample(sample) {
  return Array.isArray(sample?.joint_names)
    && sample.joint_names.length === 23
    && new Set(sample.joint_names).size === 23
    && sample.joint_names.every((joint) => G1_MODEL_INFO.joints.includes(joint))
    && Array.isArray(sample.positions_rad)
    && sample.positions_rad.length === 23
    && sample.positions_rad.every(Number.isFinite)
    && Number.isFinite(sample.age_ms)
    && sample.age_ms >= 0
    && sample.age_ms <= LEGACY_MAX_SAMPLE_AGE_MS;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function recordingFilename(name) {
  const safeName = name.trim().replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
  return `${safeName || 'g1-motion'}.json`;
}

export default function TeacherArmMotionRecorder({
  connection,
  controllerVersion,
  onPreview,
  onBusyChange,
}) {
  const [recordings, setRecordings] = useState([]);
  const [feedbackReady, setFeedbackReady] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState('Checking robot and measured-joint feedback…');
  const [name, setName] = useState('');
  const [code, setCode] = useState(controllerVersion === 'duet'
    ? 'duet.wave_right("mid", 1.5)'
    : 'robot.arm_action("face wave")');
  const [confirmClearArea, setConfirmClearArea] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [sampleCount, setSampleCount] = useState(0);

  useEffect(() => {
    let active = true;
    connection.recordings()
      .then((response) => {
        if (active) setRecordings(response.recordings);
      })
      .catch((requestError) => {
        if (active) setError(`Recorded motions could not be loaded: ${requestError.message}`);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connection]);

  useEffect(() => {
    setCode(controllerVersion === 'duet'
      ? 'duet.wave_right("mid", 1.5)'
      : 'robot.arm_action("face wave")');
  }, [controllerVersion]);

  useEffect(() => {
    let active = true;
    const refreshStatus = async () => {
      try {
        const status = await connection.status();
        if (!active) return;
        if (controllerVersion === 'duet') {
          const ready = hasDuetArmFeedback(status);
          setFeedbackReady(ready && isDuetIdle(status));
          setFeedbackMessage(ready
            ? (isDuetIdle(status)
              ? 'DUET v2 and fresh measured arm feedback are ready.'
              : 'Stop the active DUET program or motion before recording.')
            : 'Connect a ready DUET v2 controller that reports arm-feedback capability.');
          return;
        }
        if (!isLegacyIdle(status)) {
          setFeedbackReady(false);
          setFeedbackMessage(status?.sdkAvailable
            ? 'Stop the active legacy SDK program before recording.'
            : 'Connect the legacy G1 SDK and its robot host.');
          return;
        }
        const sample = await connection.jointState();
        if (!active) return;
        setFeedbackReady(hasCompleteLegacySample(sample));
        setFeedbackMessage(
          hasCompleteLegacySample(sample)
            ? 'Legacy SDK and fresh 23-joint ROS telemetry are ready.'
            : 'Legacy telemetry did not contain a fresh, complete 23-joint sample.',
        );
      } catch (requestError) {
        if (!active) return;
        setFeedbackReady(false);
        setFeedbackMessage(controllerVersion === 'legacy'
          ? `Legacy SDK joint telemetry is unavailable: ${requestError.message}`
          : `DUET arm feedback is unavailable: ${requestError.message}`);
      }
    };

    refreshStatus();
    const timer = window.setInterval(() => {
      if (!isRunning) refreshStatus();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection, controllerVersion, isRunning]);

  useEffect(() => {
    onBusyChange(isRunning || isStopping);
  }, [isRunning, isStopping, onBusyChange]);

  const readMeasuredSample = async (status) => {
    if (controllerVersion === 'duet') {
      const currentStatus = status || await connection.status();
      if (!hasDuetArmFeedback(currentStatus)) {
        throw new Error('Live ten-joint DUET arm feedback was lost; no recording was saved.');
      }
      return {
        jointNames: getDuetArmCatalog().jointOrder,
        positions: currentStatus.measuredJoints,
      };
    }

    if (status && !isLegacyIdle(status)) {
      throw new Error('The legacy SDK is unavailable or has an active program.');
    }
    const sample = await connection.jointState();
    if (!hasCompleteLegacySample(sample)) {
      throw new Error('Fresh, complete 23-joint ROS telemetry is unavailable; no recording was saved.');
    }
    return {
      jointNames: sample.joint_names,
      positions: sample.positions_rad,
    };
  };

  const handleRunAndRecord = async (event) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setSampleCount(0);

    let validatedMotion;
    let initialStatus;
    let firstSample;
    try {
      validatedMotion = controllerVersion === 'duet'
        ? validateDuetArmMotion(name, code)
        : validateLegacyArmMotion(name, code);
      if (!confirmClearArea) {
        throw new Error('Confirm the robot workspace is clear and that you will supervise the motion.');
      }
      initialStatus = await connection.status();
      const idle = controllerVersion === 'duet'
        ? isDuetIdle(initialStatus)
        : isLegacyIdle(initialStatus);
      if (!idle) {
        throw new Error(controllerVersion === 'duet'
          ? 'Connect a ready DUET v2 controller with arm feedback and stop all active motion before recording.'
          : 'Connect the legacy SDK and stop any active robot program before recording.');
      }
      firstSample = await readMeasuredSample(initialStatus);
    } catch (requestError) {
      setError(requestError.message);
      return;
    }

    const frames = [];
    const startedAt = performance.now();
    const addSample = (sample) => {
      const elapsed = Math.min(
        MAX_CAPTURE_SECONDS,
        Math.max(0, (performance.now() - startedAt) / 1000),
      );
      const time = frames.length === 0 ? 0 : Math.max(
        Number(elapsed.toFixed(3)),
        frames.at(-1).time + 0.001,
      );
      if (time <= MAX_CAPTURE_SECONDS) {
        frames.push({ time, joints: [...sample.positions] });
        setSampleCount(frames.length);
      }
    };
    addSample(firstSample);

    try {
      const capturedAt = new Date().toISOString();
      setIsRunning(true);
      setMessage(`Recording measured ${controllerVersion === 'duet' ? 'arm' : '23-DOF'} joints while the approved command runs.`);

      let runSettled = false;
      let samplingError = null;
      const runPromise = connection.run(validatedMotion.code).finally(() => {
        runSettled = true;
      });
      const samplingPromise = (async () => {
        while (!runSettled && performance.now() - startedAt < MAX_CAPTURE_SECONDS * 1000) {
          await wait(SAMPLE_INTERVAL_MS);
          if (runSettled) break;
          try {
            addSample(await readMeasuredSample());
          } catch (requestError) {
            samplingError = requestError;
            break;
          }
        }
      })();
      const result = await runPromise;
      await samplingPromise;
      if (samplingError) throw samplingError;

      if (controllerVersion === 'duet') {
        addSample(await readMeasuredSample(await connection.status()));
      } else {
        addSample(await readMeasuredSample());
      }
      if (!['completed', 'stopped'].includes(result.status)) {
        throw new Error(`Robot command ended with status ${result.status || 'unknown'}; no recording was saved.`);
      }
      if (frames.length < 2) {
        throw new Error('The motion was too short to produce a usable measured recording.');
      }

      const saved = await connection.saveRecording({
        name: validatedMotion.name,
        controller_version: controllerVersion,
        command: validatedMotion.code,
        joint_names: firstSample.jointNames,
        captured_at: capturedAt,
        frames,
      });
      setRecordings((current) => [...current, saved.recording].sort(
        (left, right) => left.name.localeCompare(right.name),
      ));
      setName('');
      setMessage(
        `Saved ${frames.length} measured samples${result.status === 'stopped' ? ' from the stopped motion' : ''}.`,
      );
    } catch (requestError) {
      setError(`Motion capture failed: ${requestError.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleStopRobot = async () => {
    setIsStopping(true);
    setError('');
    try {
      const result = await connection.stop();
      setMessage(result.physicalStopVerified === false
        ? 'Stop was sent; the controller does not independently verify physical immobility.'
        : 'Robot stop was acknowledged by the controller.');
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
    } catch (requestError) {
      setError(`Recorded motion could not be deleted: ${requestError.message}`);
    }
  };

  const controllerLabel = controllerVersion === 'duet' ? 'DUET v2' : 'legacy SDK';
  const jointCount = controllerVersion === 'duet' ? 10 : 23;
  return (
    <section className="rounded-xl border border-violet-300 bg-violet-50 p-4">
      <h3 className="text-sm font-semibold text-violet-950">Record a real robot motion</h3>
      <p className="mt-1 text-xs leading-5 text-violet-900">
        Uses the selected {controllerLabel} to run a validated arm-only command and records measured joint positions.
        DUET captures ten arm joints; legacy SDK captures the full 23-DOF ROS joint state.
      </p>
      <p role="status" aria-live="polite" className="mt-2 text-xs font-medium text-slate-700">
        {feedbackMessage}
      </p>
      <form onSubmit={handleRunAndRecord} className="mt-3 space-y-3">
        <label className="block text-xs font-semibold text-slate-700">
          Recording name
          <input
            aria-label="Recorded motion name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            required
            className="mt-1 w-full rounded-md border border-violet-200 bg-white px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-xs font-semibold text-slate-700">
          Approved arm-only {controllerLabel} command
          <textarea
            aria-label="Arm command to record"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            rows={3}
            maxLength={10_000}
            spellCheck={false}
            className="mt-1 w-full resize-y rounded-md border border-violet-200 bg-white px-3 py-2 font-mono text-xs"
          />
        </label>
        <label className="flex items-start gap-2 text-xs leading-5 text-amber-950">
          <input
            type="checkbox"
            aria-label="Confirm robot arm workspace is clear"
            checked={confirmClearArea}
            onChange={(event) => setConfirmClearArea(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-amber-700"
          />
          <span>
            I have cleared the robot&apos;s workspace, will supervise this physical motion, and have the emergency stop accessible.
            The robot moves when I select Run &amp; record.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!feedbackReady || isRunning || isStopping || !confirmClearArea}
            className="rounded-lg bg-violet-800 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRunning ? `Running & recording · ${sampleCount} samples` : 'Run & record on robot'}
          </button>
          {isRunning && (
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
        Sampling runs for at most 30 seconds. A capture failure does not stop the robot command; use Stop robot if needed.
        Position feedback does not certify safety or confirm physical immobility.
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
      {message && <p role="status" className="mt-2 text-xs text-emerald-800">{message}</p>}
      <div className="mt-4 border-t border-violet-200 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-slate-800">Saved recordings</h4>
          <button
            type="button"
            onClick={() => downloadG1MotionRecordings(recordings)}
            disabled={!recordings.length}
            className="rounded-md border border-violet-300 px-2 py-1 text-[11px] font-semibold text-violet-900 disabled:opacity-50"
          >
            Export all JSON
          </button>
        </div>
        {isLoading ? (
          <p className="mt-2 text-xs text-slate-500">Loading recordings…</p>
        ) : recordings.length ? (
          <ul className="mt-2 space-y-2">
            {recordings.map((recording) => (
              <li key={recording.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-100 bg-white p-2">
                <div>
                  <p className="text-xs font-semibold text-slate-800">{recording.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {recording.controller_version === 'legacy' ? 'Legacy · 23 joints' : 'DUET · 10 arm joints'}
                    {' · '}{recording.frames.length} samples · {recording.frames.at(-1)?.time.toFixed(2) ?? '0.00'} s
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onPreview(recording)}
                    disabled={isRunning}
                    className="rounded-md border border-violet-300 px-2 py-1 text-[11px] font-semibold text-violet-900 disabled:opacity-50"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadG1MotionRecording(recording, recordingFilename(recording.name))}
                    disabled={isRunning}
                    className="rounded-md border border-violet-300 px-2 py-1 text-[11px] font-semibold text-violet-900 disabled:opacity-50"
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(recording)}
                    disabled={isRunning}
                    className="rounded-md border border-red-200 px-2 py-1 text-[11px] font-semibold text-red-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No measured robot recordings saved yet.</p>
        )}
      </div>
      <span className="sr-only">{jointCount} joints available for capture.</span>
    </section>
  );
}
