import assert from 'node:assert/strict';
import test from 'node:test';
import { DuetRobotConnection } from './DuetRobotConnection.js';

test('DUET connection uses isolated connect, status, run, stop and disconnect endpoints', async () => {
  const requests = [];
  const connection = new DuetRobotConnection(async (...args) => {
    requests.push(args);
    return { status: 'connected' };
  });

  await connection.connect();
  await connection.status();
  await connection.run('duet.move(0.2, 0, 0, 1)');
  await connection.stop();
  await connection.disconnect();

  assert.deepEqual(requests.map(([url]) => url), [
    '/api/duet/connect',
    '/api/duet/status',
    '/api/duet/run',
    '/api/duet/stop',
    '/api/duet/disconnect',
  ]);
  assert.deepEqual(requests[1][1], { cache: 'no-store' });
  assert.deepEqual(JSON.parse(requests[2][1].body), { code: 'duet.move(0.2, 0, 0, 1)' });
});

test('DUET connection rejects legacy commands before sending a request', async () => {
  const requests = [];
  const connection = new DuetRobotConnection(async (...args) => {
    requests.push(args);
  });
  await assert.rejects(connection.run('robot.walk(1)'), /Unsupported statement/);
  assert.deepEqual(requests, []);
});

test('DUET connection rejects empty programs before sending a request', async () => {
  const requests = [];
  const connection = new DuetRobotConnection(async (...args) => {
    requests.push(args);
  });
  await assert.rejects(connection.run('# no commands'), /contains no commands/);
  assert.deepEqual(requests, []);
});

test('DUET connection requires authenticated request transport', () => {
  assert.throws(() => new DuetRobotConnection(), /authenticated request function/);
});
