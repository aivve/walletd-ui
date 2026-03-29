const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

let mainWindow;
let walletdProcess = null;
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {
      rpcUrl: 'http://127.0.0.1:16000/json_rpc',
      autoLaunch: false,
      walletdPath: '',
      walletdArgs: ''
    };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Karbo Wallet',
    backgroundColor: '#0f1720',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');
}

// RPC proxy - avoids CORS issues
ipcMain.handle('rpc', async (_event, method, params) => {
  const settings = loadSettings();
  const url = settings.rpcUrl || 'http://127.0.0.1:16000/json_rpc';

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} });
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(json.error);
          else resolve(json.result);
        } catch (e) {
          reject({ message: 'Invalid JSON response from walletd' });
        }
      });
    });
    req.on('error', (e) => reject({ message: `Connection failed: ${e.message}` }));
    req.setTimeout(30000, () => { req.destroy(); reject({ message: 'Request timeout' }); });
    req.write(postData);
    req.end();
  });
});

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_event, settings) => { saveSettings(settings); return true; });

ipcMain.handle('launch-walletd', async (_event) => {
  const settings = loadSettings();
  if (!settings.walletdPath) return { error: 'walletd path not set' };
  if (walletdProcess) return { error: 'walletd already running' };

  const args = settings.walletdArgs ? settings.walletdArgs.split(/\s+/) : [];
  try {
    walletdProcess = spawn(settings.walletdPath, args, { stdio: 'pipe' });
    walletdProcess.on('exit', () => { walletdProcess = null; mainWindow?.webContents.send('walletd-stopped'); });
    walletdProcess.on('error', (err) => { walletdProcess = null; mainWindow?.webContents.send('walletd-error', err.message); });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('stop-walletd', () => {
  if (walletdProcess) { walletdProcess.kill(); walletdProcess = null; }
  return true;
});

ipcMain.handle('walletd-running', () => !!walletdProcess);

ipcMain.handle('browse-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Executables', extensions: ['exe', ''] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();

  // Auto-launch walletd if configured
  const settings = loadSettings();
  if (settings.autoLaunch && settings.walletdPath) {
    const args = settings.walletdArgs ? settings.walletdArgs.split(/\s+/) : [];
    try {
      walletdProcess = spawn(settings.walletdPath, args, { stdio: 'pipe' });
      walletdProcess.on('exit', () => { walletdProcess = null; });
    } catch (e) {
      console.error('Auto-launch failed:', e);
    }
  }
});

app.on('window-all-closed', () => {
  if (walletdProcess) walletdProcess.kill();
  app.quit();
});
