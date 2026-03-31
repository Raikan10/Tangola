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
const { Summarizer } = require('./src/main-process/Summarizer.cjs');

const provider = new ProviderManager();
const summarizer = new Summarizer(process.env.GEMINI_API_KEY);
try {
  provider.initialize('sarvam', { apiKey: process.env.SARVAM_API_KEY });
} catch (e) {
  console.warn("Failed to initialize Sarvam Provider: ", e.message);
}

let pythonWs = null;
let isRecording = false;
let pythonProcess = null;
let heartbeatWatchdog = null;
let lastHeartbeat = 0;
let engineRestartTimer = null;

let mainWindow;
let activeMeetingId = null;

// ─── Path resolution: dev vs. packaged ────────────────────────────────────────
function getEnginePaths() {
  const isPackaged = app.isPackaged;

  let engineDir, pythonExe;
  if (isPackaged) {
    // electron-builder puts extraResources at process.resourcesPath/engine
    engineDir = path.join(process.resourcesPath, 'engine');
  } else {
    engineDir = path.resolve(__dirname, '..', 'engine');
  }

  const venvBin = process.platform === 'win32'
    ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
    : path.join(engineDir, '.venv', 'bin', 'python');

  return { engineDir, pythonExe: venvBin, mainPy: path.join(engineDir, 'main.py') };
}

// ─── Engine process management ─────────────────────────────────────────────────
function startPythonEngine() {
  if (pythonProcess) return; // already running

  const { engineDir, pythonExe, mainPy } = getEnginePaths();
  const enginePath = mainPy;
  const pythonPath = pythonExe;

  console.log(`[Engine] dir=${engineDir}`);
  console.log(`[Engine] Starting: ${pythonPath} ${enginePath}`);

  pythonProcess = spawn(pythonPath, [enginePath], {
    cwd: path.dirname(enginePath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pythonProcess.stdout.on('data', (d) => process.stdout.write(`[Engine] ${d}`));
  pythonProcess.stderr.on('data', (d) => process.stderr.write(`[Engine:ERR] ${d}`));

  pythonProcess.on('error', (err) => {
    console.error('[Engine] Failed to start:', err);
    pythonProcess = null;
    sendStatus('engine-dead');
    scheduleEngineRestart();
  });

  pythonProcess.on('exit', (code, signal) => {
    console.log(`[Engine] Exited (code=${code}, signal=${signal})`);
    pythonProcess = null;
    sendStatus('engine-dead');
    if (!app.isQuitting) scheduleEngineRestart();
  });

  // Give the engine 1s to boot, then start the heartbeat watchdog
  setTimeout(startHeartbeatWatchdog, 1000);
}

function scheduleEngineRestart() {
  if (engineRestartTimer) return;
  console.log('[Engine] Restarting in 3s...');
  engineRestartTimer = setTimeout(() => {
    engineRestartTimer = null;
    startPythonEngine();
  }, 3000);
}

// ─── Heartbeat watchdog ────────────────────────────────────────────────────────
// Python sends a heartbeat every 2s. If we miss 3 in a row (6s), restart the engine.
function startHeartbeatWatchdog() {
  if (heartbeatWatchdog) clearInterval(heartbeatWatchdog);
  lastHeartbeat = Date.now();

  heartbeatWatchdog = setInterval(() => {
    const elapsed = Date.now() - lastHeartbeat;
    if (elapsed > 6000) {
      console.warn('[Watchdog] No heartbeat for 6s — restarting engine.');
      sendStatus('engine-dead');
      if (pythonProcess) {
        pythonProcess.kill();
        pythonProcess = null;
      }
      clearInterval(heartbeatWatchdog);
      heartbeatWatchdog = null;
      scheduleEngineRestart();
    }
  }, 2000);
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('engine-status', status);
  }
}

// ─── Meeting persistence ───────────────────────────────────────────────────────
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

// ─── Connect to Python WebSocket ───────────────────────────────────────────────
async function connectToEngine() {
  return new Promise((resolve, reject) => {
    if (pythonWs && pythonWs.readyState === WebSocket.OPEN) {
      return resolve();
    }

    pythonWs = new WebSocket('ws://localhost:8765');

    pythonWs.on('message', (data, isBinary) => {
      if (isBinary) {
        // Raw audio bytes — push to STT provider
        if (isRecording) provider.pushAudioChunk(data);
      } else {
        // JSON control message
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'heartbeat') {
            lastHeartbeat = Date.now(); // reset watchdog timer
          } else if (msg.type === 'status') {
            sendStatus(msg.status);
          }
        } catch (_) {}
      }
    });

    pythonWs.on('error', (err) => {
      console.error('[WS] Engine connection error:', err.message);
      sendStatus('error');
      reject(err);
    });

    pythonWs.on('close', () => {
      console.log('[WS] Engine disconnected.');
      sendStatus('Disconnected');
      pythonWs = null;
    });

    pythonWs.once('open', () => {
      console.log('[WS] Connected to Python engine.');
      sendStatus('Connected');
      resolve();
    });
  });
}

// ─── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  // ── IPC handlers ──
  ipcMain.handle('get-status', () => ({
    pythonConnected: pythonWs && pythonWs.readyState === WebSocket.OPEN,
    recording: isRecording,
    providerInitialized: !!provider.provider,
    activeMeetingId,
  }));

  ipcMain.handle('get-meetings', () => getMeetings());

  ipcMain.handle('create-meeting', (event, title) => {
    const meetings = getMeetings();
    const id = Date.now().toString();
    const newMeeting = {
      id,
      title: title || `Meeting ${new Date().toLocaleString()}`,
      date: new Date().toISOString(),
      transcripts: [],
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

  ipcMain.handle('set-debug-wav', (event, enabled) => {
    provider.setDebugWav(enabled);
    return true;
  });

  ipcMain.handle('set-provider', (event, providerType) => {
    try {
      if (providerType === 'openai' && process.env.VITE_ENABLE_OPENAI !== 'true') {
        return { success: false, error: 'OpenAI integration is currently disabled via feature flag.' };
      }
      const apiKey = providerType === 'openai' ? process.env.OPENAI_API_KEY : process.env.SARVAM_API_KEY;
      if (!apiKey) return { success: false, error: `Missing ${providerType.toUpperCase()}_API_KEY` };
      provider.initialize(providerType, { apiKey });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('generate-summary', async (event, meetingId) => {
    const meetings = getMeetings();
    const m = meetings.find(x => x.id === meetingId);
    if (!m || !m.transcripts || m.transcripts.length === 0) {
      return { success: false, error: "No transcripts available to summarize." };
    }
    const fullText = m.transcripts.map(t => t.text).join(' ');
    try {
      const resultText = await summarizer.generateSummary(fullText);
      let title = m.title;
      let summaryText = resultText;
      
      const titleMatch = resultText.match(/^Title:\s*(.+)/i);
      if (titleMatch) {
        title = titleMatch[1].trim();
        // Remove the parsed title line (and any trailing empty lines) from the summary body
        summaryText = resultText.replace(/^Title:\s*(.+)\n*/i, '').trim();
      }

      m.title = title;
      m.summary = summaryText;
      saveMeetings(meetings);
      return { success: true, summary: summaryText };
    } catch (error) {
      console.error('[IPC] Summarization failed:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('start-capture', async (event, meetingId) => {
    if (isRecording) return true;

    // Attempt to connect (engine may already be running)
    try {
      await connectToEngine();
    } catch (err) {
      console.error('[IPC] Could not connect to engine:', err.message);
      return false;
    }

    try {
      if (meetingId) activeMeetingId = meetingId;
      if (!activeMeetingId) {
        const meetings = getMeetings();
        const id = Date.now().toString();
        const newMeeting = {
          id,
          title: `Meeting ${new Date().toLocaleString()}`,
          date: new Date().toISOString(),
          transcripts: [],
        };
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
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('transcript', { text, isFinal, meetingId: currentMeetingId });
          }
        },
        (status) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('provider-status', status);
          }
        }
      );

      pythonWs.send(JSON.stringify({ action: 'start' }));
      isRecording = true;
      return true;
    } catch (e) {
      console.error('[IPC] Start recording failed:', e);
      return false;
    }
  });

  ipcMain.handle('stop-capture', async () => {
    if (!isRecording) return true;
    if (pythonWs && pythonWs.readyState === WebSocket.OPEN) {
      pythonWs.send(JSON.stringify({ action: 'stop' }));
    }
    provider.stopRecording();
    isRecording = false;
    return true;
  });
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────
app.isQuitting = false;

app.whenReady().then(() => {
  startPythonEngine();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (pythonProcess) pythonProcess.kill();
  if (heartbeatWatchdog) clearInterval(heartbeatWatchdog);
  if (engineRestartTimer) clearTimeout(engineRestartTimer);
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (pythonProcess) pythonProcess.kill();
});
