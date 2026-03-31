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

class SarvamProvider extends STTProvider {
  constructor(apiKey) {
    super();
    this.client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    this.socket = null;
  }

  async start() {
    // 1. Prevent overlapping connection attempts
    if (this.socket && (this.socket.readyState === 1 || this.socket.readyState === 0)) {
      return; 
    }

    try {
      if (this.onStatus) this.onStatus('connecting');

      this.socket = await this.client.speechToTextTranslateStreaming.connect({
        model: "saaras:v3",
        "language-code": "ta-IN",
        high_vad_sensitivity: true,
        vad_signals: true 
      });

      // 2. Setup standard life-cycle listeners
      this.socket.on('message', (response) => {
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

      this.socket.on('error', (err) => {
        console.error("Sarvam SDK Error:", err);
        if (this.onStatus) this.onStatus('error: ' + err.message);
      });

      this.socket.on('close', () => {
        if (this.onStatus) this.onStatus('disconnected');
      });

      // 3. Wait for the connection to be fully live
      await this.socket.waitForOpen();
      if (this.onStatus) this.onStatus('connected');

    } catch (err) {
      console.error("Failed to start Sarvam translation streaming:", err);
      if (this.onStatus) this.onStatus('error: ' + err.message);
      throw err;
    }
  }

  stop() {
    if (this.socket) {
      try {
        this.socket.flush();
      } catch (e) {
        // ignore if already closed
      }
      this.socket.close();
    }
    this.socket = null;
  }

  sendAudioChunk(chunkBuffer) {
    if (this.socket) {
      try {
        const base64Audio = chunkBuffer.toString('base64');
        // Note: The translation socket specialized client uses .translate()
        this.socket.translate({
          audio: base64Audio,
          sample_rate: 16000,
          encoding: "audio/wav"
        });
      } catch (e) {
        console.error("Failed to push chunk to Sarvam", e);
      }
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
  constructor() {
    this.provider = null;
    this.debugWav = false;
    this.debugBuffer = Buffer.alloc(0);
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

  async startRecording(onTranscript, onStatus) {
    if (!this.provider) throw new Error("Provider not initialized");
    this.provider.onTranscript = onTranscript;
    this.provider.onStatus = onStatus;
    await this.provider.start();
  }

  stopRecording() {
    if (this.provider) {
      this.provider.stop();
    }
    
    if (this.debugWav && this.debugBuffer.length > 0) {
      const debugFile = path.join(app ? app.getPath('userData') : os.homedir(), `tangola_debug_${Date.now()}.wav`);
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
