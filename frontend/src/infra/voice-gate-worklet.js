const HOLD_S = 0.25;
const ATTACK_S = 0.004;
const RELEASE_S = 0.06;

class VoiceGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.gain = 1;
    this.hold = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output) return true;
    const threshold = parameters.threshold[0];
    const block = input[0].length;
    let sum = 0;
    for (const s of input[0]) sum += s * s;
    const rms = Math.sqrt(sum / block);
    this.hold = threshold <= 0 || rms >= threshold ? HOLD_S * sampleRate : Math.max(0, this.hold - block);
    const target = this.hold > 0 ? 1 : 0;
    const up = 1 / (ATTACK_S * sampleRate);
    const down = 1 / (RELEASE_S * sampleRate);
    let g = this.gain;
    for (let c = 0; c < output.length; c++) {
      const from = input[c] ?? input[0];
      const to = output[c];
      g = this.gain;
      for (let i = 0; i < to.length; i++) {
        g = target > g ? Math.min(target, g + up) : Math.max(target, g - down);
        to[i] = from[i] * g;
      }
    }
    this.gain = g;
    return true;
  }
}

registerProcessor('voice-gate', VoiceGate);
