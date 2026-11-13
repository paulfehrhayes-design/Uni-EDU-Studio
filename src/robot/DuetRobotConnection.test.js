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

test('DUET connection stores and deletes measured motion recordings', async () => {
  const requests = [];
  const connection = new DuetRobotConnection(async (...args) => {
    requests.push(args);
    return { recordings: [] };
  });
  const recording = {
    name: 'Wave',
    controller_version: 'duet',
    command: 'duet.wave_right("mid", 1.5)',
    joint_names: Array(10).fill('joint'),
    frames: [
    { time: 0, joints: Array(10).fill(0) },
    { time: 0.1, joints: Array(10).fill(0.1) },
    ],
  };

  await connection.recordings();
  await connection.saveRecording(recording);
  await connection.deleteRecording('capture-1');

  assert.deepEqual(requests.map(([url]) => url), [
    '/api/robot/recordings',
    '/api/robot/recordings',
    '/api/robot/recordings/capture-1',
  ]);
  assert.deepEqual(requests[0][1], { cache: 'no-store' });
  assert.deepEqual(JSON.parse(requests[1][1].body), recording);
  assert.deepEqual(requests[2][1], { method: 'DELETE' });
});

test('DUET commissioning exposes isolated evidence and review endpoints', async () => {
  const requests = [];
  const connection = new DuetRobotConnection(async (...args) => {
    requests.push(args);
    return { status: 'passed' };
  });

  await connection.commissioningStatus();
  await connection.commissioningEvidence();
  await connection.startCommissioning();
  await connection.runCommissioningStep(2);
  await connection.reviewCommissioningStep(2, {
    passed: true,
    observed: true,
    observedResult: 'Observed the expected response.',
    notes: 'Clear area.',
  });

  assert.deepEqual(requests.map(([url]) => url), [
    '/api/duet/commissioning',
    '/api/duet/commissioning/evidence',
    '/api/duet/commissioning/start',
    '/api/duet/commissioning/step',
    '/api/duet/commissioning/review',
  ]);
  assert.deepEqual(requests[1][1], { cache: 'no-store' });
  assert.deepEqual(JSON.parse(requests[4][1].body), {
    step_index: 2,
    passed: true,
    observed: true,
    observed_result: 'Observed the expected response.',
    notes: 'Clear area.',
  });
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
