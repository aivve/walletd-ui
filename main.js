const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
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
      walletdPath: ''
    };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Build walletd command-line args from structured settings
function buildArgs(s) {
  const args = [];

  if (s.configFile)    { args.push('-c', s.configFile); }
  if (s.containerFile) { args.push('-w', s.containerFile); }
  if (s.containerPass) { args.push('-p', s.containerPass); }

  // Bind
  if (s.bindAddr && s.bindAddr !== '127.0.0.1') args.push('--bind-address', s.bindAddr);
  if (s.bindPort && s.bindPort !== '16000')      args.push('--bind-port', s.bindPort);

  // RPC auth
  if (s.rpcUser) args.push('--rpc-user', s.rpcUser);
  if (s.rpcPass) args.push('--rpc-password', s.rpcPass);

  // Node mode
  if (s.nodeMode === 'local') {
    args.push('--local');
  } else {
    if (s.daemonAddr && s.daemonAddr !== '127.0.0.1') args.push('--daemon-address', s.daemonAddr);
    if (s.daemonPort && s.daemonPort !== '32348')     args.push('--daemon-port', s.daemonPort);
  }

  if (s.testnet)   args.push('--testnet');
  if (s.logFile)   args.push('--log-file', s.logFile);
  if (s.logLevel)  args.push('--log-level', s.logLevel);
  if (s.scanHeight && s.scanHeight !== '0') args.push('--scan-height', s.scanHeight);
  if (s.dataDir)   args.push('--data-dir', s.dataDir);

  // SSL
  if (s.sslEnable) {
    args.push('--rpc-ssl-enable');
    if (s.sslChain) args.push('--rpc-chain-file', s.sslChain);
    if (s.sslKey)   args.push('--rpc-key-file', s.sslKey);
    if (s.sslPort)  args.push('--bind-port-ssl', s.sslPort);
  }

  // Extra raw args
  if (s.extraArgs) {
    args.push(...s.extraArgs.split(/\s+/).filter(Boolean));
  }

  return args;
}

function launchWalletdProcess(settings) {
  if (walletdProcess) return { error: 'walletd already running' };
  if (!settings.walletdPath) return { error: 'walletd path not set' };

  const args = buildArgs(settings);
  try {
    walletdProcess = spawn(settings.walletdPath, args, { stdio: 'pipe' });

    // Collect stdout/stderr for debugging
    let lastOutput = '';
    walletdProcess.stdout?.on('data', d => { lastOutput = d.toString().slice(-500); });
    walletdProcess.stderr?.on('data', d => { lastOutput = d.toString().slice(-500); });

    walletdProcess.on('exit', (code) => {
      walletdProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('walletd-stopped', code, lastOutput);
      }
    });
    walletdProcess.on('error', (err) => {
      walletdProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('walletd-error', err.message);
      }
    });
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Karbo Payment Gate Wallet',
    icon: path.join(__dirname, 'build', 'icon.ico'),
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

// RPC proxy — avoids CORS; supports both http and https
ipcMain.handle('rpc', async (_event, method, params) => {
  const settings = loadSettings();
  const url = settings.rpcUrl || 'http://127.0.0.1:16000/json_rpc';

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const postData = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} });
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      rejectUnauthorized: false  // allow self-signed certs for local walletd
    };

    // Add basic auth if configured
    if (settings.rpcUser) {
      const auth = Buffer.from(`${settings.rpcUser}:${settings.rpcPass || ''}`).toString('base64');
      options.headers['Authorization'] = `Basic ${auth}`;
    }

    const req = transport.request(options, (res) => {
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

ipcMain.handle('launch-walletd', async () => {
  const settings = loadSettings();
  return launchWalletdProcess(settings);
});

ipcMain.handle('stop-walletd', () => {
  if (walletdProcess) { walletdProcess.kill(); walletdProcess = null; }
  return true;
});

ipcMain.handle('walletd-running', () => !!walletdProcess);

ipcMain.handle('browse-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'Executables', extensions: ['exe'] },
      { name: 'Wallet Files', extensions: ['wallet'] },
      { name: 'Config Files', extensions: ['conf', 'ini', 'cfg'] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();

  // Auto-launch walletd if configured
  const settings = loadSettings();
  if (settings.autoLaunch && settings.walletdPath) {
    const result = launchWalletdProcess(settings);
    if (result.error) console.error('Auto-launch failed:', result.error);
  }
});

app.on('window-all-closed', () => {
  if (walletdProcess) walletdProcess.kill();
  app.quit();
});
