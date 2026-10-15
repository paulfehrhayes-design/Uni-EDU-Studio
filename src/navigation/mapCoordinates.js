export function mapLocalToWorld(x, y, map) {
  const cosine = Math.cos(map.origin.yaw_rad);
  const sine = Math.sin(map.origin.yaw_rad);
  return {
    x: map.origin.x + cosine * x - sine * y,
    y: map.origin.y + sine * x + cosine * y,
  };
}

export function worldToMapLocal(x, y, map) {
  const dx = x - map.origin.x;
  const dy = y - map.origin.y;
  const cosine = Math.cos(map.origin.yaw_rad);
  const sine = Math.sin(map.origin.yaw_rad);
  return {
    x: cosine * dx + sine * dy,
    y: -sine * dx + cosine * dy,
  };
}

export function occupancyAtMapLocalPoint(x, y, map, data) {
  if (
    !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(map.resolution_m)
    || map.resolution_m <= 0
    || !Array.isArray(data)
    || data.length !== map.width * map.height
  ) return null;
  const column = Math.floor(x / map.resolution_m);
  const row = Math.floor(y / map.resolution_m);
  if (column < 0 || row < 0 || column >= map.width || row >= map.height) return null;
  return data[row * map.width + column];
}

export function isWorldPointInKnownFreeSpace(x, y, snapshot) {
  if (!snapshot?.map || !Array.isArray(snapshot.data)) return false;
  const local = worldToMapLocal(x, y, snapshot.map);
  const occupancy = occupancyAtMapLocalPoint(local.x, local.y, snapshot.map, snapshot.data);
  return Number.isInteger(occupancy) && occupancy >= 0 && occupancy < 65;
}
