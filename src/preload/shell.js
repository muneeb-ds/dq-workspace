'use strict';
// Preload for the shell UI (sidebar, toolbar, settings). Exposes a narrow API.

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('dq:state', (_e, state) => {
  for (const cb of listeners) cb(state);
});
const commandListeners = new Set();
ipcRenderer.on('dq:command', (_e, cmd) => {
  for (const cb of commandListeners) cb(cmd);
});

contextBridge.exposeInMainWorld('dq', {
  getState: () => ipcRenderer.invoke('dq:get-state'),
  onState: (cb) => listeners.add(cb),
  onCommand: (cb) => commandListeners.add(cb),
  switchTo: (id) => ipcRenderer.send('dq:switch', id),
  nav: (action) => ipcRenderer.send('dq:nav', action),
  retry: (id) => ipcRenderer.send('dq:retry', id),
  setOverlay: (open) => ipcRenderer.send('dq:overlay', !!open),
  appAction: (id, action) => ipcRenderer.send('dq:app-action', { id, action }),
  showAppMenu: (id) => ipcRenderer.send('dq:app-menu', id),
  saveApps: (list) => ipcRenderer.invoke('dq:save-apps', list),
  resetApps: () => ipcRenderer.invoke('dq:reset-apps'),
  setPref: (key, value) => ipcRenderer.invoke('dq:set-pref', { key, value }),
  revealConfig: () => ipcRenderer.send('dq:reveal-config'),
  capture: () => ipcRenderer.invoke('dq:capture'),
  networkChanged: (online) => ipcRenderer.send('dq:network', !!online),
});
