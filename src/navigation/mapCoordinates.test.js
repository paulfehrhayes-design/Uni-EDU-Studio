import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWorldPointInKnownFreeSpace,
  mapLocalToWorld,
  occupancyAtMapLocalPoint,
  worldToMapLocal,
} from './mapCoordinates.js';

const map = {
  resolution_m: 0.5,
  width: 2,
  height: 2,
  origin: { x: 3, y: -2, yaw_rad: Math.PI / 2 },
};

test('map-local and world coordinates round-trip with a rotated origin', () => {
  const world = mapLocalToWorld(0.75, 0.25, map);
  assert.ok(Math.abs(world.x - 2.75) < 1e-12);
  assert.ok(Math.abs(world.y - -1.25) < 1e-12);
  const local = worldToMapLocal(world.x, world.y, map);
  assert.ok(Math.abs(local.x - 0.75) < 1e-12);
  assert.ok(Math.abs(local.y - 0.25) < 1e-12);
});

test('map-cell lookup uses bottom-origin occupancy rows and rejects out-of-map points', () => {
  const occupancy = [0, 100, -1, 10];
  assert.equal(occupancyAtMapLocalPoint(0.25, 0.25, map, occupancy), 0);
  assert.equal(occupancyAtMapLocalPoint(0.25, 0.75, map, occupancy), -1);
  assert.equal(occupancyAtMapLocalPoint(0.75, 0.25, map, occupancy), 100);
  assert.equal(occupancyAtMapLocalPoint(-0.01, 0.25, map, occupancy), null);
  assert.equal(occupancyAtMapLocalPoint(0.25, 0.25, map, [0]), null);
});

test('waypoints remain in world coordinates and only known free cells are accepted', () => {
  const snapshot = { map, data: [0, 100, -1, 10] };
  const freePoint = mapLocalToWorld(0.25, 0.25, map);
  const occupiedPoint = mapLocalToWorld(0.75, 0.25, map);
  const unknownPoint = mapLocalToWorld(0.25, 0.75, map);
  assert.equal(isWorldPointInKnownFreeSpace(freePoint.x, freePoint.y, snapshot), true);
  assert.equal(isWorldPointInKnownFreeSpace(occupiedPoint.x, occupiedPoint.y, snapshot), false);
  assert.equal(isWorldPointInKnownFreeSpace(unknownPoint.x, unknownPoint.y, snapshot), false);
  assert.equal(isWorldPointInKnownFreeSpace(100, 100, snapshot), false);
});
