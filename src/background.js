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
  const parts = [];
  if (m.title) parts.push(fr('TIT2', m.title));
  if (m.artist) parts.push(fr('TPE1', m.artist));
  if (!parts.length) return new Blob([]);
  const size = parts.reduce((a, p) => a + p.length, 0), head = new Uint8Array(10);
  head.set(enc.encode('ID3'));
  head[3] = 3;
  head[6] = (size >> 21) & 127; head[7] = (size >> 14) & 127; head[8] = (size >> 7) & 127; head[9] = size & 127;
  return new Blob([head, ...parts]);
}

function splitTags(s) {
  s = s.replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.+?)\s*[-–—]\s+(.+)$/) || s.match(/^(.+?)\s+[-–—]\s*(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: s };
}

function tabTags(raw, host) {
  let s = (raw || '').replace(/^\(\d+\+?\)\s*/, '').trim();
  if (/soundcloud/i.test(host || '')) {
    const m = s.match(/^(?:Listen to|Stream)\s+(.+?)\s+by\s+([^|]+?)(?:\s+in\s+[^|]*)?\s+(?:online for free\s+)?on SoundCloud$/i)
      || s.match(/^Stream\s+(.+?)\s+by\s+(.+?)\s*\|/i);
    if (m) return { title: m[1].trim(), artist: m[2].trim() };
  }
  s = s.replace(/\s+[-–—|]\s+YouTube(?: Music)?$/i, '');
  return splitTags(s);
}

function tagsFor(m, tpl) {
  if (tpl && !tpl.includes('{title}')) {
    const own = tpl.replace(/\{(date|time|host)\}/g, ' ');
    if (own.trim()) return splitTags(own);
  }
  return tabTags(m.title, m.host);
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
  const { nameTpl } = await browser.storage.local.get('nameTpl');
  const url = URL.createObjectURL(new Blob([wav ? wavHeader(chunks.reduce((n, c) => n + c.length, 0), m.sr || 44100) : id3(tagsFor(m, nameTpl)), ...chunks], { type: wav ? 'audio/wav' : 'audio/mpeg' }));
  const d = new Date(m.startedAt), p = (n) => String(n).padStart(2, '0');
  const clean = (v) => v.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
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
  if (browser.pageAction) browser.pageAction.setIcon({ tabId, path: on && text === 'REC' ? 'icons/icon-rec.svg' : 'icons/icon.svg' }).catch(() => {});
  pageIconById(tabId);
  const rec = on && text === 'REC';
  browser.action.setBadgeText({ tabId, text: on && !rec ? text : '' }).catch(() => {});
  if (on && !rec) browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function keepAlive() {
  if (ping) return;
  ping = setInterval(() => {
    if (!recs.size && !dls.size && !waits.size && !fsJobs.size) { clearInterval(ping); ping = null; return; }
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

// silence detector: a player is playing, yet nothing audible reaches the recording (DRM, players that hide the sound)
const SIL_MS = 7000;
const drmOf = (tabId) => browser.tabs.sendMessage(tabId, { type: 'media' }, { frameId: 0 }).then((l) => (l || []).some((e) => e.drm)).catch(() => false);
function warnBadge(tabId, on) {
  browser.action.setBadgeText({ tabId, text: on ? '!' : '' }).catch(() => {});
  if (on) browser.action.setBadgeBackgroundColor({ tabId, color: '#f9a825' }).catch(() => {});
}
function heard(r, buf) {
  for (let i = 0; i < buf.length; i += 3) {
    const v = buf[i];
    if (v > 2 || v < -2) { r.loudAt = Date.now(); if (r.warn) { r.warn = ''; warnBadge(r.tabId, false); } return; }
  }
}
async function silCheck(r) {
  if (r.stopping || recs.get(r.tabId) !== r) return;
  if (!r.warn && Date.now() - r.loudAt > SIL_MS && [...r.busy.values()].some((x) => x.v)) {
    const drm = await drmOf(r.tabId);
    if (!r.warn && Date.now() - r.loudAt > SIL_MS) r.warn = drm ? 'drm' : 'silent';
  }
  if (r.warn) warnBadge(r.tabId, true);
}

async function finish(r) {
  clearInterval(r.silT);
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
  const r = { id: `${Date.now()}-${tabId}`, tabId, sr: opts.sr > 0 ? opts.sr : 44100, startedAt: opts.t0 ? Math.floor(opts.t0) : Date.now(), kbps, bytes: 0, seq: 0, chain: Promise.resolve(), title: '', host: '', stopping: false, auto: !!opts.auto, busy: new Map(), endT: null, endAt: 0, warn: '', loudAt: Date.now(), silT: 0 };
  r.worker = new Worker('encoder.worker.js');
  r.worker.onmessage = (ev) => onWorker(r, ev.data);
  r.worker.postMessage({ t: 'init', kbps, sr: r.sr, startEpoch: r.startedAt, trim: true });
  recs.set(tabId, r);
  let resp = null;
  try { resp = await browser.tabs.sendMessage(tabId, { type: 'rec', mode: 'on' }); } catch (e) { /* no receiver */ }
  if (!resp || !resp.ok) { r.worker.terminate(); recs.delete(tabId); return { error: 'unsupported' }; }
  r.title = resp.title; r.host = resp.host;
  await putMeta({ id: r.id, title: r.title, host: r.host, startedAt: r.startedAt, saved: false, fmt: kbps === 0 ? 'wav' : 'mp3', sr: r.sr });
  badge(tabId, true);
  r.silT = setInterval(() => silCheck(r), 1000);
  drmOf(tabId).then((d) => { if (d && recs.get(tabId) === r && !r.stopping) { r.warn = 'drm'; warnBadge(tabId, true); } });
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
  drmOf(tabId).then((d) => { const w = waits.get(tabId); if (d && w) w.warn = 'drm'; });
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
    const s = r && !r.stopping && startStream(resp, (d) => { heard(r, d.buf); r.worker.postMessage({ t: 'pcm', k: 'st' + frameId + ':' + id, ts: d.ts, buf: d.buf }, [d.buf.buffer]); });
    if (!s) { if (resp.body) resp.body.cancel(); return {}; }
    streams.set(tabId + ':' + frameId + ':' + id, s);
    return { stream: true };
  } catch (e) { return {}; }
}

browser.runtime.onMessage.addListener((m, sender) => {
  const tabId = sender.tab && sender.tab.id;
  switch (m.type) {
    case 'hasMedia': if (tabId != null && !withMedia.has(tabId)) { withMedia.add(tabId); pageIconById(tabId); } return;
    case 'hello': return Promise.resolve({ on: recs.has(tabId) && !recs.get(tabId).stopping, watch: waits.has(tabId) });
    case 'pcm': {
      const r = recs.get(tabId);
      if (r && !r.stopping) { heard(r, m.buf); r.worker.postMessage({ t: 'pcm', k: sender.frameId, ts: m.ts, at: m.at, buf: m.buf }, [m.buf.buffer]); }
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
    case 'fast': return fastSave(m.tabId, m.kbps);
    case 'fastNow': return fastNow(m.tabId);
    case 'state': {
      const r = recs.get(m.tabId);
      return Promise.resolve({ recording: !!r && !r.stopping, saving: !!r && r.stopping, waiting: waits.has(m.tabId), auto: !!r && r.auto, elapsed: r ? Date.now() - r.startedAt : 0, bytes: r ? r.bytes : 0, fast: fsState(m.tabId), warn: r ? r.warn : (waits.get(m.tabId) || {}).warn || '' });
    }
    case 'recovered': return recovered();
    case 'recSave': return allMeta().then((all) => { const x = all.find((y) => y.id === m.id); return x ? saveRec(x) : false; });
    case 'recDiscard': return delRec(m.id).then(() => true);
  }
});

// ---------- hotkeys ----------
// address bar icon: only on web pages with sound (media element, sound playing, recording or waiting), unless turned off
let pageIcon = true;
const withMedia = new Set();
function pageIconFor(tab) {
  if (!browser.pageAction || !tab) return;
  const id = tab.id;
  if (pageIcon && /^https?:/i.test(tab.url || '') && (tab.audible || withMedia.has(id) || recs.has(id) || waits.has(id))) browser.pageAction.show(id).catch(() => {});
  else browser.pageAction.hide(id).catch(() => {});
}
function pageIconById(id) { browser.tabs.get(id).then(pageIconFor, () => {}); }
async function refreshPageIcons() { for (const t of await browser.tabs.query({})) pageIconFor(t); }
browser.storage.local.get({ pageIcon: true }).then((st) => { pageIcon = st.pageIcon !== false; refreshPageIcons(); });
browser.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.pageIcon) { pageIcon = c.pageIcon.newValue !== false; refreshPageIcons(); } });
browser.tabs.onUpdated.addListener((id, ch, tab) => {
  if (ch.status === 'loading') withMedia.delete(id);
  if (ch.status || ch.url || 'audible' in ch) pageIconFor(tab);
});
browser.tabs.onRemoved.addListener((id) => withMedia.delete(id));

// whole-track save from a hotkey reports in the page title
const note = (tabId, text) => browser.tabs.sendMessage(tabId, { type: 'note', text }, { frameId: 0 }).catch(() => {});
const tr = (k) => browser.i18n.getMessage(k);
function noteFast(tabId) {
  const t = setInterval(() => {
    const s = fsState(tabId);
    if (s && s.run) { note(tabId, `⬇ ${s.collecting ? s.pct : s.p}%`); return; }
    clearInterval(t);
    if (s && s.err) { note(tabId, `⚠ ${tr('err_' + s.err)}`); setTimeout(() => note(tabId, ''), 8000); }
    else { note(tabId, `✓ ${tr('fast_done')}`); setTimeout(() => note(tabId, ''), 4000); }
  }, 500);
}

async function runCommand(cmd, given) {
  const [tab] = given ? [given] : await browser.tabs.query({ active: true, currentWindow: true });
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
  } else if (cmd === 'fast-save') {
    const j = fsJobs.get(tab.id);
    if (j) { if (j.collecting) fastNow(tab.id); return; }
    const res = await fastSave(tab.id, kbps);
    if (res && res.error) { note(tab.id, `⚠ ${tr('err_' + res.error)}`); setTimeout(() => note(tab.id, ''), 8000); }
    else noteFast(tab.id);
  }
}
browser.commands.onCommand.addListener((cmd) => { runCommand(cmd); });
