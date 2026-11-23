// AudioWorklet that captures raw microphone samples, starting at an exact context time.
class RecTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.startAt = 0;
    this.started = false;
    this.buf = new Float32Array(8192);
    this.n = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.cmd === 'start') { this.on = true; this.startAt = m.at; this.started = false; this.n = 0; }
      if (m.cmd === 'stop') { this.flush(); this.on = false; this.port.postMessage({ type: 'stopped' }); }
    };
  }
  flush() {
    if (this.n) { this.port.postMessage({ type: 'data', data: this.buf.slice(0, this.n) }); this.n = 0; }
  }
  process(inputs) {
    const inp = inputs[0];
    if (!this.on || !inp || !inp.length) return true;
    const frameTime = currentFrame / sampleRate;
    if (frameTime + 128 / sampleRate < this.startAt) return true;
    let from = 0;
    if (!this.started) {
      from = Math.max(0, Math.round((this.startAt - frameTime) * sampleRate));
      this.started = true;
      this.port.postMessage({ type: 'first', time: frameTime + from / sampleRate });
    }
    const len = inp[0].length;
    const chs = inp.length;
    for (let i = from; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chs; c++) s += inp[c][i];
      this.buf[this.n++] = s / chs;
      if (this.n === this.buf.length) this.flush();
    }
    return true;
  }
}
registerProcessor('rec-tap', RecTap);
