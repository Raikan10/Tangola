# Tangola Roadmap

- [ ] **Phase 1: Audio Foundation**
    - [ ] Create `engine/` adapter for Windows (WASAPI) and Mac (Microphone).
    - [ ] Implement Local WebSocket server in Python to stream audio.
    - [ ] Add 2s Heartbeat between Python and Electron.

- [ ] **Phase 2: The Provider Plugin**
    - [ ] Define generic `STTProvider` interface.
    - [ ] Implement `SarvamProvider` (Tamil -> English).
    - [ ] Implement `OpenAIProvider` (as a reliable fallback).

- [ ] **Phase 3: Simplified UI**
    - [ ] Standard Electron window (Main Dashboard).
    - [ ] Real-time Transcript display panel.
    - [ ] "Record" state management.

- [ ] **Phase 4: Summarization & Context**
    - [ ] JSON transcript persistence.
    - [ ] LLM prompt engineering for "Granola-style" structured notes.
    - [ ] Basic "WAV Debug" toggle for remote troubleshooting.
