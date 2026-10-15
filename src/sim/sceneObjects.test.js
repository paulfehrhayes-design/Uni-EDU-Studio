import test from 'node:test';
import assert from 'node:assert/strict';
import { getSceneObjectBaseDimensions, getSceneObjectDimensions, getSceneObjectScale } from './sceneObjects.js';

test('scene object dimensions default to their existing model proportions', () => {
  const types = ['box', 'wall', 'platform', 'ramp', 'stairs', 'sphere', 'cylinder', 'table', 'terrain'];

  types.forEach((type) => {
    const object = { type, radius: 10 };
    const dimensions = getSceneObjectDimensions(object);
    assert.deepEqual(dimensions, getSceneObjectBaseDimensions(type, 10));
    assert.deepEqual(getSceneObjectScale(object), { x: 1, y: 1, z: 1 });
  });
});

test('custom dimensions scale each scene object axis independently', () => {
  const object = {
    type: 'box',
    radius: 10,
    dimensions: { width: 2.7, height: 0.675, depth: 1.35 },
  };

  assert.deepEqual(getSceneObjectScale(object), { x: 2, y: 0.5, z: 1 });
});
