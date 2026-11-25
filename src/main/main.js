'use strict';
// DQ Workspace main process.
// One window: the shell UI (sidebar, toolbar, settings) fills it, and each app
// (GitLab, Plane, Google Chat, ...) is a WebContentsView laid over the content
// area, with its own persistent session partition.

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  session,
  shell,
} = require('electron');
const { Store } = require('./config');

const SIDEBAR_W = 68;
const TOOLBAR_H = 44;
const BADGE_POLL_MS = 60 * 1000;
const OFFLINE_RETRY_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 6000;
const NETWORK_ERRORS = new Set([-2, -15, -111, -130, -7, -21, -100, -101, -102, -104, -105, -106, -109, -118, -137, -138, -324]);

const ROOT = path.join(__dirname, '..', '..');
const SHELL_HTML = path.join(ROOT, 'src', 'shell', 'index.html');
const SHELL_PRELOAD = path.join(ROOT, 'src', 'preload', 'shell.js');
const APP_PRELOAD = path.join(ROOT, 'src', 'preload', 'app.js');
const DEFAULTS_FILE = path.join(ROOT, 'config', 'default-apps.json');

const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
  process.versions.chrome.split('.')[0]
}.0.0.0 Safari/537.36`;

let store;
let win = null;
let iconDir;
let isQuitting = false;
let overlayOpen = false;
let activeId = null;
let stateTimer = null;
let badgeTimer = null;
const entries = new Map(); // appId -> entry
const configuredSessions = new Set();
const notifications = new Map(); // `${appId}:${id}` -> Notification
let pendingOpenUrl = null;

// ---------------------------------------------------------------- helpers

function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === pattern;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function appForUrl(url) {
  const u = parseUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.host.toLowerCase();
  for (const a of store.apps) {
    if (a.hosts.some((h) => hostMatches(host, h))) return a;
  }
  return null;
}

function allowedInApp(a, url) {
  const u = parseUrl(url);
  if (!u) return false;
  if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.host.toLowerCase();
  return [...a.hosts, ...a.authHosts].some((h) => hostMatches(host, h));
}

function currentApp() {
  const e = entries.get(activeId);
  return e ? e.app : null;
}

function activeEntry() {
  return entries.get(activeId) || null;
}

function totalBadge() {
  let n = 0;
  for (const e of entries.values()) {
    if (!e.muted && e.badge > 0) n += e.badge;
  }
  return n;
}

function openExternal(url) {
  const u = parseUrl(url);
  if (!u) return;
  if (['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol)) shell.openExternal(u.toString());
}

// ---------------------------------------------------------------- icons

function iconFile(id) {
  return path.join(iconDir, `${id}.dataurl`);
}

function loadCachedIcon(entry) {
  try {
    entry.icon = fs.readFileSync(iconFile(entry.app.id), 'utf8');
  } catch {
    entry.icon = null;
  }
}

async function fetchIcon(entry, url) {
  try {
    const ses = session.fromPartition(`persist:${entry.app.id}`);
    const res = await ses.fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return;
    let mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 512 * 1024) return;
    if (!/^image\//.test(mime)) mime = /\.svg(\?|$)/i.test(url) ? 'image/svg+xml' : 'image/png';
    entry.icon = `data:${mime};base64,${buf.toString('base64')}`;
    fs.writeFileSync(iconFile(entry.app.id), entry.icon);
    sendState();
  } catch {
    /* keep the letter tile */
  }
}

async function loadConfiguredIcon(entry) {
  const src = entry.app.icon;
  if (!src || src === 'auto' || src === 'letter') return;
  if (/^https?:\/\//i.test(src)) {
    if (!entry.icon) await fetchIcon(entry, src);
    return;
  }
  try {
    const file = src.startsWith('~') ? path.join(app.getPath('home'), src.slice(1)) : src;
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    entry.icon = `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    /* unreadable path: letter tile */
  }
}

// ---------------------------------------------------------------- sessions

function configureSession(appId) {
  const partition = `persist:${appId}`;
  if (configuredSessions.has(partition)) return session.fromPartition(partition);
  const ses = session.fromPartition(partition);
  configuredSessions.add(partition);

  const appNow = () => (entries.get(appId) ? entries.get(appId).app : null);
  ses.setUserAgent(CHROME_UA);
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    const a = appNow();
    cb(!!a && a.permissions.includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    const a = appNow();
    return !!a && a.permissions.includes(permission);
  });
  return ses;
}

// ---------------------------------------------------------------- views

function createEntry(a) {
  const ses = configureSession(a.id);
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: APP_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  view.setBackgroundColor('#000000');
  view.setVisible(false);
  win.contentView.addChildView(view);

  const entry = {
    app: a,
    view,
    status: 'idle', // idle | probing | loading | ready | offline | crashed
    error: '',
    title: '',
    badge: 0,
    icon: null,
    muted: !!(store.prefs.muted || {})[a.id],
    retryTimer: null,
    loadedOnce: false,
  };
  entries.set(a.id, entry);
  loadCachedIcon(entry);
  loadConfiguredIcon(entry).then(sendState);
  wireView(entry);
  return entry;
}

function destroyEntry(entry) {
  clearTimeout(entry.retryTimer);
  try {
    win.contentView.removeChildView(entry.view);
  } catch {
    /* already gone */
  }
  try {
    entry.view.webContents.close();
  } catch {
    /* already closed */
  }
  entries.delete(entry.app.id);
}

function wireView(entry) {
  const wc = entry.view.webContents;
  const id = entry.app.id;

  wc.on('page-title-updated', (_e, title) => {
    entry.title = title;
    if (entry.app.badge.from === 'title') {
      entry.badge = countFromTitle(title, entry.app.badge.pattern);
      updateDockBadge();
    }
    sendState();
  });

  wc.on('page-favicon-updated', (_e, favicons) => {
    if (entry.app.icon !== 'auto' || entry.icon || !favicons || !favicons.length) return;
    const pick = favicons.find((f) => /\.png(\?|$)/i.test(f)) || favicons[0];
    fetchIcon(entry, pick);
  });

  wc.on('did-start-loading', () => {
    if (entry.status !== 'offline') entry.status = 'loading';
    sendState();
  });
  wc.on('did-stop-loading', () => {
    if (entry.status === 'loading') entry.status = 'ready';
    entry.loadedOnce = true;
    layout();
    sendState();
  });
  wc.on('did-navigate', sendState);
  wc.on('did-navigate-in-page', sendState);

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted by a new navigation
    if (NETWORK_ERRORS.has(code)) {
      markOffline(entry, desc);
    } else {
      entry.status = 'ready';
      entry.error = `${desc} (${code}) loading ${url}`;
    }
    layout();
    sendState();
  });

  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    entry.status = 'crashed';
    entry.error = `The page stopped (${details.reason}).`;
    layout();
    sendState();
  });

  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (allowedInApp(entry.app, url)) {
      const host = (parseUrl(url) || {}).host;
      const isAuth = entry.app.authHosts.some((h) => hostMatches(host, h));
      if (disposition === 'new-window' && isAuth) {
        // Sign-in pop-ups (e.g. "Sign in with Google") need a real window.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 680,
            parent: win,
            autoHideMenuBar: true,
            backgroundColor: '#000000',
            webPreferences: { session: wc.session, sandbox: true, contextIsolation: true },
          },
        };
      }
      if (entry.app.hosts.some((h) => hostMatches(host, h))) {
        wc.loadURL(url);
        return { action: 'deny' };
      }
    }
    routeLink(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (e) => {
    if (allowedInApp(entry.app, e.url)) return;
    e.preventDefault();
    routeLink(e.url);
  });

  wc.on('context-menu', (_e, params) => showPageMenu(entry, params));
}

function countFromTitle(title, pattern) {
  if (!title) return 0;
  let m = null;
  if (pattern) {
    try {
      m = new RegExp(pattern).exec(title);
    } catch {
      m = null;
    }
  } else {
    m = /\((\d+)\+?\)/.exec(title) || /^\s*(\d+)\s+(?:new|unread)\b/i.exec(title);
  }
  const n = m ? parseInt(m[1], 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function probe(entry) {
  try {
    const ses = session.fromPartition(`persist:${entry.app.id}`);
    await ses.fetch(entry.app.url, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true; // any HTTP answer means the host is reachable
  } catch {
    return false;
  }
}

function markOffline(entry, reason) {
  entry.status = 'offline';
  entry.error = reason || '';
  clearTimeout(entry.retryTimer);
  entry.retryTimer = setTimeout(() => startApp(entry, { retry: true }), OFFLINE_RETRY_MS);
}

async function startApp(entry, { retry = false } = {}) {
  clearTimeout(entry.retryTimer);
  if (entry.app.network === 'tailscale') {
    entry.status = 'probing';
    sendState();
    const ok = await probe(entry);
    if (!entries.has(entry.app.id)) return;
    if (!ok) {
      markOffline(entry, 'No answer from ' + new URL(entry.app.url).host);
      layout();
      sendState();
      return;
    }
  }
  entry.status = 'loading';
  entry.error = '';
  const wc = entry.view.webContents;
  const here = wc.getURL();
  const pending = entry.pendingUrl;
  entry.pendingUrl = null;
  if (pending) wc.loadURL(pending).catch(() => {});
  else if (retry && here && here !== 'about:blank' && allowedInApp(entry.app, here)) wc.reload();
  else wc.loadURL(entry.app.url).catch(() => {});
  layout();
  sendState();
}

function retryOffline() {
  for (const e of entries.values()) {
    if (e.status === 'offline' || e.status === 'crashed') startApp(e, { retry: true });
  }
}

// ---------------------------------------------------------------- badges

async function pollBadges() {
  for (const e of entries.values()) {
    const b = e.app.badge;
    if (b.from !== 'api' && b.from !== 'selector') continue;
    if (e.status !== 'ready') continue;
    let js;
    if (b.from === 'api') {
      if (!b.path) continue;
      js = `(async () => {
        try {
          const r = await fetch(${JSON.stringify(b.path)}, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
          if (!r.ok) return null;
          ${
            b.header
              ? `return r.headers.get(${JSON.stringify(b.header)});`
              : `const j = await r.json(); return ${JSON.stringify(b.json || '')}.split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), j);`
          }
        } catch (e) { return null; }
      })()`;
    } else {
      if (!b.selector) continue;
      js = `(() => { const el = document.querySelector(${JSON.stringify(b.selector)}); return el ? el.textContent : null; })()`;
    }
    try {
      const v = await e.view.webContents.executeJavaScript(js, true);
      const n = parseInt(String(v == null ? '0' : v).replace(/[^\d]/g, ''), 10);
      const next = Number.isFinite(n) ? n : 0;
      if (next !== e.badge) {
        e.badge = next;
        updateDockBadge();
        sendState();
      }
    } catch {
      /* page not ready; next round */
    }
  }
}

function updateDockBadge() {
  const n = totalBadge();
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge(n > 0 ? String(n) : '');
  else app.setBadgeCount(n);
}

// ---------------------------------------------------------------- layout & switching

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const bounds = { x: SIDEBAR_W, y: TOOLBAR_H, width: Math.max(0, w - SIDEBAR_W), height: Math.max(0, h - TOOLBAR_H) };
  for (const [id, e] of entries) {
    const showing =
      id === activeId && !overlayOpen && (e.status === 'ready' || (e.status === 'loading' && e.loadedOnce));
    if (showing) e.view.setBounds(bounds);
    e.view.setVisible(showing);
  }
}

function switchTo(id) {
  if (!entries.has(id)) return;
  activeId = id;
  store.setPref('lastApp', id);
  layout();
  const e = entries.get(id);
  if (!overlayOpen && e.status === 'ready') e.view.webContents.focus();
  sendState();
}

function cycleApp(step) {
  const ids = store.apps.map((a) => a.id);
  if (!ids.length) return;
  const i = Math.max(0, ids.indexOf(activeId));
  switchTo(ids.at((i + step + ids.length) % ids.length));
}

function routeLink(url) {
  const u = parseUrl(url);
  if (!u) return;
  if (u.protocol === 'dqws:') return handleDeepLink(url);
  const target = appForUrl(url);
  if (!target) return openExternal(url);
  const e = entries.get(target.id);
  switchTo(target.id);
  if (e.status === 'offline' || e.status === 'probing') {
    e.pendingUrl = url;
    return;
  }
  e.view.webContents.loadURL(url).catch(() => {});
}

// dqws://<app-id>/<path>  or  dqws://open?url=<encoded url>
function handleDeepLink(url) {
  const u = parseUrl(url);
  if (!u) return;
  showWindow();
  if (u.host === 'open') {
    const inner = u.searchParams.get('url');
    if (inner) routeLink(inner);
    return;
  }
  const e = entries.get(u.host);
  if (!e) return;
  switchTo(e.app.id);
  const rest = u.pathname.replace(/^\/+/, '') + u.search + u.hash;
  if (rest) {
    const target = new URL(rest, e.app.url.endsWith('/') ? e.app.url : e.app.url + '/').toString();
    if (allowedInApp(e.app, target)) e.view.webContents.loadURL(target).catch(() => {});
  }
}

// ---------------------------------------------------------------- notifications

function onNotify(event, payload) {
  const entry = [...entries.values()].find((e) => e.view.webContents.id === event.sender.id);
  if (!entry || !payload) return;
  const frameUrl = event.senderFrame ? event.senderFrame.url : '';
  if (frameUrl && !allowedInApp(entry.app, frameUrl)) return;
  if (!entry.app.notifications || entry.muted || store.prefs.muteAll) return;
  if (!Notification.isSupported()) return;

  const key = `${entry.app.id}:${payload.id}`;
  if (payload.tag) {
    for (const [k, n] of notifications) {
      if (n.__tag === `${entry.app.id}:${payload.tag}`) {
        n.close();
        notifications.delete(k);
      }
    }
  }
  const n = new Notification({
    title: payload.title || entry.app.name,
    subtitle: entry.app.name,
    body: payload.body || '',
    silent: !!payload.silent,
  });
  n.__tag = payload.tag ? `${entry.app.id}:${payload.tag}` : '';
  n.on('click', () => {
    showWindow();
    switchTo(entry.app.id);
    entry.view.webContents.send('dq:notify-click', payload.id);
    notifications.delete(key);
  });
  n.on('close', () => notifications.delete(key));
  notifications.set(key, n);
  if (notifications.size > 60) {
    const first = notifications.keys().next().value;
    notifications.delete(first);
  }
  n.show();
  if (process.platform === 'darwin' && app.dock && !win.isFocused()) app.dock.bounce('informational');
}

function onNotifyClose(event, id) {
  const entry = [...entries.values()].find((e) => e.view.webContents.id === event.sender.id);
  if (!entry) return;
  const key = `${entry.app.id}:${id}`;
  const n = notifications.get(key);
  if (n) {
    n.close();
    notifications.delete(key);
  }
}

// ---------------------------------------------------------------- state for the shell

function snapshot() {
  const light = !!store.prefs.followSystem && !nativeTheme.shouldUseDarkColors;
  return {
    activeId,
    light,
    version: app.getVersion(),
    configPath: store.appsFile,
    configErrors: store.errors,
    prefs: {
      followSystem: !!store.prefs.followSystem,
      muteAll: !!store.prefs.muteAll,
    },
    apps: store.apps.map((a, i) => {
      const e = entries.get(a.id);
      const wc = e ? e.view.webContents : null;
      return {
        ...a,
        index: i,
        status: e ? e.status : 'idle',
        error: e ? e.error : '',
        unread: e ? e.badge : 0,
        muted: e ? e.muted : false,
        iconData: e ? e.icon : null,
        title: e ? e.title : '',
        currentUrl: wc && !wc.isDestroyed() ? wc.getURL() : '',
        canGoBack: wc && !wc.isDestroyed() ? wc.navigationHistory.canGoBack() : false,
        canGoForward: wc && !wc.isDestroyed() ? wc.navigationHistory.canGoForward() : false,
      };
    }),
  };
}

function sendState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('dq:state', snapshot());
  }, 40);
}

function sendCommand(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('dq:command', cmd);
}

// ---------------------------------------------------------------- app actions

function nav(action, entry = activeEntry()) {
  if (!entry) return;
  const wc = entry.view.webContents;
  switch (action) {
    case 'back':
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      break;
    case 'forward':
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      break;
    case 'reload':
      if (entry.status === 'offline' || entry.status === 'crashed') startApp(entry, { retry: true });
      else wc.reload();
      break;
    case 'force-reload':
      wc.reloadIgnoringCache();
      break;
    case 'home':
      wc.loadURL(entry.app.url).catch(() => {});
      break;
    case 'copy-url':
      clipboard.writeText(wc.getURL() || entry.app.url);
      break;
    case 'open-browser':
      openExternal(wc.getURL() || entry.app.url);
      break;
    case 'zoom-in':
      wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 5));
      break;
    case 'zoom-out':
      wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3));
      break;
    case 'zoom-reset':
      wc.setZoomLevel(0);
      break;
    case 'devtools':
      wc.openDevTools({ mode: 'detach' });
      break;
    default:
      break;
  }
}

async function appAction(id, action) {
  const entry = entries.get(id);
  if (!entry) return;
  switch (action) {
    case 'toggle-mute': {
      entry.muted = !entry.muted;
      const muted = { ...(store.prefs.muted || {}) };
      if (entry.muted) muted[id] = true;
      else delete muted[id];
      store.setPref('muted', muted);
      updateDockBadge();
      sendState();
      break;
    }
    case 'refresh-icon':
      try {
        fs.unlinkSync(iconFile(id));
      } catch {
        /* none cached */
      }
      entry.icon = null;
      if (entry.app.icon === 'auto') {
        const favs = await entry.view.webContents
          .executeJavaScript(
            `[...document.querySelectorAll('link[rel~="icon"]')].map(l => l.href)`,
            true
          )
          .catch(() => []);
        const pick = (favs || []).find((f) => /\.png(\?|$)/i.test(f)) || (favs || [])[0];
        if (pick) fetchIcon(entry, pick);
        else fetchIcon(entry, new URL('/favicon.ico', entry.app.url).toString());
      } else {
        await loadConfiguredIcon(entry);
      }
      sendState();
      break;
    case 'clear-data': {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Clear and sign out', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Clear ${entry.app.name} data and sign out?`,
        detail: 'Cookies, storage and cache for this app only are removed. Other apps stay signed in.',
      });
      if (response !== 0) return;
      const ses = entry.view.webContents.session;
      await ses.clearStorageData();
      await ses.clearCache();
      startApp(entry);
      break;
    }
    default:
      nav(action, entry);
  }
}

function showAppMenu(id) {
  const entry = entries.get(id);
  if (!entry) return;
  Menu.buildFromTemplate([
    { label: `Open ${entry.app.name}`, click: () => switchTo(id) },
    { label: 'Reload', click: () => appAction(id, 'reload') },
    { label: 'Go to start page', click: () => appAction(id, 'home') },
    { type: 'separator' },
    { label: 'Mute notifications', type: 'checkbox', checked: entry.muted, click: () => appAction(id, 'toggle-mute') },
    { label: 'Copy link', click: () => appAction(id, 'copy-url') },
    { label: 'Open in browser', click: () => appAction(id, 'open-browser') },
    { label: 'Refresh icon', click: () => appAction(id, 'refresh-icon') },
    { type: 'separator' },
    { label: 'Edit…', click: () => sendCommand({ type: 'settings', appId: id }) },
    { label: 'Clear data and sign out…', click: () => appAction(id, 'clear-data') },
  ]).popup({ window: win });
}

function showPageMenu(entry, p) {
  const wc = entry.view.webContents;
  const items = [];
  if (p.misspelledWord && p.dictionarySuggestions.length) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    }
    items.push({ type: 'separator' });
  }
  if (p.linkURL) {
    const target = appForUrl(p.linkURL);
    items.push(
      { label: target ? `Open link in ${target.name}` : 'Open link in browser', click: () => routeLink(p.linkURL) },
      ...(target ? [{ label: 'Open link in browser', click: () => openExternal(p.linkURL) }] : []),
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' }
    );
  }
  if (p.isEditable) {
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' });
  } else if (p.selectionText) {
    items.push({ role: 'copy' });
  }
  if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' });
  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => nav('back', entry) },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => nav('forward', entry) },
    { label: 'Reload', click: () => nav('reload', entry) },
    { type: 'separator' },
    { label: 'Inspect element', click: () => wc.inspectElement(p.x, p.y) }
  );
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------- menus

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const appItems = store.apps.slice(0, 9).map((a, i) => ({
    label: a.name,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => {
      showWindow();
      switchTo(a.id);
    },
  }));
  const template = [
    ...(isMac
      ? [
          {
            label: 'DQ Workspace',
            submenu: [
              { label: 'About DQ Workspace', click: () => sendCommand({ type: 'about' }) },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendCommand({ type: 'settings' }) },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [
          {
            label: 'File',
            submenu: [
              { label: 'Settings…', accelerator: 'Ctrl+,', click: () => sendCommand({ type: 'settings' }) },
              { label: 'About DQ Workspace', click: () => sendCommand({ type: 'about' }) },
              { role: 'quit' },
            ],
          },
        ]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => nav('reload') },
        { label: 'Force Reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => nav('force-reload') },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => nav('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => nav('forward') },
        { label: 'Start Page', accelerator: 'Shift+CmdOrCtrl+H', click: () => nav('home') },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => nav('zoom-reset') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => nav('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => nav('zoom-out') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools for This App', accelerator: 'Alt+CmdOrCtrl+I', click: () => nav('devtools') },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Quick Switcher…', accelerator: 'CmdOrCtrl+K', click: () => sendCommand({ type: 'switcher' }) },
        { label: 'Previous App', accelerator: 'Alt+CmdOrCtrl+Up', click: () => cycleApp(-1) },
        { label: 'Next App', accelerator: 'Alt+CmdOrCtrl+Down', click: () => cycleApp(1) },
        { type: 'separator' },
        ...appItems,
      ],
    },
    {
      label: 'Page',
      submenu: [
        { label: 'Copy Link', accelerator: 'Shift+CmdOrCtrl+C', click: () => nav('copy-url') },
        { label: 'Open in Browser', accelerator: 'CmdOrCtrl+L', click: () => nav('open-browser') },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- window

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const saved = store.prefs.bounds || {};
  win = new BrowserWindow({
    width: saved.width || 1320,
    height: saved.height || 860,
    x: saved.x,
    y: saved.y,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'DQ Workspace',
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 15 },
    webPreferences: {
      preload: SHELL_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (saved.maximized) win.maximize();
  win.loadFile(SHELL_HTML);
  win.once('ready-to-show', () => win.show());

  // The shell never navigates away from its own page.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      store.setPref('bounds', { ...win.getNormalBounds(), maximized: win.isMaximized() });
    }, 500);
  };
  win.on('resize', () => {
    layout();
    saveBounds();
  });
  win.on('move', saveBounds);
  win.on('focus', () => {
    const e = activeEntry();
    if (e && !overlayOpen && e.status === 'ready') e.view.webContents.focus();
    pollBadges();
  });
  win.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      // Keep running so notifications keep arriving; Dock click brings it back.
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------- reconcile apps with config

function reconcile() {
  const wanted = new Map(store.apps.map((a) => [a.id, a]));
  for (const [id, e] of entries) {
    if (!wanted.has(id)) destroyEntry(e);
  }
  let delay = 0;
  for (const a of store.apps) {
    const e = entries.get(a.id);
    if (!e) {
      const fresh = createEntry(a);
      setTimeout(() => startApp(fresh), delay);
      delay += 250;
      continue;
    }
    const urlChanged = e.app.url !== a.url;
    const iconChanged = e.app.icon !== a.icon;
    e.app = a;
    if (iconChanged) {
      e.icon = null;
      try {
        fs.unlinkSync(iconFile(a.id));
      } catch {
        /* none */
      }
      loadConfiguredIcon(e).then(sendState);
    }
    if (urlChanged) startApp(e);
  }
  if (!entries.has(activeId)) activeId = store.apps.length ? store.apps[0].id : null;
  buildMenu();
  layout();
  updateDockBadge();
  sendState();
}

// ---------------------------------------------------------------- IPC

function wireIpc() {
  ipcMain.handle('dq:get-state', () => snapshot());
  ipcMain.handle('dq:capture', async () => {
    const e = activeEntry();
    if (!e || overlayOpen || e.status !== 'ready') return null;
    try {
      const img = await e.view.webContents.capturePage();
      return img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  });
  ipcMain.on('dq:switch', (_e, id) => switchTo(id));
  ipcMain.on('dq:nav', (_e, action) => nav(action));
  ipcMain.on('dq:retry', (_e, id) => {
    const e = entries.get(id);
    if (e) startApp(e, { retry: true });
  });
  ipcMain.on('dq:overlay', (_e, open) => {
    overlayOpen = !!open;
    layout();
    if (!overlayOpen) {
      const e = activeEntry();
      if (e && e.status === 'ready') e.view.webContents.focus();
    }
  });
  ipcMain.on('dq:app-action', (_e, { id, action }) => appAction(id, action));
  ipcMain.on('dq:app-menu', (_e, id) => showAppMenu(id));
  ipcMain.handle('dq:save-apps', (_e, list) => {
    try {
      store.saveApps(list);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('dq:reset-apps', () => {
    store.resetToDefaults();
    return { ok: true };
  });
  ipcMain.handle('dq:set-pref', (_e, { key, value }) => {
    if (!['followSystem', 'muteAll'].includes(key)) return { ok: false };
    store.setPref(key, !!value);
    if (key === 'followSystem') nativeTheme.themeSource = value ? 'system' : 'dark';
    updateDockBadge();
    sendState();
    return { ok: true };
  });
  ipcMain.on('dq:reveal-config', () => shell.showItemInFolder(store.appsFile));
  ipcMain.on('dq:network', (_e, online) => {
    if (online) retryOffline();
  });
  ipcMain.on('dq:notify', onNotify);
  ipcMain.on('dq:notify-close', onNotifyClose);
}

// ---------------------------------------------------------------- lifecycle

// Separate profile for testing: DQWS_PROFILE=/tmp/dq-test npm start
if (process.env.DQWS_PROFILE) app.setPath('userData', process.env.DQWS_PROFILE);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow();
    const link = argv.find((a) => a.startsWith('dqws://'));
    if (link) handleDeepLink(link);
  });

  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (app.isReady() && win) handleDeepLink(url);
    else pendingOpenUrl = url;
  });

  app.setAsDefaultProtocolClient('dqws');

  app.whenReady().then(() => {
    store = new Store({ userDataDir: app.getPath('userData'), defaultsFile: DEFAULTS_FILE });
    store.init();
    iconDir = path.join(app.getPath('userData'), 'icons');
    fs.mkdirSync(iconDir, { recursive: true });
    nativeTheme.themeSource = store.prefs.followSystem ? 'system' : 'dark';

    wireIpc();
    createWindow();

    const last = store.prefs.lastApp;
    activeId = store.apps.some((a) => a.id === last) ? last : store.apps.length ? store.apps[0].id : null;
    reconcile();

    store.on('apps', reconcile);
    nativeTheme.on('updated', sendState);
    powerMonitor.on('resume', retryOffline);
    badgeTimer = setInterval(pollBadges, BADGE_POLL_MS);
    setTimeout(pollBadges, 8000);

    if (pendingOpenUrl) {
      handleDeepLink(pendingOpenUrl);
      pendingOpenUrl = null;
    }
  });

  app.on('activate', () => {
    if (win) showWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    clearInterval(badgeTimer);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Never let any web contents attach a <webview> or open devtools for the shell.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}
