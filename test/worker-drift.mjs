// Simulates a long device recording whose clock runs slower than the computer's clock, and checks that the
// encoder worker keeps the stream gapless. Usage: node test/worker-drift.mjs [workerPath] [mode]
//   mode "ts" = old protocol (blocks placed by time), "at" = new protocol (blocks carry a frame index)
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = process.argv[2] || path.join(here, '..', 'src', 'encoder.worker.js');
const mode = process.argv[3] || 'at';
const SR = 44100, N = 4096, SECONDS = 240, DRIFT = +(process.env.DRIFT || 1.004); // the device clock is 0.4% slower than the wall clock

let now = 1e9, tick = null;
const outChunks = [];
const ctx = {
  importScripts() {}, lamejs: {},
  postMessage: (m) => { if (m.t === 'mp3') outChunks.push(m.buf); },
  setInterval: (f) => { tick = f; return 1; }, clearInterval() {},
  Date: { now: () => now },
  Int32Array, Int16Array, Uint8Array, Map, Math, onmessage: null
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(workerPath, 'utf8'), ctx);
const send = (d) => ctx.onmessage({ data: d });

const start = now;
send({ t: 'init', kbps: 0, startEpoch: start });
let nextTick = start + 250;
const blocks = Math.floor((SECONDS * SR) / N);
const ts0 = start - 93;
for (let i = 0; i < blocks; i++) {
  const arrive = start + ((i + 1) * N / SR) * 1000 * DRIFT; // wall time when block i is complete
  while (nextTick <= arrive) { const keep = now; now = nextTick; tick(); now = keep; nextTick += 250; }
  now = arrive;
  const buf = new Int16Array(N * 2).fill(1000);
  if (mode === 'at') send({ t: 'pcm', k: 1, ts: ts0, at: i * N, buf });
  else send({ t: 'pcm', k: 1, ts: ts0 + (i * N / SR) * 1000, buf }); // old: time from the device clock
}
send({ t: 'stop', now });

let zeros = 0, total = 0;
for (const u of outChunks) {
  const s16 = new Int16Array(u.buffer, u.byteOffset, u.length >> 1);
  for (let i = 0; i < s16.length; i += 2) { total++; if (s16[i] === 0) zeros++; }
}
const want = blocks * N;
const ok = zeros === 0 && Math.abs(total - want) < SR / 4;
console.log(`${ok ? 'PASS' : 'FAIL'}  worker ${mode}: ${total} frames written of ${want}, silent frames ${zeros} (${(zeros / SR).toFixed(2)} s)`);
process.exit(ok ? 0 : 1);
