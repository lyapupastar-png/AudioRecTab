'use strict';
const recs = new Map();   // tabId -> active recording
const dls = new Map();    // downloadId -> { url, meta }
const waits = new Map();  // tabId -> { kbps }: waiting for sound, recording starts by itself
let ping = null;

// ---------- IndexedDB: encoded MP3 chunks survive a crash ----------
const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbP = new Promise((res, rej) => {
  const q = indexedDB.open('mp3tab', 1);
  q.onupgradeneeded = () => {
    q.result.createObjectStore('chunks', { keyPath: ['rec', 'seq'] });
    q.result.createObjectStore('meta', { keyPath: 'id' });
  };
  q.onsuccess = () => res(q.result);
  q.onerror = () => rej(q.error);
});
const range = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);
const putChunk = async (id, seq, data) => rq((await dbP).transaction('chunks', 'readwrite').objectStore('chunks').put({ rec: id, seq, data }));
const putMeta = async (m) => rq((await dbP).transaction('meta', 'readwrite').objectStore('meta').put(m));
const allMeta = async () => rq((await dbP).transaction('meta').objectStore('meta').getAll());
const getChunks = async (id) => (await rq((await dbP).transaction('chunks').objectStore('chunks').getAll(range(id)))).map((x) => x.data);
async function delRec(id) {
  const x = (await dbP).transaction(['chunks', 'meta'], 'readwrite');
  x.objectStore('chunks').delete(range(id));
  x.objectStore('meta').delete(id);
  return new Promise((res) => { x.oncomplete = res; });
}

// ---------- ID3v2.3 tag ----------
function id3(m) {
  const enc = new TextEncoder();
  const txt = (s) => {
    const u = new Uint8Array(3 + s.length * 2 + 2);
    u[0] = 1; u[1] = 0xff; u[2] = 0xfe;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[3 + i * 2] = c & 255; u[4 + i * 2] = c >> 8; }
    return u;
  };
  const fr = (id, s) => {
    const b = txt(s), h = new Uint8Array(10 + b.length);
    h.set(enc.encode(id));
    new DataView(h.buffer).setUint32(4, b.length);
    h.set(b, 10);
    return h;
  };
  const parts = [
    fr('TIT2', m.title || m.host || 'AudioRecTab'), fr('TPE1', m.host || 'AudioRecTab'),
    fr('TALB', 'AudioRecTab'), fr('TYER', String(new Date(m.startedAt).getFullYear()))
  ];
  const size = parts.reduce((a, p) => a + p.length, 0), head = new Uint8Array(10);
  head.set(enc.encode('ID3'));
  head[3] = 3;
  head[6] = (size >> 21) & 127; head[7] = (size >> 14) & 127; head[8] = (size >> 7) & 127; head[9] = size & 127;
  return new Blob([head, ...parts]);
}

// ---------- saving ----------
function wavHeader(n, sr = 44100) {
  const h = new DataView(new ArrayBuffer(44)), w = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); h.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true);
  h.setUint32(24, sr, true); h.setUint32(28, sr * 4, true); h.setUint16(32, 4, true); h.setUint16(34, 16, true);
  w(36, 'data'); h.setUint32(40, n, true);
  return h.buffer;
}

async function saveRec(m) {
  const chunks = await getChunks(m.id);
  if (!chunks.length) { await delRec(m.id); return false; }
  const wav = m.fmt === 'wav';
  const url = URL.createObjectURL(new Blob([wav ? wavHeader(chunks.reduce((n, c) => n + c.length, 0), m.sr || 44100) : id3(m), ...chunks], { type: wav ? 'audio/wav' : 'audio/mpeg' }));
  const d = new Date(m.startedAt), p = (n) => String(n).padStart(2, '0');
  const clean = (v) => v.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  const { nameTpl } = await browser.storage.local.get('nameTpl');
  const vars = { title: m.title || m.host || 'tab', host: m.host || '', date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}` };
  const name = clean((nameTpl || '{title} {date} {time}').replace(/\{(title|host|date|time)\}/g, (x, k) => vars[k])).slice(0, 120) || 'tab';
  try {
    const dl = await browser.downloads.download({ url, filename: `AudioRecTab/${name}.${wav ? 'wav' : 'mp3'}`, conflictAction: 'uniquify', saveAs: false });
    dls.set(dl, { url, meta: m });
    await putMeta(Object.assign({}, m, { saved: true }));
    keepAlive();
    return true;
  } catch (e) {
    URL.revokeObjectURL(url);
    return false;
  }
}

browser.downloads.onChanged.addListener((c) => {
  const x = dls.get(c.id);
  if (!x || !c.state) return;
  if (c.state.current === 'complete') { URL.revokeObjectURL(x.url); dls.delete(c.id); delRec(x.meta.id); }
  else if (c.state.current === 'interrupted') { URL.revokeObjectURL(x.url); dls.delete(c.id); putMeta(Object.assign({}, x.meta, { saved: false })); }
});

// ---------- recording ----------
// toolbar icon: green dot while idle, red while any tab is recording. The icon is global (not per tab):
// a popup window has no toolbar, so the person watches the main window's button, whatever tab is active there.
// The badge stays only for the waiting mode.
function updateIcon() {
  browser.action.setIcon({ path: recs.size ? 'icons/icon-rec.svg' : 'icons/icon.svg' }).catch(() => {});
}
function badge(tabId, on, text = 'REC', color = '#d32f2f') {
  updateIcon();
  const rec = on && text === 'REC';
  browser.action.setBadgeText({ tabId, text: on && !rec ? text : '' }).catch(() => {});
  if (on && !rec) browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function keepAlive() {
  if (ping) return;
  ping = setInterval(() => {
    if (!recs.size && !dls.size && !waits.size) { clearInterval(ping); ping = null; return; }
    browser.runtime.getPlatformInfo();
  }, 10000);
}

function onWorker(r, d) {
  if (d.t === 'mp3') {
    r.bytes += d.buf.length;
    const s = r.seq++;
    r.chain = r.chain.then(() => putChunk(r.id, s, d.buf)).catch(() => {});
  } else if (d.t === 'end') finish(r);
}

async function finish(r) {
  stopStreams(String(r.tabId));
  r.worker.terminate();
  recs.delete(r.tabId);
  badge(r.tabId, false);
  await r.chain;
  await saveRec({ id: r.id, title: r.title, host: r.host, startedAt: r.startedAt, fmt: r.kbps === 0 ? 'wav' : 'mp3', sr: r.sr });
}

async function start(tabId, kbps, opts = {}) {
  if (recs.has(tabId)) return { ok: true };
  waits.delete(tabId);
  const r = { id: `${Date.now()}-${tabId}`, tabId, sr: opts.sr > 0 ? opts.sr : 44100, startedAt: opts.t0 ? Math.floor(opts.t0) : Date.now(), kbps, bytes: 0, seq: 0, chain: Promise.resolve(), title: '', host: '', stopping: false, auto: !!opts.auto, busy: new Map(), endT: null, endAt: 0 };
  r.worker = new Worker('encoder.worker.js');
  r.worker.onmessage = (ev) => onWorker(r, ev.data);
  r.worker.postMessage({ t: 'init', kbps, sr: r.sr, startEpoch: r.startedAt });
  recs.set(tabId, r);
  let resp = null;
  try { resp = await browser.tabs.sendMessage(tabId, { type: 'rec', mode: 'on' }); } catch (e) { /* no receiver */ }
  if (!resp || !resp.ok) { r.worker.terminate(); recs.delete(tabId); return { error: 'unsupported' }; }
  r.title = resp.title; r.host = resp.host;
  await putMeta({ id: r.id, title: r.title, host: r.host, startedAt: r.startedAt, saved: false, fmt: kbps === 0 ? 'wav' : 'mp3', sr: r.sr });
  badge(tabId, true);
  keepAlive();
  return { ok: true };
}

async function stop(tabId) {
  const r = recs.get(tabId);
  if (!r || r.stopping) return { ok: true };
  r.stopping = true;
  stopStreams(String(tabId));
  clearTimeout(r.endT);
  try { await browser.tabs.sendMessage(tabId, { type: 'rec', mode: 'off' }); } catch (e) { /* tab gone */ }
  await new Promise((res) => setTimeout(res, 1000));
  // after the track has ended, cut the file where the sound ended instead of at the click/timer
  r.worker.postMessage({ t: 'stop', now: r.endAt || Date.now() });
  return { ok: true };
}

// ---------- wait-for-sound mode ----------
async function watch(tabId, kbps) {
  if (recs.has(tabId) || waits.has(tabId)) return { ok: true };
  waits.set(tabId, { kbps });
  let resp = null;
  try { resp = await browser.tabs.sendMessage(tabId, { type: 'rec', mode: 'watch' }); } catch (e) { /* no receiver */ }
  if (!resp || !resp.ok) { waits.delete(tabId); return { error: 'unsupported' }; }
  badge(tabId, true, 'WAIT', '#f57c00');
  keepAlive();
  return { ok: true };
}

async function unwatch(tabId) {
  if (!waits.delete(tabId)) return { ok: true };
  badge(tabId, false);
  try { await browser.tabs.sendMessage(tabId, { type: 'rec', mode: 'off' }); } catch (e) { /* tab gone */ }
  return { ok: true };
}

browser.tabs.onRemoved.addListener((id) => {
  waits.delete(id);
  const r = recs.get(id);
  if (r && !r.stopping) { r.stopping = true; r.worker.postMessage({ t: 'stop', now: Date.now() }); }
});
browser.tabs.onUpdated.addListener((id, ch) => {
  if (ch.status !== 'loading') return;
  if (recs.has(id)) badge(id, true);
  else if (waits.has(id)) badge(id, true, 'WAIT', '#f57c00');
});

async function recovered() {
  const active = new Set([...recs.values()].map((r) => r.id));
  const pending = new Set([...dls.values()].map((x) => x.meta.id));
  return (await allMeta()).filter((m) => !m.saved && !active.has(m.id) && !pending.has(m.id));
}

browser.runtime.onStartup.addListener(async () => {
  for (const m of await allMeta()) if (m.saved) await delRec(m.id);
});


// ---------- media from other sites: files by blob, endless radio streams by stream.js ----------
const streams = new Map();
function stopStreams(prefix) {
  for (const [k, v] of streams) if (k === prefix || k.startsWith(prefix + ':')) { v.stop(); streams.delete(k); }
}
async function fetchForTab(tabId, frameId, id, url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return {};
    const n = +resp.headers.get('content-length');
    if (n && n <= 60e6) return { blob: await resp.blob() };
    const r = recs.get(tabId);
    if (!r && resp.body) { resp.body.cancel(); return { norec: true }; }
    const s = r && !r.stopping && startStream(resp, (d) => r.worker.postMessage({ t: 'pcm', k: 'st' + frameId + ':' + id, ts: d.ts, buf: d.buf }, [d.buf.buffer]));
    if (!s) { if (resp.body) resp.body.cancel(); return {}; }
    streams.set(tabId + ':' + frameId + ':' + id, s);
    return { stream: true };
  } catch (e) { return {}; }
}

browser.runtime.onMessage.addListener((m, sender) => {
  const tabId = sender.tab && sender.tab.id;
  switch (m.type) {
    case 'hello': return Promise.resolve({ on: recs.has(tabId) && !recs.get(tabId).stopping, watch: waits.has(tabId) });
    case 'pcm': {
      const r = recs.get(tabId);
      if (r && !r.stopping) r.worker.postMessage({ t: 'pcm', k: sender.frameId, ts: m.ts, at: m.at, buf: m.buf }, [m.buf.buffer]);
      return;
    }
    case 'fetchBlob': return fetchForTab(tabId, sender.frameId, m.id, m.url);
    case 'streamStop': stopStreams(tabId + ':' + sender.frameId + ':' + m.id); return;
    case 'arm': browser.tabs.sendMessage(m.tabId, { type: 'rec', mode: 'arm' }).catch(() => {}); return;
    case 'sound': {
      const w = waits.get(tabId);
      if (!w || recs.has(tabId)) return;
      waits.delete(tabId);
      return start(tabId, w.kbps, { auto: true, t0: m.t0 }).then((res) => { if (res && res.error) badge(tabId, false); return res; });
    }
    case 'busy': {
      const r = recs.get(tabId);
      if (!r || r.stopping) return;
      r.busy.set(sender.frameId, { v: !!m.v, p: !!m.p });
      if (!r.auto) return;
      const all = [...r.busy.values()];
      if (all.some((x) => x.v)) {
        if (r.endT) { clearTimeout(r.endT); r.endT = null; r.endAt = 0; r.endDelay = 0; r.worker.postMessage({ t: 'release' }); }
      } else {
        // nothing is playing: ended -> stop after 2.5 s, paused -> after 5 s, unless something plays again meanwhile
        const delay = all.some((x) => x.p) ? 5000 : 2500;
        if (r.endT && r.endDelay === delay) return;
        if (!r.endT) {
          r.endAt = Date.now() + 300;
          r.worker.postMessage({ t: 'hold', at: r.endAt });
        }
        clearTimeout(r.endT);
        r.endDelay = delay;
        r.endT = setTimeout(() => { r.endT = null; if (recs.get(tabId) === r) stop(tabId); }, delay);
      }
      return;
    }
    case 'watch': return watch(m.tabId, m.kbps);
    case 'unwatch': return unwatch(m.tabId);
    case 'start': return start(m.tabId, m.kbps, { sr: m.sr });
    case 'stop': return stop(m.tabId);
    case 'state': {
      const r = recs.get(m.tabId);
      return Promise.resolve({ recording: !!r && !r.stopping, saving: !!r && r.stopping, waiting: waits.has(m.tabId), auto: !!r && r.auto, elapsed: r ? Date.now() - r.startedAt : 0, bytes: r ? r.bytes : 0 });
    }
    case 'recovered': return recovered();
    case 'recSave': return allMeta().then((all) => { const x = all.find((y) => y.id === m.id); return x ? saveRec(x) : false; });
    case 'recDiscard': return delRec(m.id).then(() => true);
  }
});

// ---------- hotkeys ----------
browser.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const { kbps = 192 } = await browser.storage.local.get('kbps');
  if (cmd === 'toggle-record') {
    if (recs.has(tab.id)) await stop(tab.id);
    else if (waits.has(tab.id)) await unwatch(tab.id);
    else await start(tab.id, kbps);
  } else if (cmd === 'toggle-watch') {
    if (recs.has(tab.id)) await stop(tab.id);
    else if (waits.has(tab.id)) await unwatch(tab.id);
    else await watch(tab.id, kbps);
  }
});
