const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('walletd', {
  rpc: (method, params) => ipcRenderer.invoke('rpc', method, params),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  launchWalletd: () => ipcRenderer.invoke('launch-walletd'),
  stopWalletd: () => ipcRenderer.invoke('stop-walletd'),
  isWalletdRunning: () => ipcRenderer.invoke('walletd-running'),
  browseFile: () => ipcRenderer.invoke('browse-file'),
  onWalletdStopped: (cb) => ipcRenderer.on('walletd-stopped', (_e, code, output) => cb(code, output)),
  onWalletdError: (cb) => ipcRenderer.on('walletd-error', (_e, msg) => cb(msg))
});
