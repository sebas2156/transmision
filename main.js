const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const { execFile } = require('child_process');

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
const clients = new Map();
let nextClientId = 1;

function safeSend(channel, data) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send(channel, data);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

app.on('before-quit', () => {
  if (wss) {
    wss.clients.forEach(client => {
      try {
        client.close();
      } catch {}
    });
    wss.close();
  }
});

app.on('window-all-closed', () => {
  if (wss) wss.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('start-server', (event, port) => {
  if (wss) {
    clients.clear();
    wss.close();
  }
  
  wss = new WebSocket.Server({ port });

  wss.on('listening', () => {
    console.log(`Servidor WebSocket iniciado en puerto ${port}`);
    safeSend('server-started', port);
  });

  wss.on('connection', (ws) => {
    const clientId = nextClientId++;
    clients.set(clientId, { ws, id: clientId });
    console.log(`Cliente ${clientId} conectado. Total clientes: ${clients.size}`);

    ws.send(JSON.stringify({ type: 'client-id', clientId }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        console.log(`Mensaje de cliente ${clientId}:`, msg.type);
        
        clients.forEach((client, id) => {
          if (id !== clientId && client.ws.readyState === WebSocket.OPEN) {
            const forwardedMsg = {
              ...msg,
              senderId: clientId
            };
            client.ws.send(JSON.stringify(forwardedMsg));
          }
        });
        
        if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'candidate') {
          safeSend('signal-received', {
            type: msg.type,
            data: msg,
            senderId: clientId
          });
        }
        
      } catch (e) {
        console.error('Error procesando mensaje WebSocket:', e);
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      console.log(`Cliente ${clientId} desconectado. Clientes restantes: ${clients.size}`);
      safeSend('ws-disconnected', clientId);
    });
    
    ws.on('error', (error) => {
      console.error(`Error en cliente ${clientId}:`, error);
    });
  });

  wss.on('error', (err) => {
    console.error('Error del servidor WebSocket:', err);
    safeSend('server-error', err.message);
  });
});

ipcMain.on('stop-server', () => {
  if (wss) {
    clients.forEach((client) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close();
      }
    });
    clients.clear();
    wss.close();
    wss = null;
  }
  safeSend('server-stopped');
});

ipcMain.on('ws-broadcast', (event, data) => {
  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  });
});

ipcMain.on('ws-send-to', (event, clientId, data) => {
  const client = clients.get(clientId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
});

// ===========================
// FFmpeg DirectShow resolutions
// ===========================
const FFMPEG_FPS_RANGE = [15, 24, 30, 60];

function parseFFmpegOptions(output) {
  const result = [];
  const seen = new Set();
  const lines = output.split('\n');

  const regex = /pixel_format=(\S+)\s+min s=(\d+)x(\d+) fps=([\d.]+) max s=(\d+)x(\d+) fps=([\d.]+)/;

  for (const line of lines) {
    const m = line.match(regex);
    if (!m) continue;

    const fmt = m[1].toLowerCase();
    let minW = parseInt(m[2]);
    let minH = parseInt(m[3]);
    const minFps = parseFloat(m[4]);
    let maxW = parseInt(m[5]);
    let maxH = parseInt(m[6]);
    const maxFps = parseFloat(m[7]);
    const isRange = minW !== maxW || minH !== maxH;

    // YUY2/raw: solo resoluciones fijas (min===max) que son modos nativos
    // MJPEG/H264: si es rango, usar la resolución máxima (el sensor sí la entrega comprimida)
    if (isRange && fmt !== 'mjpeg' && fmt !== 'h264') continue;
    if (isRange) { minW = maxW; minH = maxH; }

    for (const fps of FFMPEG_FPS_RANGE) {
      if (fps >= minFps && fps <= maxFps) {
        const key = `${minW}x${minH}@${fps}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ w: minW, h: minH, fps });
        }
      }
    }
  }

  result.sort((a, b) => a.w * a.h - b.w * b.h);
  return result;
}

ipcMain.handle('get-ffmpeg-resolutions', async (event, cameraLabel) => {
  if (!cameraLabel) return { error: 'Sin nombre de cámara' };

  // Buscar ffmpeg en PATH y ubicaciones comunes de Windows
  const COMMON_FFMPEG_PATHS = [
    'ffmpeg',
    'ffmpeg.exe',
    path.join('C:', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join('C:', 'Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join('C:', 'Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default', 'Microsoft', 'WinGet', 'Packages', 'FFmpeg', 'ffmpeg.exe'),
  ];

  let ffmpegPath = null;
  for (const p of COMMON_FFMPEG_PATHS) {
    try {
      await new Promise((resolve, reject) => {
        const test = execFile(p, ['-version'], { timeout: 3000 });
        test.on('error', reject);
        test.on('close', code => code === 0 ? resolve() : reject());
        test.stdin.end();
      });
      ffmpegPath = p;
      break;
    } catch {}
  }

  if (!ffmpegPath) {
    return { error: 'ffmpeg no está instalado. Descargalo de https://ffmpeg.org o usa: winget install FFmpeg' };
  }

  return new Promise(resolve => {
    const args = ['-f', 'dshow', '-list_options', 'true', '-i', `video=${cameraLabel}`];
    const child = execFile(ffmpegPath, args, { timeout: 15000 });
    let stderr = '';

    child.stdout.on('data', () => {});

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', err => {
      resolve({ error: `Error ejecutando ffmpeg: ${err.message}` });
    });

    child.on('close', code => {
      const modes = parseFFmpegOptions(stderr);
      if (modes.length > 0) {
        resolve({ modes });
      } else {
        const sample = stderr.split('\n').slice(0, 20).join('\n');
        resolve({
          error: `Sin modos detectados (exit ${code})`,
          debug: sample
        });
      }
    });

    child.stdin.end();
  });
});