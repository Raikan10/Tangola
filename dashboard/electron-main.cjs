const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');

// Load environment variables from parent folder
let dotenvPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(dotenvPath)) {
  require('dotenv').config({ path: dotenvPath });
}

const { ProviderManager } = require('./src/main-process/ProviderManager.cjs');
const provider = new ProviderManager();
try {
  provider.initialize('sarvam', { apiKey: process.env.SARVAM_API_KEY });
} catch (e) {
  console.warn("Failed to initialize Sarvam Provider: ", e.message);
}

let pythonWs = null;
let isRecording = false;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  // Load the React app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  // Setup IPC handlers
  ipcMain.handle('get-status', () => {
    return {
      pythonConnected: pythonWs && pythonWs.readyState === WebSocket.OPEN,
      recording: isRecording,
      providerInitialized: !!provider.provider
    };
  });

  ipcMain.handle('start-capture', async (event) => {
    if (isRecording) return;
    
    // Connect to Python Engine
    if (!pythonWs || pythonWs.readyState !== WebSocket.OPEN) {
      pythonWs = new WebSocket('ws://localhost:8765');
      pythonWs.on('message', (data, isBinary) => {
        if (isBinary && isRecording) {
          provider.pushAudioChunk(data);
        }
      });
      pythonWs.on('error', (err) => {
        console.error("Python WS Error", err);
        mainWindow.webContents.send('engine-status', 'error');
      });
      pythonWs.on('close', () => mainWindow.webContents.send('engine-status', 'Disconnected'));
      
      try {
        // wait until open before sending start
        await new Promise((resolve, reject) => {
          pythonWs.once('open', () => {
            mainWindow.webContents.send('engine-status', 'Connected');
            resolve();
          });
          pythonWs.once('error', reject);
        });
      } catch (err) {
        console.error("Could not connect to Tangola Python Engine:", err.message);
        return false;
      }
    }

    try {
      await provider.startRecording(
        (text, isFinal) => {
          mainWindow.webContents.send('transcript', { text, isFinal });
        },
        (status) => {
          mainWindow.webContents.send('provider-status', status);
        }
      );
      pythonWs.send(JSON.stringify({ action: 'start' }));
      isRecording = true;
      return true;
    } catch (e) {
      console.error("Start recording failed", e);
      return false;
    }
  });

  ipcMain.handle('stop-capture', async () => {
    if (!isRecording) return;
    if (pythonWs && pythonWs.readyState === WebSocket.OPEN) {
      pythonWs.send(JSON.stringify({ action: 'stop' }));
    }
    provider.stopRecording();
    isRecording = false;
    return true;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
