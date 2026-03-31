# Sarvam AI STT Integration Learnings

This document serves as a persistent brain-dump for traversing and troubleshooting the `saaras:v3` WebSocket streaming integration for Tangola (Tamil -> English).

## 1. Connection Endpoint Realities
*   **Documentation vs. Reality**: The official guides often refer to the endpoint as `/speech-to-text-streaming`, but hitting that URL yields an immediate HTTP `403 Forbidden`.
*   **The Correct Path**: Transpiled code from the `sarvamai` JS SDK reveals the true WebSocket ingestion URL is `wss://api.sarvam.ai/speech-to-text/ws`.
*   **Query Strings**: The connection string expects explicit configurations baked into the URL. For Tangola's translation mode, it requires:
    `?model=saaras:v3&mode=translate&language-code=ta-IN&high_vad_sensitivity=true&sample_rate=16000`. 
    *Note: Notice the hyphen in `language-code` compared to the underscore in `sample_rate`.*

## 2. The 1-Second Disconnect Mystery
Currently, the WebSocket correctly completes its handshake (`open` event fires) but silently terminates the connection approximately 1 second afterward.
*   **Silent Failures**: The server does NOT send a close code or fire `ws.on('error')` when schemas mismatch—it just drops the client cleanly.
*   **Payload Shape Evolution**: We initially assumed a flat JSON structure (`{"audio": "<b64>", "encoding": "pcm_s16le"}`). The type definitions (`AudioMessage.d.ts`) mandate a nested structure:
    ```javascript
    {
      "audio": {
        "data": "base64_encoded_pcm_s16le",
        "encoding": "pcm_s16le", // Or perhaps "audio/wav" ?
        "sample_rate": 16000
      }
    }
    ```
*   **Next Investigative Steps**: We need to verify if Sarvam restricts maximum/minimum chunk byte sizes (e.g. demanding 100ms frames), or if `encoding` string strictly accepts only literal `"audio/wav"` despite us sending raw `pcm_s16le` bytes.

## 3. Translation Mode Responses (STTT)
Switching the engine to `mode="translate"` structurally alters the JSON response emitted heavily against regular STT. 
*   Instead of returning `{ "transcript": "..." }`, the payload changes completely to `{ "translation": "..." }`.
*   When using `vad_signals=true`, the server begins to dispatch event-driven markers like `{ "type": "speech_start" }` and `{ "type": "speech_end" }`, alongside `{ "type": "translation", "text": "Translated Sentence" }`.
*   Our parser is now resiliently built to sweep for `.translation`, `.transcript`, or `.text`.

## 4. Stability Check: The React IPC "Promise Lock" Bug 
*   **Discovery**: If `engine/main.py` is stopped, `new WebSocket("ws://localhost")` throws an asynchronous `error`. Because we had awaited `pythonWs.once('open', res)` without attaching a rejection handler, the Electron backend froze gracefully.
*   **Resolution**: By explicitly bounding the engine startup in an unhandled-rejection `Promise.catch` block, the Dashboard UI can now safely unlock itself and render an alert if the local capture agent drops out.
