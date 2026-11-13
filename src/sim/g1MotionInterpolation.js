function lerp(from = 0, to = 0, amount) {
  return from + (to - from) * amount;
}

function interpolateAngle(from = 0, to = 0, amount) {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * amount;
}

export function interpolateSimulationFrame(from, to, amount) {
  if (!from) return to;
  if (!to) return from;
  const joints = {};
  const jointNames = new Set([...Object.keys(from.joints || {}), ...Object.keys(to.joints || {})]);
  jointNames.forEach((name) => {
    joints[name] = lerp(Number(from.joints?.[name] ?? 0), Number(to.joints?.[name] ?? 0), amount);
  });
  return {
    ...to,
    time: lerp(from.time || 0, to.time || 0, amount),
    x: lerp(from.x || 0, to.x || 0, amount),
    y: lerp(from.y || 0, to.y || 0, amount),
    heading: interpolateAngle(from.heading || 0, to.heading || 0, amount),
    torsoPitch: lerp(from.torsoPitch || 0, to.torsoPitch || 0, amount),
    torsoRoll: lerp(from.torsoRoll || 0, to.torsoRoll || 0, amount),
    joints,
    path: from.path || to.path || [],
  };
}
