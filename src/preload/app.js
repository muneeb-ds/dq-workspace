'use strict';
// Preload for every app view (GitLab, Plane, Google Chat, ...).
// It runs sandboxed and only does one thing: replace the page's web Notification
// API with a shim that forwards notifications to the main process, which shows
// them as native macOS notifications and reports clicks back.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const clickHandlers = [];
ipcRenderer.on('dq:notify-click', (_e, id) => {
  for (const cb of clickHandlers) {
    try {
      cb(id);
    } catch {
      /* page handler threw; ignore */
    }
  }
});

const str = (v, max) => (v == null ? '' : String(v).slice(0, max));

contextBridge.exposeInMainWorld('__dqwsNotify', {
  notify(id, title, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    ipcRenderer.send('dq:notify', {
      id: Number(id) || 0,
      title: str(title, 200),
      body: str(o.body, 1000),
      tag: str(o.tag, 200),
      silent: !!o.silent,
    });
  },
  close(id) {
    ipcRenderer.send('dq:notify-close', Number(id) || 0);
  },
  onClick(cb) {
    if (typeof cb === 'function') clickHandlers.push(cb);
  },
});

// Runs in the page's own world.
function installShim() {
  const bridge = window.__dqwsNotify;
  if (!bridge || window.__dqwsShimmed) return;
  window.__dqwsShimmed = true;
  const live = new Map();
  let seq = 0;

  class DQNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body || '';
      this.tag = options.tag || '';
      this.icon = options.icon || '';
      this.data = options.data === undefined ? null : options.data;
      this.silent = !!options.silent;
      this.onclick = null;
      this.onshow = null;
      this.onclose = null;
      this.onerror = null;
      this._id = ++seq;
      live.set(this._id, this);
      bridge.notify(this._id, this.title, options);
      setTimeout(() => this._fire('show'), 0);
    }
    _fire(type) {
      const ev = new Event(type, { cancelable: true });
      this.dispatchEvent(ev);
      const h = this['on' + type];
      if (typeof h === 'function') h.call(this, ev);
      return ev;
    }
    close() {
      if (!live.has(this._id)) return;
      live.delete(this._id);
      bridge.close(this._id);
      this._fire('close');
    }
    static get permission() {
      return 'granted';
    }
    static requestPermission(cb) {
      if (typeof cb === 'function') cb('granted');
      return Promise.resolve('granted');
    }
    static get maxActions() {
      return 0;
    }
  }

  bridge.onClick((id) => {
    const n = live.get(id);
    if (!n) return;
    n._fire('click');
    try {
      window.focus();
    } catch {
      /* ignore */
    }
  });

  Object.defineProperty(window, 'Notification', {
    value: DQNotification,
    writable: true,
    configurable: true,
  });

  // Some apps notify through their service worker registration instead.
  if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype.showNotification) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      new DQNotification(title, options || {});
      return Promise.resolve();
    };
  }
}

try {
  if (typeof contextBridge.executeInMainWorld === 'function') {
    contextBridge.executeInMainWorld({ func: installShim });
  } else {
    webFrame.executeJavaScript(`(${installShim.toString()})()`);
  }
} catch {
  webFrame.executeJavaScript(`(${installShim.toString()})()`).catch(() => {});
}
