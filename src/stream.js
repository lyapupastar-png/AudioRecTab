// Endless audio streams (Icecast/Shoutcast, audio/mpeg and ADTS AAC): the page cannot capture them when the
// address belongs to another site, and fetch().blob() never ends. The background reads the stream itself,
// cuts it into frames, decodes with WebCodecs and hands 44.1 kHz stereo PCM to the recorder.
const MP3_BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const AAC_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

// returns { len, sr, ch } for a valid frame header at b[i], or null
function mp3Header(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
  if (ver === 1 || layer !== 1) return null;
  const bi = b[i + 2] >> 4, si = (b[i + 2] >> 2) & 3;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const br = MP3_BR[ver === 3 ? 1 : 2][bi] * 1000, sr = MP3_SR[ver][si], pad = (b[i + 2] >> 1) & 1;
  return { len: Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad, sr, ch: ((b[i + 3] >> 6) & 3) === 3 ? 1 : 2 };
}

function aacHeader(b, i) {
  if (i + 7 > b.length || b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return null;
  const si = (b[i + 2] >> 2) & 15, ch = ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6);
  if (si > 11 || ch < 1 || ch > 6) return null;
  const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
  return len < 7 ? null : { len, sr: AAC_SR[si], ch };
}

// Reads the response body of an endless stream; onPcm({ ts, buf }) receives Int16 planar stereo (L then R) at 44100 Hz.
// Returns { stop() } or null when the stream kind is not supported.
function startStream(resp, onPcm) {
  const type = (resp.headers.get('content-type') || '').toLowerCase();
  const kind = /audio\/(mpeg|mp3)/.test(type) ? 'mp3' : /aac/.test(type) ? 'aac' : null;
  if (!kind || typeof AudioDecoder === 'undefined') return null;
  const header = kind === 'mp3' ? mp3Header : aacHeader;
  const reader = resp.body.getReader();
  let dec = null, cfg = '', stopped = false, t0 = 0, done = 0, buf = new Uint8Array(0), stamp = 0;

  const emit = (ad) => {
    const n = ad.numberOfFrames, ch = ad.numberOfChannels, sr = ad.sampleRate;
    const pl = [];
    for (let c = 0; c < Math.min(ch, 2); c++) { const a = new Float32Array(n); ad.copyTo(a, { planeIndex: c, format: 'f32-planar' }); pl.push(a); }
    ad.close();
    const l = pl[0], r = pl[1] || pl[0], m = Math.max(1, Math.round((n * 44100) / sr));
    const out = new Int16Array(m * 2);
    for (let i = 0; i < m; i++) {
      const p = (i * sr) / 44100, j = Math.min(p | 0, n - 1), f = p - j, j2 = j + 1 < n ? j + 1 : j;
      const a = l[j] + (l[j2] - l[j]) * f, b = r[j] + (r[j2] - r[j]) * f;
      out[i] = (a > 1 ? 1 : a < -1 ? -1 : a) * 32767;
      out[m + i] = (b > 1 ? 1 : b < -1 ? -1 : b) * 32767;
    }
    if (!t0) t0 = Date.now();
    if (!stopped) onPcm({ ts: t0 + (done * 1000) / 44100, buf: out });
    done += m;
  };

  const feed = (h, frame) => {
    const key = h.sr + ':' + h.ch;
    if (!dec || cfg !== key) {
      if (dec) { try { dec.close(); } catch (e) { /* ignore */ } }
      cfg = key;
      dec = new AudioDecoder({ output: emit, error: () => {} });
      dec.configure({ codec: kind === 'mp3' ? 'mp3' : 'mp4a.40.2', sampleRate: h.sr, numberOfChannels: h.ch });
    }
    if (dec.state !== 'configured' || dec.decodeQueueSize > 200) return;
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: stamp, data: frame }));
    stamp += 1000;
  };

  const pump = async () => {
    try {
      while (!stopped) {
        const { value, done: end } = await reader.read();
        if (end) break;
        const nb = new Uint8Array(buf.length + value.length);
        nb.set(buf); nb.set(value, buf.length);
        buf = nb;
        let i = 0;
        while (i + 8 <= buf.length) {
          const h = header(buf, i);
          if (!h) { i++; continue; }
          if (i + h.len + 4 > buf.length) break;           // need the next header to confirm this frame
          if (!header(buf, i + h.len)) { i++; continue; }  // false sync
          feed(h, buf.slice(i, i + h.len));
          i += h.len;
        }
        buf = buf.slice(i);
        if (buf.length > 1 << 20) buf = new Uint8Array(0);
      }
    } catch (e) { /* network error or stop */ }
    try { if (dec && dec.state === 'configured') dec.close(); } catch (e) { /* ignore */ }
  };
  pump();
  return { stop() { stopped = true; reader.cancel().catch(() => {}); } };
}
