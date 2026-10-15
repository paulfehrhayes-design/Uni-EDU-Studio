const DIMENSION_RATIOS = Object.freeze({
  box: [1.35, 1.35, 1.35],
  wall: [2.4, 1.3, 0.48],
  platform: [1.9, 0.28, 1.9],
  ramp: [2, 1.25, 1.4],
  stairs: [1.6, 1.14, 0.8],
  sphere: [1.4, 1.4, 1.4],
  cylinder: [1.24, 1.3, 1.24],
  table: [1.8, 1.29, 1.5],
  terrain: [3, 0.56, 2.5],
});

export function getSceneObjectBaseDimensions(type, radius = 10) {
  const size = Math.max(0.45, Number(radius) / 10 || 1);
  const [width, height, depth] = DIMENSION_RATIOS[type] || [1.5, 0.5, 1.5];
  return {
    width: Number((size * width).toFixed(2)),
    height: Number((size * height).toFixed(2)),
    depth: Number((size * depth).toFixed(2)),
  };
}

export function getSceneObjectDimensions(object) {
  const baseDimensions = getSceneObjectBaseDimensions(object.type, object.radius);
  return {
    width: Number(object.dimensions?.width) || baseDimensions.width,
    height: Number(object.dimensions?.height) || baseDimensions.height,
    depth: Number(object.dimensions?.depth) || baseDimensions.depth,
  };
}

export function getSceneObjectScale(object) {
  const baseDimensions = getSceneObjectBaseDimensions(object.type, object.radius);
  const dimensions = getSceneObjectDimensions(object);
  return {
    x: dimensions.width / baseDimensions.width,
    y: dimensions.height / baseDimensions.height,
    z: dimensions.depth / baseDimensions.depth,
  };
}
