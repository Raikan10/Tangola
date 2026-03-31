# Tangola Roadmap

- [ ] **Phase 1: Audio Foundation**
    - [ ] Create `engine/` adapter for Windows (WASAPI) and Mac (Microphone).
    - [ ] Implement Local WebSocket server in Python to stream audio.
    - [ ] Add 2s Heartbeat between Python and Electron.

- [x] **Phase 2: The Provider Plugin**
    - [x] Define generic `STTProvider` interface.
    - [x] Implement `SarvamProvider` (Tamil -> English).
    - [ ] Implement `OpenAIProvider` (as a reliable fallback).

- [x] **Phase 3: Simplified UI**
    - [x] Standard Electron window (Main Dashboard).
    - [x] Real-time Transcript display panel.
    - [x] "Record" state management.

- [ ] **Phase 4: Summarization & Context**
    - [/] JSON transcript persistence.
    - [ ] LLM prompt engineering for "Granola-style" structured notes.
    - [ ] Basic "WAV Debug" toggle for remote troubleshooting.
