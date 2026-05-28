const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');

// ========== FLAGS GPU (NVENC) ==========
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-video-encode');
app.commandLine.appendSwitch('enable-hardware-overlays');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('disable-gpu-vsync');

let mainWindow;
let wss = null;
let receiverRegistered = false;
let currentClient = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (wss) wss.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ========== IPC: Servidor de señalización ==========
ipcMain.on('start-server', (event, port) => {
  if (wss) wss.close();
  wss = new WebSocket.Server({ port });

  wss.on('listening', () => {
    mainWindow.webContents.send('server-started', port);
  });

  wss.on('connection', (ws) => {
    console.log('Cliente conectado al servidor de señalización');
    currentClient = ws;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (receiverRegistered) {
          mainWindow.webContents.send('receiver-signal', msg);
        }
      } catch (e) {
        console.error('Mensaje no JSON:', data);
      }
    });

    ws.on('close', () => {
      currentClient = null;
      mainWindow.webContents.send('ws-disconnected');
    });
  });

  wss.on('error', (err) => {
    mainWindow.webContents.send('server-error', err.message);
  });
});

ipcMain.on('stop-server', () => {
  if (wss) {
    wss.close();
    wss = null;
  }
  currentClient = null;
  receiverRegistered = false;
  mainWindow.webContents.send('server-stopped');
});

// Registro del receptor
ipcMain.on('register-receiver', () => {
  receiverRegistered = true;
  console.log('Receptor registrado');
});

ipcMain.on('unregister-receiver', () => {
  receiverRegistered = false;
  console.log('Receptor anulado');
});

// Enviar datos al cliente conectado desde el renderer (solo el receptor lo usa)
ipcMain.on('ws-send', (event, data) => {
  if (currentClient && currentClient.readyState === WebSocket.OPEN) {
    currentClient.send(JSON.stringify(data));
  }
});