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
    || pose.source !== 'tf2'
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
