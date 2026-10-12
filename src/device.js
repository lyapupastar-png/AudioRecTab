'use strict';
// Records an audio input device (microphone, virtual cable, Stereo Mix, "Monitor of ...").
// This page acts like a content script for the background: it answers {type:'rec'} and sends 'pcm' blocks,
// so start/stop/saving are the same as for a tab recording (the tab of this page is the recorded "tab").
const $ = (id) => document.getElementById(id);
const t = (k) => browser.i18n.getMessage(k);
const send = (m) => browser.runtime.sendMessage(m);
const QUIET_BLOCKS = 54; // 54 blocks of 4096 samples = about 5 s
// Firefox does not report the input track's sample rate (trackRate stays null), so the graph runs at the default rate (44100 on most
// outputs). A device with another rate (BlackHole 2ch at 48000) is resampled by Firefox on the fly and glitches a few minutes in:
// in practice the crackle is gone with BlackHole set to 44100 Hz (help_mac_rate). If the rate is known, the encoder and the
// WAV header follow the context rate (SR).
let SR = 44100;
let myTab = null, stream = null, ctx = null, proc = null, label = '';
let capAt0 = -1, capTs0 = 0;
let recOn = false, peak = 0, quiet = 0, st = {}, diag = {}, perf0 = 0, blocks = 0;
document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const showErr = (k, extra) => { $('err').hidden = !k; $('err').textContent = k ? t(k) + (extra ? ` (${extra})` : '') : ''; };

function closeStream() {
  recOn = false; peak = 0; quiet = 0; capAt0 = -1;
  if (proc) { proc.port.onmessage = null; try { proc.disconnect(); } catch (e) { /* ignore */ } proc = null; }
  if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } ctx = null; }
  if (stream) { stream.getTracks().forEach((x) => x.stop()); stream = null; }
  label = '';
}

// One 4096-frame block from the worklet. Blocks are placed by their frame index (the device's own clock),
// not by wall-clock time: only the first block is anchored to the time, so a device clock that differs a little
// from the computer's clock cannot open gaps in the recording.
function onBlock(d) {
  const n = d.l.length, l = d.l, rr = d.r;
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
  peak = pk;
  quiet = pk < 1e-5 ? quiet + 1 : 0;
  if (!recOn) { capAt0 = -1; return; }
  if (capAt0 < 0) { capAt0 = d.at; capTs0 = Date.now() - (n / SR) * 1000; perf0 = performance.now(); blocks = 0; }
  // local diagnostics (storage.local only, never sent anywhere): frames delivered vs wall clock (ratio 1.0000 = no drift), every ~12 s
  if (++blocks % 128 === 0) {
    const secs = (performance.now() - perf0) / 1000, fr = d.at - capAt0 + n;
    browser.storage.local.set({ deviceDiag: { ...diag, secs: +secs.toFixed(1), frames: fr, clockRatio: +(fr / SR / secs).toFixed(5) } }).catch(() => {});
  }
  send({ type: 'pcm', ts: capTs0, at: d.at - capAt0, buf: out }).catch(() => {});
}

// One clock for capture and render. The page's audio graph is pulled by an OUTPUT device; if that is the default speakers while the
// input is BlackHole, Firefox has two unrelated device clocks and keeps correcting the drift between them (resync glitches on a
// 128-frame grid that start a few minutes into a recording). So the graph is rendered on the output "twin" of the input device
// (same groupId / same name, e.g. BlackHole 2ch in + BlackHole 2ch out). The output only ever gets silence (gain 0).
async function matchSink(c, s) {
  try {
    if (typeof c.setSinkId !== 'function') return 'no-setSinkId';
    const inId = ((s.getAudioTracks()[0] || {}).getSettings() || {}).deviceId;
    const devs = await navigator.mediaDevices.enumerateDevices();
    const inp = devs.find((d) => d.kind === 'audioinput' && d.deviceId === inId);
    const outs = devs.filter((d) => d.kind === 'audiooutput');
    const out = (inp && inp.groupId && outs.find((d) => d.groupId === inp.groupId)) || outs.find((d) => d.label && d.label === label);
    if (!out) return 'no-output-twin';
    await c.setSinkId(out.deviceId);
    return 'sink:' + out.label;
  } catch (e) { return 'sink-err:' + (e && e.name); }
}

async function openDevice(id) {
  closeStream();
  showErr(null);
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
  if (id) audio.deviceId = { exact: id };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    showErr('device_err_open', e && e.name);
    return false;
  }
  label = (stream.getAudioTracks()[0] || {}).label || '';
  const trackRate = ((stream.getAudioTracks()[0] || {}).getSettings() || {}).sampleRate || 0;
  // latencyHint 'playback': the biggest buffer, the fewest chances for a glitch on a long recording
  try { ctx = new AudioContext(trackRate ? { sampleRate: trackRate, latencyHint: 'playback' } : { latencyHint: 'playback' }); } catch (e) { ctx = new AudioContext({ latencyHint: 'playback' }); }
  SR = ctx.sampleRate;
  diag = { ctxRate: ctx.sampleRate, trackRate: trackRate || null, sink: await matchSink(ctx, stream) };
  const src = ctx.createMediaStreamSource(stream), mute = ctx.createGain();
  try { await ctx.audioWorklet.addModule('device-worklet.js'); } catch (e) { showErr('device_err_open', e && e.name); closeStream(); return false; }
  proc = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  proc.port.onmessage = (ev) => onBlock(ev.data);
  await ctx.resume().catch(() => {});
  return true;
}

async function fillDevices(selectLabel) {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const named = list.filter((d) => d.label);
  const sel = $('dev');
  sel.textContent = '';
  if (!named.length) { sel.disabled = true; $('allow').hidden = false; return false; }
  $('allow').hidden = true;
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = t('device_choose');
  sel.append(ph);
  for (const d of named) {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label;
    sel.append(o);
  }
  sel.disabled = false;
  const saved = named.find((d) => d.label === selectLabel);
  if (saved) { sel.value = saved.deviceId; await choose(); }
  return true;
}

async function choose() {
  const id = $('dev').value;
  if (!id) { closeStream(); return; }
  if (await openDevice(id)) await browser.storage.local.set({ deviceLabel: label });
}

async function tick() {
  st = await send({ type: 'state', tabId: myTab });
  const b = $('btn');
  b.className = st.recording ? 'rec' : '';
  b.textContent = t(st.recording ? 'stop' : 'start');
  b.disabled = st.saving || (!st.recording && !stream);
  $('dev').disabled = st.recording || st.saving || $('dev').options.length === 0;
  $('info').textContent = st.recording ? `${t('recording')} ${fmt(st.elapsed)} · ${(st.bytes / 1048576).toFixed(2)} MB` : st.saving ? t('saving') : '';
  $('bar').style.width = Math.min(100, Math.round(Math.sqrt(peak) * 100)) + '%';
  const silent = !!stream && quiet >= QUIET_BLOCKS;
  $('warn').hidden = !silent;
  $('warn').textContent = silent ? t('device_silent') : '';
}

// ---------- help: which virtual device to use on each system ----------
const HELP = {
  mac: { steps: ['help_mac1', 'help_mac2', 'help_mac3', 'help_mac4', 'help_mac_perm', 'help_mac_rate'], links: [
    ['link_blackhole', 'https://existential.audio/blackhole/'],
    ['link_blackhole_setup', 'https://github.com/ExistentialAudio/BlackHole/wiki/Multi-Output-Device'],
    ['link_apple', 'https://support.apple.com/guide/audio-midi-setup/play-audio-through-multiple-devices-at-once-ams7c093f372/mac']] },
  win: { steps: ['help_win1', 'help_win2', 'help_win3', 'help_win4', 'help_win5', 'help_win6', 'help_win7'], links: [['link_vbcable', 'https://vb-audio.com/Cable/']] },
  linux: { steps: ['help_linux1', 'help_linux2'], links: [['link_pipewire', 'https://pipewire.org/']] }
};
function renderHelp() {
  const h = HELP[$('os').value];
  const ol = $('steps'), ul = $('links');
  ol.textContent = ''; ul.textContent = '';
  for (const k of h.steps) { const li = document.createElement('li'); li.textContent = t(k); ol.append(li); }
  for (const [k, url] of h.links) {
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = t(k);
    li.append(a); ul.append(li);
  }
}

browser.runtime.onMessage.addListener((m) => {
  if (!m || m.type !== 'rec') return;
  if (m.mode === 'on') {
    if (!stream) return Promise.resolve({ error: 'no_device' });
    recOn = true;
    return Promise.resolve({ ok: true, title: label || t('device_title'), host: '' });
  }
  if (m.mode === 'off') setTimeout(() => { recOn = false; }, 300);
});

(async () => {
  myTab = (await browser.tabs.getCurrent()).id;
  const { kbps = 192, deviceLabel = '' } = await browser.storage.local.get(['kbps', 'deviceLabel']);
  $('kbps').value = String(kbps);
  $('kbps').onchange = () => browser.storage.local.set({ kbps: +$('kbps').value });
  const { os } = await browser.runtime.getPlatformInfo();
  $('os').value = HELP[os] ? os : 'mac';
  $('os').onchange = renderHelp;
  renderHelp();
  $('allow').onclick = async () => {
    // the permission prompt needs a real open stream; it is closed again right away
    if (await openDevice()) { closeStream(); await fillDevices(deviceLabel); }
  };
  $('dev').onchange = choose;
  $('btn').onclick = async () => {
    $('btn').disabled = true;
    showErr(null);
    const r = await send({ type: st.recording ? 'stop' : 'start', tabId: myTab, kbps: +$('kbps').value, sr: SR });
    if (r && r.error) showErr('device_err_start');
    await tick();
  };
  await fillDevices(deviceLabel).catch(() => false);
  await tick();
  setInterval(tick, 150);
})();
