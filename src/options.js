'use strict';
const $ = (id) => document.getElementById(id);
const t = (k) => browser.i18n.getMessage(k);
document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
document.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = t(e.dataset.i18nTitle); });

async function keys() {
  const ul = $('keys');
  ul.textContent = '';
  for (const c of await browser.commands.getAll()) {
    const li = document.createElement('li'), name = document.createElement('span'), key = document.createElement('b');
    name.textContent = c.description || (c.name === '_execute_page_action' ? t('cmdOpen') : c.name);
    key.textContent = c.shortcut || t('hotkey_none');
    li.append(name, key);
    ul.append(li);
  }
}

(async () => {
  const st = await browser.storage.local.get({ ignoreSite: true, pageIcon: true, nameTpl: '' });
  $('ignoreSite').checked = st.ignoreSite !== false;
  $('pageIcon').checked = st.pageIcon !== false;
  $('nameTpl').value = st.nameTpl || '';
  $('ignoreSite').onchange = () => browser.storage.local.set({ ignoreSite: $('ignoreSite').checked });
  $('pageIcon').onchange = () => browser.storage.local.set({ pageIcon: $('pageIcon').checked });
  $('nameTpl').onchange = () => browser.storage.local.set({ nameTpl: $('nameTpl').value.trim() });
  $('keysBtn').onclick = () => {
    const open = browser.commands.openShortcutSettings;
    if (open) open().catch(() => { $('keysHint').hidden = false; });
    else $('keysHint').hidden = false;
  };
  await keys();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keys(); });
})();
