const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  startCapture: () => ipcRenderer.invoke('start-capture'),
  stopCapture: () => ipcRenderer.invoke('stop-capture'),
  onEngineStatus: (callback) => {
    const subscription = (_event, status) => callback(_event, status);
    ipcRenderer.on('engine-status', subscription);
    return () => ipcRenderer.removeListener('engine-status', subscription);
  },
  onProviderStatus: (callback) => {
    const subscription = (_event, status) => callback(_event, status);
    ipcRenderer.on('provider-status', subscription);
    return () => ipcRenderer.removeListener('provider-status', subscription);
  },
  onTranscript: (callback) => {
    const subscription = (_event, data) => callback(_event, data);
    ipcRenderer.on('transcript', subscription);
    return () => ipcRenderer.removeListener('transcript', subscription);
  }
});
