const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  startCapture: (meetingId) => ipcRenderer.invoke('start-capture', meetingId),
  stopCapture: () => ipcRenderer.invoke('stop-capture'),
  getMeetings: () => ipcRenderer.invoke('get-meetings'),
  createMeeting: (title) => ipcRenderer.invoke('create-meeting', title),
  setActiveMeeting: (id) => ipcRenderer.invoke('set-active-meeting', id),
  generateSummary: (meetingId) => ipcRenderer.invoke('generate-summary', meetingId),
  setDebugWav: (enabled) => ipcRenderer.invoke('set-debug-wav', enabled),
  setProvider: (type) => ipcRenderer.invoke('set-provider', type),
  deleteMeeting: (id) => ipcRenderer.invoke('delete-meeting', id),
  updateMeetingLanguage: (data) => ipcRenderer.invoke('update-meeting-language', data),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openMeetingsFolder: (meetingId) => ipcRenderer.invoke('open-meetings-folder', meetingId),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
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
