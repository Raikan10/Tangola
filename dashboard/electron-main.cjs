const { app, BrowserWindow, ipcMain, shell, systemPreferences } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const { spawn } = require('child_process');

// ─── Logging Setup ─────────────────────────────────────────────────────────────
const logsDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const mainLogPath = path.join(logsDir, 'main.log');
const engineLogPath = path.join(logsDir, 'engine.log');

const mainLogStream = fs.createWriteStream(mainLogPath, { flags: 'a' });
const engineLogStream = fs.createWriteStream(engineLogPath, { flags: 'a' });

function logToFile(msg, stream = mainLogStream) {
  const timestamp = new Date().toISOString();
  const formattedMsg = `[${timestamp}] ${msg}\n`;
  stream.write(formattedMsg);
  process.stdout.write(formattedMsg);
}

// Redirect console logs to main.log
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  logToFile(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' '));
};
console.error = (...args) => {
  logToFile(`ERROR: ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ')}`);
};
console.warn = (...args) => {
  logToFile(`WARN: ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ')}`);
};

console.log('--- App Starting ---');
console.log(`Logs located at: ${logsDir}`);

// ─── Feature Flags ──────────────────────────────────────────────────────────────
function getFeatureFlags() {
  try {
    const filePath = path.join(__dirname, 'features.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    console.error("Error reading features.json:", e);
  }
  return { multiLanguage: false, debugEngine: false };
}

const features = getFeatureFlags();
console.log(`[Features] Multi-Language: ${features.multiLanguage}, Debug Engine: ${features.debugEngine}`);

// ─── Settings persistence ────────────────────────────────────────────────────────
function getSettingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getSettings() {
  try {
    if (fs.existsSync(getSettingsFile())) {
      return JSON.parse(fs.readFileSync(getSettingsFile(), 'utf-8'));
    }
  } catch (e) {
    console.error("Error reading settings:", e);
  }
  return {
    sarvamApiKey: '',
    geminiApiKey: '',
    openaiApiKey: '',
    defaultSummarizer: 'gemini'
  };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(getSettingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("Error saving settings:", e);
  }
}

const { ProviderManager } = require('./src/main-process/ProviderManager.cjs');
const { Summarizer } = require('./src/main-process/Summarizer.cjs');

const initialSettings = getSettings();
const provider = new ProviderManager(app.getPath('userData'));
const summarizer = new Summarizer(initialSettings);

try {
  if (initialSettings.sarvamApiKey) {
    provider.initialize('sarvam', { apiKey: initialSettings.sarvamApiKey });
  }
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

  let engineDir;
  if (isPackaged) {
    // electron-builder puts extraResources at process.resourcesPath/engine
    engineDir = path.join(process.resourcesPath, 'engine');
  } else if (features.debugEngine) {
    // Development but want to test the standalone folder
    engineDir = path.resolve(__dirname, 'dist-engine');
  } else {
    engineDir = path.resolve(__dirname, '..', 'engine');
  }

  let pythonExe;
  if (isPackaged || features.debugEngine) {
    // In standalone distribution prepared by prepare-engine.js:
    pythonExe = process.platform === 'win32'
      ? path.join(engineDir, 'python', 'python.exe')
      : path.join(engineDir, 'python', 'bin', 'python3');
  } else {
    // Development use local .venv
    pythonExe = process.platform === 'win32'
      ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : path.join(engineDir, '.venv', 'bin', 'python');
  }

  return { engineDir, pythonExe, mainPy: path.join(engineDir, 'main.py') };
}

// ─── Engine process management ─────────────────────────────────────────────────
function startPythonEngine() {
  if (pythonProcess) {
    console.log("[Engine] Cleaning up existing Python process before restart.");
    try { pythonProcess.kill(); } catch (e) {}
    pythonProcess = null;
  }

  const { engineDir, pythonExe, mainPy } = getEnginePaths();
  const enginePath = mainPy;
  const pythonPath = pythonExe;

  console.log(`[Engine] dir=${engineDir}`);
  console.log(`[Engine] Starting: ${pythonPath} ${enginePath}`);
  logToFile(`[Engine] Spawning: "${pythonPath}" "${enginePath}"`, engineLogStream);

  const spawnOptions = {
    cwd: path.dirname(enginePath),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };

  pythonProcess = spawn(pythonPath, [enginePath], spawnOptions);

  pythonProcess.stdout.on('data', (d) => {
    const msg = d.toString();
    logToFile(msg.trim(), engineLogStream);
  });
  pythonProcess.stderr.on('data', (d) => {
    const msg = d.toString();
    logToFile(`ERR: ${msg.trim()}`, engineLogStream);
  });

  pythonProcess.on('error', (err) => {
    console.error('[Engine] Failed to start:', err);
    logToFile(`CRITICAL ERROR: Failed to start engine: ${err}`, engineLogStream);
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

  // Give the engine 1s to boot, connect to it, and start the heartbeat watchdog
  setTimeout(() => {
    connectToEngine().catch(err => console.log('[Engine] Initial WS connect failed:', err.message));
    startHeartbeatWatchdog();
  }, 1000);
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
function getMeetingsRoot() {
  return path.join(app.getPath('documents'), 'Tangola');
}

function dateToFolderName(dateStr) {
  const d = new Date(dateStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function getMeetingDir(meeting) {
  return path.join(getMeetingsRoot(), meeting.folderName);
}

function getMeetings() {
  const root = getMeetingsRoot();
  if (!fs.existsSync(root)) return [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const meetings = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(root, entry.name, 'metadata.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meeting = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const summaryPath = path.join(root, entry.name, 'summary.md');
        if (fs.existsSync(summaryPath)) {
          meeting.summary = fs.readFileSync(summaryPath, 'utf-8');
        }
        meetings.push(meeting);
      } catch (e) {
        console.error(`Error reading meeting from ${entry.name}:`, e);
      }
    }
    meetings.sort((a, b) => new Date(a.date) - new Date(b.date));
    return meetings;
  } catch (e) {
    console.error("Error reading meetings:", e);
    return [];
  }
}

function saveMeeting(meeting) {
  const root = getMeetingsRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  if (!meeting.folderName) {
    const base = dateToFolderName(meeting.date);
    let candidate = base;
    let i = 2;
    while (fs.existsSync(path.join(root, candidate))) candidate = `${base}_${i++}`;
    meeting.folderName = candidate;
  }

  const dir = path.join(root, meeting.folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { summary, ...meta } = meeting;
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));

  const transcriptText = (meeting.transcripts || []).map(t => t.text).join('\n');
  fs.writeFileSync(path.join(dir, 'transcript.txt'), transcriptText);

  if (summary) {
    fs.writeFileSync(path.join(dir, 'summary.md'), summary);
  }
}

// ─── Migrate legacy meetings.json ──────────────────────────────────────────────
function migrateLegacyMeetings() {
  const oldFile = path.join(app.getPath('userData'), 'meetings.json');
  if (!fs.existsSync(oldFile)) return;
  try {
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
    if (!Array.isArray(old) || old.length === 0) return;
    console.log(`[Migration] Migrating ${old.length} meetings from meetings.json…`);
    for (const m of old) saveMeeting(m);
    fs.renameSync(oldFile, oldFile + '.bak');
    console.log('[Migration] Done. Old file renamed to meetings.json.bak');
  } catch (e) {
    console.error('[Migration] Failed:', e);
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

  ipcMain.handle('open-logs', () => {
    shell.openPath(logsDir);
    return true;
  });

  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
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

  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('save-settings', (event, newSettings) => {
    saveSettings(newSettings);
    // Re-initialize things dynamically
    summarizer.updateSettings(newSettings);
    if (newSettings.sarvamApiKey) {
      try {
        provider.initialize('sarvam', { apiKey: newSettings.sarvamApiKey });
      } catch (e) {
        console.warn("Could not re-init Sarvam provider on settings save");
      }
    }
    return { success: true };
  });

  ipcMain.handle('get-meetings', () => getMeetings());

  ipcMain.handle('create-meeting', (event, title) => {
    const id = Date.now().toString();
    const newMeeting = {
      id,
      title: title || `Meeting ${new Date().toLocaleString()}`,
      date: new Date().toISOString(),
      transcripts: [],
      languageCode: 'ta-IN',
    };
    saveMeeting(newMeeting);
    activeMeetingId = id;
    return newMeeting;
  });

  ipcMain.handle('delete-meeting', (event, id) => {
    const meetings = getMeetings();
    const m = meetings.find(x => x.id === id);
    if (!m) return { success: false, error: 'Meeting not found' };
    try {
      const dir = getMeetingDir(m);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      if (activeMeetingId === id) activeMeetingId = null;
      return { success: true };
    } catch (e) {
      console.error('[IPC] Failed to delete meeting folder:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('set-active-meeting', (event, id) => {
    activeMeetingId = id;
    return true;
  });

  ipcMain.handle('update-meeting-language', (event, { id, languageCode }) => {
    const meetings = getMeetings();
    const m = meetings.find(x => x.id === id);
    if (m) {
      m.languageCode = languageCode;
      saveMeeting(m);
      return { success: true };
    }
    return { success: false, error: 'Meeting not found' };
  });

  ipcMain.handle('set-debug-wav', (event, enabled) => {
    provider.setDebugWav(enabled);
    return true;
  });

  ipcMain.handle('set-provider', (event, providerType) => {
    try {
      const currentSettings = getSettings();
      const apiKey = providerType === 'openai' ? currentSettings.openaiApiKey : currentSettings.sarvamApiKey;
      if (!apiKey) return { success: false, error: `Missing API key for ${providerType}` };
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
      saveMeeting(m);
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
        const id = Date.now().toString();
        const newMeeting = {
          id,
          title: `Meeting ${new Date().toLocaleString()}`,
          date: new Date().toISOString(),
          transcripts: [],
        };
        saveMeeting(newMeeting);
        activeMeetingId = id;
      }
      const currentMeetingId = activeMeetingId;
      const meetings = getMeetings();
      const m = meetings.find(x => x.id === currentMeetingId);
      const languageCode = m ? m.languageCode : 'ta-IN';

      await provider.startRecording(
        (text, isFinal) => {
          if (isFinal) {
            const meetings = getMeetings();
            const m = meetings.find(x => x.id === currentMeetingId);
            if (m) {
              m.transcripts.push({ text, final: true, id: Date.now() });
              saveMeeting(m);
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
        },
        languageCode
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
    try {
      if (!isRecording) return true;
      if (pythonWs && pythonWs.readyState === WebSocket.OPEN) {
        pythonWs.send(JSON.stringify({ action: 'stop' }));
      }
      if (provider) {
        provider.stopRecording();
      }
      isRecording = false;
      return true;
    } catch (e) {
      console.error('[IPC] Stop recording failed:', e);
      return false;
    }
  });
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────
app.isQuitting = false;

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.raikan10.tangola');
  }
  
  if (process.platform === 'win32') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      console.log(`[Permission] Windows Microphone status: ${status}`);
    } catch (err) {
      console.error('[Permission] Failed to check Windows microphone status:', err);
    }
  }

  if (process.platform === 'darwin') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      console.log(`[Permission] Microphone access granted: ${granted}`);
    } catch (err) {
      console.error('[Permission] Failed to check microphone access:', err);
    }
  }

  migrateLegacyMeetings();
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
