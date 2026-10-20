import { G1_COMMANDS, parseG1Program } from '../sim/g1Commands.js';

const commandDefinitions = new Map(G1_COMMANDS.map((command) => [command.method, command]));
const MAX_EXPANDED_COMMANDS = 100;

function getPhysicalCommands(code, adapter, isSupported) {
  const commands = [];
  const program = parseG1Program(code);
  const containsCondition = (nodes) => nodes.some((node) => (
    node.type === 'condition'
    || (node.type === 'repeat' && containsCondition(node.body))
  ));
  if (adapter !== 'SDK' && containsCondition(program)) {
    throw new Error(`Conditional programs require the authenticated G1 SDK backend; ${adapter} cannot evaluate sensor or Boolean branches.`);
  }
  const visit = (nodes) => {
    let pathCommandCount = 0;
    for (const node of nodes) {
      if (node.type === 'command') {
        if (!isSupported(node.method)) {
          throw new Error(`robot.${node.method}() is not supported by the ${adapter} connection.`);
        }
        commands.push(node);
        pathCommandCount += 1;
        continue;
      }
      if (node.type === 'condition') {
        pathCommandCount += Math.max(visit(node.then), visit(node.else));
        continue;
      }
      if (node.type === 'boolean_assignment') continue;
      for (let iteration = 0; iteration < node.times; iteration += 1) {
        pathCommandCount += visit(node.body);
      }
    }
    return pathCommandCount;
  };
  const expandedCommandCount = visit(program);
  if (expandedCommandCount > MAX_EXPANDED_COMMANDS) {
    throw new Error(`Programs may contain at most ${MAX_EXPANDED_COMMANDS} expanded commands.`);
  }
  if (commands.length === 0) {
    throw new Error('Program contains no robot commands.');
  }
  return commands;
}

export class SdkRobotConnection {
  constructor(request) {
    if (typeof request !== 'function') throw new TypeError('SDK connection requires an authenticated request function.');
    this.request = request;
  }

  async connect(interfaceName) {
    return this.request('/api/robot/connect', {
      method: 'POST',
      body: JSON.stringify(interfaceName ? { interface: interfaceName } : {}),
    });
  }

  async status() {
    return this.request('/api/robot/status', { cache: 'no-store' });
  }

  async run(code) {
    getPhysicalCommands(code, 'SDK', (method) => commandDefinitions.get(method)?.adapters.sdk === true);
    return this.request('/api/run', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async stop() {
    return this.request('/api/stop', { method: 'POST' });
  }
}

export class MockRobotConnection {
  constructor() {
    this.connected = false;
    this.running = false;
    this.executions = [];
  }

  async connect() {
    this.connected = true;
    return { status: 'connected', adapter: 'mock' };
  }

  async status() {
    return {
      status: this.connected ? 'connected' : 'disconnected',
      sdkAvailable: this.connected,
      running: this.running,
      adapter: 'mock',
    };
  }

  async run(code) {
    if (!this.connected) throw new Error('Connect the mock robot before running a program.');
    const commands = getPhysicalCommands(code, 'mock', (method) => (
      commandDefinitions.get(method)?.adapters.sdk === true
    ));
    this.running = true;
    this.executions.push(commands);
    this.running = false;
    return { status: 'completed', commandsExecuted: commands.length, adapter: 'mock' };
  }

  async stop() {
    this.running = false;
    return { status: 'stopping', adapter: 'mock' };
  }
}

export class WebRtcRobotConnection {
  constructor({ transport, commandEncoders }) {
    if (!transport || typeof transport.connect !== 'function'
      || typeof transport.status !== 'function'
      || typeof transport.run !== 'function'
      || typeof transport.stop !== 'function') {
      throw new TypeError('WebRTC connection requires a verified transport with connect, status, run, and stop methods.');
    }
    if (!commandEncoders || typeof commandEncoders !== 'object') {
      throw new TypeError('WebRTC connection requires explicit encoders for verified robot commands.');
    }
    this.transport = transport;
    this.commandEncoders = commandEncoders;
  }

  async connect(options) {
    return this.transport.connect(options);
  }

  async status() {
    return this.transport.status();
  }

  async run(code) {
    const commands = getPhysicalCommands(code, 'WebRTC', (method) => (
      commandDefinitions.get(method)?.adapters.webRtc === true
      && typeof this.commandEncoders[method] === 'function'
    ));
    const protocolCommands = commands.map((command) => (
      this.commandEncoders[command.method](command.values)
    ));
    return this.transport.run(protocolCommands);
  }

  async stop() {
    return this.transport.stop();
  }
}

export function createRobotConnection(adapter, options = {}) {
  if (adapter === 'sdk') return new SdkRobotConnection(options.request);
  if (adapter === 'mock') return new MockRobotConnection();
  if (adapter === 'webrtc') return new WebRtcRobotConnection(options);
  throw new Error(`Unknown robot connection adapter: ${adapter}`);
}
