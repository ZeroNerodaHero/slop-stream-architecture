const FRAMES = 1024;

class RestreamPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(FRAMES);
    this.right = new Float32Array(FRAMES);
    this.at = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] ?? input[0];
    for (let i = 0; i < l.length; i++) {
      this.left[this.at] = l[i];
      this.right[this.at] = r[i];
      this.at++;
      if (this.at === FRAMES) {
        const data = new Float32Array(FRAMES * 2);
        data.set(this.left, 0);
        data.set(this.right, FRAMES);
        this.port.postMessage(data, [data.buffer]);
        this.at = 0;
      }
    }
    return true;
  }
}

registerProcessor('restream-pcm', RestreamPcm);
