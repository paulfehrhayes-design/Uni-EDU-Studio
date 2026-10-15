import test from 'node:test';
import assert from 'node:assert/strict';
import { createRobotConnection, MockRobotConnection, SdkRobotConnection, WebRtcRobotConnection } from './RobotConnection.js';

test('mock connection runs catalog robot commands and expands bounded loops', async () => {
  const connection = new MockRobotConnection();
  await assert.rejects(connection.run('robot.walk(1)'), /Connect the mock robot/);
  await connection.connect();
  const result = await connection.run('for _ in range(2):\n    robot.walk(1)');

  assert.deepEqual(result, { status: 'completed', commandsExecuted: 2, adapter: 'mock' });
  assert.equal(connection.executions[0].length, 2);
  await connection.run('robot.wait(1)');
  assert.equal(connection.executions[1][0].method, 'wait');
  await assert.rejects(connection.run('robot.waveleft("high")'), /not supported by the mock connection/);
  await assert.rejects(
    connection.run('for _ in range(20):\n    for _ in range(20):\n        robot.walk(1)'),
    /at most 100 expanded commands/,
  );
  await assert.rejects(
    connection.run('if robot.front_distance_m() < 1:\n    robot.walk(1)'),
    /require the authenticated G1 SDK backend and a live MID-360 sensor/,
  );
});

test('SDK adapter wraps the existing API and rejects unsupported commands before sending', async () => {
  const requests = [];
  const connection = new SdkRobotConnection(async (...args) => {
    requests.push(args);
    return { status: 'connected', sdkAvailable: true };
  });

  await connection.connect('eth0');
  await connection.status();
  await connection.run('robot.walk(1)\nrobot.wait(1)\nrobot.say("Hello, G1", 1)\nrobot.getvolume()');
  await connection.run(
    'if robot.front_distance_m() < 1:\n'
    + '    robot.walk(1)\n'
    + 'else:\n'
    + '    robot.turn("left", 90)',
  );
  await connection.stop();
  await assert.rejects(connection.run('robot.kickleft("mid")'), /not supported by the SDK connection/);

  assert.deepEqual(requests.map(([url]) => url), [
    '/api/robot/connect',
    '/api/robot/status',
    '/api/run',
    '/api/run',
    '/api/stop',
  ]);
  assert.deepEqual(JSON.parse(requests[0][1].body), { interface: 'eth0' });
  assert.deepEqual(JSON.parse(requests[2][1].body), {
    code: 'robot.walk(1)\nrobot.wait(1)\nrobot.say("Hello, G1", 1)\nrobot.getvolume()',
  });
  assert.match(JSON.parse(requests[3][1].body).code, /else:/);
});

test('SDK status request can test LiDAR without running a robot command', async () => {
  const requests = [];
  const connection = new SdkRobotConnection(async (...args) => {
    requests.push(args);
    return {
      sdkAvailable: false,
      distanceSensor: {
        ready: true,
        distance_m: 0.8,
        age_ms: 40,
        frame_id: 'livox_frame',
      },
    };
  });

  const status = await connection.status();

  assert.equal(status.sdkAvailable, false);
  assert.equal(status.distanceSensor.ready, true);
  assert.deepEqual(requests.map(([url]) => url), ['/api/robot/status']);
});

test('WebRTC adapter does not infer command support from an encoder alone', async () => {
  const sentCommands = [];
  const transport = {
    connect: async () => ({ status: 'connected' }),
    status: async () => ({ status: 'connected' }),
    run: async (commands) => {
      sentCommands.push(commands);
      return { status: 'completed' };
    },
    stop: async () => ({ status: 'stopping' }),
  };
  const connection = new WebRtcRobotConnection({
    transport,
    commandEncoders: { walk: (values) => ({ action: 'walk', values }) },
  });

  await assert.rejects(connection.run('robot.walk(1)'), /not supported by the WebRTC connection/);
  assert.deepEqual(sentCommands, []);
});

test('connection factory exposes mock and SDK adapters and rejects unknown adapters', () => {
  assert.ok(createRobotConnection('mock') instanceof MockRobotConnection);
  assert.ok(createRobotConnection('sdk', { request: async () => ({}) }) instanceof SdkRobotConnection);
  assert.throws(() => createRobotConnection('unknown'), /Unknown robot connection adapter/);
});
