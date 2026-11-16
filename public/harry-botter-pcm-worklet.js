class HarryBotterPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pendingInput = new Float32Array(0);
    this.resamplePosition = 0;
    this.samplesPerFrame = 320;
    this.outputSamples = [];
  }

  process(inputs, outputs) {
    const channels = inputs[0];
    if (channels?.length && channels[0].length) {
      const mono = new Float32Array(channels[0].length);
      for (let channel = 0; channel < channels.length; channel += 1) {
        for (let index = 0; index < mono.length; index += 1) {
          mono[index] += channels[channel][index] / channels.length;
        }
      }

      const combined = new Float32Array(this.pendingInput.length + mono.length);
      combined.set(this.pendingInput);
      combined.set(mono, this.pendingInput.length);
      const step = sampleRate / 16_000;
      while (this.resamplePosition + 1 < combined.length) {
        const leftIndex = Math.floor(this.resamplePosition);
        const fraction = this.resamplePosition - leftIndex;
        const left = combined[leftIndex];
        const right = combined[leftIndex + 1];
        this.outputSamples.push(left + ((right - left) * fraction));
        this.resamplePosition += step;
        if (this.outputSamples.length === this.samplesPerFrame) {
          this.sendFrame();
        }
      }

      const consumed = Math.floor(this.resamplePosition);
      this.pendingInput = combined.slice(consumed);
      this.resamplePosition -= consumed;
    }

    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }

  sendFrame() {
    const frame = new ArrayBuffer(this.samplesPerFrame * 2);
    const view = new DataView(frame);
    this.outputSamples.forEach((value, index) => {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true);
    });
    this.port.postMessage({ type: 'audio', frame }, [frame]);
    this.outputSamples = [];
  }
}

registerProcessor('harry-botter-pcm', HarryBotterPCMProcessor);
