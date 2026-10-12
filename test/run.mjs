// AudioRecTab end-to-end tests: a separate temporary Firefox profile (your main profile is not touched).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
// FIREFOX_BIN overrides the default binary (Windows/Linux runs)
const FF = process.env.FIREFOX_BIN || (WIN ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : '/Applications/Firefox.app/Contents/MacOS/firefox');
const UUID = '5b1f6c2a-3d4e-4f60-8a7b-9c0d1e2f3a4b';
const P1 = 8765, P2 = 8766, REC_SEC = +(process.env.REC_SEC || 5), REAL_SEC = +(process.env.REAL_SEC || 0);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3tab-'));
const media = path.join(tmp, 'media'), dl = path.join(tmp, 'dl');
fs.mkdirSync(media); fs.mkdirSync(dl);

// --- media
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=40', '-af', 'volume=4', '-ac', '2', path.join(media, 'a440.wav')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4', '-af', 'volume=4', '-ac', '2', path.join(media, 'a440s.wav')]);
if (process.env.REAL_SINK_TONE) ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=' + (+process.env.REAL_SINK_TONE), '-af', 'volume=0.5', '-ac', '2', path.join(media, 'tone_long.wav')]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=40', '-af', 'volume=4',
  '-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libopus', path.join(media, 'v660.webm')]);

// endless Icecast-like stream: no content-length, burst at connect, then ~real-time
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=40', '-af', 'volume=4', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0', '-id3v2_version', '0', path.join(media, 'a440.mp3')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=40', '-af', 'volume=4', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', path.join(media, 'a440.aac')]);
const MP3BYTES = fs.readFileSync(path.join(media, 'a440.mp3')), AACBYTES = fs.readFileSync(path.join(media, 'a440.aac'));
function endless(req, res, aac) {
  const BYTES = aac ? AACBYTES : MP3BYTES;
  res.writeHead(200, { 'content-type': aac ? 'audio/aac' : 'audio/mpeg', 'icy-name': 'test', 'cache-control': 'no-cache' });
  let pos = 0;
  const send = (n) => { const out = Buffer.alloc(n); for (let i = 0; i < n; i++) out[i] = BYTES[(pos + i) % BYTES.length]; pos = (pos + n) % BYTES.length; res.write(out); };
  send(32768);
  const t = setInterval(() => send(1600), 100);
  req.on('close', () => clearInterval(t));
}

// --- pages
const AUDIO = (src, extra = '') => `<audio id=a src="${src}" loop></audio><script>
const a=document.getElementById('a');${extra}
a.play().then(()=>{top.__ready=true}).catch(e=>{document.title='ERR '+e});</script>`;
const WA = (f, g = 0.5) => `const c=new AudioContext();const o=c.createOscillator();o.frequency.value=${f};const g=c.createGain();g.gain.value=${g};o.connect(g);g.connect(c.destination);o.start();c.resume().then(()=>{top.__ready=true});`;
const pages = {
  '/audio.html': AUDIO('/media/a440.wav'),
  '/sinktone.html': '<audio id=a src="/media/tone_long.wav"></audio>',
  '/video.html': '<video id=a src="/media/v660.webm" loop></video><script>const a=document.getElementById("a");a.play().then(()=>{top.__ready=true});</script>',
  '/webaudio.html': `<script>${WA(880)}</script>`,
  '/iframe.html': '<iframe src="/audio.html"></iframe>',
  '/mix.html': `<audio id=a src="/media/a440.wav" loop></audio><script>document.getElementById('a').play();${WA(880, 0.5)}</script>`,
  '/routed.html': `<audio id=a src="/media/a440.wav" loop></audio><script>const a=document.getElementById('a');const c=new AudioContext();const s=c.createMediaElementSource(a);s.connect(c.destination);c.resume();a.play().then(()=>{top.__ready=true});</script>`,
  '/detached.html': '<script>const a=new Audio("/media/a440.wav");a.loop=true;a.play().then(()=>{top.__ready=true});</script>',
  '/delayed.html': '<audio id=a src="/media/a440s.wav"></audio><script>top.__ready=true;setTimeout(()=>document.getElementById("a").play(),3000);</script>',
  '/gesture.html': '<button id=go style="width:300px;height:100px">go</button><audio id=a src="/media/a440.wav" loop></audio><script>top.__ready=true;document.getElementById("go").onclick=()=>document.getElementById("a").play();</script>',
  '/delayedlong.html': '<audio id=a src="/media/a440.wav" loop></audio><script>top.__ready=true;setTimeout(()=>document.getElementById("a").play(),3000);</script>',
  '/cross.html': AUDIO(`http://127.0.0.1:${P2}/media/a440.wav`),
  '/streamaac.html': AUDIO(`http://127.0.0.1:${P2}/stream.aac`),
  '/stream.html': AUDIO(`http://127.0.0.1:${P2}/stream.mp3`)
};
function serve(port, withPages) {
  return http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (withPages && pages[u]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pages[u]); }
    if (!withPages && (u === '/stream.mp3' || u === '/stream.aac')) return endless(req, res, u.endsWith('aac'));
    const f = path.join(tmp, u);
    if (!u.startsWith('/media/') || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(f).size, type = f.endsWith('.wav') ? 'audio/wav' : 'video/webm';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1 });
      fs.createReadStream(f, { start: s, end: e }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
      fs.createReadStream(f).pipe(res);
    }
  }).listen(port, '127.0.0.1');
}
const s1 = serve(P1, true), s2 = serve(P2, false);

// --- analysis
function analyze(file) {
  const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', file]).toString());
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '44100', '-'], { maxBuffer: 1 << 28 });
  const x = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1), sr = 44100;
  const goertzel = (from, to, f) => {
    let re = 0, im = 0;
    for (let i = from; i < to; i++) { const v = x[i] / 32768, a = (2 * Math.PI * f * i) / sr; re += v * Math.cos(a); im += v * Math.sin(a); }
    return (2 * Math.hypot(re, im)) / (to - from);
  };
  const W = sr / 10 | 0, wins = [];
  const lead = Math.max(0, x.findIndex((v) => Math.abs(v) > 650)) / sr;
  const from = Math.floor(sr * 1.5);
  for (let s = from; s + W < x.length - sr / 2; s += W) {
    let e = 0; for (let i = s; i < s + W; i++) e += (x[i] / 32768) ** 2;
    wins.push({ rms: Math.sqrt(e / W), a: { 440: goertzel(s, s + W, 440), 660: goertzel(s, s + W, 660), 880: goertzel(s, s + W, 880) } });
  }
  const med = (arr) => arr.slice().sort((p, q) => p - q)[arr.length >> 1] || 0;
  const amp = {};
  for (const f of [440, 660, 880]) amp[f] = med(wins.map((w) => w.a[f]));
  const medRms = med(wins.map((w) => w.rms));
  const drop = wins.filter((w) => w.rms < medRms * 0.5).length;
  const minRms = wins.length ? Math.min(...wins.map((w) => w.rms)) : 0;
  let sq = 0; for (let i = 0; i < x.length; i++) sq += (x[i] / 32768) ** 2;
  const rmsAll = Math.sqrt(sq / (x.length || 1));
  return { rmsAll, codec: pr.streams[0].codec_name, rate: +pr.streams[0].sample_rate, ch: pr.streams[0].channels, dur: +pr.format.duration, amp, minRms, drop, lead };
}

// --- browser
const gd = require('geckodriver').path;
const opts = new firefox.Options().setBinary(FF);
if (!process.env.HEADFUL) opts.addArguments('-headless');
for (const [k, v] of Object.entries({
  'extensions.webextensions.uuids': JSON.stringify({ 'audiorectab@lyapupastar': UUID }),
  ...(process.env.STRICT ? {} : { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0, 'media.autoplay.block-webaudio': false }),
  'media.volume_scale': '0.0', 'media.navigator.streams.fake': !process.env.REAL_DEVICE, 'media.navigator.permission.disabled': true,
  'browser.download.folderList': 2, 'browser.download.dir': dl, 'browser.download.useDownloadDir': true
})) opts.setPreference(k, v);
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(new firefox.ServiceBuilder(gd).addArguments('--allow-system-access')).build();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
try {
  // the package for the test goes to a temp dir: release/ holds the .xpi that may be loaded in Firefox
  // (about:debugging), and deleting or overwriting it breaks the loaded add-on (content scripts stop loading)
  const packDir = path.join(tmp, 'pack');
  execFileSync(WIN ? 'npx.cmd' : 'npx', ['web-ext', 'build', '--source-dir', 'dist', '--artifacts-dir', WIN ? `"${packDir}"` : packDir, '--overwrite-dest'], { cwd: ROOT, stdio: 'ignore', shell: WIN });
  const zip = path.join(packDir, fs.readdirSync(packDir).find((f) => f.endsWith('.zip')));
  await driver.installAddon(zip, true);
  // NOGRANT=1 checks whether site permissions are granted on install without a confirmation dialog
  await driver.setContext(firefox.Context.CHROME);
  if (!process.env.NOGRANT) console.log('grant:', await driver.executeAsyncScript(`const done=arguments[arguments.length-1];(async()=>{const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');await ExtensionPermissions.add('audiorectab@lyapupastar',{permissions:[],origins:['<all_urls>']},undefined);return JSON.stringify(await ExtensionPermissions.get('audiorectab@lyapupastar'));})().then(done).catch(e=>done(String(e)))`));
  await driver.setContext(firefox.Context.CONTENT);
  // WebDriver cannot open moz-extension:// directly: open the tab from the chrome context
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript('const t=gBrowser.addTab(arguments[0],{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});gBrowser.selectedTab=t;', `moz-extension://${UUID}/popup.html?tabId=0`);
  await driver.setContext(firefox.Context.CONTENT);
  const handles = await driver.getAllWindowHandles();
  const ctl = handles[handles.length - 1];
  await driver.switchTo().window(ctl);
  const call = (script, ...a) => driver.executeAsyncScript(`const done=arguments[arguments.length-1];const a=arguments;(async()=>{${script}})().then(done).catch(e=>done({err:String(e)}))`, ...a);

  const cases = [
    ['audio-element 440', '/audio.html', { 440: 1 }],
    ['video-element 660', '/video.html', { 660: 1 }],
    ['webaudio 880', '/webaudio.html', { 880: 1 }],
    ['iframe(audio 440)', '/iframe.html', { 440: 1 }],
    ['detached Audio() 440', '/detached.html', { 440: 1 }],
    ['audio+webaudio 440+880', '/mix.html', { 440: 1, 880: 1 }],
    ['media via createMediaElementSource', '/routed.html', { 440: 1 }],
    ['cross-origin audio via background fetch 440', '/cross.html', { 440: 1 }],
    ['endless stream 440 (Icecast-like)', '/stream.html', { 440: 1 }],
    ['endless AAC (ADTS) stream 440', '/streamaac.html', { 440: 1 }],
    ['WAV output 440', '/audio.html', { 440: 1 }, { kbps: 0 }],
    ['audio started by a click', '/gesture.html', { 440: 1 }, { click: true }],
    ['reload mid-recording', '/audio.html', { 440: 1 }, { mid: 'reload', gap: true }],
    ['tab closed while recording', '/audio.html', { 440: 1 }, { mid: 'close', dur: 3 }]
  ];
  let ref440 = null;
  let queue = cases;
  for (let attempt = 1; attempt <= 2 && queue.length; attempt++) {
  const retry = [];
  for (const cs of queue) {
    const [name, url, expect, o = {}] = cs;
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
    fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
    const r = { name, ok: false, note: '' };
    const pi = results.findIndex((x) => x.name === name), prevNote = pi >= 0 ? results[pi].note : '';
    if (pi >= 0) results.splice(pi, 1);
    results.push(r);
    try {
      await driver.switchTo().newWindow('tab');
      const pageH = await driver.getWindowHandle();
      await driver.get(`http://localhost:${P1}${url}`);
      await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {});
      if (o.click) { await driver.findElement({ id: 'go' }).click(); await sleep(800); }
      await driver.switchTo().window(ctl);
      const tid = await call('const t=await browser.tabs.query({url:"http://localhost/*"});await browser.runtime.sendMessage({type:"arm",tabId:t[0].id});return t[0].id');
      await sleep(1500);
      const st = await call('const t=await browser.tabs.query({url:"http://localhost/*"});if(!t[0])return {dbg:JSON.stringify((await browser.tabs.query({})).map(x=>[x.id,x.url,x.active])),perm:JSON.stringify(await browser.permissions.getAll())};const id=t[0].id;const r=await browser.runtime.sendMessage({type:"start",tabId:id,kbps:'+(o.kbps===undefined?192:o.kbps)+'});return {id,r}');
      if (!st.r || !st.r.ok || st.dbg) throw new Error('start failed ' + JSON.stringify(st));
      let state = {};
      if (o.mid === 'reload') {
        await sleep(2000);
        await driver.switchTo().window(pageH);
        await driver.executeScript('window.__ready=false;location.reload()');
        await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {});
        await driver.switchTo().window(ctl);
        await sleep(REC_SEC * 1000 - 2000);
      } else if (o.mid === 'close') {
        await sleep(3000);
        await driver.switchTo().window(pageH);
        await driver.close();
        await driver.switchTo().window(ctl);
      } else await sleep(REC_SEC * 1000);
      let titleBad = '';
      if (name === 'audio-element 440') {
        await driver.switchTo().window(pageH);
        const seen = new Set();
        let on = '';
        for (let i = 0; i < 5; i++) { on = await driver.getTitle(); seen.add(Array.from(on)[0]); await sleep(450); }
        await driver.switchTo().window(ctl);
        if (!on.includes('REC')) titleBad = 'no REC mark in title: ' + on;
        else if (!(seen.has('🔴') && seen.has('⚪'))) titleBad = 'dot does not blink, seen: ' + [...seen].join(',');
        const ic = await iconUrl();
        console.log('ICON during recording:', ic);
        if (!/icon-rec\.svg/.test(ic)) titleBad += ' toolbar icon is not red: ' + ic;
      }
      if (o.mid !== 'close') {
        state = await call('return await browser.runtime.sendMessage({type:"state",tabId:a[0]})', st.id);
        await call('return await browser.runtime.sendMessage({type:"stop",tabId:a[0]})', st.id);
      }
      if (name === 'audio-element 440') {
        await sleep(1500);
        await driver.switchTo().window(pageH);
        const off = await driver.getTitle();
        await driver.switchTo().window(ctl);
        if (off.includes('REC')) titleBad = 'REC mark stays after stop: ' + off;
        const ic2 = await iconUrl();
        console.log('ICON after stop:', ic2);
        if (/icon-rec\.svg/.test(ic2) || !/icon\.svg/.test(ic2)) titleBad += ' toolbar icon not green after stop: ' + ic2;
      }
      let file = null;
      for (let i = 0; i < 60 && !file; i++) {
        await sleep(500);
        const d = path.join(dl, 'AudioRecTab');
        const f = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith(o.kbps === 0 ? '.wav' : '.mp3')) : [];
        if (f.length) { const p = path.join(d, f[0]); const s1 = fs.statSync(p).size; await sleep(700); if (fs.statSync(p).size === s1) file = p; }
      }
      if (!file) throw new Error('no mp3 downloaded');
      fs.mkdirSync('/tmp/mp3tab-out', { recursive: true });
      fs.copyFileSync(file, `/tmp/mp3tab-out/${name.replace(/[^a-z0-9]+/gi, '_')}.mp3`);
      const a = analyze(file);
      const bad = titleBad ? [titleBad] : [];
      if (a.codec !== (o.kbps === 0 ? 'pcm_s16le' : 'mp3')) bad.push('codec ' + a.codec);
      const want = o.dur || REC_SEC;
      if (a.dur < want - 1 || a.dur > want + 3) bad.push('duration ' + a.dur.toFixed(2));
      if (expect.silent) {
        if (Math.max(...Object.values(a.amp)) > 0.01) bad.push('expected silence, got ' + JSON.stringify(a.amp));
        if (state.warn !== 'silent') bad.push('warn not raised (' + state.warn + ')');
      } else {
        for (const f of [440, 660, 880]) {
          if (expect[f] && a.amp[f] < 0.1) bad.push(`freq ${f} weak ${a.amp[f].toFixed(3)}`);
          if (!expect[f] && a.amp[f] > 0.02) bad.push(`freq ${f} unexpected ${a.amp[f].toFixed(3)}`);
        }
        if (a.drop > 0 && !o.gap) bad.push('dropouts ' + a.drop);
      }
      if (name === 'audio-element 440') ref440 = a.amp[440];
      if (name.startsWith('media via') && ref440 && Math.abs(a.amp[440] / ref440 - 1) > 0.25) bad.push(`level ${a.amp[440].toFixed(3)} vs ref ${ref440.toFixed(3)} (double capture?)`);
      r.ok = !bad.length;
      r.note = `${a.codec} ${a.rate}Hz ${a.ch}ch ${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)} amp660=${a.amp[660].toFixed(3)} amp880=${a.amp[880].toFixed(3)} lead=${a.lead.toFixed(2)}s drop=${a.drop} warn=${state.warn} ${bad.join('; ')}`;
    } catch (e) { r.note = String(e.message || e); }
    if (!r.ok && attempt < 2) retry.push(cs);
    if (attempt > 1) r.note += ` [attempt 2; attempt 1: ${prevNote.slice(0, 140)}]`;
    const hs = await driver.getAllWindowHandles();
    for (const h of hs) if (h !== ctl) { await driver.switchTo().window(h); await driver.close(); }
    await driver.switchTo().window(ctl);
  }
  queue = retry;
  }

  // --- wait-for-sound mode: recording starts when audio starts and stops when the track ends
  const WAIT = 'wait mode: auto start + auto stop', CANCEL = 'wait mode: cancel';
  const PAUSE = 'wait mode: pause stops', RESUME = 'wait mode: short pause keeps recording', WEBA = 'wait mode: web audio does not auto-stop';
  const DEVICE = 'device recording (fake input device)', CLICK = 'wait mode: sound starts after a click';

  async function iconUrl() {
    await driver.setContext(firefox.Context.CHROME);
    const v = await driver.executeScript('const W="audiorectab_lyapupastar-browser-action";try{CustomizableUI.addWidgetToArea(W,CustomizableUI.AREA_NAVBAR)}catch(e){}const n=document.getElementById(W);const i=n&&n.querySelector(".toolbarbutton-icon");return i?String(i.getAttribute("src")||getComputedStyle(i).listStyleImage||""):("nonode "+[...document.querySelectorAll("[id*=mp3tab]")].map((e)=>e.id).join(","))');
    await driver.setContext(firefox.Context.CONTENT);
    return v;
  }
  const wantWait = (n) => !process.env.ONLY || n.includes(process.env.ONLY);
  if ([WAIT, CANCEL, PAUSE, RESUME, WEBA, DEVICE, CLICK].some(wantWait)) {
    fs.mkdirSync('/tmp/mp3tab-out', { recursive: true });
    const tabQ = 'const t=await browser.tabs.query({url:"http://localhost/*"});const id=t[0].id;';
    const closeOthers = async () => {
      for (const h of await driver.getAllWindowHandles()) if (h !== ctl) { await driver.switchTo().window(h); await driver.close(); }
      await driver.switchTo().window(ctl);
    };
    if (wantWait(WAIT)) {
      const r = { name: WAIT, ok: false, note: '' };
      results.push(r);
      fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
      try {
        await driver.switchTo().newWindow('tab');
        await driver.get(`http://localhost:${P1}/delayed.html`);
        await driver.switchTo().window(ctl);
        const w = await call(tabQ + 'const r=await browser.runtime.sendMessage({type:"watch",tabId:id,kbps:192});await new Promise(s=>setTimeout(s,800));return {r,s:await browser.runtime.sendMessage({type:"state",tabId:id})}');
        const bad = [];
        if (!w.r || !w.r.ok) bad.push('watch failed ' + JSON.stringify(w.r));
        if (!w.s.waiting || w.s.recording) bad.push('not waiting: ' + JSON.stringify(w.s));
        let started = null;
        for (let i = 0; i < 40 && !started; i++) {
          await sleep(500);
          const s2 = await call(tabQ + 'return await browser.runtime.sendMessage({type:"state",tabId:id})');
          if (s2.recording) started = s2;
        }
        if (!started) bad.push('recording did not start by itself');
        else if (!started.auto) bad.push('started, but not as auto');
        let file = null;
        for (let i = 0; i < 80 && !file; i++) {
          await sleep(500);
          const d = path.join(dl, 'AudioRecTab');
          const f = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.mp3') || n.endsWith('.wav')) : [];
          if (f.length) { const pth = path.join(d, f[0]); const z = fs.statSync(pth).size; await sleep(700); if (fs.statSync(pth).size === z) file = pth; }
        }
        if (!file) bad.push('no mp3 saved after the track ended');
        else {
          fs.copyFileSync(file, '/tmp/mp3tab-out/wait_mode.mp3');
          const a = analyze(file);
          if (a.codec !== 'mp3') bad.push('codec ' + a.codec);
          if (a.amp[440] < 0.1) bad.push('freq 440 weak ' + a.amp[440].toFixed(3));
          if (a.dur < 3.6 || a.dur > 5.5) bad.push('duration ' + a.dur.toFixed(2) + ' (clip is 4 s)');
          if (a.lead > 0.35) bad.push('sound starts late: lead ' + a.lead.toFixed(2) + 's');
          r.note = `${a.codec} ${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)} lead=${a.lead.toFixed(2)}s ${bad.join('; ')}`;
        }
        const after = await call(tabQ + 'return await browser.runtime.sendMessage({type:"state",tabId:id})').catch(() => ({}));
        if (after.recording) bad.push('still recording after the file was saved');
        r.ok = !bad.length;
        if (!r.note) r.note = bad.join('; ');
      } catch (e) { r.note = String(e.message || e); }
      await closeOthers();
    }
    if (wantWait(CANCEL)) {
      const r = { name: CANCEL, ok: false, note: '' };
      results.push(r);
      fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
      try {
        await driver.switchTo().newWindow('tab');
        await driver.get(`http://localhost:${P1}/delayed.html`);
        await driver.switchTo().window(ctl);
        await call(tabQ + 'await browser.runtime.sendMessage({type:"watch",tabId:id,kbps:192});await browser.runtime.sendMessage({type:"unwatch",tabId:id});return 1');
        await sleep(6000);
        const st = await call(tabQ + 'return await browser.runtime.sendMessage({type:"state",tabId:id})');
        const d = path.join(dl, 'AudioRecTab');
        const files = fs.existsSync(d) ? fs.readdirSync(d) : [];
        const bad = [];
        if (st.waiting || st.recording) bad.push('state after cancel: ' + JSON.stringify(st));
        if (files.length) bad.push('file appeared after cancel');
        r.ok = !bad.length;
        r.note = bad.join('; ') || 'no recording after cancel';
      } catch (e) { r.note = String(e.message || e); }
      await closeOthers();
    }

    // --- helpers for the pause / protected / web audio cases
    const stateOf = () => call(tabQ + 'return await browser.runtime.sendMessage({type:"state",tabId:id})');
    const inPage = async (h, js) => { await driver.switchTo().window(h); await driver.executeScript(js); await driver.switchTo().window(ctl); };
    const openWait = async (url) => {
      fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
      await driver.switchTo().newWindow('tab');
      const h = await driver.getWindowHandle();
      await driver.get(`http://localhost:${P1}${url}`);
      await driver.switchTo().window(ctl);
      const w = await call(tabQ + 'return await browser.runtime.sendMessage({type:"watch",tabId:id,kbps:192})');
      if (!w || !w.ok) throw new Error('watch failed ' + JSON.stringify(w));
      return h;
    };
    const untilState = async (pred, maxMs) => {
      const t0 = Date.now();
      for (;;) {
        const s = await stateOf();
        if (pred(s)) return { s, ms: Date.now() - t0 };
        if (Date.now() - t0 > maxMs) return { s, ms: -1 };
        await sleep(250);
      }
    };
    const getFile = async (maxIter = 60) => {
      for (let i = 0; i < maxIter; i++) {
        await sleep(500);
        const d = path.join(dl, 'AudioRecTab');
        const f = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.mp3') || n.endsWith('.wav')) : [];
        if (f.length) { const pth = path.join(d, f[0]); const z = fs.statSync(pth).size; await sleep(700); if (fs.statSync(pth).size === z) return { pth, n: f.length }; }
      }
      return null;
    };

    // all players on pause for 5 s -> the recording stops and is saved, tail cut near the pause
    if (wantWait(PAUSE)) {
      const r = { name: PAUSE, ok: false, note: '' };
      results.push(r);
      try {
        const h = await openWait('/delayedlong.html');
        const bad = [];
        const st = await untilState((s) => s.recording, 20000);
        if (st.ms < 0) throw new Error('recording did not start by itself');
        await sleep(3000);
        await inPage(h, 'document.getElementById("a").pause()');
        const stopped = await untilState((s) => !s.recording, 20000);
        if (stopped.ms < 0) bad.push('did not stop after pause');
        else if (stopped.ms < 4300 || stopped.ms > 9000) bad.push(`stopped ${stopped.ms} ms after pause (want about 5000)`);
        const f = await getFile();
        if (!f) bad.push('no mp3 saved');
        else {
          fs.copyFileSync(f.pth, '/tmp/mp3tab-out/wait_pause.mp3');
          const a = analyze(f.pth);
          if (a.amp[440] < 0.1) bad.push('freq 440 weak ' + a.amp[440].toFixed(3));
          if (a.dur < 2.5 || a.dur > 5.5) bad.push('duration ' + a.dur.toFixed(2) + ' (3 s of sound, tail must be cut near the pause)');
          r.note = `${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)} stop after ${stopped.ms} ms `;
        }
        r.ok = !bad.length;
        r.note = (r.note || '') + bad.join('; ');
      } catch (e) { r.note = String(e.message || e); }
      await closeOthers();
    }

    // a short pause must not end the recording: one file with the silence inside
    if (wantWait(RESUME)) {
      const r = { name: RESUME, ok: false, note: '' };
      results.push(r);
      try {
        const h = await openWait('/delayedlong.html');
        const bad = [];
        const st = await untilState((s) => s.recording, 20000);
        if (st.ms < 0) throw new Error('recording did not start by itself');
        await sleep(2000);
        await inPage(h, 'document.getElementById("a").pause()');
        await sleep(2000);
        await inPage(h, 'document.getElementById("a").play()');
        await sleep(2500);
        const s1 = await stateOf();
        if (!s1.recording) bad.push('recording ended during a short pause');
        await call(tabQ + 'return await browser.runtime.sendMessage({type:"stop",tabId:id})');
        const f = await getFile();
        if (!f) bad.push('no mp3 saved');
        else {
          if (f.n !== 1) bad.push(f.n + ' files');
          const a = analyze(f.pth);
          if (a.dur < 5.3 || a.dur > 8.5) bad.push('duration ' + a.dur.toFixed(2) + ' (want about 6.5)');
          r.note = `${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)} `;
        }
        r.ok = !bad.length;
        r.note = (r.note || '') + bad.join('; ');
      } catch (e) { r.note = String(e.message || e); }
      await closeOthers();
    }
    // Web Audio-only page has no media element events: the auto recording must keep going until a manual stop
    if (wantWait(WEBA)) {
      const r = { name: WEBA, ok: false, note: '' };
      results.push(r);
      try {
        await openWait('/webaudio.html');
        const bad = [];
        const st = await untilState((s) => s.recording, 20000);
        if (st.ms < 0) throw new Error('recording did not start by itself');
        await sleep(6000);
        const s1 = await stateOf();
        if (!s1.recording) bad.push('recording stopped by itself');
        await call(tabQ + 'return await browser.runtime.sendMessage({type:"stop",tabId:id})');
        const f = await getFile();
        if (!f) bad.push('no mp3 saved');
        else {
          const a = analyze(f.pth);
          if (a.amp[880] < 0.1) bad.push('freq 880 weak ' + a.amp[880].toFixed(3));
          if (a.dur < 5) bad.push('duration ' + a.dur.toFixed(2));
          r.note = `${a.dur.toFixed(2)}s amp880=${a.amp[880].toFixed(3)} `;
        }
        r.ok = !bad.length;
        r.note = (r.note || '') + bad.join('; ');
      } catch (e) { r.note = String(e.message || e); }
      await closeOthers();
    }

    // record from an audio input device through device.html (Firefox fake input device in the test profile)
    if (wantWait(DEVICE)) {
      const r = { name: DEVICE, ok: false, note: '' };
      results.push(r);
      try {
        fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
        const before = new Set(await driver.getAllWindowHandles());
        await driver.setContext(firefox.Context.CHROME);
        await driver.executeScript('const t=gBrowser.addTab(arguments[0],{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});gBrowser.selectedTab=t;', `moz-extension://${UUID}/device.html`);
        await driver.setContext(firefox.Context.CONTENT);
        const devH = (await driver.getAllWindowHandles()).find((h) => !before.has(h));
        await driver.switchTo().window(devH);
        const bad = [];
        // like a user: the list is empty until access is allowed
        await call('await new Promise(r=>setTimeout(r,1000));const b=document.getElementById("allow");if(!b.hidden)b.click();return 1');
        const ready = await call('for(let i=0;i<60;i++){const s=document.getElementById("dev");if(s.options.length>1)return s.options.length;await new Promise(r=>setTimeout(r,250));}return 0');
        if (!ready) throw new Error('no devices listed (allow button hidden=' + await call('return document.getElementById("allow").hidden') + ')');
        // REAL_DEVICE='BlackHole 2ch' (manual, not part of npm test) records a real input while afplay plays a quiet tone
        await call('const s=document.getElementById("dev");const w=a[0];const o=[...s.options].find((x,i)=>i>0&&(!w||x.textContent.includes(w)));if(!o)return -1;s.value=o.value;s.dispatchEvent(new Event("change"));for(let i=0;i<60;i++){if(!document.getElementById("btn").disabled)return 1;await new Promise(r=>setTimeout(r,250));}return 0', process.env.REAL_DEVICE || '');
        const warn0 = await call('return document.getElementById("err").hidden ? "" : document.getElementById("err").textContent');
        if (warn0) throw new Error('device did not open: ' + warn0);
        // manual long run: REAL_SEC=300 REAL_KBPS=0 REAL_TONE=/tmp/tone48.wav REAL_OUT_INDEX=0 (the tone goes straight into BlackHole via audiotoolbox, speakers stay silent)
        if (process.env.REAL_KBPS) await call('const k=document.getElementById("kbps");k.value=a[0];k.dispatchEvent(new Event("change"));return 1', process.env.REAL_KBPS);
        if (process.env.REAL_SINK_TONE) {
          await driver.switchTo().newWindow('tab');
          await driver.get(`http://127.0.0.1:${P1}/sinktone.html`);
          const tr = await driver.executeAsyncScript('const cb=arguments[arguments.length-1];(async()=>{const t=await navigator.mediaDevices.getUserMedia({audio:true});t.getTracks().forEach(x=>x.stop());const d=(await navigator.mediaDevices.enumerateDevices()).find(x=>x.kind==="audiooutput"&&/BlackHole 2ch/.test(x.label));if(!d)return cb("no BlackHole output");const a=document.getElementById("a");await a.setSinkId(d.deviceId);await a.play();cb("playing to "+a.sinkId.slice(0,6));})().catch(e=>cb("ERR "+e))');
          console.log('sink tone:', tr);
          await driver.switchTo().window(devH);
        }
        const tone = process.env.REAL_DEVICE ? (process.env.REAL_TONE
          ? spawn('ffmpeg', ['-v', 'error', '-re', '-i', process.env.REAL_TONE, '-f', 'audiotoolbox', '-audio_device_index', process.env.REAL_OUT_INDEX || '0', '-'], { stdio: 'ignore' })
          : spawn('afplay', ['-v', '0.3', path.join(media, 'a440.wav')], { stdio: 'ignore' })) : null;
        await call('document.getElementById("btn").click();return 1');
        await sleep(REAL_SEC ? REAL_SEC * 1000 : 5000);
        const info = await call('return document.getElementById("info").textContent');
        const dg = process.env.REAL_DEVICE ? await call('return JSON.stringify((await browser.storage.local.get("deviceDiag")).deviceDiag || null)') : '';
        await call('document.getElementById("btn").click();return 1');
        if (tone) tone.kill();
        const f = await getFile();
        if (!f) bad.push('no mp3 saved');
        else {
          fs.copyFileSync(f.pth, '/tmp/mp3tab-out/device' + path.extname(f.pth));
          const a = analyze(f.pth);
          if (a.codec !== 'mp3' && process.env.REAL_KBPS !== '0') bad.push('codec ' + a.codec);
          if (!REAL_SEC && (a.dur < 4 || a.dur > 8)) bad.push('duration ' + a.dur.toFixed(2));
          if (a.rmsAll < 0.005) bad.push('silent file, rms ' + a.rmsAll.toFixed(4));
          // with a real device other system sound may be playing too, so the tone is only reported, not required
          r.note = `${a.dur.toFixed(2)}s rms=${a.rmsAll.toFixed(3)} amp440=${a.amp[440].toFixed(3)} diag=${dg} info="${info}" file="${path.basename(f.pth)}" `;
        }
        r.ok = !bad.length;
        r.note = (r.note || '') + bad.join('; ');
      } catch (e) { r.note = String(e.message || e); }
      await closeOthers();
    }

    // wait mode armed first, the user clicks play later, under Firefox's default autoplay policy (prefs switched for this case only)
    if (wantWait(CLICK)) {
      const r = { name: CLICK, ok: false, note: '' };
      results.push(r);
      const prefs = { 'media.autoplay.block-webaudio': true, 'media.autoplay.default': 1 };
      const setPrefs = async (o) => {
        await driver.setContext(firefox.Context.CHROME);
        await driver.executeScript('for(const [k,v] of Object.entries(arguments[0])){if(typeof v==="boolean")Services.prefs.setBoolPref(k,v);else Services.prefs.setIntPref(k,v);}', o);
        await driver.setContext(firefox.Context.CONTENT);
      };
      try {
        // the real default autoplay policy: a context made before any user gesture starts suspended
        await setPrefs(prefs);
        const h = await openWait('/gesture.html');
        const bad = [];
        await sleep(1500);
        await driver.switchTo().window(h);
        await driver.findElement({ id: 'go' }).click();
        await driver.switchTo().window(ctl);
        const st = await untilState((s) => s.recording, 12000);
        if (st.ms < 0) bad.push('recording did not start after the click');
        else { await sleep(2500); await call(tabQ + 'return await browser.runtime.sendMessage({type:"stop",tabId:id})'); }
        const f = st.ms >= 0 ? await getFile() : null;
        if (st.ms >= 0 && !f) bad.push('no mp3 saved');
        if (f) { const a = analyze(f.pth); if (a.amp[440] < 0.1) bad.push('freq 440 weak ' + a.amp[440].toFixed(3)); r.note = `${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)}`; }
        r.ok = !bad.length;
        r.note = (r.note || '') + bad.join('; ');
      } catch (e) { r.note = String(e.message || e); }
      await setPrefs({ 'media.autoplay.block-webaudio': false, 'media.autoplay.default': 0 }).catch(() => {});
      await closeOthers();
    }
  }
} finally {
  await driver.quit().catch(() => {});
  s1.close(); s2.close();
}
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.note}`);
// Windows may still hold a media file open for a moment after the servers close
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { console.log('temp cleanup skipped:', e.code); }
process.exit(results.every((r) => r.ok) ? 0 : 1);
