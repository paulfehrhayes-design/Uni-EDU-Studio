import { parseDuetProgram } from '../sim/duetCommands.js';

export class DuetRobotConnection {
  constructor(request) {
    if (typeof request !== 'function') {
      throw new TypeError('DUET connection requires an authenticated request function.');
    }
    this.request = request;
  }

  async connect() {
    return this.request('/api/duet/connect', { method: 'POST' });
  }

  async disconnect() {
    return this.request('/api/duet/disconnect', { method: 'POST' });
  }

  async status() {
    return this.request('/api/duet/status', { cache: 'no-store' });
  }

  async run(code) {
    if (!parseDuetProgram(code).length) {
      throw new Error('DUET program contains no commands.');
    }
    return this.request('/api/duet/run', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async stop() {
    return this.request('/api/duet/stop', { method: 'POST' });
  }
}
