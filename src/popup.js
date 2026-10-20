'use strict';
const $ = (id) => document.getElementById(id);
const t = (k) => browser.i18n.getMessage(k);
const send = (m) => browser.runtime.sendMessage(m);
const q = new URLSearchParams(location.search);
let tabId = null, st = { recording: false };
document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
document.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle); });
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// do not rewrite unchanged text: otherwise selection and copying are reset every 0.5 s
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };

async function tick() {
  st = await send({ type: 'state', tabId });
  const manual = st.recording && !st.auto, auto = st.recording && st.auto;
  const b = $('btn'), b2 = $('btn2');
  b.className = manual ? 'rec' : '';
  setText(b, t(manual ? 'stop' : 'start'));
  b.disabled = st.saving || st.waiting || auto;
  b2.className = auto ? 'rec' : st.waiting ? 'wait' : '';
  setText(b2, t(auto ? 'stop' : st.waiting ? 'unwatch' : 'watch'));
  b2.disabled = st.saving || manual;
  $('warn').hidden = !st.warn;
  setText($('warn'), st.warn ? t('warn_' + st.warn) : '');
  const fast = st.fast || {};
  setText($('btn4'), fast.collecting ? `${t('fast_collect')} ${fast.pct}% · ${t('fast_collect_now')}` : fast.run ? `${t('fast_saving')} ${fast.p}%` : t('fast_btn'));
  $('btn4').disabled = (!!fast.run && !fast.collecting) || st.saving;
  if (fast.err && !$('btn4').dataset.err) { $('err').hidden = false; $('err').textContent = t('err_' + fast.err) + (fast.err === 'fast' || fast.err === 'codec' ? ' ' + fast.detail : ''); }
  $('btn4').dataset.err = fast.err ? '1' : '';
  setText($('btn3'), t('device_btn'));
  $('btn3').disabled = st.saving || st.recording || st.waiting;
  setText($('info'), st.recording ? `${t(auto ? 'recording_auto' : 'recording')} ${fmt(st.elapsed)} · ${(st.bytes / 1048576).toFixed(2)} MB` : st.waiting ? t('waiting') : t('idle'));
}

async function loadRecovered() {
  const list = await send({ type: 'recovered' });
  $('rec').hidden = !list.length;
  const ul = $('list');
  ul.textContent = '';
  for (const m of list) {
    const li = document.createElement('li'), s = document.createElement('span');
    s.textContent = `${new Date(m.startedAt).toLocaleString()} ${m.title || m.host}`;
    const save = document.createElement('button'), del = document.createElement('button');
    save.textContent = t('save'); del.textContent = t('discard');
    save.onclick = async () => { await send({ type: 'recSave', id: m.id }); loadRecovered(); };
    del.onclick = async () => { await send({ type: 'recDiscard', id: m.id }); loadRecovered(); };
    li.append(s, save, del);
    ul.append(li);
  }
}

(async () => {
  tabId = q.get('tabId') ? +q.get('tabId') : (await browser.tabs.query({ active: true, currentWindow: true }))[0].id;
  const { kbps = 192 } = await browser.storage.local.get('kbps');
  $('kbps').value = String(kbps);
  $('gear').onclick = () => { browser.runtime.openOptionsPage(); window.close(); };
  $('kbps').onchange = () => browser.storage.local.set({ kbps: +$('kbps').value });
  $('btn').onclick = async () => {
    $('btn').disabled = true;
    $('err').hidden = true;
    const r = await send({ type: st.recording ? 'stop' : 'start', tabId, kbps: +$('kbps').value });
    if (r && r.error) { $('err').hidden = false; $('err').textContent = t('err_' + r.error); }
    await tick();
  };
  $('btn2').onclick = async () => {
    $('btn2').disabled = true;
    $('err').hidden = true;
    const r = await send({ type: st.recording ? 'stop' : st.waiting ? 'unwatch' : 'watch', tabId, kbps: +$('kbps').value });
    if (r && r.error) { $('err').hidden = false; $('err').textContent = t('err_' + r.error); }
    await tick();
  };
  $('btn4').onclick = async () => {
    $('btn4').disabled = true;
    $('err').hidden = true;
    const r = await send(st.fast && st.fast.collecting ? { type: 'fastNow', tabId } : { type: 'fast', tabId, kbps: +$('kbps').value });
    if (r && r.error) { $('err').hidden = false; $('err').textContent = t('err_' + r.error); }
    await tick();
  };
  $('btn3').onclick = async () => {
    await browser.tabs.create({ url: browser.runtime.getURL('device.html') });
    window.close();
  };
  await tick();
  if (!st.recording && !st.waiting) send({ type: 'arm', tabId });
  setInterval(tick, 500);
  loadRecovered();
})();
