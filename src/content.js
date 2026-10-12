(() => {
  'use strict';
  const CH = '__mp3tab';
  let active = false;
  const post = (o) => window.postMessage(Object.assign({ [CH]: 1 }, o), '*');
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[CH] !== 1) return;
    if (d.k === 'sound') { browser.runtime.sendMessage({ type: 'sound', t0: d.t0 }).catch(() => {}); return; }
    if (d.k === 'fetch') { browser.runtime.sendMessage({ type: 'fetchBlob', url: d.url, id: d.id }).then((r) => post({ k: 'blob', id: d.id, blob: r && r.blob, stream: !!(r && r.stream), norec: !!(r && r.norec) })).catch(() => post({ k: 'blob', id: d.id })); return; }
    if (d.k === 'sstop') { browser.runtime.sendMessage({ type: 'streamStop', id: d.id }).catch(() => {}); return; }
    if (!active) return;
    if (d.k === 'busy') browser.runtime.sendMessage({ type: 'busy', v: d.v, p: d.p }).catch(() => {});
    else if (d.k === 'pcm') browser.runtime.sendMessage({ type: 'pcm', ts: d.ts, buf: d.buf }).catch(() => {});
  });
  // a popup window has no toolbar button, so the badge is not visible: mark the page title while recording
  const PFXS = ['🔴 REC ·', '⚪ REC ·'];  // the dot blinks: red / white
  const strip = (t) => { const x = PFXS.find((p) => t.startsWith(p)); return x ? t.slice(x.length).trimStart() : t; };
  let obs = null, blink = null, phase = 0;
  const mark = () => {
    if (!obs) return;
    const base = strip(document.title), next = PFXS[phase] + (base ? ' ' + base : '');
    if (document.title !== next) document.title = next;
  };
  function indicator(on) {
    if (window !== window.top) return;
    if (on && !obs) {
      obs = new MutationObserver(mark);
      phase = 0;
      mark();
      obs.observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
      blink = setInterval(() => { phase ^= 1; mark(); }, 1000);
    } else if (!on && obs) {
      obs.disconnect(); obs = null;
      clearInterval(blink); blink = null;
      document.title = strip(document.title);
    }
  }
  function set(mode) {
    post({ k: 'cmd', mode });
    if (mode === 'on') { active = true; indicator(true); }
    else if (mode === 'off') { indicator(false); setTimeout(() => { active = false; }, 800); }
  }
  browser.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== 'rec') return;
    const title = strip(document.title);
    set(m.mode);
    if (window === window.top) return Promise.resolve({ ok: true, title, host: location.hostname });
  });
  browser.runtime.sendMessage({ type: 'hello' }).then((r) => { if (r && r.on) set('on'); else if (r && r.watch) set('watch'); }).catch(() => {});
})();
