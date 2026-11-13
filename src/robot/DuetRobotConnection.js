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

  async motions() {
    return this.request('/api/duet/motions', { cache: 'no-store' });
  }

  async saveMotion(name, code) {
    return this.request('/api/duet/motions', {
      method: 'POST',
      body: JSON.stringify({ name, code }),
    });
  }

  async recordings() {
    return this.request('/api/robot/recordings', { cache: 'no-store' });
  }

  async saveRecording(recording) {
    return this.request('/api/robot/recordings', {
      method: 'POST',
      body: JSON.stringify(recording),
    });
  }

  async deleteRecording(recordingId) {
    return this.request(`/api/robot/recordings/${encodeURIComponent(recordingId)}`, {
      method: 'DELETE',
    });
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

  async commissioningStatus() {
    return this.request('/api/duet/commissioning', { cache: 'no-store' });
  }

  async commissioningEvidence() {
    return this.request('/api/duet/commissioning/evidence', { cache: 'no-store' });
  }

  async startCommissioning() {
    return this.request('/api/duet/commissioning/start', { method: 'POST' });
  }

  async runCommissioningStep(stepIndex) {
    return this.request('/api/duet/commissioning/step', {
      method: 'POST',
      body: JSON.stringify({ step_index: stepIndex }),
    });
  }

  async reviewCommissioningStep(stepIndex, { passed, observed, observedResult, notes = '' }) {
    return this.request('/api/duet/commissioning/review', {
      method: 'POST',
      body: JSON.stringify({
        step_index: stepIndex,
        passed,
        observed,
        observed_result: observedResult,
        notes,
      }),
    });
  }

  async abortCommissioning() {
    return this.request('/api/duet/commissioning/abort', { method: 'POST' });
  }
}
