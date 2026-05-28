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
const clients = new Map();
let nextClientId = 1;

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
    mainWindow.webContents.send('server-started', port);
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
          mainWindow.webContents.send('signal-received', {
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
      mainWindow.webContents.send('ws-disconnected', clientId);
    });
    
    ws.on('error', (error) => {
      console.error(`Error en cliente ${clientId}:`, error);
    });
  });

  wss.on('error', (err) => {
    console.error('Error del servidor WebSocket:', err);
    mainWindow.webContents.send('server-error', err.message);
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
  mainWindow.webContents.send('server-stopped');
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