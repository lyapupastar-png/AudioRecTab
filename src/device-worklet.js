// Captures the input device on the audio thread (a ScriptProcessor on the page's main thread can skip blocks).
// Posts 4096-frame blocks; "at" is the index of the block's first frame counted from the start of the capture.
class Cap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = new Float32Array(4096); this.r = new Float32Array(4096); this.i = 0; this.at = 0;
  }
  process(inputs) {
    const inp = inputs[0] || [];
    const a = inp[0], b = inp[1] || inp[0];
    for (let k = 0; k < 128; k++) {
      this.l[this.i] = a ? a[k] : 0; this.r[this.i] = b ? b[k] : 0;
      if (++this.i === 4096) {
        this.port.postMessage({ l: this.l, r: this.r, at: this.at }, [this.l.buffer, this.r.buffer]);
        this.at += 4096; this.i = 0;
        this.l = new Float32Array(4096); this.r = new Float32Array(4096);
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);
