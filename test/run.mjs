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
ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '30', path.join(media, 'silence.wav')]);
// fade-in from -90 dB to 0 dB over 2 s, then 2 s at full level: crosses -60 dB at 0.67 s, -84 dB at 0.13 s
ff(['-f', 'lavfi', '-i', 'aevalsrc=0.5*pow(10\\,min(0\\,-90+45*t)/20)*sin(2*PI*440*t):s=44100:d=4', '-ac', '2', path.join(media, 'fadein.wav')]);
if (process.env.REAL_SINK_TONE) ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=' + (+process.env.REAL_SINK_TONE), '-af', 'volume=0.5', '-ac', '2', path.join(media, 'tone_long.wav')]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=40', '-af', 'volume=4',
  '-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libopus', path.join(media, 'v660.webm')]);

// endless Icecast-like stream: no content-length, burst at connect, then ~real-time
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=40', '-af', 'volume=4', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0', '-id3v2_version', '0', path.join(media, 'a440.mp3')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=40', '-af', 'volume=4', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', path.join(media, 'a440.aac')]);
// HLS fixtures for whole-track saving: 20 s of 660 Hz in every segment kind
const hlsDir = path.join(media, 'hls');
const hlsOut = (name, codec, extra = []) => {
  const d = path.join(hlsDir, name); fs.mkdirSync(d, { recursive: true });
  const fmp4 = extra.includes('fmp4');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=' + (codec === 'libopus' ? 48000 : 44100) + ':duration=20', '-af', 'volume=4', '-ac', '2', '-c:a', codec, '-b:a', '128k',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', ...(fmp4 ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4'] : []),
    ...extra.filter((x) => x !== 'fmp4'), '-hls_segment_filename', path.join(d, fmp4 ? 's%03d.m4s' : 's%03d.ts'), path.join(d, 'index.m3u8')]);
};
hlsOut('ts', 'aac');
{
  const d = path.join(hlsDir, 'next'); fs.mkdirSync(d, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=30', '-af', 'volume=4', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(d, 's%03d.ts'), path.join(d, 'index.m3u8')]);
}
hlsOut('fmp4', 'aac', ['fmp4']);
hlsOut('mp3', 'libmp3lame');
hlsOut('opus', 'libopus', ['fmp4']);
fs.mkdirSync(path.join(hlsDir, 'aes'), { recursive: true });
fs.writeFileSync(path.join(hlsDir, 'aes', 'k.key'), Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
fs.writeFileSync(path.join(hlsDir, 'aes', 'k.info'), `k.key\n${path.join(hlsDir, 'aes', 'k.key')}\n`);
hlsOut('aes', 'aac', ['-hls_key_info_file', path.join(hlsDir, 'aes', 'k.info')]);
fs.mkdirSync(path.join(hlsDir, 'sample'), { recursive: true });
fs.writeFileSync(path.join(hlsDir, 'sample', 'index.m3u8'), fs.readFileSync(path.join(hlsDir, 'ts', 'index.m3u8'), 'utf8').replace('#EXTINF', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF').replace(/^s0/gm, '../ts/s0'));
fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=70000,CODECS="mp4a.40.2"\nmp3/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=140000,CODECS="mp4a.40.2"\nts/index.m3u8\n');
fs.writeFileSync(path.join(hlsDir, 'live.m3u8'), fs.readFileSync(path.join(hlsDir, 'ts', 'index.m3u8'), 'utf8').replace('#EXT-X-ENDLIST', '').replace('#EXT-X-PLAYLIST-TYPE:VOD', '').replace(/s0/g, 'ts/s0'));
// DASH fixtures: 20 s of 880 Hz
const dashOut = (name, extra, opus) => {
  const d = path.join(media, 'dash', name); fs.mkdirSync(d, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=' + (opus ? 48000 : 44100) + ':duration=20', '-af', 'volume=4', '-ac', '2', '-c:a', opus ? 'libopus' : 'aac', '-b:a', '128k',
    '-f', 'dash', '-seg_duration', '4', ...extra, path.join(d, 'manifest.mpd')]);
};
dashOut('timeline', ['-use_template', '1', '-use_timeline', '1']);
dashOut('number', ['-use_template', '1', '-use_timeline', '0']);
dashOut('list', ['-use_template', '0', '-use_timeline', '0']);
dashOut('single', ['-single_file', '1']);
dashOut('webm', ['-dash_segment_type', 'webm'], true);
{
  const d = path.join(media, 'dash', 'two'); fs.mkdirSync(d, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=20', '-af', 'volume=4', '-ac', '2', '-map', '0:a', '-map', '0:a', '-c:a', 'aac', '-b:a:0', '128k', '-b:a:1', '64k',
    '-f', 'dash', '-seg_duration', '4', '-adaptation_sets', 'id=0,streams=a', path.join(d, 'manifest.mpd')]);
  const st = path.join(media, 'dash', 'steps'); fs.mkdirSync(st, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*t*(300+100*floor(t/4))):s=44100:d=20', '-ac', '2', '-map', '0:a', '-map', '0:a', '-c:a', 'aac', '-b:a:0', '128k', '-b:a:1', '64k',
    '-f', 'dash', '-seg_duration', '4', '-adaptation_sets', 'id=0,streams=a', path.join(st, 'manifest.mpd')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=20', '-af', 'volume=4', '-ac', '2',
    '-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libopus', '-f', 'webm', path.join(media, 'muxed.webm')]);
}
// HE-AAC (as on many real streams): the macOS AudioToolbox encoder makes it; skipped where it is missing
const HEAAC = (() => { try { return /aac_at/.test(execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString()); } catch (e) { return false; } })();
if (HEAAC) {
  const d = path.join(media, 'dash', 'he'); fs.mkdirSync(d, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=20', '-af', 'volume=4', '-ac', '2', '-c:a', 'aac_at', '-profile:a', '4', '-b:a', '64k', '-f', 'dash', '-seg_duration', '4', path.join(d, 'manifest.mpd')]);
  const h = path.join(media, 'hls', 'he'); fs.mkdirSync(h, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=20', '-af', 'volume=4', '-ac', '2', '-c:a', 'aac_at', '-profile:a', '4', '-b:a', '64k', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(h, 's%03d.ts'), path.join(h, 'index.m3u8')]);
}
{
  const d = path.join(media, 'dash', 'av'); fs.mkdirSync(d, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=20', '-af', 'volume=4', '-ac', '2',
    '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-b:a', '128k', '-f', 'dash', '-seg_duration', '4', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', path.join(d, 'manifest.mpd')]);
}
fs.writeFileSync(path.join(media, 'dash', 'single', 'base.mpd'), fs.readFileSync(path.join(media, 'dash', 'single', 'manifest.mpd'), 'utf8').replace(/<SegmentList[\s\S]*?<\/SegmentList>/, '<SegmentBase/>'));
fs.writeFileSync(path.join(media, 'dash', 'live.mpd'), fs.readFileSync(path.join(media, 'dash', 'timeline', 'manifest.mpd'), 'utf8').replace('type="static"', 'type="dynamic"').replace(/<BaseURL>[^<]*<\/BaseURL>/, '').replace('<Period', '<BaseURL>timeline/</BaseURL><Period'));

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
const HLSPAGE = (pl) => `<video id=v></video><script>const v=document.getElementById('v');v.src=URL.createObjectURL(new MediaSource());fetch('${pl}').then(r=>r.text()).then(()=>{top.__ready=true});</script>`;
// MSE player without any manifest: appends the listed files to one SourceBuffer, one every `gap` ms
const MSEPAGE = (mime, files, gap = 0, after = '', eos = true) => `<audio id=a></audio><script>
const a=document.getElementById('a');const ms=new MediaSource();a.src=URL.createObjectURL(ms);
ms.addEventListener('sourceopen',async()=>{const sb=ms.addSourceBuffer('${mime}');
const app=(u)=>fetch(u).then(r=>r.arrayBuffer()).then(b=>new Promise(r=>{sb.addEventListener('updateend',r,{once:true});sb.appendBuffer(b);}));
const files=${JSON.stringify(files)};
for(let i=0;i<files.length;i++){await app(files[i]);if(i===0){try{ms.duration=20}catch(e){}${after}top.__ready=true;}if(${gap})await new Promise(r=>setTimeout(r,${gap}));}
${eos ? 'try{ms.endOfStream()}catch(e){}' : ''}});</script>`;
const D = (dir, st, list) => list.map((n) => `/media/dash/${dir}/${n === 'i' ? `init-stream${st}.m4s` : `chunk-stream${st}-0000${n}.m4s`}`);
const pages = {
  '/mse_full.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1, 2, 3, 4, 5])),
  '/mse_slow.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1, 2, 3, 4, 5]), 1200),
  '/mse_now.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1, 2, 3, 4, 5]), 3000),
  '/mse_switch.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', [...D('two', 0, ['i', 1, 2, 3]), ...D('two', 1, ['i', 2, 5, 4])]),
  '/mse_steps.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', [...D('steps', 1, ['i', 4, 5]), ...D('steps', 0, ['i', 1, 3, 2, 3]), ...D('steps', 1, ['i', 2])]),
  '/queue.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1]), 0, "navigator.mediaSession.metadata=new MediaMetadata({title:'Real Title',artist:'Real Artist'});await fetch('/media/hls/ts/index.m3u8');await fetch('/media/hls/next/index.m3u8');", false),
  '/queue_nomatch.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1, 2, 3, 4, 5]), 0, "await fetch('/media/hls/next/index.m3u8');"),
  '/fetch_next.html': '<script>fetch("/media/hls/next/index.m3u8").then(()=>{top.__ready=true});</script>',
  '/mse_drm.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1]), 0, "const acc=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['cenc'],audioCapabilities:[{contentType:'audio/mp4'}]}]);await a.setMediaKeys(await acc.createMediaKeys());await fetch('/media/hls/ts/index.m3u8');", false),
  '/mse_drm_only.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1]), 0, "const acc=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['cenc'],audioCapabilities:[{contentType:'audio/mp4'}]}]);await a.setMediaKeys(await acc.createMediaKeys());", false),
  '/mse_drm_enc.html': MSEPAGE('audio/mp4; codecs="mp4a.40.2"', D('two', 0, ['i', 1]), 0, "const acc=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['cenc'],audioCapabilities:[{contentType:'audio/mp4'}]}]);await a.setMediaKeys(await acc.createMediaKeys());await fetch('/media/hls/sample/index.m3u8');", false),
  '/mse_webm.html': MSEPAGE('audio/webm; codecs="opus"', ['/media/dash/webm/init-stream0.webm', ...[1, 2, 3, 4, 5].map((n) => `/media/dash/webm/chunk-stream0-0000${n}.webm`)]),
  '/mse_muxed.html': MSEPAGE('video/webm; codecs="vp8,opus"', ['/media/muxed.webm']),
  '/nosound.html': '<p>no sound here</p><script>top.__ready=true</script>',
  '/fastfile.html': '<audio id=a src="/media/a440.wav" preload="metadata"></audio><script>document.getElementById("a").onloadedmetadata=()=>{top.__ready=true};</script>',
  '/fast_ts.html': HLSPAGE('/media/hls/ts/index.m3u8'),
  '/fast_fmp4.html': HLSPAGE('/media/hls/fmp4/index.m3u8'),
  '/fast_mp3.html': HLSPAGE('/media/hls/mp3/index.m3u8'),
  '/fast_aes.html': HLSPAGE('/media/hls/aes/index.m3u8'),
  '/fast_opus.html': HLSPAGE('/media/hls/opus/index.m3u8'),
  '/fast_master.html': HLSPAGE('/media/hls/master.m3u8'),
  '/fast_live.html': HLSPAGE('/media/hls/live.m3u8'),
  '/dash_timeline.html': HLSPAGE('/media/dash/timeline/manifest.mpd'),
  '/dash_number.html': HLSPAGE('/media/dash/number/manifest.mpd'),
  '/dash_list.html': HLSPAGE('/media/dash/list/manifest.mpd'),
  '/dash_single.html': HLSPAGE('/media/dash/single/manifest.mpd'),
  '/dash_base.html': HLSPAGE('/media/dash/single/base.mpd'),
  '/dash_webm.html': HLSPAGE('/media/dash/webm/manifest.mpd'),
  '/dash_he.html': HLSPAGE('/media/dash/he/manifest.mpd'),
  '/hls_he.html': HLSPAGE('/media/hls/he/index.m3u8'),
  '/dash_av.html': HLSPAGE('/media/dash/av/manifest.mpd'),
  '/dash_live.html': HLSPAGE('/media/dash/live.mpd'),
  '/hls_and_dash.html': `<video id=v></video><script>const v=document.getElementById('v');v.src=URL.createObjectURL(new MediaSource());fetch('/media/hls/ts/index.m3u8').then(()=>fetch('/media/dash/timeline/manifest.mpd')).then(()=>{top.__ready=true});</script>`,
  '/audio.html': AUDIO('/media/a440.wav'),
  '/silentplay.html': AUDIO('/media/silence.wav'),
  '/fadein.html': '<audio id=a src="/media/fadein.wav"></audio><script>top.__ready=true;setTimeout(()=>document.getElementById("a").play(),3000);</script>',
  '/drmplay.html': AUDIO('/media/silence.wav', "navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['cenc'],audioCapabilities:[{contentType:'audio/mp4'}]}]).then((x)=>x.createMediaKeys()).then((k)=>a.setMediaKeys(k));"),
  '/sinktone.html': '<audio id=a src="/media/tone_long.wav"></audio>',
  '/video.html': '<video id=a src="/media/v660.webm" loop></video><script>const a=document.getElementById("a");a.play().then(()=>{top.__ready=true});</script>',
  '/webaudio.html': `<script>${WA(880)}</script>`,
  '/iframe.html': '<iframe src="/audio.html"></iframe>',
  '/mix.html': `<audio id=a src="/media/a440.wav" loop></audio><script>document.getElementById('a').play();${WA(880, 0.5)}</script>`,
  '/routedgain0.html': `<audio id=a src="/media/a440.wav" loop></audio><script>const a=document.getElementById('a');const c=new AudioContext();const g=c.createGain();g.gain.value=0;c.createMediaElementSource(a).connect(g);g.connect(c.destination);c.resume();a.play().then(()=>{top.__ready=true});</script>`,
  '/mixgain.html': `<audio id=a src="/media/a440.wav" loop></audio><script>const a=document.getElementById('a');const c=new AudioContext();const g=c.createGain();g.gain.value=0;c.createMediaElementSource(a).connect(g);g.connect(c.destination);const o=c.createOscillator();o.frequency.value=880;const og=c.createGain();og.gain.value=0.5;o.connect(og);og.connect(c.destination);o.start();c.resume();a.play().then(()=>{top.__ready=true});</script>`,
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
    const size = fs.statSync(f).size, type = { '.wav': 'audio/wav', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'audio/mp4', '.mp4': 'audio/mp4', '.key': 'application/octet-stream', '.mpd': 'application/dash+xml' }[path.extname(f)] || 'video/webm';
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

  const muteTab = async (on) => {
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript('for(const t of gBrowser.tabs) if(t.linkedBrowser.currentURI.spec.startsWith("http://localhost:")&&t.muted!==arguments[0]) t.toggleMuteAudio();', on);
    await driver.setContext(firefox.Context.CONTENT);
  };
  const cases = [
    ['audio-element 440', '/audio.html', { 440: 1 }],
    ['video-element 660', '/video.html', { 660: 1 }],
    ['webaudio 880', '/webaudio.html', { 880: 1 }],
    ['iframe(audio 440)', '/iframe.html', { 440: 1 }],
    ['detached Audio() 440', '/detached.html', { 440: 1 }],
    ['audio+webaudio 440+880', '/mix.html', { 440: 1, 880: 1 }],
    ['media via createMediaElementSource', '/routed.html', { 440: 1 }],
    ['ignore site sound: site volume 0 (Web Audio gain)', '/routedgain0.html', { 440: 1 }],
    ['ignore site sound: Web Audio player in a muted tab', '/routed.html', { 440: 1 }, { tabmute: true }],
    ['ignore site sound off: follows site volume 0', '/routedgain0.html', {}, { ign: false, warn: 'silent', rec: 9, dur: 9 }],
    ['ignore site sound: mixed Web Audio context keeps site mix', '/mixgain.html', { 880: 1 }],
    ['cross-origin audio via background fetch 440', '/cross.html', { 440: 1 }],
    ['endless stream 440 (Icecast-like)', '/stream.html', { 440: 1 }],
    ['endless AAC (ADTS) stream 440', '/streamaac.html', { 440: 1 }],
    ['WAV output 440', '/audio.html', { 440: 1 }, { kbps: 0 }],
    ['audio started by a click', '/gesture.html', { 440: 1 }, { click: true }],
    ['reload mid-recording', '/audio.html', { 440: 1 }, { mid: 'reload', gap: true }],
    ['tab closed while recording', '/audio.html', { 440: 1 }, { mid: 'close', dur: 3 }],
    ['silence warning: player plays, recording silent (file kept)', '/silentplay.html', {}, { warn: 'silent', rec: 9, dur: 9 }],
    ['silence warning: DRM player (mediaKeys)', '/drmplay.html', {}, { warn: 'drm' }],
    ['recording starts with the sound, not with the click', '/delayedlong.html', { 440: 1 }, { rec: 6, dur: 3, lead: 0.1 }]
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
      await call('await browser.storage.local.set({ignoreSite:a[0]});return 1', o.ign !== false);
      await driver.switchTo().newWindow('tab');
      const pageH = await driver.getWindowHandle();
      await driver.get(`http://localhost:${P1}${url}`);
      await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {});
      if (o.tabmute) await muteTab(true);
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
      } else await sleep((o.rec || REC_SEC) * 1000);
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
      if (o.nofile) {
        await sleep(5000);
        const d = path.join(dl, 'AudioRecTab'), f = fs.existsSync(d) ? fs.readdirSync(d) : [];
        const bad = f.length ? ['file saved for a silent recording: ' + f.join(',')] : [];
        if ((state.warn || '') !== (o.warn || '')) bad.push(`warn ${state.warn || 'none'} (want ${o.warn || 'none'})`);
        r.ok = !bad.length;
        r.note = `no file, warn=${state.warn} ` + bad.join('; ');
        throw { skip: true };
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
      if ((state.warn || '') !== (o.warn || '') && o.mid !== 'close') bad.push(`warn ${state.warn || 'none'} (want ${o.warn || 'none'})`);
      if (o.lead !== undefined && a.lead > o.lead) bad.push(`silence at the start: lead ${a.lead.toFixed(2)} s`);
      if (name === 'audio-element 440') ref440 = a.amp[440];
      if (name.startsWith('media via') && ref440 && Math.abs(a.amp[440] / ref440 - 1) > 0.25) bad.push(`level ${a.amp[440].toFixed(3)} vs ref ${ref440.toFixed(3)} (double capture?)`);
      r.ok = !bad.length;
      r.note = `${a.codec} ${a.rate}Hz ${a.ch}ch ${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)} amp660=${a.amp[660].toFixed(3)} amp880=${a.amp[880].toFixed(3)} lead=${a.lead.toFixed(2)}s drop=${a.drop} warn=${state.warn} ${bad.join('; ')}`;
    } catch (e) { if (!e || !e.skip) r.note = String(e.message || e); }
    if (!r.ok && attempt < 2) retry.push(cs);
    if (attempt > 1) r.note += ` [attempt 2; attempt 1: ${prevNote.slice(0, 140)}]`;
    const hs = await driver.getAllWindowHandles();
    for (const h of hs) if (h !== ctl) { await driver.switchTo().window(h); await driver.close(); }
    await driver.switchTo().window(ctl);
  }
  queue = retry;
  }
  await call('await browser.storage.local.set({ignoreSite:true});return 1');

  // two tabs at once: each gets its own file with only its own sound
  const TWO = 'two tabs recorded at once';
  if (!process.env.ONLY || TWO.includes(process.env.ONLY)) {
    const r = { name: TWO, ok: false, note: '' };
    results.push(r);
    fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
    try {
      for (const u of ['/audio.html', '/video.html']) {
        await driver.switchTo().newWindow('tab');
        await driver.get(`http://localhost:${P1}${u}`);
        await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {});
      }
      await driver.switchTo().window(ctl);
      const bad = [];
      const ids = await call('const t=await browser.tabs.query({url:"http://localhost/*"});const out=[];for(const x of t){const r=await browser.runtime.sendMessage({type:"start",tabId:x.id,kbps:192});out.push({id:x.id,ok:!!(r&&r.ok)});}return out');
      if (ids.length !== 2 || !ids.every((x) => x.ok)) bad.push('start ' + JSON.stringify(ids));
      const idl = ids.map((x) => x.id);
      await sleep(REC_SEC * 1000);
      const states = await call('const o=[];for(const id of a[0])o.push(await browser.runtime.sendMessage({type:"state",tabId:id}));return o', idl);
      if (!states.every((x) => x.recording)) bad.push('not both recording ' + JSON.stringify(states));
      await call('await Promise.all(a[0].map((id)=>browser.runtime.sendMessage({type:"stop",tabId:id})));return 1', idl);
      const d = path.join(dl, 'AudioRecTab');
      let files = [];
      for (let i = 0; i < 60 && files.length < 2; i++) { await sleep(500); files = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.mp3')).map((n) => path.join(d, n)) : []; }
      await sleep(1500);
      if (files.length !== 2) {
        bad.push('files ' + files.length);
        const after = await call('const o=[];for(const id of a[0])o.push(await browser.runtime.sendMessage({type:"state",tabId:id}));return JSON.stringify({o,rec:await browser.runtime.sendMessage({type:"recovered"})})', idl);
        bad.push('after stop ' + String(after).slice(0, 400) + ' dl=' + JSON.stringify(fs.existsSync(dl) ? fs.readdirSync(dl, { recursive: true }) : null));
      }
      const res = files.map(analyze);
      if (!res.some((a) => a.amp[440] > 0.1) || !res.some((a) => a.amp[660] > 0.1)) bad.push('a tone is missing');
      for (const a of res) {
        if (a.amp[440] > 0.02 && a.amp[660] > 0.02) bad.push('both tones in one file');
        if (a.dur < REC_SEC - 1 || a.dur > REC_SEC + 3) bad.push('duration ' + a.dur.toFixed(2));
        if (a.drop > 0) bad.push('dropouts ' + a.drop);
      }
      r.ok = !bad.length;
      r.note = res.map((a) => `${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)} amp660=${a.amp[660].toFixed(3)} drop=${a.drop}`).join(' | ') + ' ' + bad.join('; ');
    } catch (e) { r.note = String(e.message || e); }
    for (const h of await driver.getAllWindowHandles()) if (h !== ctl) { await driver.switchTo().window(h); await driver.close(); }
    await driver.switchTo().window(ctl);
  }

  // without the toolbar button: address bar icon, settings page, hotkey for whole-track save with title notes
  const UI = 'ui without the toolbar';
  if (!process.env.ONLY || UI.includes(process.env.ONLY)) {
    const r = { name: UI, ok: false, note: '' };
    results.push(r);
    fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
    const bad = [], notes = [];
    try {
      const pop = await driver.executeScript('return [!!document.getElementById("gear"), !!document.getElementById("nameTpl"), !!document.getElementById("ignoreSite")]');
      if (!pop[0] || pop[1] || pop[2]) bad.push('popup: gear/moved fields ' + JSON.stringify(pop));
      await driver.switchTo().newWindow('tab');
      const pageH = await driver.getWindowHandle();
      await driver.get(`http://localhost:${P1}/fastfile.html`);
      await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {});
      await driver.switchTo().window(ctl);
      const q = 'const t=await browser.tabs.query({url:"http://localhost/*"});const id=t[0].id;';
      await sleep(500);
      const shown1 = await call(q + 'return await browser.pageAction.isShown({tabId:id})');
      await call('await browser.storage.local.set({pageIcon:false});return 1'); await sleep(500);
      const shown2 = await call(q + 'return await browser.pageAction.isShown({tabId:id})');
      await call('await browser.storage.local.set({pageIcon:true});return 1'); await sleep(500);
      const shown3 = await call(q + 'return await browser.pageAction.isShown({tabId:id})');
      if (!(shown1 === true && shown2 === false && shown3 === true)) bad.push(`address bar icon ${shown1}/${shown2}/${shown3}`);
      await driver.switchTo().window(pageH);
      await driver.get(`http://localhost:${P1}/nosound.html`);
      await driver.switchTo().window(ctl); await sleep(700);
      const shown4 = await call(q + 'return await browser.pageAction.isShown({tabId:id})');
      await driver.switchTo().window(pageH);
      await driver.executeScript('document.body.appendChild(document.createElement("audio"))');
      await driver.switchTo().window(ctl); await sleep(700);
      const shown5 = await call(q + 'return await browser.pageAction.isShown({tabId:id})');
      if (!(shown4 === false && shown5 === true)) bad.push(`address bar icon without sound ${shown4}, after audio element ${shown5}`);
      await driver.switchTo().window(pageH);
      await driver.get(`http://localhost:${P1}/fastfile.html`);
      await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {});
      await driver.switchTo().window(ctl); await sleep(500);
      await call(q + 'const bg=await browser.runtime.getBackgroundPage();bg.runCommand("fast-save",{id});return 1');
      await driver.switchTo().window(pageH);
      for (let i = 0; i < 40; i++) { const tt = await driver.getTitle(); if (!notes.includes(tt)) notes.push(tt); if (tt.startsWith('✓')) break; await sleep(250); }
      await driver.switchTo().window(ctl);
      if (!notes.some((x) => x.startsWith('✓'))) bad.push('no done note in title: ' + notes.join(' | '));
      let file = null;
      for (let i = 0; i < 40 && !file; i++) { await sleep(250); const d = path.join(dl, 'AudioRecTab'); const f = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.mp3')) : []; if (f.length) file = path.join(d, f[0]); }
      if (!file) bad.push('hotkey: no file'); else { await sleep(500); const a = analyze(file); if (Math.abs(a.dur - 40) > 0.6) bad.push('hotkey file ' + a.dur.toFixed(2)); }
      await driver.switchTo().window(pageH);
      await driver.get(`http://localhost:${P1}/webaudio.html`);
      await driver.switchTo().window(ctl);
      await sleep(500);
      await call(q + 'const bg=await browser.runtime.getBackgroundPage();bg.runCommand("fast-save",{id});return 1');
      await driver.switchTo().window(pageH);
      let warn = '';
      for (let i = 0; i < 20 && !warn; i++) { const tt = await driver.getTitle(); if (tt.startsWith('⚠')) warn = tt; await sleep(250); }
      if (!warn) bad.push('no error note in title');
      await driver.close();
      await driver.switchTo().window(ctl);
      await driver.setContext(firefox.Context.CHROME);
      await driver.executeScript('const t=gBrowser.addTab(arguments[0],{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});gBrowser.selectedTab=t;', `moz-extension://${UUID}/options.html`);
      await driver.setContext(firefox.Context.CONTENT);
      await sleep(1000);
      const hs = await driver.getAllWindowHandles(), optH = hs.filter((h) => h !== ctl).pop();
      await driver.switchTo().window(optH);
      const opt = await driver.executeScript('return {keys:[...document.querySelectorAll("#keys li")].map(l=>l.textContent), icon:document.getElementById("pageIcon").checked, open:typeof browser.commands.openShortcutSettings}');
      await driver.executeScript('document.getElementById("pageIcon").click()');
      await sleep(300);
      await driver.switchTo().window(ctl);
      const afterClick = await call('return (await browser.storage.local.get("pageIcon")).pageIcon');
      await call('await browser.storage.local.set({pageIcon:true});return 1');
      if (opt.keys.length < 4 || !opt.keys.some((k) => k.includes('Alt+Shift+S')) || !opt.keys.some((k) => k.includes('Alt+Shift+O'))) bad.push('settings keys ' + JSON.stringify(opt.keys));
      if (!opt.icon || afterClick !== false) bad.push(`settings icon checkbox ${opt.icon}/${afterClick}`);
      r.note = `icon ${shown1}/${shown2}/${shown3}; notes ${notes.slice(0, 4).join(' | ').slice(0, 120)}; warn ${warn.slice(0, 60)}; openShortcutSettings ${opt.open}; keys ${opt.keys.length} `;
      r.ok = !bad.length;
      r.note += bad.join('; ');
    } catch (e) { r.note = String(e.message || e); }
    for (const h of await driver.getAllWindowHandles()) if (h !== ctl) { await driver.switchTo().window(h); await driver.close(); }
    await driver.switchTo().window(ctl);
  }

  // whole track saved without playback: direct file and HLS kinds
  const FAST = [
    ['fast save: direct file, not played', '/fastfile.html', 440, 40],
    ['fast save: HLS TS AAC', '/fast_ts.html', 660, 20],
    ['fast save: HLS fMP4 AAC', '/fast_fmp4.html', 660, 20],
    ['fast save: HLS TS MP3', '/fast_mp3.html', 660, 20],
    ['fast save: HLS AES-128', '/fast_aes.html', 660, 20],
    ['fast save: HLS fMP4 Opus', '/fast_opus.html', 660, 20],
    ['fast save: HLS master playlist', '/fast_master.html', 660, 20],
    ['fast save: WAV output', '/fast_ts.html', 660, 20, { kbps: 0 }],
    ['fast save: live HLS refused', '/fast_live.html', 0, 0, { err: 'live' }],
    ['fast save: nothing to save', '/webaudio.html', 0, 0, { err: 'nosource' }],
    ['fast save: DASH template + timeline', '/dash_timeline.html', 880, 20],
    ['fast save: DASH template + number', '/dash_number.html', 880, 20],
    ['fast save: DASH segment list', '/dash_list.html', 880, 20],
    ['fast save: DASH single file', '/dash_single.html', 880, 20],
    ['fast save: DASH SegmentBase (whole file)', '/dash_base.html', 880, 20],
    ['fast save: DASH WebM Opus', '/dash_webm.html', 880, 20],
    ['fast save: DASH audio picked from video+audio', '/dash_av.html', 880, 20],
    ...(HEAAC ? [['fast save: DASH fMP4 HE-AAC', '/dash_he.html', 880, 20], ['fast save: HLS TS HE-AAC', '/hls_he.html', 660, 20]] : []),
    ['fast save: live DASH refused', '/dash_live.html', 0, 0, { err: 'live' }],
    ['fast save: HLS preferred over DASH', '/hls_and_dash.html', 660, 20],
    ['fast save: MSE source, already loaded', '/mse_full.html', 880, 20],
    ['fast save: MSE source, finishes by itself while loading', '/mse_slow.html', 880, 20, { slow: true }],
    ['fast save: MSE source, save what is collected', '/mse_now.html', 880, 0, { now: 2500, dur: [2, 14] }],
    ['fast save: MSE source, quality switch + repeat + out of order', '/mse_switch.html', 880, 20],
    ['fast save: MSE source, order by media time', '/mse_steps.html', 0, 20, { steps: [300, 400, 500, 600, 700] }],
    ['fast save: MSE source, WebM Opus', '/mse_webm.html', 880, 20],
    ['fast save: queue — the playing track, not the preloaded next one', '/queue.html', 660, 20, { name: 'Real Artist - Real Title' }],
    ['fast save: queue — no playlist of that length, collects the playing player', '/queue_nomatch.html', 880, 20],
    ['fast save: playlist of the previous page is not reused after navigation', '/mse_full.html', 880, 20, { pre: '/fetch_next.html' }],
    ['fast save: DRM player — open playlist of the same length is saved', '/mse_drm.html', 660, 20],
    ['fast save: DRM player, no open version — refused at once', '/mse_drm_only.html', 0, 0, { err: 'drm' }],
    ['fast save: DRM player, the playlist found is encrypted too — refused', '/mse_drm_enc.html', 0, 0, { err: 'drm' }],
    ['fast save: MSE video+audio in one buffer refused', '/mse_muxed.html', 0, 0, { err: 'mse' }]
  ];
  for (const [name, url, freq, want, o = {}] of FAST) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
    const r = { name, ok: false, note: '' };
    results.push(r);
    fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
    try {
      await driver.switchTo().newWindow('tab');
      if (o.pre) { await driver.get(`http://localhost:${P1}${o.pre}`); await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {}); await sleep(500); }
      await driver.get(`http://localhost:${P1}${url}`);
      await driver.wait(async () => driver.executeScript('return !!window.__ready'), 10000).catch(() => {});
      await driver.switchTo().window(ctl);
      const kb = o.kbps === undefined ? 192 : o.kbps, t0 = Date.now(), bad = [];
      const q = 'const t=await browser.tabs.query({url:"http://localhost/*"});const id=t[0].id;';
      const res = await call(q + 'return await browser.runtime.sendMessage({type:"fast",tabId:id,kbps:a[0]})', kb);
      let fin = null;
      if (res && res.ok && o.now) { await sleep(o.now); await call(q + 'return await browser.runtime.sendMessage({type:"fastNow",tabId:id})'); }
      if (res && res.ok) {
        for (let i = 0; i < 240; i++) {
          const s = await call(q + 'return await browser.runtime.sendMessage({type:"state",tabId:id})');
          if (!s.fast || !s.fast.run) { fin = s.fast; break; }
          await sleep(250);
        }
      }
      const err = (res && res.error) || (fin && fin.err) || '';
      if (o.err) {
        if (err !== o.err) bad.push(`expected error ${o.err}, got ${err || 'none'} ${fin && fin.detail ? fin.detail : ''}`);
        r.note = 'error=' + err;
      } else if (err) bad.push(`error ${err} ${fin && fin.detail ? fin.detail : ''}`);
      else {
        let file = null;
        for (let i = 0; i < 40 && !file; i++) {
          await sleep(250);
          const d = path.join(dl, 'AudioRecTab');
          const f = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith(kb === 0 ? '.wav' : '.mp3')) : [];
          if (f.length) { const p = path.join(d, f[0]); const z = fs.statSync(p).size; await sleep(400); if (fs.statSync(p).size === z) file = p; }
        }
        const ms = Date.now() - t0;
        if (!file) bad.push('no file');
        else {
          fs.mkdirSync('/tmp/mp3tab-out', { recursive: true });
          fs.copyFileSync(file, `/tmp/mp3tab-out/${name.replace(/[^a-z0-9]+/gi, '_')}${kb === 0 ? '.wav' : '.mp3'}`);
          const a = analyze(file);
          if (o.name && !path.basename(file).startsWith(o.name)) bad.push('file name ' + path.basename(file));
          if (a.codec !== (kb === 0 ? 'pcm_s16le' : 'mp3')) bad.push('codec ' + a.codec);
          if (o.dur ? a.dur < o.dur[0] || a.dur > o.dur[1] : Math.abs(a.dur - want) > 0.6) bad.push(`duration ${a.dur.toFixed(2)} (want ${o.dur ? o.dur.join('..') : want})`);
          if (o.steps) {
            const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '44100', '-'], { maxBuffer: 1 << 28 });
            const x = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
            const seen = o.steps.map((f0, k) => {
              const c = Math.round((k * 4 + 2) * 44100), w = 8820;
              let best = 0, bp = -1;
              for (const f of o.steps) { let re = 0, im = 0; for (let i = c - w; i < c + w; i++) { const v = x[i] / 32768, ph = (2 * Math.PI * f * i) / 44100; re += v * Math.cos(ph); im += v * Math.sin(ph); } const pw = Math.hypot(re, im); if (pw > bp) { bp = pw; best = f; } }
              return best;
            });
            if (seen.join() !== o.steps.join()) bad.push('order ' + seen.join(','));
            r.note = 'steps ' + seen.join(',') + ' ';
          } else {
            if (a.amp[freq] < 0.1) bad.push(`freq ${freq} weak ${a.amp[freq].toFixed(3)}`);
            for (const f of [440, 660, 880]) if (f !== freq && a.amp[f] > 0.02) bad.push(`freq ${f} unexpected`);
          }
          if (a.drop > 0) bad.push('dropouts ' + a.drop);
          if (!o.slow && !o.now && ms > want * 500) bad.push(`slow: ${ms} ms for ${want} s`);
          r.note += `${a.codec} ${a.rate}Hz ${a.dur.toFixed(2)}s ${freq ? `amp${freq}=${a.amp[freq].toFixed(3)} ` : ''}drop=${a.drop} took ${ms} ms`;
        }
      }
      r.ok = !bad.length;
      r.note += ' ' + bad.join('; ');
    } catch (e) { r.note = String(e.message || e); }
    for (const h of await driver.getAllWindowHandles()) if (h !== ctl) { await driver.switchTo().window(h); await driver.close(); }
    await driver.switchTo().window(ctl);
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
  if ([WAIT, CANCEL, PAUSE, RESUME, WEBA, DEVICE, CLICK, 'wait mode: quiet fade-in is kept'].some(wantWait)) {
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

    // a quiet fade-in is kept: the file starts where the sound becomes audible, not where the detector fired
    const FADE = 'wait mode: quiet fade-in is kept';
    if (wantWait(FADE)) {
      const r = { name: FADE, ok: false, note: '' };
      results.push(r);
      try {
        await openWait('/fadein.html');
        const bad = [];
        const st = await untilState((x) => x.recording, 20000);
        if (st.ms < 0) bad.push('recording did not start by itself');
        const f = st.ms >= 0 ? await getFile(80) : null;
        if (st.ms >= 0 && !f) bad.push('no file saved after the track ended');
        if (f) {
          const a = analyze(f.pth);
          if (a.dur < 3.75 || a.dur > 4.6) bad.push(`duration ${a.dur.toFixed(2)} (clip 4 s; the fade-in must be kept)`);
          r.note = `${a.dur.toFixed(2)}s amp440=${a.amp[440].toFixed(3)} `;
        }
        r.ok = !bad.length;
        r.note += bad.join('; ');
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
