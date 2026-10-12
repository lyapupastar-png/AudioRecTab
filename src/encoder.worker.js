importScripts('lame.min.js');
let SR = 44100;
const CAP = 960000; // ring buffer: about 20 s at 44.1 kHz, 10 s at 96 kHz
let enc = null, wav = false, startEpoch = 0, flushed = 0, maxPos = 0, timer = null, holdPos = Infinity, byFrames = false;
const L = new Int32Array(CAP), R = new Int32Array(CAP), frames = new Map();
const clamp = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

function out(b) {
  if (!b || !b.length) return;
  const u = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  postMessage({ t: 'mp3', buf: u }, [u.buffer]);
}

function flushTo(target) {
  while (flushed < target) {
    const m = Math.min(target - flushed, 9216), l = new Int16Array(m), r = new Int16Array(m);
    for (let i = 0; i < m; i++) {
      const x = (flushed + i) % CAP;
      l[i] = clamp(L[x]); r[i] = clamp(R[x]); L[x] = 0; R[x] = 0;
    }
    if (wav) {
      const w = new Int16Array(m * 2);
      for (let i = 0; i < m; i++) { w[2 * i] = l[i]; w[2 * i + 1] = r[i]; }
      out(new Uint8Array(w.buffer));
    } else out(enc.encodeBuffer(l, r));
    flushed += m;
  }
}

onmessage = (e) => {
  const d = e.data;
  if (d.t === 'init') {
    wav = d.kbps === 0;
    if (d.sr > 0) SR = d.sr; // an input device is recorded at its own rate, tabs at 44100
    if (!wav) enc = new lamejs.Mp3Encoder(2, SR, d.kbps);
    startEpoch = d.startEpoch;
    timer = setInterval(() => {
      // device recording: follow the data (0.5 s behind the newest block), not the computer's clock
      const target = byFrames ? maxPos - (SR >> 1) : Math.min(Math.floor(((Date.now() - startEpoch) * SR) / 1000) - SR, holdPos);
      if (target > flushed) flushTo(target);
    }, 250);
  } else if (d.t === 'pcm') {
    const n = d.buf.length >> 1;
    let f = frames.get(d.k);
    if (!f) frames.set(d.k, (f = { next: null, base: null }));
    let pos;
    if (d.at !== undefined) {
      // blocks of an input device carry their frame index: contiguous by construction
      byFrames = true;
      if (f.base === null) f.base = Math.max(0, Math.round(((d.ts - startEpoch) * SR) / 1000));
      pos = f.base + d.at;
    } else {
      pos = Math.round(((d.ts - startEpoch) * SR) / 1000);
      if (f.next !== null && Math.abs(pos - f.next) < 2205) pos = f.next;
    }
    f.next = pos + n;
    if (pos + n > maxPos) maxPos = pos + n;
    for (let i = 0; i < n; i++) {
      const p = pos + i;
      if (p < flushed) continue;
      if (p >= flushed + CAP) break;
      const x = p % CAP;
      L[x] += d.buf[i]; R[x] += d.buf[n + i];
    }
  } else if (d.t === 'hold') {
    // the track ended: do not encode the silence that follows until we know whether sound resumes
    holdPos = Math.floor(((d.at - startEpoch) * SR) / 1000);
  } else if (d.t === 'release') {
    holdPos = Infinity;
  } else if (d.t === 'stop') {
    clearInterval(timer);
    const nowS = Math.floor(((d.now - startEpoch) * SR) / 1000);
    flushTo(Math.max(flushed, byFrames ? maxPos : Math.min(maxPos, nowS)));
    if (!wav) out(enc.flush());
    postMessage({ t: 'end' });
  }
};
