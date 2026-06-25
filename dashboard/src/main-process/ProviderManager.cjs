const { SarvamAIClient } = require('sarvamai');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Helper to write WAV header
function createWavFile(pcmBuffer, filePath) {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20); // PCM
  wavHeader.writeUInt16LE(1, 22); // channels
  wavHeader.writeUInt32LE(16000, 24); // sampleRate
  wavHeader.writeUInt32LE(32000, 28); // byteRate
  wavHeader.writeUInt16LE(2, 32); // blockAlign
  wavHeader.writeUInt16LE(16, 34); // bitDepth
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcmBuffer.length, 40);
  
  fs.writeFileSync(filePath, Buffer.concat([wavHeader, pcmBuffer]));
}

class STTProvider {
  constructor() {
    this.onTranscript = null; // callback(text, isFinal)
    this.onStatus = null; // callback(status)
  }

  async start() { throw new Error("Not implemented"); }
  stop() { throw new Error("Not implemented"); }
  sendAudioChunk(chunk) { throw new Error("Not implemented"); }
}

// Sarvam closes its streaming socket with code=1000 after ~37 min (a server-
// side max-session cap). SarvamProvider survives arbitrarily long meetings by
// transparently (re)connecting when the server drops us, buffering the few
// chunks that arrive mid-handshake so nothing is lost.
//
// Idle-close (closing the socket during silence) is DISABLED by default: in a
// real meeting people pause to think, and closing on every pause both shows a
// jarring "idle" status and can truncate a transcript Sarvam is still
// finalizing (flush+close races the final message). An idle socket costs
// nothing — we already send no audio during silence (the engine gates it) and
// Sarvam bills per second of audio, not per connection — so there's no reason
// to close it. The 37-min cap is handled by reconnect regardless.
const IDLE_CLOSE_ENABLED = false;
const IDLE_CLOSE_MS = 120000;      // only used if IDLE_CLOSE_ENABLED is flipped on
const MAX_RECONNECT_ATTEMPTS = 6;  // give up (and surface an error) after this
const MAX_QUEUED_CHUNKS = 300;     // ~ a few seconds of audio held during reconnect

class SarvamProvider extends STTProvider {
  constructor(apiKey) {
    super();
    this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    this.socket = null;
    this.languageCode = 'ta-IN';
    this.intentionalStop = false; // user pressed stop — do not reconnect
    this.idleClosed = false;      // we closed on purpose after silence
    this.connecting = false;
    this.sendQueue = [];          // chunks buffered while (re)connecting
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
  }

  async start(languageCode = 'ta-IN') {
    this.languageCode = languageCode;
    this.intentionalStop = false;
    this.idleClosed = false;
    this.reconnectAttempts = 0;
    await this._connect();
  }

  async _connect() {
    // Guard against overlapping connection attempts / already-live sockets.
    if (this.connecting) return;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    if (this.intentionalStop) return;

    this.connecting = true;
    try {
      if (this.onStatus) this.onStatus('connecting');

      const socket = await this.client.speechToTextTranslateStreaming.connect({
        model: "saaras:v3",
        "language-code": this.languageCode,
        high_vad_sensitivity: true,
        vad_signals: true
      });
      this.socket = socket;
      this._attachHandlers(socket);

      await socket.waitForOpen();
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.idleClosed = false;
      if (this.onStatus) this.onStatus('connected');
      this._flushQueue();
      this._resetIdleTimer();
    } catch (err) {
      this.connecting = false;
      console.error("Failed to start Sarvam translation streaming:", err);
      if (this.onStatus) this.onStatus('error: ' + (err && err.message));
      this._scheduleReconnect();
    }
  }

  _attachHandlers(socket) {
    socket.on('message', (response) => {
      if (response.type === "data" && response.data) {
        if (response.data.transcript && this.onTranscript) {
          this.onTranscript(response.data.transcript, true);
        }
      } else if (response.type === "events" && response.data) {
        if (response.data.signal_type === "START_SPEECH") {
          if (this.onStatus) this.onStatus("listening");
        } else if (response.data.signal_type === "END_SPEECH") {
          if (this.onStatus) this.onStatus("processing");
        }
      }
    });

    socket.on('error', (err) => {
      // The SDK surfaces the ~37-min cap here as a bare Error; the actual
      // close detail (code/reason) comes through the 'close' handler below,
      // which decides whether to reconnect. Just log here.
      console.error("Sarvam SDK Error:", err);
    });

    socket.on('close', (event) => {
      const code = event && event.code;
      const reason = (event && event.reason) || '';
      const detail = code ? `code=${code}${reason ? ` reason="${reason}"` : ''}` : 'no close detail';
      console.warn(`Sarvam socket closed: ${detail}`);

      // Ignore closes from a socket we've already replaced/abandoned.
      if (socket !== this.socket) return;
      this.socket = null;

      if (this.intentionalStop) return;          // user stop
      if (this.idleClosed) {                      // we closed it on purpose
        if (this.onStatus) this.onStatus('idle');
        return;                                   // reconnect lazily on next chunk
      }

      // Genuine billing/quota failure (e.g. code 1003 "Credits exhausted") —
      // reconnecting would just loop, so surface it instead.
      if (code === 1003 || /credit|quota|exhaust/i.test(reason)) {
        if (this.onStatus) this.onStatus(`error: ${reason || 'credits exhausted'}`);
        return;
      }

      // Unexpected close (the ~37-min cap, a network blip) — reconnect.
      if (this.onStatus) this.onStatus('reconnecting');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.intentionalStop) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("Sarvam reconnect gave up after", this.reconnectAttempts, "attempts.");
      if (this.onStatus) this.onStatus('error: reconnect failed');
      return;
    }
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => { if (!this.intentionalStop) this._connect(); }, delay);
  }

  stop() {
    this.intentionalStop = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.sendQueue = [];
    if (this.socket) {
      try { this.socket.flush(); } catch (e) { /* already closed */ }
      try { this.socket.close(); } catch (e) { /* already closed */ }
    }
    this.socket = null;
  }

  sendAudioChunk(chunkBuffer) {
    if (this.intentionalStop) return;
    // A chunk arriving means the engine's VAD detected speech. Reset the idle
    // timer so an active speaker keeps the socket alive.
    this._resetIdleTimer();

    const open = this.socket && this.socket.readyState === 1;
    if (open) {
      this._translate(chunkBuffer);
      return;
    }

    // Not open: buffer the chunk and make sure a connection is coming up.
    this._queue(chunkBuffer);
    if (this.idleClosed || (!this.socket && !this.connecting)) {
      this.idleClosed = false;
      this._connect();
    }
    // else: a connect/reconnect is already in flight — flushed on open.
  }

  _translate(chunkBuffer) {
    try {
      this.socket.translate({
        audio: chunkBuffer.toString('base64'),
        sample_rate: 16000,
        encoding: "audio/wav"
      });
    } catch (e) {
      console.error("Failed to push chunk to Sarvam:", e);
    }
  }

  _queue(chunkBuffer) {
    this.sendQueue.push(chunkBuffer);
    if (this.sendQueue.length > MAX_QUEUED_CHUNKS) {
      // Reconnect is taking too long; drop the oldest audio rather than grow
      // unbounded. Bounded loss beats a memory leak on a real outage.
      this.sendQueue.splice(0, this.sendQueue.length - MAX_QUEUED_CHUNKS);
    }
  }

  _flushQueue() {
    if (!this.socket || this.socket.readyState !== 1) return;
    const queued = this.sendQueue;
    this.sendQueue = [];
    for (const chunk of queued) this._translate(chunk);
  }

  _resetIdleTimer() {
    if (!IDLE_CLOSE_ENABLED) return; // keep the socket open through silences
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this._onIdle(), IDLE_CLOSE_MS);
  }

  _onIdle() {
    // No speech for IDLE_CLOSE_MS — close the socket. This frees the idle
    // connection and resets Sarvam's session clock; the next chunk reopens it.
    if (this.intentionalStop) return;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
      console.log(`[Sarvam] Idle-closing socket after ${IDLE_CLOSE_MS / 1000}s of silence.`);
      this.idleClosed = true;
      try { this.socket.flush(); } catch (e) { /* ignore */ }
      try { this.socket.close(); } catch (e) { /* ignore */ }
    }
  }
}

class OpenAIProvider extends STTProvider {
  constructor(apiKey) {
    super();
    this.openai = new OpenAI({ apiKey });
    this.byteBuffer = Buffer.alloc(0);
    this.isRecording = false;
    this.processInterval = null;
  }

  async start() {
    this.isRecording = true;
    this.byteBuffer = Buffer.alloc(0);
    if (this.onStatus) this.onStatus("listening");
    
    // Chunk processing every 5 seconds for pseudo-streaming fallback
    this.processInterval = setInterval(() => this.processBuffer(), 5000);
  }

  stop() {
    this.isRecording = false;
    if (this.processInterval) clearInterval(this.processInterval);
    this.processBuffer(true);
  }

  sendAudioChunk(chunkBuffer) {
    if (!this.isRecording) return;
    this.byteBuffer = Buffer.concat([this.byteBuffer, chunkBuffer]);
  }

  async processBuffer(isFinalCall = false) {
    if (this.byteBuffer.length === 0) return;
    
    // Snatch the buffer safely
    const currentBuffer = this.byteBuffer;
    this.byteBuffer = Buffer.alloc(0);
    
    if (this.onStatus) this.onStatus("processing");

    const tempFile = path.join(os.tmpdir(), `tangola_chunk_${Date.now()}.wav`);
    createWavFile(currentBuffer, tempFile);
    
    try {
      const response = await this.openai.audio.translations.create({
        file: fs.createReadStream(tempFile),
        model: "whisper-1",
      });
      if (response.text && this.onTranscript) {
        this.onTranscript(response.text, true); 
      }
    } catch (e) {
      console.error("OpenAI Fallback error:", e);
      if (this.onStatus) this.onStatus("error: " + e.message);
    } finally {
      try { fs.unlinkSync(tempFile); } catch (e) {}
      if (this.onStatus && this.isRecording) this.onStatus("listening");
    }
  }
}

class ProviderManager {
  constructor(userDataPath) {
    this.provider = null;
    this.debugWav = false;
    this.debugBuffer = Buffer.alloc(0);
    this.userDataPath = userDataPath || os.homedir();
  }

  setDebugWav(enabled) {
    this.debugWav = enabled;
    console.log(`[Provider] WAV Debug ${enabled ? 'enabled' : 'disabled'}`);
  }

  initialize(providerType, config) {
    if (providerType === 'sarvam') {
      this.provider = new SarvamProvider(config.apiKey);
    } else if (providerType === 'openai') {
      this.provider = new OpenAIProvider(config.apiKey);
    } else {
      throw new Error(`Unknown provider: ${providerType}`);
    }
  }

  async startRecording(onTranscript, onStatus, languageCode) {
    if (!this.provider) throw new Error("Provider not initialized");
    this.provider.onTranscript = onTranscript;
    this.provider.onStatus = onStatus;
    await this.provider.start(languageCode);
  }

  stopRecording() {
    if (this.provider) {
      this.provider.stop();
    }
    
    if (this.debugWav && this.debugBuffer.length > 0) {
      const debugFile = path.join(this.userDataPath, `tangola_debug_${Date.now()}.wav`);
      createWavFile(this.debugBuffer, debugFile);
      console.log(`[Provider] Saved debug WAV to ${debugFile}`);
      this.debugBuffer = Buffer.alloc(0);
    }
  }

  pushAudioChunk(chunkBuffer) {
    if (this.debugWav) {
      this.debugBuffer = Buffer.concat([this.debugBuffer, chunkBuffer]);
    }
    if (this.provider) {
      this.provider.sendAudioChunk(chunkBuffer);
    }
  }
}

module.exports = { ProviderManager, SarvamProvider, OpenAIProvider };
