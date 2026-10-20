'use strict';
// Save a whole track without playing it: a direct media file, an HLS playlist (TS, packed audio, fMP4; AES-128),
// or a DASH manifest when the page has no HLS (fMP4 or WebM).
const fsHls = new Map();    // tabId -> recent playlist urls
const fsDash = new Map();   // tabId -> recent DASH manifest urls
const fsMedia = new Map();  // tabId -> recent media file urls
const fsJobs = new Map();   // tabId -> { p }
const fsErrs = new Map();   // tabId -> { code, detail, t }

function fsNote(map, tabId, url) {
  if (tabId < 0) return;
  let a = map.get(tabId);
  if (!a) map.set(tabId, (a = []));
  const i = a.indexOf(url);
  if (i >= 0) a.splice(i, 1);
  a.push(url);
  if (a.length > 20) a.shift();
}
browser.webRequest.onHeadersReceived.addListener((d) => {
  const h = (d.responseHeaders || []).find((x) => x.name.toLowerCase() === 'content-type');
  const ct = (h && h.value) || '';
  // a new page (or a reload) starts with an empty list: its own requests come after this one
  if (d.type === 'main_frame') { fsHls.delete(d.tabId); fsDash.delete(d.tabId); fsMedia.delete(d.tabId); return; }
  if (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(d.url)) fsNote(fsHls, d.tabId, d.url);
  else if (/dash\+xml/i.test(ct) || /\.mpd(\?|$)/i.test(d.url)) fsNote(fsDash, d.tabId, d.url);
  else if (d.type === 'media' && /^https?:/i.test(d.url)) fsNote(fsMedia, d.tabId, d.url);
}, { urls: ['<all_urls>'] }, ['responseHeaders']);
browser.tabs.onRemoved.addListener((id) => { fsHls.delete(id); fsDash.delete(id); fsMedia.delete(id); fsErrs.delete(id); });


const fsFail = (code, detail) => Object.assign(new Error(detail || code), { fsCode: code });

async function fsBytes(url, range) {
  const r = await fetch(url, { credentials: 'include', headers: range ? { Range: `bytes=${range.start}-${range.end - 1}` } : {} });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------- HLS playlist ----------
function hlsParse(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw fsFail('fast', 'not an HLS playlist');
  const attrs = (s) => { const o = {}; s.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (x, k, v) => { o[k] = v.replace(/^"|"$/g, ''); }); return o; };
  const abs = (u) => new URL(u, base).href;
  const range = (s, prev) => { const [len, off] = s.split('@'); const start = off !== undefined ? +off : prev; return { start, end: start + +len }; };
  const pl = { variants: [], audios: [], segs: [], map: null, end: false, dur: 0 };
  let seq = 0, key = null, inf = false, vattr = null, br = null, prevEnd = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-STREAM-INF:')) vattr = attrs(l.slice(18));
    else if (l.startsWith('#EXT-X-MEDIA:')) { const a = attrs(l.slice(13)); if (a.TYPE === 'AUDIO' && a.URI) pl.audios.push(Object.assign(a, { url: abs(a.URI) })); }
    else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = +l.slice(22) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) { const a = attrs(l.slice(11)); key = a.METHOD === 'NONE' ? null : { method: a.METHOD, url: a.URI && abs(a.URI), iv: a.IV }; }
    else if (l.startsWith('#EXT-X-MAP:')) { const a = attrs(l.slice(11)); pl.map = { url: abs(a.URI), range: a.BYTERANGE ? range(a.BYTERANGE, 0) : null }; }
    else if (l.startsWith('#EXT-X-BYTERANGE:')) br = l.slice(17);
    else if (l === '#EXT-X-ENDLIST') pl.end = true;
    else if (l.startsWith('#EXTINF:')) { inf = true; pl.dur += parseFloat(l.slice(8)) || 0; }
    else if (l.startsWith('#')) continue;
    else if (vattr) { pl.variants.push(Object.assign(vattr, { url: abs(l) })); vattr = null; }
    else if (inf) {
      let r = null;
      if (br) { r = range(br, prevEnd); prevEnd = r.end; br = null; }
      pl.segs.push({ url: abs(l), key, range: r, n: seq + pl.segs.length });
      inf = false;
    }
  }
  return pl;
}

async function aesDec(b, k, n, cache) {
  let kp = cache.get(k.url);
  if (!kp) { kp = fsBytes(k.url).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])); cache.set(k.url, kp); }
  const iv = new Uint8Array(16);
  if (k.iv) { const h = k.iv.replace(/^0x/i, '').padStart(32, '0'); for (let i = 0; i < 16; i++) iv[i] = parseInt(h.substr(i * 2, 2), 16); }
  else new DataView(iv.buffer).setUint32(12, n);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await kp, b));
}

// ---------- MPEG-TS: audio elementary stream ----------
function tsAudio(b, st) {
  const parts = [];
  for (let i = 0; i + 188 <= b.length; i += 188) {
    if (b[i] !== 0x47) { const j = b.indexOf(0x47, i + 1); if (j < 0) break; i = j - 188; continue; }
    const pusi = b[i + 1] & 0x40, pid = ((b[i + 1] & 0x1f) << 8) | b[i + 2], afc = (b[i + 3] >> 4) & 3, end = i + 188;
    let p = i + 4;
    if (afc & 2) p += 1 + b[p];
    if (!(afc & 1) || p >= end) continue;
    if (pid === 0 && pusi) {
      p += 1 + b[p];
      st.pmt = ((b[p + 10] & 0x1f) << 8) | b[p + 11];
    } else if (pid === st.pmt && pusi && st.pid < 0) {
      p += 1 + b[p];
      const slen = ((b[p + 1] & 0x0f) << 8) | b[p + 2], send = Math.min(p + 3 + slen - 4, end);
      let q = p + 12 + (((b[p + 10] & 0x0f) << 8) | b[p + 11]);
      while (q + 5 <= send) {
        const type = b[q], epid = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
        if (st.pid < 0 && [0x0f, 0x03, 0x04, 0x11].includes(type)) { st.pid = epid; st.type = type; }
        q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4]);
      }
      if (st.type === 0x11) throw fsFail('fast', 'AAC LATM in TS is not supported');
    } else if (pid === st.pid) {
      if (pusi) p += 9 + b[p + 8];
      if (p < end) parts.push(b.subarray(p, end));
    }
  }
  return fsCat(parts);
}

function fsCat(parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

function stripId3(b) {
  let p = 0;
  while (b[p] === 0x49 && b[p + 1] === 0x44 && b[p + 2] === 0x33 && p + 10 <= b.length) {
    p += 10 + ((b[p + 6] << 21) | (b[p + 7] << 14) | (b[p + 8] << 7) | b[p + 9]) + (b[p + 5] & 0x10 ? 10 : 0);
  }
  return b.subarray(p);
}

// ADTS / MP3 frames, carried over segment borders
function frameFeeder() {
  let buf = new Uint8Array(0), kind = null;
  return (chunk, last) => {
    buf = fsCat([buf, chunk]);
    const out = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      let h = null, k = kind;
      if (k !== 'mp3') { h = aacHeader(buf, i); if (h) k = 'aac'; }
      if (!h && k !== 'aac') { h = mp3Header(buf, i); if (h) k = 'mp3'; }
      if (!h) { i++; continue; }
      if (i + h.len > buf.length) break;
      if (buf.length - i - h.len >= 8) {
        if (!(k === 'aac' ? aacHeader : mp3Header)(buf, i + h.len)) { i++; continue; }
      } else if (!last) break;
      kind = k;
      out.push({ k, h, data: buf.slice(i, i + h.len) });
      i += h.len;
    }
    buf = buf.slice(i);
    return out;
  };
}

// AAC from MP4/WebM goes to the decoder as ADTS (the form proven for TS): Firefox rejects some
// AudioSpecificConfig descriptions (HE-AAC), while ADTS with the core rate decodes SBR/PS itself
function aacAdts(asc, ch) {
  if (!asc || asc.length < 2) return null;
  const aot = asc[0] >> 3, sfi = ((asc[0] & 7) << 1) | (asc[1] >> 7), c = (asc[1] >> 3) & 15;
  if (![2, 5, 29].includes(aot) || sfi > 11 || !c) return null;
  return { sfi, ch: c, cfg: { codec: 'mp4a.40.2', sampleRate: AAC_SR[sfi], numberOfChannels: c || ch } };
}
function adtsWrap(f, a) {
  const n = f.length + 7, o = new Uint8Array(n);
  o[0] = 0xff; o[1] = 0xf1; o[2] = 0x40 | (a.sfi << 2) | ((a.ch >> 2) & 1); o[3] = ((a.ch & 3) << 6) | ((n >> 11) & 3);
  o[4] = (n >> 3) & 0xff; o[5] = ((n & 7) << 5) | 0x1f; o[6] = 0xfc;
  o.set(f, 7);
  return o;
}

// ---------- fragmented MP4 ----------
function bx(b, s, e, cb) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (s + 8 <= e) {
    let size = dv.getUint32(s), h = 8;
    const t = String.fromCharCode(b[s + 4], b[s + 5], b[s + 6], b[s + 7]);
    if (size === 1) { size = Number(dv.getBigUint64(s + 8)); h = 16; } else if (size === 0) size = e - s;
    if (size < h || s + size > e) return;
    cb(t, s + h, s + size, s, dv);
    s += size;
  }
}

function esds(b, s, e) {
  let p = s + 4, oti = 0, asc = null;
  const rd = () => { const tag = b[p++]; let len = 0; for (let i = 0; i < 4; i++) { const c = b[p++]; len = (len << 7) | (c & 127); if (!(c & 128)) break; } return { tag, len }; };
  while (p < e) {
    const { tag, len } = rd();
    if (tag === 3) { const fl = b[p + 2]; p += 3; if (fl & 128) p += 2; if (fl & 64) p += 1 + b[p]; if (fl & 32) p += 2; }
    else if (tag === 4) { oti = b[p]; p += 13; }
    else if (tag === 5) { asc = b.slice(p, p + len); p += len; }
    else p += len;
  }
  return { oti, asc };
}

function mp4Init(b) {
  const tracks = [], trex = {};
  bx(b, 0, b.length, (t, s, e) => {
    if (t !== 'moov') return;
    bx(b, s, e, (t2, s2, e2, x, dv) => {
      if (t2 === 'mvex') bx(b, s2, e2, (t3, s3) => { if (t3 === 'trex') trex[dv.getUint32(s3 + 4)] = { dur: dv.getUint32(s3 + 12), size: dv.getUint32(s3 + 16) }; });
      if (t2 !== 'trak') return;
      const tr = {};
      const walk = (ws, we) => bx(b, ws, we, (wt, cs, ce) => {
        if (wt === 'tkhd') tr.id = dv.getUint32(cs + (b[cs] === 1 ? 20 : 12));
        else if (wt === 'mdhd') tr.scale = dv.getUint32(cs + (b[cs] === 1 ? 20 : 12));
        else if (wt === 'hdlr') tr.hdlr = String.fromCharCode(b[cs + 8], b[cs + 9], b[cs + 10], b[cs + 11]);
        else if (wt === 'mdia' || wt === 'minf' || wt === 'stbl') walk(cs, ce);
        else if (wt === 'stsd') bx(b, cs + 8, ce, (et, es, ee) => {
          if (tr.entry) return;
          tr.entry = et; tr.ch = dv.getUint16(es + 16); tr.sr = dv.getUint32(es + 24) >>> 16;
          bx(b, es + 28, ee, (ct, s4, e4) => {
            if (ct === 'esds') Object.assign(tr, esds(b, s4, e4));
            else if (ct === 'dOps') tr.dops = b.slice(s4, e4);
            else if (ct === 'dfLa') tr.dfla = b.slice(s4 + 4, e4);
          });
        });
      });
      walk(s2, e2);
      tracks.push(tr);
    });
  });
  const tr = tracks.find((x) => x.hdlr === 'soun');
  if (!tr) throw fsFail('fast', 'no audio track');
  if (tr.entry === 'enca') throw fsFail('drm');
  tr.size = (trex[tr.id] || {}).size || 0;
  tr.ddur = (trex[tr.id] || {}).dur || 0;
  const ch = tr.ch || 2;
  if (tr.entry === 'mp4a' && tr.asc && (tr.oti === 0x40 || tr.oti === 0x66 || tr.oti === 0x67)) {
    tr.adts = aacAdts(tr.asc, ch);
    tr.cfg = tr.adts ? tr.adts.cfg : { codec: 'mp4a.40.' + (tr.asc[0] >> 3), sampleRate: tr.sr || 44100, numberOfChannels: ch, description: tr.asc };
  } else if (tr.entry === '.mp3' || (tr.entry === 'mp4a' && (tr.oti === 0x69 || tr.oti === 0x6b))) {
    tr.cfg = { codec: 'mp3', sampleRate: tr.sr || 44100, numberOfChannels: ch };
  } else if (tr.entry === 'Opus' && tr.dops) {
    const d = tr.dops, dv = new DataView(d.buffer, d.byteOffset, d.byteLength), head = new Uint8Array(19 + (d[10] ? 2 + d[1] : 0)), hv = new DataView(head.buffer);
    head.set([79, 112, 117, 115, 72, 101, 97, 100, 1, d[1]]);
    hv.setUint16(10, dv.getUint16(2), true); hv.setUint32(12, dv.getUint32(4), true); hv.setInt16(16, dv.getInt16(8), true); head[18] = d[10];
    if (d[10]) head.set(d.subarray(11, 13 + d[1]), 19);
    tr.cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: d[1] || ch, description: head };
  } else if (tr.entry === 'fLaC' && tr.dfla) {
    tr.cfg = { codec: 'flac', sampleRate: tr.sr || 44100, numberOfChannels: ch, description: fsCat([new Uint8Array([102, 76, 97, 67]), tr.dfla]) };
  } else throw fsFail('fast', 'unsupported audio codec ' + tr.entry);
  return tr;
}

function mp4Samples(b, tr) {
  const out = [], times = [];
  out.times = times;
  bx(b, 0, b.length, (t, s, e, start, dv) => {
    if (t !== 'moof') return;
    const mdat = e + 8 <= b.length && String.fromCharCode(b[e + 4], b[e + 5], b[e + 6], b[e + 7]) === 'mdat' ? e + 8 : e;
    bx(b, s, e, (t2, s2, e2) => {
      if (t2 !== 'traf') return;
      let base = start, size = tr.size, dur = tr.ddur, mine = false, next = mdat, t = 0;
      bx(b, s2, e2, (t3, s3) => {
        if (t3 === 'tfhd') {
          const fl = dv.getUint32(s3) & 0xffffff;
          mine = dv.getUint32(s3 + 4) === tr.id;
          let p = s3 + 8;
          if (fl & 1) { base = Number(dv.getBigUint64(p)); p += 8; }
          if (fl & 2) p += 4;
          if (fl & 8) { dur = dv.getUint32(p); p += 4; }
          if (fl & 0x10) size = dv.getUint32(p);
        } else if (t3 === 'tfdt') {
          t = b[s3] === 1 ? Number(dv.getBigUint64(s3 + 4)) : dv.getUint32(s3 + 4);
        } else if (t3 === 'trun' && mine) {
          const fl = dv.getUint32(s3) & 0xffffff, n = dv.getUint32(s3 + 4);
          let p = s3 + 8, off = next;
          if (fl & 1) { off = base + dv.getInt32(p); p += 4; }
          if (fl & 4) p += 4;
          for (let i = 0; i < n; i++) {
            let d = dur;
            if (fl & 0x100) { d = dv.getUint32(p); p += 4; }
            let sz = size;
            if (fl & 0x200) { sz = dv.getUint32(p); p += 4; }
            if (fl & 0x400) p += 4;
            if (fl & 0x800) p += 4;
            if (sz && off + sz <= b.length) { out.push(tr.adts ? adtsWrap(b.subarray(off, off + sz), tr.adts) : b.slice(off, off + sz)); times.push(t / (tr.scale || 1)); }
            off += sz;
            t += d;
          }
          next = off;
        }
      });
    });
  });
  return out;
}

// ---------- WebM ----------
const fsIsWebm = (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
const EBML_MASTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0]);
// linear walk: masters are entered (works with unknown sizes), other elements are passed to cb and skipped
function ebml(b, cb) {
  let p = 0;
  const vint = (id) => {
    const f = b[p];
    let len = 1, m = 0x80;
    while (len <= 8 && !(f & m)) { len++; m >>= 1; }
    if (len > 8 || p + len > b.length) return null;
    let v = id ? f : f & (m - 1), ones = (f & (m - 1)) === m - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 255) ones = false; }
    p += len;
    return { v, unk: !id && ones };
  };
  while (p < b.length) {
    const id = vint(true), sz = id && vint(false);
    if (!sz) break;
    if (EBML_MASTER.has(id.v)) { cb(id.v, p, sz.unk ? b.length : Math.min(b.length, p + sz.v), true); continue; }
    if (sz.unk || p + sz.v > b.length) break;
    cb(id.v, p, p + sz.v, false);
    p += sz.v;
  }
}

function webmInit(b) {
  const tracks = [], dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const uint = (s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; };
  let cur = null;
  ebml(b, (id, s, e, master) => {
    if (id === 0xae) { cur = {}; tracks.push(cur); }
    else if (id === 0x1f43b675) cur = null;
    else if (!cur || master) return;
    else if (id === 0xd7) cur.num = uint(s, e);
    else if (id === 0x83) cur.type = uint(s, e);
    else if (id === 0x86) cur.codec = String.fromCharCode(...b.subarray(s, e)).replace(/\0+$/, '');
    else if (id === 0x63a2) cur.priv = b.slice(s, e);
    else if (id === 0xb5) cur.sr = e - s === 4 ? dv.getFloat32(s) : dv.getFloat64(s);
    else if (id === 0x9f) cur.ch = uint(s, e);
    else if (id === 0x6d80) cur.enc = true;
  });
  const tr = tracks.find((t) => t.type === 2);
  if (!tr) throw fsFail('fast', 'no audio track');
  if (tr.enc) throw fsFail('drm');
  const ch = tr.ch || 2, sr = Math.round(tr.sr || 44100);
  if (tr.codec === 'A_OPUS') tr.cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: ch, description: tr.priv };
  else if (/^A_AAC/.test(tr.codec) && tr.priv) { tr.adts = aacAdts(tr.priv, ch); tr.cfg = tr.adts ? tr.adts.cfg : { codec: 'mp4a.40.' + (tr.priv[0] >> 3), sampleRate: sr, numberOfChannels: ch, description: tr.priv }; }
  else if (tr.codec === 'A_MPEG/L3') tr.cfg = { codec: 'mp3', sampleRate: sr, numberOfChannels: ch };
  else if (tr.codec === 'A_FLAC') tr.cfg = { codec: 'flac', sampleRate: sr, numberOfChannels: ch, description: tr.priv };
  else if (tr.codec === 'A_VORBIS') tr.cfg = { codec: 'vorbis', sampleRate: sr, numberOfChannels: ch, description: tr.priv };
  else throw fsFail('fast', 'unsupported audio codec ' + tr.codec);
  return tr;
}

function webmFrames(b, tr) {
  const out = [];
  ebml(b, (id, s, e, master) => {
    if (master || (id !== 0xa3 && id !== 0xa1)) return;
    const f = b[s];
    let len = 1, m = 0x80;
    while (!(f & m)) { len++; m >>= 1; }
    let tn = f & (m - 1);
    for (let i = 1; i < len; i++) tn = tn * 256 + b[s + i];
    if (tn !== tr.num) return;
    const p = s + len + 3;
    if (b[s + len + 2] & 0x06) throw fsFail('fast', 'laced WebM blocks are not supported');
    out.push(tr.adts ? adtsWrap(b.subarray(p, e), tr.adts) : b.slice(p, e));
  });
  return out;
}

// ---------- DASH manifest ----------
const fsDur = (s) => {
  const m = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(s || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
};

function dashPlan(text, url) {
  const mpd = new DOMParser().parseFromString(text, 'application/xml').documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw fsFail('fast', 'not a DASH manifest');
  if (mpd.getAttribute('type') === 'dynamic') throw fsFail('live');
  const kids = (el, n) => (el ? [...el.children].filter((c) => c.localName === n) : []);
  const one = (el, n) => kids(el, n)[0] || null;
  const base = (el, b) => { const x = one(el, 'BaseURL'); return x ? new URL(x.textContent.trim(), b).href : b; };
  const mpdBase = base(mpd, url), total = fsDur(mpd.getAttribute('mediaPresentationDuration')), periods = kids(mpd, 'Period');
  return periods.map((pe, pi) => {
    const st = fsDur(pe.getAttribute('start')), nx = periods[pi + 1] && periods[pi + 1].getAttribute('start');
    const pDur = fsDur(pe.getAttribute('duration')) || (nx ? fsDur(nx) - st : total - st);
    const cands = [];
    for (const as of kids(pe, 'AdaptationSet')) {
      for (const rep of kids(as, 'Representation')) {
        const mime = rep.getAttribute('mimeType') || as.getAttribute('mimeType') || '';
        if (!/^audio\//.test(mime) && as.getAttribute('contentType') !== 'audio') continue;
        cands.push({ as, rep, codecs: rep.getAttribute('codecs') || as.getAttribute('codecs') || '', bw: +rep.getAttribute('bandwidth') || 0, prot: !!(one(as, 'ContentProtection') || one(rep, 'ContentProtection')) });
      }
    }
    if (!cands.length) throw fsFail('fast', 'no audio in the DASH manifest');
    const clear = cands.filter((c) => !c.prot).sort((a, b) => b.bw - a.bw);
    if (!clear.length) throw fsFail('drm');
    const { as, rep } = clear.find((c) => /mp4a|opus|mp3|flac/i.test(c.codecs)) || clear[0];
    const b = base(rep, base(as, base(pe, mpdBase))), id = rep.getAttribute('id') || '', bw = rep.getAttribute('bandwidth') || '';
    const fill = (t, num, time) => t.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (x, k, w) => {
      const v = String(k === 'RepresentationID' ? id : k === 'Number' ? num : k === 'Time' ? time : bw);
      return w ? v.padStart(+w, '0') : v;
    }).replace(/\$\$/g, '$');
    const tpls = [one(rep, 'SegmentTemplate'), one(as, 'SegmentTemplate'), one(pe, 'SegmentTemplate')].filter(Boolean);
    if (tpls.length) {
      const ta = (n) => { for (const t of tpls) if (t.hasAttribute(n)) return t.getAttribute(n); return null; };
      const ts = +ta('timescale') || 1, start = ta('startNumber') !== null ? +ta('startNumber') : 1, media = ta('media') || '', init = ta('initialization');
      const tl = tpls.map((t) => one(t, 'SegmentTimeline')).find(Boolean), segs = [];
      if (tl) {
        let t = 0, n = start;
        for (const sx of kids(tl, 'S')) {
          if (sx.hasAttribute('t')) t = +sx.getAttribute('t');
          const d = +sx.getAttribute('d');
          let r = +sx.getAttribute('r') || 0;
          if (r < 0) r = Math.ceil((pDur * ts - t) / d) - 1;
          for (let i = 0; i <= r; i++) { segs.push({ url: new URL(fill(media, n, t), b).href }); t += d; n++; }
        }
      } else {
        const d = +ta('duration');
        if (!d || !pDur) throw fsFail('fast', 'DASH template without segment count');
        const cnt = Math.ceil((pDur * ts) / d - 1e-6);
        for (let i = 0; i < cnt; i++) segs.push({ url: new URL(fill(media, start + i, i * d), b).href });
      }
      return { init: init ? { url: new URL(fill(init, start, 0), b).href } : null, segs };
    }
    const sl = one(rep, 'SegmentList') || one(as, 'SegmentList');
    if (sl) {
      const rng = (v) => { if (!v) return null; const [x, z] = v.split('-').map(Number); return { start: x, end: z + 1 }; };
      const ini = one(sl, 'Initialization');
      return {
        init: ini ? { url: new URL(ini.getAttribute('sourceURL') || '', b).href, range: rng(ini.getAttribute('range')) } : null,
        segs: kids(sl, 'SegmentURL').map((u) => ({ url: new URL(u.getAttribute('media') || '', b).href, range: rng(u.getAttribute('mediaRange')) }))
      };
    }
    return { init: null, segs: [{ url: b }] };
  });
}

// ---------- decode -> encode ----------
function fsSink(tabId, kbps) {
  const id = `${Date.now()}-${tabId}-fast`;
  let w = null, sr = 0, seq = 0, chain = Promise.resolve(), pend = 0, endR = null, org = 0, at = 0;
  const waiters = [], endP = new Promise((r) => { endR = r; });
  const toI16 = (f, n) => { const o = new Int16Array(n); for (let i = 0; i < n; i++) { const v = f[i]; o[i] = (v > 1 ? 1 : v < -1 ? -1 : v) * 32767; } return o; };
  const lin = (a, from, to) => { const m = Math.max(1, Math.round((a.length * to) / from)), o = new Float32Array(m); for (let i = 0; i < m; i++) { const p = (i * from) / to, j = Math.min(p | 0, a.length - 1), j2 = Math.min(j + 1, a.length - 1); o[i] = a[j] + (a[j2] - a[j]) * (p - j); } return o; };
  return {
    id,
    push(l, r, rate) {
      if (w && !l.length) return;
      if (!w) {
        sr = rate;
        w = new Worker('encoder.worker.js');
        w.onmessage = (e) => {
          const d = e.data;
          if (d.t === 'mp3') { const s = seq++; chain = chain.then(() => putChunk(id, s, d.buf)).catch(() => {}); }
          else if (d.t === 'ack') { pend--; if (pend < 8) waiters.splice(0).forEach((f) => f()); }
          else if (d.t === 'end') endR();
        };
        w.postMessage({ t: 'init', kbps, sr, fast: true });
      }
      if (rate !== sr) { l = lin(l, rate, sr); r = lin(r, rate, sr); }
      const L = toI16(l, l.length), R = toI16(r, l.length);
      pend++;
      w.postMessage({ t: 'chunk', l: L, r: R }, [L.buffer, R.buffer]);
    },
    // place decoded audio by its media time: overlaps are cut, short gaps become silence, long jumps are joined
    pushAt(l, r, rate, us) {
      if (!w) { this.push(new Float32Array(0), new Float32Array(0), rate); org = us; }
      if (rate !== sr) { l = lin(l, rate, sr); r = lin(r, rate, sr); }
      const target = Math.round(((us - org) * sr) / 1e6), tol = sr / 50;
      let skip = 0;
      if (target > at + tol) {
        const gap = target - at;
        if (gap <= sr * 2) { const z = new Float32Array(gap); this.push(z, z, sr); at += gap; } else org += ((gap) * 1e6) / sr;
      } else if (target < at - tol) skip = at - target;
      if (skip >= l.length) return;
      if (skip) { l = l.subarray(skip); r = r.subarray(skip); }
      this.push(l, r, sr);
      at += l.length;
    },
    ready() { return pend < 16 ? Promise.resolve() : new Promise((f) => waiters.push(f)); },
    async end() {
      if (!w) return null;
      w.postMessage({ t: 'stop' });
      await endP;
      w.terminate();
      await chain;
      return { id, sr };
    },
    abort() { if (w) w.terminate(); delRec(id); }
  };
}

function fsDecoder(sink, timed) {
  let dec = null, key = '', ts = 0, err = null;
  const out = (ad) => {
    const n = ad.numberOfFrames, ch = ad.numberOfChannels, pl = [];
    for (let c = 0; c < Math.min(ch, 2); c++) { const a = new Float32Array(n); ad.copyTo(a, { planeIndex: c, format: 'f32-planar' }); pl.push(a); }
    const rate = ad.sampleRate;
    const us = ad.timestamp;
    ad.close();
    if (n) { if (timed) sink.pushAt(pl[0], pl[1] || pl[0], rate, us); else sink.push(pl[0], pl[1] || pl[0], rate); }
  };
  // isConfigSupported never settles in some Firefox builds: try each variant and see whether it survives a flush
  const tryCfg = async (cfg) => {
    let bad = null;
    const d = new AudioDecoder({ output: out, error: (e) => { bad = e; err = e; } });
    try { d.configure(cfg); await d.flush(); } catch (e) { bad = bad || e; }
    if (!bad && d.state === 'configured') return d;
    try { d.close(); } catch (e) { /* closed */ }
    err = null;
    return null;
  };
  return {
    async conf(cfg) {
      const k = cfg.codec + '|' + cfg.sampleRate + '|' + cfg.numberOfChannels;
      if (dec && k === key) return;
      if (dec) { await dec.flush().catch(() => {}); dec.close(); dec = null; }
      key = k;
      const alts = [cfg];
      if (/^mp4a\.40/.test(cfg.codec)) for (const c of ['mp4a.40.2', 'mp4a.40.5', 'mp4a.40.29']) for (const sr of [cfg.sampleRate, cfg.sampleRate * 2]) alts.push(Object.assign({}, cfg, { codec: c, sampleRate: sr }));
      for (const c of alts) { dec = await tryCfg(c); if (dec) return; }
      throw fsFail('codec', cfg.codec);
    },
    async put(data, us) {
      if (err || dec.state !== 'configured') throw fsFail('fast', 'decoder: ' + ((err && err.message) || dec.state));
      await sink.ready();
      while (dec.decodeQueueSize > 40) await new Promise((r) => setTimeout(r, 5));
      try { dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: us === undefined ? ts : us, data })); } catch (e) { throw fsFail(dec.state === 'configured' ? 'fast' : 'codec', key.split('|')[0]); }
      ts += 1000;
    },
    async end() {
      if (dec && dec.state === 'configured') await dec.flush();
      if (dec) dec.close();
      if (err) throw fsFail('fast', 'decoder: ' + (err.message || err));
    }
  };
}

const fsIsMp4 = (b) => ['ftyp', 'styp', 'moof', 'sidx', 'mdat'].includes(String.fromCharCode(b[4], b[5], b[6], b[7]));
const fsIsTs = (b) => b[0] === 0x47 && (b.length < 376 || b[188] === 0x47);

async function hlsMedia(url) {
  let pl = hlsParse(await (await fetch(url, { credentials: 'include' })).text(), url);
  if (pl.variants.length || pl.audios.length) {
    let pick = pl.audios.find((a) => a.DEFAULT === 'YES') || pl.audios[0];
    if (!pick) {
      const v = pl.variants.slice().sort((a, b) => (+b.BANDWIDTH || 0) - (+a.BANDWIDTH || 0));
      pick = v.find((x) => x.CODECS && !/avc|hvc|hev|vp0|vp9|av01|dvh/i.test(x.CODECS)) || v[v.length - 1];
    }
    pl = hlsParse(await (await fetch(pick.url, { credentials: 'include' })).text(), pick.url);
  }
  return pl;
}

async function fsHlsRun(url, sink, job) {
  const pl = await hlsMedia(url);
  if (!pl.end) throw fsFail('live');
  if (!pl.segs.length) throw fsFail('fast', 'empty playlist');
  if (pl.segs.some((s) => s.key && s.key.method !== 'AES-128')) throw fsFail('drm');
  const keys = new Map();
  const init = pl.map ? await fsBytes(pl.map.url, pl.map.range) : null;
  const dec = fsDecoder(sink);
  let done = 0;
  await fsSegRun(pl.segs, (x) => fsBytes(x.url, x.range).then((b) => (x.key ? aesDec(b, x.key, x.n, keys) : b)), init, dec, sink, () => { job.p = ++done / pl.segs.length; });
  await dec.end();
}

async function fsDashRun(url, sink, job) {
  const plan = dashPlan(await (await fetch(url, { credentials: 'include' })).text(), url);
  const total = plan.reduce((n, x) => n + x.segs.length, 0), dec = fsDecoder(sink);
  let done = 0;
  for (const part of plan) {
    const init = part.init ? await fsBytes(part.init.url, part.init.range) : null;
    await fsSegRun(part.segs, (x) => fsBytes(x.url, x.range), init, dec, sink, () => { job.p = ++done / total; });
  }
  await dec.end();
}

// segments in order, 6 downloads ahead; container found from the init or the segment itself
async function fsSegRun(segs, get, init, dec, sink, step) {
  const W = 6, ahead = [];
  const load = (x) => { const p = get(x); p.catch(() => {}); return p; };
  for (let i = 0; i < Math.min(W, segs.length); i++) ahead.push(load(segs[i]));
  let tr = init && fsIsMp4(init) ? mp4Init(init) : null, wm = init && fsIsWebm(init) ? webmInit(init) : null;
  const feed = frameFeeder(), ts = { pmt: -1, pid: -1, type: 0 };
  for (let i = 0; i < segs.length; i++) {
    const b = await ahead[i];
    if (i + W < segs.length) ahead.push(load(segs[i + W]));
    if (wm || fsIsWebm(b)) {
      if (!wm) wm = webmInit(b);
      await dec.conf(wm.cfg);
      for (const f of webmFrames(b, wm)) await dec.put(f);
    } else if (tr || fsIsMp4(b)) {
      if (!tr) tr = mp4Init(b);
      const smp = mp4Samples(b, tr);
      if (!smp.length && !init && segs.length === 1) await fsDecodeWhole(b, sink, () => {});
      else {
        await dec.conf(tr.cfg);
        for (const f of smp) await dec.put(f);
      }
    } else {
      for (const f of feed(fsIsTs(b) ? tsAudio(b, ts) : stripId3(b), i === segs.length - 1)) {
        await dec.conf({ codec: f.k === 'mp3' ? 'mp3' : 'mp4a.40.2', sampleRate: f.h.sr, numberOfChannels: f.h.ch });
        await dec.put(f.data);
      }
    }
    step();
  }
}

async function fsDecodeWhole(bytes, sink, prog) {
  const buf = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const l = buf.getChannelData(0), rr = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l, step = 44100 * 5;
  for (let i = 0; i < buf.length; i += step) {
    await sink.ready();
    sink.push(l.subarray(i, i + step), rr.subarray(i, i + step), buf.sampleRate);
    prog(Math.min(1, (i + step) / buf.length));
  }
}

async function fsFileRun(url, sink, job) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) job.p = 0.7 * Math.min(1, got / total);
  }
  job.p = 0.75;
  await fsDecodeWhole(fsCat(parts), sink, (f) => { job.p = 0.75 + 0.25 * f; });
}

// ---------- MSE source bytes (no HLS/DASH): what the page's player appended ----------
function webmTimed(b, base, offAt, frames, order) {
  const uint = (s, e) => { let v = 0; for (let i = s; i < e; i++) v = v * 256 + b[i]; return v; };
  let tr = null, scale = 1e6, ctc = 0;
  ebml(b, (id, s, e, master) => {
    if (id === 0x1654ae6b && master) tr = webmInit(b.subarray(s, e));
    else if (master) return;
    else if (id === 0x2ad7b1) scale = uint(s, e);
    else if (id === 0xe7) ctc = uint(s, e);
    else if ((id === 0xa3 || id === 0xa1) && tr) {
      const f = b[s];
      let len = 1, m = 0x80;
      while (!(f & m)) { len++; m >>= 1; }
      let tn = f & (m - 1);
      for (let i = 1; i < len; i++) tn = tn * 256 + b[s + i];
      if (tn !== tr.num || (b[s + len + 2] & 0x06)) return;
      const rel = (b[s + len] << 24 >> 16) | b[s + len + 1];
      const data = b.subarray(s + len + 3, e);
      frames.push({ t: ((ctc + rel) * scale) / 1e9 + offAt(base + s), data: tr.adts ? adtsWrap(data, tr.adts) : data.slice(), cfg: tr.cfg, i: order.n++ });
    }
  });
}

function mp4Timed(b, base, offAt, frames, order) {
  let tr = null;
  bx(b, 0, b.length, (t, s, e, start, dv) => {
    if (t === 'moov') tr = mp4Init(b.subarray(start, e));
    else if (t === 'moof' && tr && e + 8 <= b.length) {
      const me = e + dv.getUint32(e);
      if (me > b.length || String.fromCharCode(b[e + 4], b[e + 5], b[e + 6], b[e + 7]) !== 'mdat') return;
      const smp = mp4Samples(b.subarray(start, me), tr), off = offAt(base + start);
      smp.forEach((d, k) => frames.push({ t: smp.times[k] + off, data: d, cfg: tr.cfg, i: order.n++ }));
    }
  });
}

async function fsMseRun(d, sink, job) {
  const all = new Uint8Array(await d.blob.arrayBuffer()), runs = [], starts = [];
  let pos = 0, rs = 0;
  for (const m of d.meta) {
    if (m.n < 0) { runs.push([rs, pos]); rs = pos; continue; }
    starts.push({ at: pos, off: m.off || 0 });
    pos += m.n;
  }
  runs.push([rs, pos]);
  const offAt = (p) => { let o = 0; for (const x of starts) { if (x.at > p) break; o = x.off; } return o; };
  const frames = [], order = { n: 0 };
  for (const [a, z] of runs) if (z > a) (d.kind === 'webm' ? webmTimed : mp4Timed)(all.subarray(a, z), a, offAt, frames, order);
  if (!frames.length) throw fsFail('fast', 'no audio in the captured data');
  frames.sort((x, y) => x.t - y.t || y.i - x.i);
  const dec = fsDecoder(sink, true);
  let last = -1;
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    if (Math.abs(f.t - last) < 1e-4) continue;
    last = f.t;
    await dec.conf(f.cfg);
    await dec.put(f.data, Math.round(f.t * 1e6));
    if (!(k & 255)) job.p = 0.5 + (0.5 * k) / frames.length;
  }
  await dec.end();
}

async function fsMseWait(tabId, job) {
  const q = () => browser.tabs.sendMessage(tabId, { type: 'mse', op: 'q' }).catch(() => null);
  for (;;) {
    const i = await q();
    if (!i || !i.has) throw fsFail('mse');
    if (i.drm) throw fsFail('drm');
    if (i.dur === Infinity) throw fsFail('live');
    const dur = isFinite(i.dur) && i.dur > 0 ? i.dur : 0;
    job.cov = i.cov;
    job.p = dur ? Math.min(0.99, i.cov / dur) * 0.5 : 0;
    job.pct = dur ? Math.min(100, Math.floor((100 * i.cov) / dur)) : 0;
    if (job.now || i.ended || (dur && i.cov >= dur - 0.5)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const d = await browser.tabs.sendMessage(tabId, { type: 'mse', op: 'd' }).catch(() => null);
  if (!d || !d.blob) throw fsFail('mse');
  job.collecting = false;
  return d;
}

// length of the track behind a playlist, to tell the playing track from ones the page preloads
async function fsPlDur(c) {
  try {
    if (c.kind === 'hls') { const pl = await hlsMedia(c.url); return pl.end ? pl.dur : Infinity; }
    const mpd = new DOMParser().parseFromString(await (await fetch(c.url, { credentials: 'include' })).text(), 'application/xml').documentElement;
    return mpd.getAttribute('type') === 'dynamic' ? Infinity : fsDur(mpd.getAttribute('mediaPresentationDuration'));
  } catch (e) { return NaN; }
}

async function fsMatch(cands, dur) {
  if (!cands.length) return null;
  if (!(dur > 0) || !isFinite(dur)) return cands.length === 1 ? cands[0] : null;
  const lens = await Promise.all(cands.map(fsPlDur)), tol = Math.max(0.5, dur * 0.002);
  const hit = cands.filter((c, i) => Math.abs(lens[i] - dur) <= tol);
  return hit.length === 1 ? hit[0] : null;
}

async function fsPick(tabId) {
  const list = (await browser.tabs.sendMessage(tabId, { type: 'media' }, { frameId: 0 }).catch(() => null)) || [];
  const els = list.filter((e) => e.src).sort((a, b) => (b.playing - a.playing) || ((isFinite(b.dur) ? b.dur : 0) - (isFinite(a.dur) ? a.dur : 0)));
  // the request events of a page that has just loaded its playlist may still be on the way
  if (els.some((e) => /^blob:/i.test(e.src)) && !(fsHls.get(tabId) || []).length && !(fsDash.get(tabId) || []).length) await new Promise((r) => setTimeout(r, 1000));
  const file = (fsMedia.get(tabId) || []).slice(-1)[0];
  const hlsC = (fsHls.get(tabId) || []).slice().reverse().map((url) => ({ kind: 'hls', url }));
  const dashC = (fsDash.get(tabId) || []).slice().reverse().map((url) => ({ kind: 'dash', url }));
  const meta = list.find((e) => e.meta) ? list.find((e) => e.meta).meta : null;
  const withMeta = (x) => Object.assign(x, { meta });
  // EME (mediaKeys) on the playing element: the version it plays is encrypted; an open version of the same length loaded by the page is saved instead
  const drmEl = els.find((e) => e.drm && (e.playing || els.length === 1));
  if (drmEl) {
    const open = (await fsMatch(hlsC, drmEl.dur)) || (await fsMatch(dashC, drmEl.dur));
    return open ? withMeta(open) : { error: 'drm' };
  }
  for (const e of els) {
    // a player on MSE: the playlist whose length is the playing track's; otherwise collect what the player loads
    if (/^blob:/i.test(e.src)) return withMeta((await fsMatch(hlsC, e.dur)) || (await fsMatch(dashC, e.dur)) || { kind: 'mse' });
    if (!/^https?:/i.test(e.src)) continue;
    if (/\.m3u8(\?|$)/i.test(e.src)) return { kind: 'hls', url: e.src };
    if (/\.mpd(\?|$)/i.test(e.src)) return { kind: 'dash', url: e.src };
    if (e.dur === Infinity) return { error: 'live' };
    return { kind: 'file', url: e.src };
  }
  if (hlsC.length === 1 && !dashC.length) return withMeta(hlsC[0]);
  if (dashC.length === 1 && !hlsC.length) return withMeta(dashC[0]);
  if (hlsC.length || dashC.length) return { error: 'nosource' };
  if (file) return { kind: 'file', url: file };
  return { error: 'nosource' };
}

async function fastSave(tabId, kbps) {
  if (fsJobs.has(tabId)) return { ok: true };
  fsErrs.delete(tabId);
  const src = await fsPick(tabId);
  if (src.error) return src;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  let host = '';
  try { host = new URL((tab && tab.url) || src.url).hostname; } catch (e) { /* ignore */ }
  const m = src.meta, own = m && m.title ? (m.artist ? `${m.artist} - ${m.title}` : m.title) : '';
  const title = own || ((tab && tab.title) || '').replace(/^(🔴|⚪) REC ·\s*/u, '');
  const job = { p: 0, mse: src.kind === 'mse', collecting: src.kind === 'mse', now: false };
  fsJobs.set(tabId, job);
  keepAlive();
  (async () => {
    const sink = fsSink(tabId, kbps);
    try {
      if (src.kind === 'hls') await fsHlsRun(src.url, sink, job);
      else if (src.kind === 'dash') await fsDashRun(src.url, sink, job);
      else if (src.kind === 'mse') await fsMseRun(await fsMseWait(tabId, job), sink, job);
      else await fsFileRun(src.url, sink, job);
      const res = await sink.end();
      if (!res) throw fsFail('fast', 'no audio decoded');
      const m = { id: res.id, title, host, startedAt: Date.now(), saved: false, fmt: kbps === 0 ? 'wav' : 'mp3', sr: res.sr };
      await putMeta(m);
      if (!(await saveRec(m))) throw fsFail('fast', 'download failed');
    } catch (e) {
      sink.abort();
      fsErrs.set(tabId, { code: (e && e.fsCode) || 'fast', detail: (e && e.message) || String(e), t: Date.now() });
    }
    fsJobs.delete(tabId);
  })();
  return { ok: true };
}

function fastNow(tabId) {
  const j = fsJobs.get(tabId);
  if (j) j.now = true;
  return Promise.resolve({ ok: true });
}

function fsState(tabId) {
  const j = fsJobs.get(tabId);
  if (j) return { run: true, p: Math.round(j.p * 100), collecting: !!j.collecting, pct: j.pct || 0 };
  const e = fsErrs.get(tabId);
  return e && Date.now() - e.t < 60000 ? { err: e.code, detail: e.detail } : null;
}
