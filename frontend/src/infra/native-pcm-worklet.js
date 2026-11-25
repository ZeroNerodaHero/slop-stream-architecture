const RING_S = 1;
const PRIME_S = 0.04;
const MOST_S = 0.15;

class NativePcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions?.channels === 1 ? 1 : 2;
    this.size = Math.round(sampleRate * RING_S) * this.channels;
    this.ring = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.primed = false;
    this.prime = Math.round(sampleRate * PRIME_S) * this.channels;
    this.most = Math.round(sampleRate * MOST_S) * this.channels;
    this.port.addEventListener('message', (e) => this.push(new Float32Array(e.data)));
    this.port.start();
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i];
      this.write = (this.write + 1) % this.size;
      if (this.count < this.size) this.count++;
      else this.read = (this.read + 1) % this.size;
    }
    if (this.count > this.most) {
      const extra = this.count - this.prime;
      const skip = extra - (extra % this.channels);
      this.read = (this.read + skip) % this.size;
      this.count -= skip;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const need = frames * this.channels;
    if (!this.primed) {
      if (this.count < this.prime) return true;
      this.primed = true;
    }
    if (this.count < need) {
      this.primed = false;
      return true;
    }
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channels; c++) {
        const to = output[c];
        if (to) to[i] = this.ring[this.read];
        this.read = (this.read + 1) % this.size;
      }
      for (let c = this.channels; c < output.length; c++) output[c][i] = output[0][i];
    }
    this.count -= need;
    return true;
  }
}

registerProcessor('native-pcm', NativePcm);
