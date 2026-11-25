'use strict';
// Loads, validates, saves and watches the apps config and user prefs.
// Team defaults ship in config/default-apps.json; the user's own copy lives in
// ~/Library/Application Support/DQ Workspace/apps.json and wins once it exists.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_PERMISSIONS = ['notifications', 'clipboard-sanitized-write', 'fullscreen'];
const BADGE_MODES = ['title', 'api', 'selector', 'none'];

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function cleanHostList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((h) => String(h).trim().toLowerCase()).filter(Boolean))];
}

// Returns a normalised app, or throws an Error with a readable message.
function normaliseApp(raw, takenIds = new Set()) {
  if (!raw || typeof raw !== 'object') throw new Error('App entry is not an object');
  const name = String(raw.name || '').trim();
  if (!name) throw new Error('Every app needs a name');
  let url = String(raw.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const host = hostOf(url);
  if (!host) throw new Error(`"${name}": URL is not valid`);

  let id = slug(raw.id || name) || 'app';
  if (takenIds.has(id)) {
    let n = 2;
    while (takenIds.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }

  const hosts = cleanHostList(raw.hosts);
  if (!hosts.includes(host)) hosts.unshift(host);

  const b = raw.badge && typeof raw.badge === 'object' ? raw.badge : { from: raw.badge || 'title' };
  const badge = { from: BADGE_MODES.includes(b.from) ? b.from : 'title' };
  if (b.pattern) badge.pattern = String(b.pattern);
  if (badge.from === 'api') {
    badge.path = String(b.path || '');
    if (b.header) badge.header = String(b.header).toLowerCase();
    if (b.json) badge.json = String(b.json);
  }
  if (badge.from === 'selector') badge.selector = String(b.selector || '');

  return {
    id,
    name,
    url,
    hosts,
    authHosts: cleanHostList(raw.authHosts),
    icon: raw.icon ? String(raw.icon) : 'auto',
    badge,
    network: raw.network === 'tailscale' || /\.ts\.net$/i.test(host) ? 'tailscale' : 'internet',
    notifications: raw.notifications !== false,
    permissions: Array.isArray(raw.permissions) ? raw.permissions.map(String) : DEFAULT_PERMISSIONS,
    userAgent: raw.userAgent === 'electron' ? 'electron' : 'chrome',
  };
}

function normaliseList(list) {
  const taken = new Set();
  const apps = [];
  const errors = [];
  for (const raw of Array.isArray(list) ? list : []) {
    try {
      const app = normaliseApp(raw, taken);
      taken.add(app.id);
      apps.push(app);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { apps, errors };
}

class Store extends EventEmitter {
  constructor({ userDataDir, defaultsFile }) {
    super();
    this.dir = userDataDir;
    this.defaultsFile = defaultsFile;
    this.appsFile = path.join(userDataDir, 'apps.json');
    this.prefsFile = path.join(userDataDir, 'prefs.json');
    this.apps = [];
    this.errors = [];
    this.prefs = {};
    this._selfWrite = 0;
    this._watcher = null;
    this._debounce = null;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.appsFile)) {
      fs.copyFileSync(this.defaultsFile, this.appsFile);
    }
    this.loadApps();
    this.prefs = this._readJson(this.prefsFile, {});
    this.watch();
  }

  defaults() {
    return this._readJson(this.defaultsFile, { apps: [] }).apps || [];
  }

  loadApps() {
    const data = this._readJson(this.appsFile, null);
    if (!data) {
      this.errors = ['apps.json could not be read; using team defaults'];
      const res = normaliseList(this.defaults());
      this.apps = res.apps;
      return;
    }
    const res = normaliseList(data.apps);
    this.apps = res.apps;
    this.errors = res.errors;
  }

  saveApps(list) {
    const res = normaliseList(list);
    if (res.errors.length) throw new Error(res.errors.join('\n'));
    this.apps = res.apps;
    this.errors = [];
    this._selfWrite = Date.now();
    this._writeJson(this.appsFile, { version: 1, apps: res.apps });
    this.emit('apps', this.apps);
    return this.apps;
  }

  resetToDefaults() {
    return this.saveApps(this.defaults());
  }

  setPref(key, value) {
    this.prefs[key] = value;
    this._writeJson(this.prefsFile, this.prefs);
  }

  watch() {
    try {
      this._watcher = fs.watch(this.dir, (_evt, file) => {
        if (file !== 'apps.json') return;
        if (Date.now() - this._selfWrite < 1500) return; // our own save
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
          this.loadApps();
          this.emit('apps', this.apps);
        }, 300);
      });
    } catch {
      /* watching is a convenience; the Settings window still works without it */
    }
  }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  _writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
}

module.exports = { Store, normaliseApp, normaliseList, hostOf, slug };
