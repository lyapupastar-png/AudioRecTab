// Runs in the page's own JS world: taps media elements and Web Audio output.
(() => {
  'use strict';
  const CH = '__mp3tab', SR = 44100;
  const A = window.AudioContext, NP = window.AudioNode && AudioNode.prototype;
  if (!A || !NP || window.__mp3tabHook) return;
  Object.defineProperty(window, '__mp3tabHook', { value: true });
  const origConnect = NP.connect, origDisc = NP.disconnect;
  const origMSD = A.prototype.createMediaStreamDestination;
  const origCMES = A.prototype.createMediaElementSource;
  const origPlay = HTMLMediaElement.prototype.play;
  const post = (o, tr) => window.postMessage(Object.assign({ [CH]: 1 }, o), '*', tr || []);
  const seen = new WeakSet(), routed = new WeakSet(), taps = new WeakMap();
  const mediaRefs = new Set(), tapRefs = new Set();
  let rec = null, wantOn = false, sendOn = false, watchOn = false;
  // elements that started playing and have not ended; used to stop an auto recording at the end of the track
  const live = new Set();     // playing right now
  const paused = new Set();   // were playing, now paused (not ended)
  let everBusy = false;       // pages with Web Audio only never report busy, so they never auto-stop
  let lastBusy = '';
  function updBusy() {
    const r = rec;
    if (!r || !r.send || !everBusy) return;
    const v = live.size > 0 ? 1 : 0, p = paused.size > 0 ? 1 : 0, b = v + ':' + p;
    if (b !== lastBusy) { lastBusy = b; post({ k: 'busy', v, p }); }
  }

  const hasCandidates = () => mediaRefs.size > 0 || tapRefs.size > 0 || !!document.querySelector('audio,video');

  function unlink(ent) {
    try { if (ent.src) ent.src.disconnect(); } catch (e) { /* ignore */ }
    try { if (ent.an) ent.an.disconnect(); } catch (e) { /* ignore */ }
    ent.src = null; ent.an = null; ent.tid = null;
  }

  function attachEl(el) {
    const r = rec;
    if (!r || routed.has(el) || r.els.has(el)) return;
    let stream;
    try { stream = el.captureStream ? el.captureStream() : el.mozCaptureStream(); } catch (e) { return; }
    const ent = { stream, src: null, an: null, tid: null, q: 0, skip: false };
    const link = () => {
      if (rec !== r) return;
      const t = stream.getAudioTracks()[0];
      if (!t || t.id === ent.tid) return;
      unlink(ent);
      try {
        ent.src = r.ctx.createMediaStreamSource(stream);
        ent.tid = t.id;
        ent.an = r.ctx.createAnalyser();
        ent.an.fftSize = 1024;
        origConnect.call(ent.src, r.mixer);
        origConnect.call(ent.src, ent.an);
      } catch (e) { unlink(ent); }
    };
    r.els.set(el, ent);
    stream.addEventListener('addtrack', link);
    link();
    if (el.crossOrigin === null) startFallback(r, el, ent);
  }

  function attachTap(ctx, t) {
    const r = rec;
    if (!r || !t.node || r.tapSrc.has(ctx)) return;
    try {
      const s = r.ctx.createMediaStreamSource(t.node.stream);
      origConnect.call(s, r.mixer);
      r.tapSrc.set(ctx, s);
    } catch (e) { /* ignore */ }
  }

  function onProc(e) {
    const r = rec;
    if (!r) return;
    const off0 = Date.now() - e.playbackTime * 1000;
    if (off0 < r.off) r.off = off0;
    if (!r.send && !r.watch) return;
    const inp = e.inputBuffer, n = inp.length, l = inp.getChannelData(0);
    const rr = inp.numberOfChannels > 1 ? inp.getChannelData(1) : l;
    const out = new Int16Array(n * 2);
    let pk = 0;
    for (let i = 0; i < n; i++) {
      const a = l[i], b = rr[i];
      out[i] = (a > 1 ? 1 : a < -1 ? -1 : a) * 32767;
      out[n + i] = (b > 1 ? 1 : b < -1 ? -1 : b) * 32767;
      const pa = a < 0 ? -a : a, pb = b < 0 ? -b : b;
      if (pa > pk) pk = pa;
      if (pb > pk) pk = pb;
    }
    const ts = r.off + e.playbackTime * 1000 - (n / SR) * 1000;
    if (r.send) { post({ k: 'pcm', ts, buf: out }, [out.buffer]); return; }
    // waiting for sound: keep the last blocks so the beginning of the sound is not lost
    r.ring.push({ ts, buf: out });
    if (r.ring.length > 8) r.ring.shift();
    if (r.sound) return;
    if (pk > 0.001) {
      if (!r.loud++) r.t0 = ts;
      if (r.loud >= 2) {
        r.sound = true;
        post({ k: 'sound', t0: r.t0 });
        // if nobody started the recording, allow another detection
        setTimeout(() => { if (rec === r && !r.send) { r.sound = false; r.loud = 0; } }, 3000);
      }
    } else r.loud = 0;
  }

  // switch an armed/watching graph to sending; blocks kept since the first loud one go first
  function startSending(r) {
    if (r.send) return;
    r.send = true;
    r.watch = false;
    if (r.pend) { for (const q of r.pend) { const nid = ++fbId; fbReq.set(nid, q); post({ k: 'fetch', id: nid, url: q.url }); } r.pend = null; }
    clearTimeout(r.armT);
    const t0 = r.t0 || 0;
    for (const it of r.ring) if (it.ts >= t0 - 1) post({ k: 'pcm', ts: it.ts, buf: it.buf }, [it.buf.buffer]);
    r.ring = [];
    lastBusy = '';
    updBusy();
  }

  function checkSilence() {
    const r = rec;
    // while waiting for sound the same check runs, slower (a quiet intro is normal); it tells the user the sound is protected
    const waiting = r && !r.send && r.watch && !r.sound, need = waiting ? 6 : 3;
    if (!r || (!r.send && !waiting)) return;
    for (const [el, e] of r.els) {
      const playing = !el.paused && !el.ended && el.readyState > 2 && !el.muted && el.volume > 0 && el.currentTime > 1;
      if (!playing || e.skip) { e.q = 0; continue; }
      let peak = 0;
      if (e.an) {
        e.an.getFloatTimeDomainData(r.buf);
        for (let i = 0; i < r.buf.length; i++) { const v = r.buf[i] < 0 ? -r.buf[i] : r.buf[i]; if (v > peak) peak = v; }
      } else if (el.mozHasAudio === false) continue;
      if (peak >= 1e-6) e.q = 0;
      else if (++e.q >= need) { if (startFallback(r, el, e)) continue; e.skip = true; }
    }
  }


  // A cross-origin <audio> without CORS gives silence to captureStream. The background fetches the same file
  // (host permissions lift CORS); a copy from that blob follows the original and is captured instead.
  const fbReq = new Map();
  let fbId = 0;
  function startFallback(r, el, e) {
    const url = el.currentSrc;
    if (!/^https?:/i.test(url || '')) return false;
    try { if (new URL(url).origin === location.origin) return false; } catch (err) { return false; }
    e.skip = true;
    const id = ++fbId;
    fbReq.set(id, { r, el, e, url });
    post({ k: 'fetch', id, url });
    return true;
  }
  // endless stream: the background decodes it; the page only tells it when the element pauses or plays again
  function onStream(q, id) {
    if (q.sc) { q.sc.cur = id; return; }
    const { r, el, e, url } = q, sc = { cur: id };
    const pause = () => post({ k: 'sstop', id: sc.cur });
    const play = () => {
      if (rec !== r) return;
      const nid = ++fbId;
      fbReq.set(nid, { r, el, e, url, sc });
      post({ k: 'fetch', id: nid, url });
    };
    const gone = () => {
      pause();
      el.removeEventListener('pause', pause); el.removeEventListener('play', play);
      el.removeEventListener('emptied', gone); el.removeEventListener('loadstart', gone);
      e.skip = false; e.q = 0;
    };
    el.addEventListener('pause', pause); el.addEventListener('play', play);
    el.addEventListener('emptied', gone); el.addEventListener('loadstart', gone);
    q.sc = sc;
  }
  // The copy is played by Web Audio (an <audio> element copy proved unreliable: muted, captured and in a
  // background tab Firefox sometimes restarted it at 0 and left it stuck). The buffer follows the original
  // element's position, pause, seek and speed.
  async function onBlob(d) {
    const q = fbReq.get(d.id);
    fbReq.delete(d.id);
    if (!q) return;
    const { r, el, e } = q;
    if (rec !== r) return;
    if (d.stream) { onStream(q, d.id); return; }
    if (d.norec) { (r.pend = r.pend || []).push(q); return; }
    let buf = null;
    try { if (d.blob) buf = await r.ctx.decodeAudioData(await d.blob.arrayBuffer()); } catch (err) { buf = null; }
    if (!buf) { post({ k: 'warn', kind: 'silent' }); return; }
    if (rec !== r) return;
    let src = null, t0 = 0, off = 0;
    const halt = () => { if (src) { try { src.stop(); src.disconnect(); } catch (err) { /* ignore */ } src = null; } };
    const where = () => {
      if (!src) return -1;
      const p = off + (r.ctx.currentTime - t0) * el.playbackRate;
      return el.loop ? p % buf.duration : p;
    };
    const go = () => {
      halt();
      if (el.paused || el.ended) return;
      src = r.ctx.createBufferSource();
      src.buffer = buf; src.loop = el.loop; src.playbackRate.value = el.playbackRate;
      origConnect.call(src, r.mixer);
      off = el.loop ? el.currentTime % buf.duration : Math.min(el.currentTime, buf.duration);
      t0 = r.ctx.currentTime;
      try { src.start(0, off); } catch (err) { halt(); }
    };
    const tick = () => {
      if (rec !== r) { stop(); return; }
      if (el.paused || el.ended) { halt(); return; }
      if (!src || Math.abs(where() - el.currentTime) > 0.3) go();
    };
    const ev = ['play', 'playing', 'pause', 'seeked', 'ratechange'];
    const tmr = setInterval(tick, 500);
    function stop() {
      clearInterval(tmr);
      for (const n of ev) el.removeEventListener(n, go);
      el.removeEventListener('emptied', onNew); el.removeEventListener('loadstart', onNew);
      halt();
    }
    function onNew() { stop(); e.warned = false; e.q = 0; }
    for (const n of ev) el.addEventListener(n, go);
    el.addEventListener('emptied', onNew); el.addEventListener('loadstart', onNew);
    go();
  }

  function startCapture() {
    if (rec) return;
    let ctx;
    try { ctx = new A({ sampleRate: SR }); } catch (e) { return; }
    const mixer = ctx.createGain(), proc = ctx.createScriptProcessor(4096, 2, 2), mute = ctx.createGain();
    mute.gain.value = 0;
    origConnect.call(mixer, proc);
    origConnect.call(proc, mute);
    origConnect.call(mute, ctx.destination);
    rec = { ctx, mixer, proc, els: new Map(), tapSrc: new Map(), off: Infinity, buf: new Float32Array(1024), send: sendOn, armT: 0, watch: watchOn && !sendOn, ring: [], loud: 0, t0: 0, sound: false };
    lastBusy = '';
    if (!sendOn && !watchOn) setArmTimer();
    proc.onaudioprocess = onProc;
    rec.timer = setInterval(checkSilence, 1000);
    ctx.resume().catch(() => {});
    document.querySelectorAll('audio,video').forEach(reg);
    for (const r of mediaRefs) { const el = r.deref(); if (el) attachEl(el); else mediaRefs.delete(r); }
    for (const r of tapRefs) {
      const c = r.deref(), t = c && taps.get(c);
      if (t) attachTap(c, t); else if (!c) tapRefs.delete(r);
    }
    updBusy();
  }

  // armed = graph is ready but nothing is sent; drops by itself if recording is never started
  function setArmTimer() {
    clearTimeout(rec.armT);
    rec.armT = setTimeout(() => { if (rec && !rec.send) { wantOn = false; stopCapture(); } }, 30000);
  }

  function stopCapture() {
    const r = rec;
    if (!r) return;
    rec = null;
    lastBusy = '';
    clearTimeout(r.armT);
    clearInterval(r.timer);
    r.proc.onaudioprocess = null;
    try { r.ctx.close(); } catch (e) { /* ignore */ }
  }

  function reg(el) {
    if (!(el instanceof HTMLMediaElement) || seen.has(el)) return;
    seen.add(el);
    mediaRefs.add(new WeakRef(el));
    const gone = () => { live.delete(el); paused.delete(el); updBusy(); };
    el.addEventListener('playing', () => { live.add(el); paused.delete(el); everBusy = true; updBusy(); });
    // pause fires right before ended at the end of a track: that is an end, not a pause
    el.addEventListener('pause', () => { if (el.ended || !live.has(el)) return; live.delete(el); paused.add(el); updBusy(); });
    for (const ev of ['ended', 'emptied', 'abort', 'error']) el.addEventListener(ev, gone);
    if (!el.paused && !el.ended && el.readyState > 2) { live.add(el); everBusy = true; }
    if (wantOn) { if (rec) attachEl(el); else startCapture(); }
  }

  function tapOf(ctx) {
    let t = taps.get(ctx);
    if (!t) {
      try { t = { node: origMSD.call(ctx) }; } catch (e) { t = { node: null }; }
      taps.set(ctx, t);
      tapRefs.add(new WeakRef(ctx));
      if (t.node && wantOn) { if (rec) attachTap(ctx, t); else startCapture(); }
    }
    return t.node ? t : null;
  }

  function markRouted(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    routed.add(el);
    const ent = rec && rec.els.get(el);
    if (ent) { unlink(ent); rec.els.delete(el); }
  }

  NP.connect = function (dest) {
    const res = origConnect.apply(this, arguments);
    try {
      if (dest instanceof AudioDestinationNode && this.context instanceof A && !(rec && this.context === rec.ctx)) {
        const t = tapOf(this.context);
        if (t) origConnect.call(this, t.node);
      }
    } catch (e) { /* never break the page */ }
    return res;
  };
  NP.disconnect = function (dest) {
    const res = arguments.length ? origDisc.apply(this, arguments) : origDisc.call(this);
    try {
      if (dest instanceof AudioDestinationNode) {
        const t = taps.get(this.context);
        if (t && t.node) origDisc.call(this, t.node);
      }
    } catch (e) { /* not connected */ }
    return res;
  };
  A.prototype.createMediaElementSource = function (el) {
    try { markRouted(el); } catch (e) { /* ignore */ }
    return origCMES.apply(this, arguments);
  };
  if (window.MediaElementAudioSourceNode) {
    window.MediaElementAudioSourceNode = new Proxy(window.MediaElementAudioSourceNode, {
      construct(target, args, nt) {
        try { markRouted(args[1] && args[1].mediaElement); } catch (e) { /* ignore */ }
        return Reflect.construct(target, args, nt);
      }
    });
  }
  HTMLMediaElement.prototype.play = function () {
    try { reg(this); } catch (e) { /* ignore */ }
    return origPlay.apply(this, arguments);
  };
  document.addEventListener('playing', (e) => { try { reg(e.target); kick(e); } catch (err) { /* ignore */ } }, true);
  // A context created before the page had a user gesture (armed / waiting for sound) stays suspended under
  // Firefox's autoplay policy, even after the user clicks. Resume it inside the gesture itself.
  function kick(e) {
    const r = rec;
    if (r && r.ctx.state !== 'running' && e.isTrusted !== false) r.ctx.resume().catch(() => {});
  }
  for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'touchend']) {
    window.addEventListener(ev, kick, true);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[CH] !== 1) return;
    if (d.k === 'blob') { onBlob(d); return; }
    if (d.k !== 'cmd') return;
    if (d.mode === 'off') { wantOn = sendOn = watchOn = false; stopCapture(); return; }
    if (d.mode === 'arm' && watchOn) return;
    wantOn = true;
    if (d.mode === 'watch') { watchOn = true; sendOn = false; }
    else { sendOn = d.mode === 'on'; if (sendOn) watchOn = false; }
    if (rec) {
      if (sendOn) startSending(rec);
      else if (watchOn) { rec.watch = true; clearTimeout(rec.armT); }
      else if (!rec.send) setArmTimer();
    } else if (hasCandidates()) startCapture();
  });
})();
