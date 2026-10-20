(() => {
  'use strict';
  const CH = '__mp3tab';
  let active = false, ign = true, mqId = 0, msHas = false;
  const mq = new Map();
  const post = (o) => window.postMessage(Object.assign({ [CH]: 1 }, o), '*');
  browser.storage.local.get({ ignoreSite: true }).then((s) => { ign = s.ignoreSite !== false; post({ k: 'cfg', ign }); }).catch(() => {});
  browser.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.ignoreSite) { ign = c.ignoreSite.newValue !== false; post({ k: 'cfg', ign }); } });
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[CH] !== 1) return;
    if (d.k === 'sound') { browser.runtime.sendMessage({ type: 'sound', t0: d.t0 }).catch(() => {}); return; }
    if (d.k === 'fetch') { browser.runtime.sendMessage({ type: 'fetchBlob', url: d.url, id: d.id }).then((r) => post({ k: 'blob', id: d.id, blob: r && r.blob, stream: !!(r && r.stream), norec: !!(r && r.norec) })).catch(() => post({ k: 'blob', id: d.id })); return; }
    if (d.k === 'mshas') { msHas = true; return; }
    if (d.k === 'hasel') { hasMedia(); return; }
    if (d.k === 'msr') { const f = mq.get(d.id); if (f) { mq.delete(d.id); f(d.v); } return; }
    if (d.k === 'ml') { const f = mq.get(d.id); if (f) { mq.delete(d.id); f(d.list); } return; }
    if (d.k === 'sstop') { browser.runtime.sendMessage({ type: 'streamStop', id: d.id }).catch(() => {}); return; }
    if (!active) return;
    if (d.k === 'busy') browser.runtime.sendMessage({ type: 'busy', v: d.v, p: d.p }).catch(() => {});
    else if (d.k === 'pcm') browser.runtime.sendMessage({ type: 'pcm', ts: d.ts, buf: d.buf }).catch(() => {});
  });
  // a popup window has no toolbar button, so the badge is not visible: mark the page title while recording
  const PFXS = ['🔴 REC ·', '⚪ REC ·'];  // the dot blinks: red / white
  // `note`: progress of a whole-track save started by a hotkey (there is no popup to show it)
  let obs = null, blink = null, phase = 0, rec = false, note = '', shown = '';
  const strip = (t) => {
    const x = PFXS.find((p) => t.startsWith(p));
    if (x) t = t.slice(x.length).trimStart();
    if (shown && t.startsWith(shown)) t = t.slice(shown.length).trimStart();
    return t;
  };
  const mark = () => {
    const base = strip(document.title), pre = [rec ? PFXS[phase] : '', note].filter(Boolean).join(' ');
    shown = note;
    const next = pre ? pre + (base ? ' ' + base : '') : base;
    if (document.title !== next) document.title = next;
  };
  function watchTitle() {
    if ((rec || note) && !obs) {
      obs = new MutationObserver(mark);
      obs.observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
    }
    mark();
    if (!rec && !note && obs) { obs.disconnect(); obs = null; }
  }
  function indicator(on) {
    if (window !== window.top) return;
    if (on && !rec) { rec = true; phase = 0; blink = setInterval(() => { phase ^= 1; mark(); }, 1000); }
    else if (!on && rec) { rec = false; clearInterval(blink); blink = null; }
    watchTitle();
  }
  function set(mode) {
    post({ k: 'cmd', mode, ign });
    if (mode === 'on') { active = true; indicator(true); }
    else if (mode === 'off') { indicator(false); setTimeout(() => { active = false; }, 800); }
  }
  // the address bar icon is shown only where the page has audio or video
  let said = false, mo = null;
  function hasMedia() {
    if (said) return;
    said = true;
    if (mo) { mo.disconnect(); mo = null; }
    browser.runtime.sendMessage({ type: 'hasMedia' }).catch(() => {});
  }
  const isMedia = (n) => n.nodeType === 1 && (n.localName === 'audio' || n.localName === 'video' || !!n.querySelector('audio,video'));
  if (document.querySelector('audio,video')) hasMedia();
  else {
    mo = new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (isMedia(n)) { hasMedia(); return; } });
    mo.observe(document, { childList: true, subtree: true });
  }
  browser.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'note') {
      if (window === window.top) { note = m.text ? m.text + ' ·' : ''; watchTitle(); }
      return;
    }
    if (m && m.type === 'mse') {
      if (!msHas) return;
      const id = ++mqId;
      return new Promise((res) => { mq.set(id, res); post({ k: 'msq', id, op: m.op }); setTimeout(() => { if (mq.delete(id)) res(null); }, 5000); });
    }
    if (m && m.type === 'media') {
      const id = ++mqId;
      return new Promise((res) => { mq.set(id, res); post({ k: 'mq', id }); setTimeout(() => { if (mq.delete(id)) res([]); }, 700); });
    }
    if (!m || m.type !== 'rec') return;
    const title = strip(document.title);
    set(m.mode);
    if (window === window.top) return Promise.resolve({ ok: true, title, host: location.hostname });
  });
  browser.runtime.sendMessage({ type: 'hello' }).then((r) => { if (r && r.on) set('on'); else if (r && r.watch) set('watch'); }).catch(() => {});
})();
