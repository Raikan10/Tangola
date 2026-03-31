const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const { spawn } = require('child_process');

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
let pythonProcess = null;

let mainWindow;
let activeMeetingId = null;

function startPythonEngine() {
  const enginePath = path.resolve(__dirname, '..', 'engine', 'main.py');
  const venvPath = path.resolve(__dirname, '..', 'engine', '.venv', 'bin', 'python');
  
  console.log(`Starting Python Engine: ${venvPath} ${enginePath}`);
  
  pythonProcess = spawn(venvPath, [enginePath], {
    cwd: path.dirname(enginePath),
    stdio: 'inherit'
  });

  pythonProcess.on('error', (err) => {
    console.error('Failed to start python engine:', err);
  });

  pythonProcess.on('exit', (code) => {
    console.log(`Python engine exited with code ${code}`);
    pythonProcess = null;
  });
}

function getMeetingsFile() {
  return path.join(app.getPath('userData'), 'meetings.json');
}

function getMeetings() {
  try {
    if (fs.existsSync(getMeetingsFile())) {
      return JSON.parse(fs.readFileSync(getMeetingsFile(), 'utf-8'));
    }
  } catch (e) {
    console.error("Error reading meetings:", e);
  }
  return [];
}

function saveMeetings(meetings) {
  try {
    fs.writeFileSync(getMeetingsFile(), JSON.stringify(meetings, null, 2));
  } catch(e) {
    console.error("Error saving meetings:", e);
  }
}

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
      providerInitialized: !!provider.provider,
      activeMeetingId
    };
  });

  ipcMain.handle('get-meetings', () => getMeetings());

  ipcMain.handle('create-meeting', (event, title) => {
    const meetings = getMeetings();
    const id = Date.now().toString();
    const newMeeting = { 
      id, 
      title: title || `Meeting ${new Date().toLocaleString()}`, 
      date: new Date().toISOString(), 
      transcripts: [] 
    };
    meetings.push(newMeeting);
    saveMeetings(meetings);
    activeMeetingId = id;
    return newMeeting;
  });

  ipcMain.handle('set-active-meeting', (event, id) => {
    activeMeetingId = id;
    return true;
  });

  ipcMain.handle('start-capture', async (event, meetingId) => {
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
      if (meetingId) activeMeetingId = meetingId;
      if (!activeMeetingId) {
         const meetings = getMeetings();
         const id = Date.now().toString();
         const newMeeting = { id, title: `Meeting ${new Date().toLocaleString()}`, date: new Date().toISOString(), transcripts: [] };
         meetings.push(newMeeting);
         saveMeetings(meetings);
         activeMeetingId = id;
      }
      const currentMeetingId = activeMeetingId;

      await provider.startRecording(
        (text, isFinal) => {
          if (isFinal) {
             const meetings = getMeetings();
             const m = meetings.find(x => x.id === currentMeetingId);
             if (m) {
                 m.transcripts.push({ text, final: true, id: Date.now() });
                 saveMeetings(meetings);
             }
          }
          mainWindow.webContents.send('transcript', { text, isFinal, meetingId: currentMeetingId });
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
  startPythonEngine();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
});
