const { SarvamAIClient } = require('sarvamai');

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

class ProviderManager {
  constructor() {
    this.provider = null;
  }

  initialize(providerType, config) {
    if (providerType === 'sarvam') {
      this.provider = new SarvamProvider(config.apiKey);
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
  }

  pushAudioChunk(chunkBuffer) {
    if (this.provider) {
      this.provider.sendAudioChunk(chunkBuffer);
    }
  }
}

module.exports = { ProviderManager, SarvamProvider };
