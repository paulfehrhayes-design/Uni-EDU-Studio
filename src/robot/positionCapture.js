export function selectPositionCapturePose(snapshot, requiredFrameId = null) {
  const readyPoses = Array.isArray(snapshot?.poses)
    ? snapshot.poses.filter((pose) => pose?.ready === true)
    : [];
  const pose = requiredFrameId
    ? readyPoses.find((entry) => entry.frame_id === requiredFrameId)
    : readyPoses.find((entry) => entry.frame_id === 'odom')
      || readyPoses.find((entry) => entry.frame_id === snapshot?.preferred_frame)
      || readyPoses[0];
  if (!pose) {
    throw new Error(requiredFrameId
      ? `The ${requiredFrameId} pose frame is unavailable or stale; no frame switch was made.`
      : snapshot?.error || 'No fresh odometry or localization pose is available.');
  }
  if (
    typeof pose.frame_id !== 'string'
    || !pose.frame_id
    || typeof pose.base_frame !== 'string'
    || !pose.base_frame
    || !['x', 'y', 'z', 'yaw_rad', 'age_ms'].every((key) => Number.isFinite(pose[key]))
    || pose.age_ms < 0
    || pose.age_ms > 1000
    || typeof pose.timestamp !== 'string'
    || !Number.isFinite(new Date(pose.timestamp).getTime())
    || !['tf2', 'odometry'].includes(pose.source)
  ) {
    throw new Error('The ROS pose sample is invalid or stale.');
  }
  return {
    frame_id: pose.frame_id,
    base_frame: pose.base_frame,
    x: pose.x,
    y: pose.y,
    z: pose.z,
    yaw_rad: pose.yaw_rad,
    timestamp: pose.timestamp,
    age_ms: pose.age_ms,
    source: pose.source,
  };
}

export function scheduleNextPositionCaptureSample(scheduledAt, completedAt, intervalMs) {
  return scheduledAt <= completedAt
    ? completedAt + intervalMs
    : scheduledAt;
}

export function summarizePositionCaptureSensorUpdates(readings, timestampKey) {
  if (!Array.isArray(readings) || typeof timestampKey !== 'string') {
    throw new TypeError('Sensor rate summary requires readings and a timestamp key.');
  }

  const seenTimestamps = new Set();
  const uniqueReadings = [];
  let repeatedReads = 0;
  for (const reading of readings) {
    const timestamp = reading?.[timestampKey];
    if (typeof timestamp !== 'string' || !timestamp || !Number.isFinite(reading.elapsed_ms)) {
      throw new TypeError('Sensor rate readings must include timestamps and elapsed times.');
    }
    if (seenTimestamps.has(timestamp)) {
      repeatedReads += 1;
    } else {
      seenTimestamps.add(timestamp);
      uniqueReadings.push(reading);
    }
  }

  const firstElapsed = uniqueReadings[0]?.elapsed_ms;
  const lastElapsed = uniqueReadings.at(-1)?.elapsed_ms;
  const spanMs = uniqueReadings.length > 1 ? lastElapsed - firstElapsed : 0;
  return {
    distinct_samples: uniqueReadings.length,
    repeated_reads: repeatedReads,
    observed_update_rate_hz: spanMs > 0
      ? Number(((uniqueReadings.length - 1) * 1000 / spanMs).toFixed(2))
      : 0,
    unique_timestamps: uniqueReadings.map((reading) => reading[timestampKey]),
  };
}
