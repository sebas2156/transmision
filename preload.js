const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startServer: (port) => ipcRenderer.send('start-server', port),
  stopServer: () => ipcRenderer.send('stop-server'),
  onServerStarted: (callback) => {
    ipcRenderer.on('server-started', (event, port) => callback(port));
  },
  onServerError: (callback) => {
    ipcRenderer.on('server-error', (event, msg) => callback(msg));
  },
  onServerStopped: (callback) => {
    ipcRenderer.on('server-stopped', () => callback());
  },
  onWsDisconnected: (callback) => {
    ipcRenderer.on('ws-disconnected', () => callback());
  },
  wsSend: (data) => ipcRenderer.send('ws-send', data),

  registerReceiver: () => ipcRenderer.send('register-receiver'),
  unregisterReceiver: () => ipcRenderer.send('unregister-receiver'),
  onReceiverSignal: (callback) => {
    ipcRenderer.removeAllListeners('receiver-signal');
    ipcRenderer.on('receiver-signal', (event, msg) => callback(msg));
  },
  removeReceiverSignalListener: () => {
    ipcRenderer.removeAllListeners('receiver-signal');
  }
});
