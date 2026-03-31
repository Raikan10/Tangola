const { SarvamAIClient } = require('sarvamai');
const fs = require('fs');
require('dotenv').config({ path: '../.env' });

async function runOptimizedStream() {
  const FILE_PATH = "test.wav";
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`❌ Audio file not found: ${FILE_PATH}`);
    return;
  }
  
  const client = new SarvamAIClient({
    apiSubscriptionKey: process.env.SARVAM_API_KEY
  });

  console.log("Connecting to Sarvam Optimized Streaming API...");

  try {
    const socket = await client.speechToTextStreaming.connect({
      model: "saaras:v3",
      mode: "translate", 
      "language-code": "ta-IN",
      high_vad_sensitivity: true,
      vad_signals: true // Enables speech_start and speech_end for better accuracy
    });

    socket.on("open", () => {
      console.log("✅ SDK Socket Connected (Real-Time Mode)");
      
      const fullBuffer = fs.readFileSync(FILE_PATH);
      const CHUNK_SIZE = 3200; // 100ms worth of 16kHz mono audio
      let offset = 0;

      console.log("📡 Streaming audio chunks (simulating 1x real-time)...");
      
      const interval = setInterval(() => {
        if (offset >= fullBuffer.length) {
          clearInterval(interval);
          console.log("🏁 Streaming finished. Flushing...");
          socket.flush();
          return;
        }

        const chunk = fullBuffer.slice(offset, offset + CHUNK_SIZE);
        socket.transcribe({
          audio: chunk.toString('base64'),
          sample_rate: 16000,
          encoding: "audio/wav"
        });

        offset += CHUNK_SIZE;
      }, 100); // Send one chunk every 100ms
    });

    socket.on("message", (response) => {
      if (response.type === "transcript") {
        console.log("📥 [LIVE TRANSCRIPT]:", response.text);
      } else if (response.type === "translation") {
        console.log("📥 [LIVE TRANSLATION]:", response.text);
      } else if (response.type === "speech_start") {
        console.log("🟢 Speech Started");
      } else if (response.type === "speech_end") {
        console.log("🔴 Speech Ended");
      } else {
        // Log other events too
        console.log("📥 Message:", JSON.stringify(response, null, 2));
      }
    });

    socket.on("error", (error) => {
      console.error("❌ SDK Error:", error);
    });

    socket.on("close", () => {
      console.log("🔌 SDK Socket Closed");
      process.exit(0);
    });

    await socket.waitForOpen();
    // Allow time for the stream to finish (approx 10s for the test file)
    await new Promise(resolve => setTimeout(resolve, 15000));
    socket.close();

  } catch (err) {
    console.error("💥 Connection Failed:", err);
  }
}

runOptimizedStream().catch(console.error);
