'use strict';
/* global dq */
// Shell UI: sidebar, toolbar, status screens, settings, quick switcher, about.

const $ = (sel) => document.querySelector(sel);
const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
if (isMac) document.documentElement.classList.add('mac');

let state = { apps: [], activeId: null, prefs: {}, light: false };
let overlay = null; // 'settings' | 'switcher' | 'about' | null
let editingId = null; // app id being edited, '' for a new app
let switcherSel = 0;
let dragId = null;

// Fields that belong in apps.json (everything else in state is runtime info).
const CONFIG_KEYS = ['id', 'name', 'url', 'hosts', 'authHosts', 'icon', 'badge', 'network', 'notifications', 'permissions', 'userAgent'];
const configOf = (a) => Object.fromEntries(CONFIG_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

const activeApp = () => state.apps.find((a) => a.id === state.activeId) || null;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

function iconNode(a, cls = 'tile') {
  const box = el('span', { class: cls });
  if (a.iconData) {
    const img = el('img', { src: a.iconData, alt: '' });
    img.addEventListener('error', () => img.replaceWith(el('span', { class: 'letter', text: (a.name || '?').slice(0, 1).toUpperCase() })));
    box.append(img);
  } else {
    box.append(el('span', { class: 'letter', text: (a.name || '?').slice(0, 1).toUpperCase() }));
  }
  return box;
}

function keyLabel(i) {
  return i < 9 ? `${isMac ? '⌘' : 'Ctrl+'}${i + 1}` : '';
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

// ------------------------------------------------------------- render

function render() {
  document.documentElement.classList.toggle('dq-light', !!state.light);
  for (const img of document.querySelectorAll('img[data-light-src]')) {
    if (!img.dataset.darkSrc) img.dataset.darkSrc = img.getAttribute('src');
    img.src = state.light ? img.dataset.lightSrc : img.dataset.darkSrc;
  }
  renderSidebar();
  renderToolbar();
  renderStage();
  if (overlay === 'settings') renderSettingsList();
  if (overlay === 'switcher') renderSwitcher();
}

function renderSidebar() {
  const list = $('#app-list');
  list.replaceChildren(
    ...state.apps.map((a, i) => {
      const tile = el('button', {
        class: 'tile',
        title: `${a.name}${keyLabel(i) ? '  ' + keyLabel(i) : ''}${a.muted ? '  (muted)' : ''}`,
        'aria-label': a.name,
        onclick: () => dq.switchTo(a.id),
        oncontextmenu: (e) => {
          e.preventDefault();
          dq.showAppMenu(a.id);
        },
      });
      const inner = iconNode(a, '');
      tile.append(...inner.childNodes);
      if (a.unread > 0) tile.append(el('span', { class: `badge${a.muted ? ' muted' : ''}`, text: a.unread > 99 ? '99+' : String(a.unread) }));
      if (a.status === 'offline' || a.status === 'crashed') tile.append(el('span', { class: 'dot' }));
      else if (a.status === 'probing' || (a.status === 'loading' && !a.currentUrl)) tile.append(el('span', { class: 'dot loading' }));
      return el('li', { class: [a.id === state.activeId ? 'active' : '', a.muted ? 'dim' : ''].join(' ').trim() }, tile);
    })
  );
}

function renderToolbar() {
  const a = activeApp();
  $('#app-name').textContent = a ? a.name : 'DQ Workspace';
  const st = $('#app-status');
  st.className = 'status';
  st.textContent = '';
  if (a) {
    if (a.status === 'offline') {
      st.textContent = 'Offline';
      st.classList.add('offline');
    } else if (a.status === 'crashed') {
      st.textContent = 'Stopped';
      st.classList.add('offline');
    } else if (a.status === 'loading' || a.status === 'probing') {
      st.textContent = 'Loading';
      st.classList.add('loading');
    } else if (a.muted) {
      st.textContent = 'Muted';
    }
  }
  const has = !!a;
  $('#btn-back').disabled = !has || !a.canGoBack;
  $('#btn-forward').disabled = !has || !a.canGoForward;
  for (const id of ['#btn-reload', '#btn-home', '#btn-copy', '#btn-browser']) $(id).disabled = !has;
}

function renderStage() {
  const a = activeApp();
  const screens = ['#screen-loading', '#screen-offline', '#screen-crashed', '#screen-empty'];
  for (const s of screens) $(s).hidden = true;
  if (!a) {
    $('#screen-empty').hidden = false;
    return;
  }
  if (a.status === 'offline') {
    const tail = a.network === 'tailscale';
    const title = $('#offline-title');
    title.replaceChildren(
      document.createTextNode(tail ? 'Can’t reach the ' : 'Can’t reach '),
      el('span', { class: 'accent', text: tail ? 'tailnet' : a.name })
    );
    $('#offline-text').textContent = tail
      ? `${a.name} lives on the DataQuartz tailnet. Connect Tailscale on this Mac, then retry.`
      : `${a.name} isn’t answering. Check your internet connection, then retry.`;
    $('#offline-detail').textContent = a.error || '';
    $('#screen-offline').hidden = false;
  } else if (a.status === 'crashed') {
    $('#crashed-title').replaceChildren(document.createTextNode(`${a.name} `), el('span', { class: 'accent', text: 'stopped' }));
    $('#crashed-text').textContent = a.error || 'The page stopped responding.';
    $('#screen-crashed').hidden = false;
  } else if (a.status === 'probing' || a.status === 'loading' || a.status === 'idle') {
    $('#loading-name').textContent = a.name;
    $('#screen-loading').hidden = false;
  }
}

// ------------------------------------------------------------- overlays

async function openOverlay(name, opts = {}) {
  if (overlay && overlay !== name) closeOverlay(false);
  overlay = name;
  if (name === 'switcher' || name === 'about') {
    // Freeze the current page behind the dimmed overlay so it doesn't blank out.
    const shot = await dq.capture().catch(() => null);
    const fr = $('#freeze');
    fr.replaceChildren();
    if (shot && overlay === name) {
      fr.append(el('img', { src: shot, alt: '' }));
      fr.hidden = false;
    }
  }
  dq.setOverlay(true);
  $('#' + name).hidden = false;
  if (name === 'settings') openSettings(opts.appId);
  if (name === 'switcher') {
    switcherSel = 0;
    $('#switcher-input').value = '';
    renderSwitcher();
    $('#switcher-input').focus();
  }
  if (name === 'about') {
    $('#about-version').textContent = `Version ${state.version || ''}`;
    $('#about-close').focus();
  }
}

function closeOverlay(notify = true) {
  if (!overlay) return;
  $('#' + overlay).hidden = true;
  overlay = null;
  editingId = null;
  $('#freeze').hidden = true;
  $('#freeze').replaceChildren();
  if (notify) dq.setOverlay(false);
}

// ------------------------------------------------------------- switcher

function switcherMatches() {
  const q = $('#switcher-input').value.trim().toLowerCase();
  return state.apps
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => !q || a.name.toLowerCase().includes(q) || a.url.toLowerCase().includes(q));
}

function renderSwitcher() {
  const items = switcherMatches();
  if (switcherSel >= items.length) switcherSel = Math.max(0, items.length - 1);
  $('#switcher-list').replaceChildren(
    ...items.map(({ a, i }, n) =>
      el(
        'li',
        {
          class: n === switcherSel ? 'sel' : '',
          onmousemove: () => {
            if (switcherSel !== n) {
              switcherSel = n;
              renderSwitcher();
            }
          },
          onclick: () => pickSwitcher(a.id),
        },
        iconNode(a, 'tile mini'),
        el('span', { class: 'nm', text: a.name }),
        a.unread > 0 ? el('span', { class: 'cnt', text: String(a.unread) }) : null,
        el('span', { class: 'key', text: keyLabel(i) })
      )
    )
  );
}

function pickSwitcher(id) {
  closeOverlay();
  dq.switchTo(id);
}

$('#switcher-input').addEventListener('input', () => {
  switcherSel = 0;
  renderSwitcher();
});
$('#switcher-input').addEventListener('keydown', (e) => {
  const items = switcherMatches();
  if (e.key === 'ArrowDown') {
    switcherSel = Math.min(items.length - 1, switcherSel + 1);
    renderSwitcher();
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    switcherSel = Math.max(0, switcherSel - 1);
    renderSwitcher();
    e.preventDefault();
  } else if (e.key === 'Enter' && items[switcherSel]) {
    pickSwitcher(items[switcherSel].a.id);
  }
});
$('#switcher').addEventListener('mousedown', (e) => {
  if (e.target.id === 'switcher') closeOverlay();
});

// ------------------------------------------------------------- settings

function renderSettingsList() {
  $('#pref-follow').checked = !!state.prefs.followSystem;
  $('#pref-mute').checked = !!state.prefs.muteAll;
  $('#config-errors').textContent = (state.configErrors || []).length
    ? 'Some entries in apps.json were skipped: ' + state.configErrors.join('; ')
    : '';
  $('#settings-apps').replaceChildren(
    ...state.apps.map((a, i) =>
      el(
        'li',
        {
          class: a.id === editingId ? 'sel' : '',
          draggable: 'true',
          onclick: () => editApp(a.id),
          ondragstart: (e) => {
            dragId = a.id;
            e.dataTransfer.effectAllowed = 'move';
          },
          ondragover: (e) => {
            e.preventDefault();
            e.currentTarget.classList.add('drag-over');
          },
          ondragleave: (e) => e.currentTarget.classList.remove('drag-over'),
          ondrop: (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('drag-over');
            reorder(dragId, a.id);
          },
        },
        el('span', { class: 'grip', text: '⋮⋮', title: 'Drag to reorder' }),
        iconNode(a, 'tile mini'),
        el('span', { class: 'nm', text: a.name }),
        el('span', { class: 'key', text: keyLabel(i) })
      )
    )
  );
}

async function reorder(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const list = state.apps.map(configOf);
  const from = list.findIndex((a) => a.id === fromId);
  const to = list.findIndex((a) => a.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  const res = await dq.saveApps(list);
  if (!res.ok) toast(res.error);
}

function openSettings(appId) {
  renderSettingsList();
  if (appId === '') newApp();
  else editApp(appId || state.activeId || (state.apps[0] && state.apps[0].id));
}

function setBadgeExtra(mode) {
  for (const box of document.querySelectorAll('.badge-extra')) box.classList.toggle('on', box.dataset.for === mode);
}

function fillForm(a) {
  $('#f-name').value = a.name || '';
  $('#f-url').value = a.url || '';
  const ownHost = (() => {
    try {
      return new URL(a.url).host;
    } catch {
      return '';
    }
  })();
  $('#f-hosts').value = (a.hosts || []).filter((h) => h !== ownHost).join(', ');
  $('#f-auth').value = (a.authHosts || []).join(', ');
  $('#f-icon').value = a.icon && a.icon !== 'auto' ? a.icon : '';
  const b = a.badge || { from: 'title' };
  $('#f-badge').value = b.from || 'title';
  $('#f-pattern').value = b.pattern || '';
  $('#f-api-path').value = b.path || '';
  $('#f-api-header').value = b.header || '';
  $('#f-api-json').value = b.json || '';
  $('#f-selector').value = b.selector || '';
  setBadgeExtra($('#f-badge').value);
  $('#f-tailscale').checked = a.network === 'tailscale';
  $('#f-notify').checked = a.notifications !== false;
  $('#f-media').checked = (a.permissions || []).includes('media');
  $('#form-error').textContent = '';
}

function editApp(id) {
  const a = state.apps.find((x) => x.id === id);
  if (!a) return newApp();
  editingId = id;
  $('#form-eyebrow').textContent = 'Edit app';
  $('#form-title').textContent = a.name;
  $('#f-delete').hidden = false;
  fillForm(a);
  renderSettingsList();
}

function newApp() {
  editingId = '';
  $('#form-eyebrow').textContent = 'New app';
  $('#form-title').textContent = 'Add an app';
  $('#f-delete').hidden = true;
  fillForm({ badge: { from: 'title' }, notifications: true });
  renderSettingsList();
  $('#f-name').focus();
}

const splitHosts = (s) =>
  s
    .split(/[\s,]+/)
    .map((h) => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);

function formToApp(base) {
  const from = $('#f-badge').value;
  const badge = { from };
  if (from === 'title' && $('#f-pattern').value.trim()) badge.pattern = $('#f-pattern').value.trim();
  if (from === 'api') {
    badge.path = $('#f-api-path').value.trim();
    if ($('#f-api-header').value.trim()) badge.header = $('#f-api-header').value.trim();
    if ($('#f-api-json').value.trim()) badge.json = $('#f-api-json').value.trim();
  }
  if (from === 'selector') badge.selector = $('#f-selector').value.trim();

  let perms = (base.permissions || ['notifications', 'clipboard-sanitized-write', 'fullscreen']).filter((p) => p !== 'media');
  if ($('#f-media').checked) perms = [...perms, 'media'];

  return {
    ...base,
    name: $('#f-name').value.trim(),
    url: $('#f-url').value.trim(),
    hosts: splitHosts($('#f-hosts').value),
    authHosts: splitHosts($('#f-auth').value),
    icon: $('#f-icon').value.trim() || 'auto',
    badge,
    network: $('#f-tailscale').checked ? 'tailscale' : 'internet',
    notifications: $('#f-notify').checked,
    permissions: perms,
  };
}

$('#f-badge').addEventListener('change', (e) => setBadgeExtra(e.target.value));

$('#app-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#form-error');
  err.textContent = '';
  const list = state.apps.map(configOf);
  if (!$('#f-name').value.trim()) return (err.textContent = 'Give the app a name.');
  if (!$('#f-url').value.trim()) return (err.textContent = 'Add the app’s URL.');
  const b = $('#f-badge').value;
  if (b === 'api' && !$('#f-api-path').value.trim()) return (err.textContent = 'Add the API path, or pick another unread-count source.');
  if (b === 'selector' && !$('#f-selector').value.trim()) return (err.textContent = 'Add a CSS selector, or pick another unread-count source.');

  let savedId;
  if (editingId) {
    const i = list.findIndex((a) => a.id === editingId);
    list[i] = formToApp(list[i]);
    savedId = editingId;
  } else {
    const fresh = formToApp({});
    list.push(fresh);
    savedId = null;
  }
  const res = await dq.saveApps(list);
  if (!res.ok) {
    err.textContent = res.error;
    return;
  }
  toast('Saved');
  const latest = await dq.getState();
  state = latest;
  render();
  if (!savedId) {
    const added = state.apps.at(-1);
    if (added) {
      closeOverlay();
      dq.switchTo(added.id);
      return;
    }
  }
  editApp(savedId);
});

$('#f-cancel').addEventListener('click', () => (editingId ? editApp(editingId) : closeOverlay()));

$('#f-delete').addEventListener('click', async () => {
  const a = state.apps.find((x) => x.id === editingId);
  if (!a) return;
  if (!window.confirm(`Remove ${a.name} from DQ Workspace? Its sign-in stays saved in case you add it back.`)) return;
  const list = state.apps.map(configOf).filter((x) => x.id !== editingId);
  const res = await dq.saveApps(list);
  if (!res.ok) return toast(res.error);
  state = await dq.getState();
  render();
  if (state.apps.length) editApp(state.apps[0].id);
  else newApp();
});

$('#settings-add').addEventListener('click', newApp);
$('#settings-close').addEventListener('click', () => closeOverlay());
$('#pref-follow').addEventListener('change', (e) => dq.setPref('followSystem', e.target.checked));
$('#pref-mute').addEventListener('change', (e) => dq.setPref('muteAll', e.target.checked));
$('#reveal-config').addEventListener('click', () => dq.revealConfig());
$('#reset-config').addEventListener('click', async () => {
  if (!window.confirm('Replace your app list with the team defaults (GitLab, Plane, Google Chat)? Sign-ins are kept.')) return;
  await dq.resetApps();
  state = await dq.getState();
  render();
  editApp(state.apps[0] && state.apps[0].id);
});

// ------------------------------------------------------------- about

$('#about-close').addEventListener('click', () => closeOverlay());
$('#about').addEventListener('mousedown', (e) => {
  if (e.target.id === 'about') closeOverlay();
});

// ------------------------------------------------------------- toolbar & sidebar buttons

$('#btn-back').addEventListener('click', () => dq.nav('back'));
$('#btn-forward').addEventListener('click', () => dq.nav('forward'));
$('#btn-reload').addEventListener('click', () => dq.nav('reload'));
$('#btn-home').addEventListener('click', () => dq.nav('home'));
$('#btn-copy').addEventListener('click', () => {
  dq.nav('copy-url');
  toast('Link copied');
});
$('#btn-browser').addEventListener('click', () => dq.nav('open-browser'));
$('#btn-switcher').addEventListener('click', () => openOverlay('switcher'));
$('#btn-settings').addEventListener('click', () => (overlay === 'settings' ? closeOverlay() : openOverlay('settings')));
$('#btn-add').addEventListener('click', () => openOverlay('settings', { appId: '' }));
$('#btn-empty-add').addEventListener('click', () => openOverlay('settings', { appId: '' }));
$('#btn-retry').addEventListener('click', () => state.activeId && dq.retry(state.activeId));
$('#btn-reload-crashed').addEventListener('click', () => state.activeId && dq.retry(state.activeId));
$('#btn-offline-browser').addEventListener('click', () => dq.nav('open-browser'));

// Clicking an app in the sidebar while an overlay is open closes the overlay.
$('#app-list').addEventListener('click', () => {
  if (overlay) closeOverlay();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlay) {
    e.preventDefault();
    closeOverlay();
  }
});

window.addEventListener('online', () => dq.networkChanged(true));

// ------------------------------------------------------------- wiring

dq.onState((s) => {
  state = s;
  render();
});

dq.onCommand((cmd) => {
  if (cmd.type === 'settings') openOverlay('settings', { appId: cmd.appId });
  else if (cmd.type === 'switcher') overlay === 'switcher' ? closeOverlay() : openOverlay('switcher');
  else if (cmd.type === 'about') openOverlay('about');
});

dq.getState().then((s) => {
  state = s;
  render();
});
