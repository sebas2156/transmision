const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startServer: (port) => ipcRenderer.send('start-server', port),
  stopServer: () => ipcRenderer.send('stop-server'),
  onServerStarted: (callback) => {
    ipcRenderer.removeAllListeners('server-started');
    ipcRenderer.on('server-started', (event, port) => callback(port));
  },
  onServerError: (callback) => {
    ipcRenderer.removeAllListeners('server-error');
    ipcRenderer.on('server-error', (event, msg) => callback(msg));
  },
  onServerStopped: (callback) => {
    ipcRenderer.removeAllListeners('server-stopped');
    ipcRenderer.on('server-stopped', () => callback());
  },
  
  wsBroadcast: (data) => ipcRenderer.send('ws-broadcast', data),
  wsSendTo: (clientId, data) => ipcRenderer.send('ws-send-to', clientId, data),
  onWsDisconnected: (callback) => {
    ipcRenderer.removeAllListeners('ws-disconnected');
    ipcRenderer.on('ws-disconnected', (event, clientId) => callback(clientId));
  },
  
  onSignalReceived: (callback) => {
    ipcRenderer.removeAllListeners('signal-received');
    ipcRenderer.on('signal-received', (event, signal) => callback(signal));
  },
  removeSignalListener: () => {
    ipcRenderer.removeAllListeners('signal-received');
  },
});